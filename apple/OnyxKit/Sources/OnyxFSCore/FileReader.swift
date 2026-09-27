import Foundation

/// Reads one open file a range at a time, fast enough to scrub a video
/// master that is never downloaded whole.
///
/// The file is read in 8 MiB chunks, each fetched with one HTTP Range GET
/// straight from storage on a presigned URL, and kept in the ChunkStore.
/// While reads run sequentially, chunks ahead of them are fetched too: two
/// at first, doubling each time the reads move into a new chunk, up to 16
/// (128 MiB), never more than a quarter of the cache. A seek resets that, and
/// read-ahead nothing will now use is dropped, so the new position gets the
/// bandwidth. At most four fetches run at once; a read that needs a chunk
/// takes a slot from read-ahead if it must.
///
/// Every chunk is fetched once however many reads want it; they wait on the
/// same fetch. A read that is cancelled stops waiting, but the fetch goes on
/// and is cached, and nothing half-fetched is ever kept.
///
/// The presigned URL is asked for only when a chunk is not cached, replaced a
/// minute before it expires, and once more when storage refuses it (400,
/// 403, 404, 416: expired, revoked, or the object moved). Network errors,
/// 408, 429 and 5xx are tried three times in all, with backoff.
///
/// A file kept on this Mac (`local`) is read through /fs/v1/data, range for
/// range, and not cached again. A file being written is read from its
/// staging file (`init(staging:)`).
///
/// If the file's version changes while it is open and bytes of the old one
/// were already read, reads fail with `.stale` rather than mix the two.
public actor FileReader {
    public struct Tuning: Sendable, Hashable {
        /// The unit of fetching and of the cache.
        public var chunkSize = 8 << 20
        /// Read-ahead, in chunks, once reads are sequential...
        public var initialWindow = 2
        /// ...and at most.
        public var maxWindow = 16
        public var maxInFlight = 4
        /// Tries per chunk against network errors, 408, 429 and 5xx.
        public var attempts = 3
        /// Seconds to wait before the second try, the third, and so on.
        public var retryDelays: [Double] = [0.25, 1]
        /// A presigned URL is replaced this many seconds before it expires.
        public var refreshMargin: Double = 60

        public init() {}
    }

    public struct Stats: Sendable, Hashable {
        /// Chunk fetches started, and of those, ahead of any read.
        public var fetches = 0
        public var readAheadFetches = 0
        /// Chunks a read found in the cache.
        public var cacheHits = 0
        /// Read-ahead dropped after a seek, or to give a read its slot.
        public var droppedFetches = 0
        /// Storage requests tried again after a network error or a 5xx.
        public var retries = 0
        /// Presigned URLs asked for: the first, and every refresh.
        public var sourceFetches = 0
        public var seeks = 0
        /// The read-ahead window now (0 when reads are not sequential), and
        /// its largest, in chunks.
        public var window = 0
        public var peakWindow = 0
        public var peakInFlight = 0
        /// Bytes handed to reads.
        public var bytesRead: Int64 = 0
    }

    private enum Backing {
        case staging(URL)
        case bridge(FSBridgeClient, ChunkStore)
    }

    private struct Link {
        let url: URL
        let expiresAt: Double?
        let serial: Int
    }

    private struct Flight {
        let token: UInt64
        /// Nil while it waits for a slot.
        var task: Task<Void, Never>?
        var waiters: [UInt64: CheckedContinuation<Data, Error>] = [:]
        var readAhead: Bool
    }

    /// A wait found no fetch to wait on: look again.
    private struct LookAgain: Error {}

    public nonisolated let fileId: String
    private let backing: Backing
    private let tuning: Tuning
    /// Seconds since 1970, for link expiry.
    private let now: @Sendable () -> Double

    private var version: String
    private var size: Int64
    private var local: Bool
    private var key: ChunkStore.Key

    private var link: Link?
    private var linkSerial = 0
    private var linkRefresh: Task<FSSource, Error>?
    private var served = false
    private var stale = false

    // The access pattern.
    private var lastStart: Int64?
    private var lastEnd: Int64 = 0
    /// The last chunk reads have reached, and the first chunk of the latest
    /// read.
    private var position = 0
    private var readFirst = 0
    private var sequential = false
    private var window: Int

    private var flights: [Int: Flight] = [:]
    private var running = 0
    /// Chunks reads are waiting for that have no slot yet, oldest first.
    private var queue: [Int] = []
    /// Chunks this reader has seen in the cache or put there.
    private var cached: Set<Int> = []
    private var nextToken: UInt64 = 0
    private var counters = Stats()

    /// A file the bridge serves. `version` and `size` are the entry's; if the
    /// file turns out to have moved on before a byte was read, the reader
    /// follows it. `local`: the entry says its bytes are on this Mac.
    public init(fileId: String, version: String, size: Int64, client: FSBridgeClient, store: ChunkStore,
                local: Bool = false, tuning: Tuning = Tuning()) {
        self.init(fileId: fileId, version: version, size: size, client: client, store: store, local: local,
                  tuning: tuning, now: { Date().timeIntervalSince1970 })
    }

    init(fileId: String, version: String, size: Int64, client: FSBridgeClient, store: ChunkStore, local: Bool,
         tuning: Tuning, now: @escaping @Sendable () -> Double) {
        self.fileId = fileId
        self.backing = .bridge(client, store)
        self.tuning = tuning
        self.now = now
        self.version = version
        self.size = max(0, size)
        self.local = local
        self.key = ChunkStore.Key(fileId: fileId, version: version)
        self.window = tuning.initialWindow
    }

    /// A file on this Mac: the staging copy of a file being written. Reads
    /// see what has been written so far.
    public init(staging url: URL) {
        fileId = ""
        backing = .staging(url)
        tuning = Tuning()
        now = { Date().timeIntervalSince1970 }
        version = ""
        size = 0
        local = true
        key = ChunkStore.Key(fileId: "", version: "")
        window = 0
    }

    /// Up to `length` bytes from `offset`: fewer at the end of the file, none
    /// at or past it.
    public func read(offset: Int64, length: Int) async throws -> Data {
        guard offset >= 0, length > 0 else { return Data() }
        switch backing {
        case let .staging(url):
            let data = try Self.readFile(url, offset: offset, length: length)
            counters.bytesRead += Int64(data.count)
            return data
        case let .bridge(client, store):
            if stale { throw FSBridgeError.stale }
            let data = local
                ? try await readLocal(client, offset: offset, length: length)
                : try await readChunks(store, offset: offset, length: length)
            if !data.isEmpty { served = true }
            counters.bytesRead += Int64(data.count)
            return data
        }
    }

    /// Stops fetching ahead: the file was closed. Reads still work.
    public func close() {
        for (index, flight) in flights where flight.waiters.isEmpty && flight.task != nil {
            drop(index)
        }
        sequential = false
    }

    public func stats() -> Stats {
        var stats = counters
        stats.window = sequential ? effectiveWindow : 0
        return stats
    }

    // MARK: - Reading

    private func readLocal(_ client: FSBridgeClient, offset: Int64, length: Int) async throws -> Data {
        let end = min(offset + Int64(length), size)
        guard offset < end else { return Data() }
        return try await client.data(id: fileId, range: offset..<end)
    }

    private func readChunks(_ store: ChunkStore, offset: Int64, length: Int) async throws -> Data {
        let end = min(offset + Int64(length), size)
        guard offset < end else { return Data() }
        let first = chunk(of: offset), last = chunk(of: end - 1)
        observe(offset: offset, end: end, first: first, last: last)
        // A read across a boundary waits for the slower of its fetches, not
        // their sum.
        if first < last {
            for index in (first + 1)...last where flights[index] == nil && !cached.contains(index) {
                if await store.contains(key, index: index) { cached.insert(index) } else { start(index, demand: true) }
            }
        }
        if sequential { await pump(store) }
        var result = Data()
        result.reserveCapacity(Int(end - offset))
        for index in first...last {
            let chunkStart = self.chunkStart(index)
            let lower = Int(max(offset, chunkStart) - chunkStart)
            let upper = Int(min(end, chunkStart + Int64(tuning.chunkSize)) - chunkStart)
            let piece = try await bytes(of: index, range: lower..<upper, store)
            result.append(piece)
            // Shorter than asked: the file is shorter than it was.
            if piece.count < upper - lower { break }
        }
        await pump(store)
        return result
    }

    /// `range` of chunk `index`: from a fetch under way, the cache, or a new
    /// fetch.
    private func bytes(of index: Int, range: Range<Int>, _ store: ChunkStore) async throws -> Data {
        var looked = false
        while true {
            try Task.checkCancellation()
            if stale { throw FSBridgeError.stale }
            if flights[index] != nil {
                do {
                    return Self.slice(try await wait(for: index), range)
                } catch is LookAgain {
                    continue
                }
            }
            let expected = chunkLength(index)
            guard expected > 0 else { return Data() }
            if !looked || cached.contains(index) {
                looked = true
                cached.remove(index)
                let clipped = range.lowerBound..<min(range.upperBound, expected)
                if let hit = await store.read(key, index: index, expectedLength: expected, range: clipped) {
                    cached.insert(index)
                    counters.cacheHits += 1
                    return hit
                }
                // While we looked, a fetch may have started, or finished.
                if flights[index] != nil || cached.contains(index) { continue }
            }
            start(index, demand: true)
        }
    }

    /// Waits for the fetch of chunk `index` without holding it up: a
    /// cancelled read stops waiting at once, and the fetch goes on.
    private func wait(for index: Int) async throws -> Data {
        nextToken += 1
        let waiter = nextToken
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else if flights[index] == nil {
                    continuation.resume(throwing: LookAgain())
                } else {
                    flights[index]?.waiters[waiter] = continuation
                }
            }
        } onCancel: {
            Task { await self.stopWaiting(index, waiter) }
        }
    }

    private func stopWaiting(_ index: Int, _ waiter: UInt64) {
        guard let continuation = flights[index]?.waiters.removeValue(forKey: waiter) else { return }
        continuation.resume(throwing: CancellationError())
        // A fetch still waiting for a slot that no one wants now need not run.
        if let flight = flights[index], flight.task == nil, flight.waiters.isEmpty {
            flights[index] = nil
            queue.removeAll { $0 == index }
        }
    }

    // MARK: - The access pattern

    /// Sequential when a read lands within a chunk of the last one, either
    /// way: the kernel's own reads can arrive a little out of order. Each move
    /// into a new chunk doubles the window.
    private func observe(offset: Int64, end: Int64, first: Int, last: Int) {
        defer {
            lastStart = offset
            lastEnd = end
            readFirst = first
            counters.peakWindow = max(counters.peakWindow, sequential ? effectiveWindow : 0)
        }
        guard let previousStart = lastStart else {
            // One read says nothing yet about the next.
            sequential = false
            window = tuning.initialWindow
            position = last
            return
        }
        let slack = Int64(tuning.chunkSize)
        if offset + slack >= previousStart && offset <= lastEnd + slack {
            if !sequential {
                sequential = true
                window = tuning.initialWindow
            } else if last > position {
                window = min(window * 2, tuning.maxWindow)
            }
            position = max(position, last)
        } else {
            sequential = false
            window = tuning.initialWindow
            position = last
            counters.seeks += 1
        }
    }

    private var effectiveWindow: Int {
        guard case let .bridge(_, store) = backing else { return 0 }
        // Read-ahead must not evict what it fetched before it is read.
        let fits = Int(min(Int64(Int.max), store.limitBytes / Int64(tuning.chunkSize) / 4))
        return max(1, min(window, fits))
    }

    /// Chunks worth fetching now: those the latest reads are in (and the one
    /// before, for a read a little out of order) and the window ahead.
    private func wanted(_ index: Int) -> Bool {
        sequential && index >= min(readFirst, position) - 1 && index <= position + effectiveWindow
    }

    // MARK: - Fetches

    /// Drops read-ahead no read will want now, gives waiting reads their
    /// slots, then fills the free ones with the window ahead.
    private func pump(_ store: ChunkStore) async {
        for (index, flight) in flights
        where flight.readAhead && flight.waiters.isEmpty && flight.task != nil && !wanted(index) {
            drop(index)
        }
        startQueued()
        guard sequential, !stale, !local, size > 0 else { return }
        let upper = min(position + effectiveWindow, chunk(of: size - 1))
        guard position < upper else { return }
        for index in (position + 1)...upper {
            guard running < tuning.maxInFlight else { return }
            guard flights[index] == nil, !cached.contains(index) else { continue }
            if await store.contains(key, index: index) {
                cached.insert(index)
                continue
            }
            // Reads may have moved on while we looked.
            guard wanted(index), flights[index] == nil, running < tuning.maxInFlight, !stale, !local else { continue }
            start(index, demand: false)
        }
    }

    private func start(_ index: Int, demand: Bool) {
        guard flights[index] == nil else { return }
        nextToken += 1
        flights[index] = Flight(token: nextToken, task: nil, readAhead: !demand)
        if running < tuning.maxInFlight || (demand && makeRoom()) {
            launch(index)
        } else {
            queue.append(index)
        }
    }

    /// Frees a slot by dropping the read-ahead furthest from what reads need.
    private func makeRoom() -> Bool {
        let droppable = flights.filter { $0.value.readAhead && $0.value.waiters.isEmpty && $0.value.task != nil }
        guard let victim = droppable.keys.max(by: { distance($0) < distance($1) }) else { return false }
        drop(victim)
        return true
    }

    private func distance(_ index: Int) -> Int {
        wanted(index) ? index - position : Int.max
    }

    private func launch(_ index: Int) {
        guard var flight = flights[index], flight.task == nil else { return }
        let token = flight.token
        running += 1
        counters.fetches += 1
        if flight.readAhead { counters.readAheadFetches += 1 }
        counters.peakInFlight = max(counters.peakInFlight, running)
        flight.task = Task { await self.fetch(index, token: token) }
        flights[index] = flight
    }

    private func startQueued() {
        while running < tuning.maxInFlight, !queue.isEmpty {
            let index = queue.removeFirst()
            guard let flight = flights[index], flight.task == nil else { continue }
            if flight.waiters.isEmpty {
                flights[index] = nil
            } else {
                launch(index)
            }
        }
    }

    /// Cancels a running fetch no read waits on. It is forgotten at once, so
    /// a read that wants the chunk later starts a fetch of its own; what the
    /// cancelled one had is never cached.
    private func drop(_ index: Int) {
        guard let flight = flights.removeValue(forKey: index), let task = flight.task else { return }
        task.cancel()
        running -= 1
        counters.droppedFetches += 1
    }

    private func fetch(_ index: Int, token: UInt64) async {
        let result: Result<Data, Error>
        do {
            result = .success(try await download(index))
        } catch {
            result = .failure(error)
        }
        guard let flight = flights[index], flight.token == token else { return }
        flights[index] = nil
        running -= 1
        switch result {
        case .success:
            cached.insert(index)
        case .failure:
            // Read-ahead that fails (the network is down) stops until reads
            // show they are sequential again.
            if flight.readAhead { sequential = false }
        }
        for waiter in flight.waiters.values { waiter.resume(with: result) }
        guard case let .bridge(_, store) = backing else { return }
        await pump(store)
    }

    /// One chunk, from storage, into the cache.
    private func download(_ index: Int) async throws -> Data {
        guard case let .bridge(client, store) = backing else { return Data() }
        var failures = 0
        var refused: Int?
        var refreshed = false
        while true {
            try Task.checkCancellation()
            let link = try await currentLink(client, replacing: refused)
            let start = chunkStart(index)
            let expected = chunkLength(index)
            guard expected > 0 else { return Data() }
            guard let link else {
                // The file turned out to be on this Mac.
                return try await client.data(id: fileId, range: start..<(start + Int64(expected)))
            }
            let version = self.version, key = self.key, whole = size
            let answer: (status: Int, body: Data, contentRange: String?)
            do {
                answer = try await client.storageGET(link.url, range: start..<(start + Int64(expected)))
            } catch let error as URLError {
                if error.code == .cancelled || Task.isCancelled { throw CancellationError() }
                failures += 1
                guard failures < tuning.attempts else { throw FSBridgeError.network(error.code) }
                counters.retries += 1
                try await pause(after: failures)
                continue
            }
            try Task.checkCancellation()
            // The file moved on while this was in flight: fetch it again as it is now.
            guard version == self.version else { continue }
            var data: Data?
            switch answer.status {
            case 206:
                if answer.body.count == expected && Self.contentRange(answer.contentRange, startsAt: start) {
                    data = answer.body
                }
            case 200:
                // Storage ignored the range and sent the whole object.
                if Int64(answer.body.count) == whole {
                    data = answer.body.subdata(in: Int(start)..<(Int(start) + expected))
                }
            case 400, 403, 404, 416:
                // Expired, revoked, or the object moved: a fresh link, once.
                guard !refreshed else { throw FSBridgeError.storage(status: answer.status) }
                refreshed = true
                refused = link.serial
                continue
            case 408, 429, 500...599:
                break
            default:
                throw FSBridgeError.storage(status: answer.status)
            }
            guard let data else {
                // A 5xx, or a body that is not the range asked for: try again.
                failures += 1
                guard failures < tuning.attempts else { throw FSBridgeError.storage(status: answer.status) }
                counters.retries += 1
                try await pause(after: failures)
                continue
            }
            await store.write(key, index: index, data: data)
            return data
        }
    }

    private func pause(after failures: Int) async throws {
        guard !tuning.retryDelays.isEmpty else { return }
        let delay = tuning.retryDelays[min(failures - 1, tuning.retryDelays.count - 1)]
        try await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
    }

    // MARK: - The link

    /// The presigned URL to read with; nil when the file is on this Mac.
    /// One /fs/v1/source request at a time, shared by every fetch that needs
    /// it. `refused` is the serial of a link storage turned down.
    private func currentLink(_ client: FSBridgeClient, replacing refused: Int?) async throws -> Link? {
        if stale { throw FSBridgeError.stale }
        if local { return nil }
        if let link, link.serial != refused, !expiring(link) { return link }
        let refresh: Task<FSSource, Error>
        if let running = linkRefresh {
            refresh = running
        } else {
            let fileId = self.fileId
            refresh = Task { try await client.source(id: fileId) }
            linkRefresh = refresh
            counters.sourceFetches += 1
        }
        let source: FSSource
        do {
            source = try await refresh.value
        } catch {
            if linkRefresh == refresh { linkRefresh = nil }
            throw error
        }
        if linkRefresh == refresh {
            linkRefresh = nil
            try adopt(source)
        }
        if stale { throw FSBridgeError.stale }
        if local { return nil }
        guard let link else { throw FSBridgeError.server("The Onyx app gave no link to the file.") }
        return link
    }

    private func expiring(_ link: Link) -> Bool {
        guard let expiresAt = link.expiresAt else { return false }
        return now() >= expiresAt - tuning.refreshMargin
    }

    private func adopt(_ source: FSSource) throws {
        if source.version != version {
            guard !served else {
                stale = true
                abandon(FSBridgeError.stale)
                throw FSBridgeError.stale
            }
            // Nothing read yet: the entry was older than the file. Read the
            // file as it is.
            version = source.version
            key = ChunkStore.Key(fileId: fileId, version: version)
            cached.removeAll()
        }
        size = max(0, source.size)
        switch source.kind {
        case .local:
            local = true
            link = nil
        case .remote:
            guard let url = source.url else { throw FSBridgeError.server("The Onyx app gave no link to the file.") }
            linkSerial += 1
            link = Link(url: url, expiresAt: source.expiresAt, serial: linkSerial)
        }
    }

    /// Ends every fetch, and every read waiting on one, with `error`.
    private func abandon(_ error: Error) {
        let all = flights
        flights.removeAll()
        queue.removeAll()
        running = 0
        for flight in all.values {
            flight.task?.cancel()
            for waiter in flight.waiters.values { waiter.resume(throwing: error) }
        }
    }

    // MARK: - Arithmetic

    private func chunk(of offset: Int64) -> Int { Int(offset / Int64(tuning.chunkSize)) }

    private func chunkStart(_ index: Int) -> Int64 { Int64(index) * Int64(tuning.chunkSize) }

    private func chunkLength(_ index: Int) -> Int {
        Int(max(0, min(Int64(tuning.chunkSize), size - chunkStart(index))))
    }

    static func slice(_ whole: Data, _ range: Range<Int>) -> Data {
        let upper = min(range.upperBound, whole.count)
        guard range.lowerBound < upper else { return Data() }
        return whole.subdata(in: (whole.startIndex + range.lowerBound)..<(whole.startIndex + upper))
    }

    /// Whether a 206's Content-Range starts where the range asked did. A
    /// server that leaves it out is taken at its word.
    static func contentRange(_ header: String?, startsAt start: Int64) -> Bool {
        guard let header else { return true }
        guard header.lowercased().hasPrefix("bytes "),
              let dash = header.firstIndex(of: "-"),
              let first = Int64(header[header.index(header.startIndex, offsetBy: 6)..<dash]
                                    .trimmingCharacters(in: .whitespaces)) else { return false }
        return first == start
    }

    /// What there is of `length` bytes from `offset` in a local file that may
    /// still be growing.
    static func readFile(_ url: URL, offset: Int64, length: Int) throws -> Data {
        let fd = open(url.path, O_RDONLY)
        guard fd >= 0 else {
            if errno == ENOENT { throw FSBridgeError.notFound }
            throw FSBridgeError.server(String(cString: strerror(errno)))
        }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw FSBridgeError.server(String(cString: strerror(errno))) }
        let count = Int(max(0, min(Int64(length), Int64(info.st_size) - offset)))
        guard count > 0 else { return Data() }
        var data = Data(count: count)
        var done = 0
        let failed = data.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> Bool in
            guard let base = buffer.baseAddress else { return false }
            while done < count {
                let n = pread(fd, base + done, count - done, off_t(offset) + off_t(done))
                if n < 0 && errno == EINTR { continue }
                if n < 0 { return true }
                if n == 0 { break }
                done += n
            }
            return false
        }
        if failed { throw FSBridgeError.server(String(cString: strerror(errno))) }
        data.count = done
        return data
    }
}
