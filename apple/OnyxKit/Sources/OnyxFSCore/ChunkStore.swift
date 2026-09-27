import CryptoKit
import Foundation

/// The bytes streamed so far, kept on disk: one file per chunk of one version
/// of one file, evicted least-recently-used past a byte limit, and always
/// before the disk would have less than `spareSpace` free.
///
///     <directory>/<sha256(fileId + "\n" + version)>/<index>   a chunk, then its SHA-256
///     <directory>/.tmp/                                      chunks on their way in
///
/// Keyed by version, so a file whose bytes change is never read from the old
/// ones and a rename keeps what was cached. Written to .tmp and renamed into
/// place, so a reader sees a whole chunk or none. Each chunk ends with the
/// SHA-256 of its bytes: one left by an earlier run is checked the first time
/// it is read, and a chunk that is short, long or wrong is deleted and
/// counted as a miss, so the reader fetches it again.
///
/// The index (sizes and last use) lives in memory and is rebuilt from the
/// folder at start, a chunk's modification time standing in for its last use.
/// Disk I/O happens outside the actor, which only keeps the books, so one
/// file's cache hit does not wait behind another's write.
///
/// Give each mounted drive a folder of its own: two stores sharing one would
/// each count only their own chunks against the limit.
public actor ChunkStore {
    /// One version of one file.
    public struct Key: Hashable, Sendable, CustomStringConvertible {
        public let hex: String

        public init(fileId: String, version: String) {
            hex = SHA256.hash(data: Data("\(fileId)\n\(version)".utf8)).map { String(format: "%02x", $0) }.joined()
        }

        public var description: String { hex }
    }

    public struct Stats: Sendable, Hashable {
        public var chunks = 0
        /// On disk, digests included.
        public var bytes: Int64 = 0
        /// `Int64.max` when there is no limit.
        public var limitBytes: Int64 = 0
        public var hits = 0
        public var misses = 0
        public var writes = 0
        public var evictions = 0
        /// Chunks found short, long or wrong, and deleted.
        public var discarded = 0
        /// Chunks not kept because the disk had no room to spare.
        public var skipped = 0
    }

    public nonisolated let directory: URL
    /// `Int64.max` when there is no limit.
    public nonisolated let limitBytes: Int64

    /// Left free on the store's disk whatever the limit, as PinStore leaves
    /// it: filled to the last byte, everything else on it stalls — on the
    /// startup disk, the whole Mac.
    static let spareSpace: Int64 = 1 << 30
    /// How long a look at the disk's free space is trusted.
    static let freeSpaceInterval: TimeInterval = 2

    static let digestLength = 32
    /// A chunk's recorded last use is written back to its file at most this
    /// often, so the order survives a restart without a syscall per read.
    static let touchInterval: TimeInterval = 60

    struct ChunkID: Hashable, Sendable {
        let key: String
        let index: Int
    }

    private struct Record {
        var bytes: Int64
        var lastUse: TimeInterval
        var touchedOnDisk: TimeInterval
        /// Checked against its digest this run (or written by it).
        var verified: Bool
    }

    private var records: [ChunkID: Record] = [:]
    private var total: Int64 = 0
    private var counters = Stats()
    private let freeSpace: @Sendable (URL) -> Int64?
    /// The disk's free bytes when last looked at (less what was written
    /// since), and when.
    private var lastFree: (bytes: Int64, at: TimeInterval)?

    private nonisolated var temporary: URL { directory.appendingPathComponent(".tmp", isDirectory: true) }

    /// Opens the store in `directory`, creating it if need be, and rebuilds
    /// the index from what is there. Chunks past `limitBytes` (a limit made
    /// smaller since) are evicted at once. A limit of 0 or less is no limit,
    /// as the app's `cacheLimitBytes` has it; `spareSpace` is left free on
    /// the disk even then.
    public init(directory: URL, limitBytes: Int64) throws {
        try self.init(directory: directory, limitBytes: limitBytes, freeSpace: { ChunkStore.availableCapacity($0) })
    }

    init(directory: URL, limitBytes: Int64, freeSpace: @escaping @Sendable (URL) -> Int64?) throws {
        self.directory = directory
        self.limitBytes = limitBytes > 0 ? limitBytes : .max
        self.freeSpace = freeSpace
        let files = FileManager.default
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        let temporary = directory.appendingPathComponent(".tmp", isDirectory: true)
        try? files.removeItem(at: temporary)
        try files.createDirectory(at: temporary, withIntermediateDirectories: true)

        var records: [ChunkID: Record] = [:]
        var total: Int64 = 0
        var discarded = 0
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        let folders = (try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? []
        for folder in folders where Self.isKeyName(folder.lastPathComponent) {
            let chunks = (try? files.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
            for chunk in chunks {
                guard let index = Int(chunk.lastPathComponent), index >= 0,
                      String(index) == chunk.lastPathComponent,
                      let values = try? chunk.resourceValues(forKeys: Set(keys)), values.isDirectory != true else {
                    continue
                }
                let size = Int64(values.fileSize ?? 0)
                guard size > Int64(Self.digestLength) else {
                    // Nothing but a digest, or not even that: no chunk is empty.
                    try? files.removeItem(at: chunk)
                    discarded += 1
                    continue
                }
                let used = values.contentModificationDate?.timeIntervalSince1970 ?? 0
                records[ChunkID(key: folder.lastPathComponent, index: index)] =
                    Record(bytes: size, lastUse: used, touchedOnDisk: used, verified: false)
                total += size
            }
        }
        // Over the limit, least recently used first.
        var evictions = 0
        let oldestFirst = records.sorted { $0.value.lastUse < $1.value.lastUse }.map(\.key)
        for id in oldestFirst where total > self.limitBytes {
            total -= records.removeValue(forKey: id)?.bytes ?? 0
            Self.delete(id, in: directory)
            evictions += 1
        }
        self.records = records
        self.total = total
        counters.discarded = discarded
        counters.evictions = evictions
    }

    public func stats() -> Stats {
        var stats = counters
        stats.chunks = records.count
        stats.bytes = total
        stats.limitBytes = limitBytes
        return stats
    }

    public func contains(_ key: Key, index: Int) -> Bool {
        records[ChunkID(key: key.hex, index: index)] != nil
    }

    /// `range` of chunk `index`, whose full length must be `expectedLength`.
    /// Nil on a miss, including a chunk found damaged, which is deleted.
    public nonisolated func read(_ key: Key, index: Int, expectedLength: Int, range: Range<Int>) async -> Data? {
        let id = ChunkID(key: key.hex, index: index)
        guard let verified = await lookUp(id) else { return nil }
        let outcome = Self.readChunk(at: url(id), expectedLength: expectedLength, range: range, verify: !verified)
        await settle(id, outcome)
        if case let .bytes(data) = outcome { return data }
        return nil
    }

    /// Keeps `data` as chunk `index`, replacing any chunk there. Best
    /// effort: a chunk that cannot be kept (no room on the disk, a write that
    /// fails) only means its next read goes to storage again.
    public nonisolated func write(_ key: Key, index: Int, data: Data) async {
        guard !data.isEmpty else { return }
        let id = ChunkID(key: key.hex, index: index)
        let bytes = Int64(data.count + Self.digestLength)
        guard await makeRoom(for: bytes, keeping: id) else { return }
        let digest = Data(SHA256.hash(data: data))
        guard Self.writeAtomically([data, digest], to: url(id), via: temporary) else { return }
        await recordWrite(id, bytes: bytes)
    }

    /// Free bytes on the disk holding `url`: what macOS would make room for
    /// (purgeable space counts), or what is plainly free when it will not
    /// say. Nil when neither is known. PinStore's measure.
    public static func availableCapacity(_ url: URL) -> Int64? {
        // A URL made afresh: one asked before may answer from its cache.
        let values = try? URL(fileURLWithPath: url.path).resourceValues(
            forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey])
        let important = values?.volumeAvailableCapacityForImportantUsage.flatMap { $0 > 0 ? $0 : nil }
        let plain = values?.volumeAvailableCapacity.map(Int64.init)
        switch (important, plain) {
        case let (a?, b?): return max(a, b)
        case let (a, b): return a ?? b
        }
    }

    // MARK: - Books (on the actor)

    /// Whether the chunk is indexed, and if so whether it is already checked.
    private func lookUp(_ id: ChunkID) -> Bool? {
        guard let record = records[id] else {
            counters.misses += 1
            return nil
        }
        return record.verified
    }

    private func settle(_ id: ChunkID, _ outcome: ReadOutcome) {
        switch outcome {
        case .bytes:
            guard var record = records[id] else { return }
            counters.hits += 1
            let now = Date().timeIntervalSince1970
            record.lastUse = now
            record.verified = true
            if now - record.touchedOnDisk > Self.touchInterval {
                utimes(url(id).path, nil)
                record.touchedOnDisk = now
            }
            records[id] = record
        case .missing:
            counters.misses += 1
            forget(id)
        case .damaged:
            counters.misses += 1
            counters.discarded += 1
            try? FileManager.default.removeItem(at: url(id))
            forget(id)
        }
    }

    /// Whether the disk can take `bytes` more and still have `spareSpace`
    /// free, evicting the least recently used until it can. Free space that
    /// cannot be learned is not taken for none.
    private func makeRoom(for bytes: Int64, keeping id: ChunkID) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        if lastFree == nil || now - lastFree!.at > Self.freeSpaceInterval {
            lastFree = freeSpace(directory).map { ($0, now) }
        }
        guard var free = lastFree?.bytes else { return true }
        while free - Self.spareSpace < bytes, let victim = leastRecentlyUsed(excluding: id) {
            free += evict(victim)
        }
        guard free - Self.spareSpace >= bytes else {
            lastFree?.bytes = free
            counters.skipped += 1
            return false
        }
        // Counted as spent until the next look at the disk.
        lastFree?.bytes = free - bytes
        return true
    }

    private func recordWrite(_ id: ChunkID, bytes: Int64) {
        forget(id)
        let now = Date().timeIntervalSince1970
        records[id] = Record(bytes: bytes, lastUse: now, touchedOnDisk: now, verified: true)
        total += bytes
        counters.writes += 1
        // Least recently used first. The chunk just written goes last, and
        // only if it alone is over the limit.
        while total > limitBytes, let victim = leastRecentlyUsed(excluding: id) ?? records[id].map({ _ in id }) {
            evict(victim)
        }
    }

    private func forget(_ id: ChunkID) {
        if let old = records.removeValue(forKey: id) { total -= old.bytes }
    }

    private func leastRecentlyUsed(excluding kept: ChunkID) -> ChunkID? {
        var victim: ChunkID?
        var oldest = TimeInterval.infinity
        for (id, record) in records where id != kept && record.lastUse < oldest {
            oldest = record.lastUse
            victim = id
        }
        return victim
    }

    /// Deletes a chunk; the bytes that frees.
    @discardableResult
    private func evict(_ id: ChunkID) -> Int64 {
        guard let record = records.removeValue(forKey: id) else { return 0 }
        Self.delete(id, in: directory)
        total -= record.bytes
        counters.evictions += 1
        return record.bytes
    }

    // MARK: - Disk (off the actor)

    enum ReadOutcome: Sendable {
        case bytes(Data)
        case missing
        case damaged
    }

    private nonisolated func url(_ id: ChunkID) -> URL {
        Self.url(id, in: directory)
    }

    private static func url(_ id: ChunkID, in directory: URL) -> URL {
        directory.appendingPathComponent(id.key, isDirectory: true).appendingPathComponent(String(id.index))
    }

    private static func delete(_ id: ChunkID, in directory: URL) {
        let file = url(id, in: directory)
        unlink(file.path)
        // The version's folder goes with its last chunk; rmdir refuses while
        // there are others.
        rmdir(file.deletingLastPathComponent().path)
    }

    static func isKeyName(_ name: String) -> Bool {
        name.count == 64 && name.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    static func readChunk(at url: URL, expectedLength: Int, range: Range<Int>, verify: Bool) -> ReadOutcome {
        let fd = open(url.path, O_RDONLY)
        guard fd >= 0 else { return .missing }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { return .missing }
        guard expectedLength > 0, Int64(info.st_size) == Int64(expectedLength + digestLength) else { return .damaged }
        let lower = max(0, range.lowerBound)
        let upper = min(expectedLength, range.upperBound)
        if verify {
            guard let whole = readExactly(fd, offset: 0, count: expectedLength + digestLength) else { return .damaged }
            let body = whole.prefix(expectedLength)
            guard Data(SHA256.hash(data: body)) == whole.suffix(digestLength) else { return .damaged }
            return .bytes(lower < upper ? whole.subdata(in: lower..<upper) : Data())
        }
        guard lower < upper else { return .bytes(Data()) }
        guard let data = readExactly(fd, offset: lower, count: upper - lower) else { return .damaged }
        return .bytes(data)
    }

    static func readExactly(_ fd: Int32, offset: Int, count: Int) -> Data? {
        var data = Data(count: count)
        var done = 0
        let ok = data.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> Bool in
            guard let base = buffer.baseAddress else { return count == 0 }
            while done < count {
                let n = pread(fd, base + done, count - done, off_t(offset + done))
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { return false }
                done += n
            }
            return true
        }
        return ok ? data : nil
    }

    /// Writes `parts` to a new file in `temporary`, then renames it to `url`.
    static func writeAtomically(_ parts: [Data], to url: URL, via temporary: URL) -> Bool {
        let staging = temporary.appendingPathComponent(UUID().uuidString)
        let fd = open(staging.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { return false }
        var ok = true
        for part in parts where ok {
            ok = part.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Bool in
                guard let base = buffer.baseAddress else { return true }
                var done = 0
                while done < buffer.count {
                    let n = Darwin.write(fd, base + done, buffer.count - done)
                    if n < 0 && errno == EINTR { continue }
                    guard n > 0 else { return false }
                    done += n
                }
                return true
            }
        }
        if close(fd) != 0 { ok = false }
        guard ok else {
            unlink(staging.path)
            return false
        }
        let folder = url.deletingLastPathComponent()
        for _ in 0..<2 {
            mkdir(folder.path, 0o700)
            if rename(staging.path, url.path) == 0 { return true }
            // ENOENT: eviction took the version's folder between the two
            // calls. Once more.
            guard errno == ENOENT else { break }
        }
        unlink(staging.path)
        return false
    }
}
