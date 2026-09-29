import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The network, as the thumbnail worker needs it: the server's routes
/// (OnyxAPI, with the device token) and storage, by presigned link.
/// APIThumbnailServer in the app; a stub in tests.
public protocol ThumbnailServer: Sendable {
    func mayRecordThumbnail(fileId: String) async throws -> Bool
    func fileDetail(id: String) async throws -> OnyxAPI.FileDetail
    func presignThumbnail(contentType: String, sizes: [String]) async throws -> OnyxAPI.PreviewTarget
    func presignPoster(contentType: String) async throws -> OnyxAPI.PreviewTarget
    func recordThumbnail(fileId: String, thumbnailKey: String, posterKey: String?, thumbSizes: [String],
                         media: MediaFacts, placeholder: Placeholder?) async throws -> FileItem
    /// A picture to storage, by its presigned PUT.
    func put(_ data: Data, to url: URL, contentType: String, cacheControl: String?) async throws
    /// A small picture from storage: a thumbnail, to see how big it is.
    func fetch(_ url: URL) async throws -> Data
    /// A whole file from storage, into `destination`: an image original.
    func download(_ url: URL, to destination: URL) async throws
}

/// How the pictures are drawn: ThumbnailRenderer in the app; a stub in
/// tests. Async and not the worker's, so the decoding runs off its actor.
public protocol ThumbnailDrawing: Sendable {
    func video(_ url: URL, mime: String?) async throws -> PreviewSet
    func image(_ file: URL, bytes: Int64?, mime: String?, name: String) async throws -> PreviewSet
}

/// Pictures that are missing, made on this Mac: for the files of the drives
/// it syncs that have no thumbnail (or, for a video, only one of the old
/// small ones), and for each file it uploads, from the bytes still on this
/// disk.
///
/// One job at a time, at utility priority, holding nothing but the few
/// pictures of the job in hand. Each goes:
///
///   ask      GET /api/files/<id>: is it still missing, and in the bucket?
///            A thumbnail it has already is looked at: one of the old
///            480px ones is made again, a newer one is kept.
///   may      GET /api/files/<id>/thumbnail — 204 when this account may
///            record one — before anything is downloaded or drawn
///   draw     the frame (AVFoundation reads only the ranges it needs of a
///            presigned link) or the image, at every size (Poster), and
///            its placeholder (Placeholder)
///   hand in  the presign route's PUTs for the pictures, then
///            PUT /api/files/<id>/thumbnail with their keys and the
///            placeholder: the file's seq moves, and every device picks the
///            thumbnail up
///
/// A thumbnail made before placeholders is not fetched again for one: a
/// browser draws it, from the smallest picture the row has, when its tile
/// comes into view, which costs this Mac nothing.
///
/// A file just uploaded skips the asking: it is new, and its bytes are here.
///
/// What came of each file goes in a ledger kept on disk (ThumbnailLedger):
/// one that failed waits before it is tried again, and one this account may
/// not change is not asked about for a week. Nothing runs while nothing is
/// due. The worker is woken by what it is given (`update`, `offer`), and by
/// one timer for the soonest retry while there is one.
public actor ThumbnailWorker {
    /// A file this Mac has just uploaded, with its bytes still here.
    public struct LocalFile: Sendable, Equatable {
        public let fileId: String
        public let scope: String
        public let name: String
        public let mime: String?
        public let size: Int64
        public let kind: Poster.Kind
        /// A link of the worker's own to the bytes, in its folder; removed
        /// once the job is over, whatever its end.
        public let url: URL

        public init(fileId: String, scope: String, name: String, mime: String?, size: Int64, kind: Poster.Kind, url: URL) {
            self.fileId = fileId; self.scope = scope; self.name = name; self.mime = mime
            self.size = size; self.kind = kind; self.url = url
        }
    }

    /// What the worker is doing, for Settings.
    public struct Status: Sendable, Equatable {
        /// The file being made now, once its name is known.
        public var working: String?
        /// Files due, the one in hand included.
        public var waiting = 0
        /// Made since the worker started.
        public var made = 0

        public init(working: String? = nil, waiting: Int = 0, made: Int = 0) {
            self.working = working; self.waiting = waiting; self.made = made
        }
    }

    /// One finished job, for the log.
    public struct Report: Sendable {
        public let fileId: String
        public let name: String?
        public let outcome: ThumbnailLedger.Outcome
        /// Why, for anything but `made`.
        public let detail: String?
        public let seconds: Double
        /// What went up: every picture, encoded.
        public let bytes: Int
    }

    private enum Job: Sendable {
        case local(LocalFile)
        case mirror(ThumbnailCandidate)

        var fileId: String {
            switch self {
            case let .local(file): return file.fileId
            case let .mirror(candidate): return candidate.fileId
            }
        }
    }

    /// What one job came to. No outcome: nothing to note (stopped, signed
    /// out, or the file has its pictures now).
    private struct Result: Sendable {
        var outcome: ThumbnailLedger.Outcome?
        var version: Int?
        var name: String?
        var detail: String?
        var bytes = 0
        /// The file needs nothing more from this worker, as far as it knows.
        var settled = false
    }

    private let server: ThumbnailServer
    private let drawing: ThumbnailDrawing
    private let folder: URL
    private let ledgerFile: URL?
    private let clock: @Sendable () -> Date
    private let jobTimeout: TimeInterval

    private var ledger: ThumbnailLedger
    private var ledgerDirty = false
    private var ledgerSavedAt = Date.distantPast
    private var candidates: [String: ThumbnailCandidate] = [:]
    private var uploads: [LocalFile] = []
    private var running: Task<Void, Never>?
    private var wake: Task<Void, Never>?
    /// Stopped for good: a worker is made afresh for each sign-in.
    private var stopped = false
    /// The server does not take thumbnails from this Mac: nothing more is
    /// tried until a worker is made again (the next sign-in or launch).
    private var unsupported = false
    private var status = Status()
    /// An upload in hand, which `waiting` would otherwise not count.
    private var holdingUpload = false
    private var onStatus: (@Sendable (Status) -> Void)?
    private var onReport: (@Sendable (Report) -> Void)?

    /// The soonest retry worth a timer: anything later waits for the next
    /// thing that wakes the worker anyway.
    static let longestWake: TimeInterval = 6 * 3600

    /// `folder` is the worker's own, emptied as it starts: what a job left
    /// there when the app stopped is no use now. `ledgerFile` keeps what
    /// came of each file across launches. `jobTimeout` stops a job that a
    /// stalled network would leave waiting for ever.
    public init(server: ThumbnailServer, drawing: ThumbnailDrawing, folder: URL, ledgerFile: URL?,
                jobTimeout: TimeInterval = 180, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.server = server
        self.drawing = drawing
        self.folder = folder
        self.ledgerFile = ledgerFile
        self.jobTimeout = jobTimeout
        self.clock = clock
        var ledger = ledgerFile.flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode(ThumbnailLedger.self, from: $0) } ?? ThumbnailLedger()
        ledger.prune(now: clock())
        self.ledger = ledger
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    /// Told whenever what `status` says changes, and of each job's end.
    public func observe(status handler: @escaping @Sendable (Status) -> Void,
                        reports: (@Sendable (Report) -> Void)? = nil) {
        onStatus = handler
        onReport = reports
        publish()
    }

    // MARK: - Work in

    /// What a drive's mirror says now about some of its files: `files` are
    /// as the replica has them (those that need nothing are passed over),
    /// the ids in `settled` need nothing (they have their pictures, or are
    /// gone). `whole`: `files` is every file of the drive that might need
    /// something, and any other of that drive is dropped.
    public func update(scope: String, files: [ReplicaFile], settled: [String] = [], whole: Bool = false) {
        guard !stopped else { return }
        if whole { candidates = candidates.filter { $0.value.scope != scope } }
        for id in settled { candidates[id] = nil }
        for file in files {
            if let candidate = ThumbnailCandidate(file, scope: scope) {
                candidates[file.id] = candidate
            } else {
                candidates[file.id] = nil
            }
        }
        pump()
    }

    /// A file just uploaded from this Mac: made next, from `file.url`.
    public func offer(_ file: LocalFile) {
        guard !stopped, !unsupported else {
            try? FileManager.default.removeItem(at: file.url)
            return
        }
        if let earlier = uploads.firstIndex(where: { $0.fileId == file.fileId }) {
            try? FileManager.default.removeItem(at: uploads[earlier].url)
            uploads.remove(at: earlier)
        }
        uploads.append(file)
        pump()
    }

    /// Sign-out, quit, or turned off: the job in hand stops, nothing more
    /// is done, and what is on disk for it goes.
    public func stop() {
        guard !stopped else { return }
        stopped = true
        running?.cancel()
        running = nil
        wake?.cancel()
        wake = nil
        for upload in uploads { try? FileManager.default.removeItem(at: upload.url) }
        uploads = []
        candidates = [:]
        saveLedger(force: true)
        status = Status()
        onStatus?(status)
    }

    /// Returns once no job is running.
    public func idle() async {
        while let running { await running.value }
    }

    var ledgerForTesting: ThumbnailLedger { ledger }
    var candidateIDs: Set<String> { Set(candidates.keys) }
    var hasWakeTimer: Bool { wake != nil }

    // MARK: - Running

    private func pump() {
        guard running == nil else { publish(); return }
        guard !stopped, !unsupported, !uploads.isEmpty || next() != nil else {
            scheduleWake()
            publish()
            return
        }
        wake?.cancel()
        wake = nil
        running = Task(priority: .utility) { await self.drain() }
        publish()
    }

    /// Jobs one after another, until none is due.
    private func drain() async {
        while !stopped, !Task.isCancelled, !unsupported {
            let job: Job
            if !uploads.isEmpty {
                job = .local(uploads.removeFirst())
            } else if let candidate = next() {
                job = .mirror(candidate)
            } else {
                break
            }
            await perform(job)
        }
        guard !stopped else { return }
        running = nil
        saveLedger(force: true)
        scheduleWake()
        publish()
    }

    /// The candidate to make next: due, and first in ThumbnailCandidate's
    /// order.
    private func next() -> ThumbnailCandidate? {
        let now = clock()
        var best: ThumbnailCandidate?
        for candidate in candidates.values where ledger.isDue(candidate.fileId, version: candidate.version, now: now) {
            if best.map({ candidate.goesBefore($0) }) ?? true { best = candidate }
        }
        return best
    }

    private func perform(_ job: Job) async {
        let began = Date()
        if case let .local(file) = job {
            status.working = file.name
            holdingUpload = true
        }
        publish()
        var result: Result
        do {
            result = try await Self.within(jobTimeout) { try await self.make(job) }
        } catch {
            result = Self.result(of: error)
        }
        if case let .local(file) = job { try? FileManager.default.removeItem(at: file.url) }
        status.working = nil
        holdingUpload = false
        guard !stopped else { return }
        if result.detail == Self.unsupportedDetail {
            unsupported = true
            candidates = [:]
            for upload in uploads { try? FileManager.default.removeItem(at: upload.url) }
            uploads = []
        }
        if result.settled || (result.outcome != nil && result.outcome != .failed) {
            // Settled one way or another; the ledger keeps it from coming
            // straight back should the mirror name it again.
            candidates[job.fileId] = nil
        }
        guard let outcome = result.outcome else { return }
        ledger.record(outcome, fileId: job.fileId, version: result.version, at: clock())
        ledgerDirty = true
        if outcome == .made { status.made += 1 }
        saveLedger()
        onReport?(Report(fileId: job.fileId, name: result.name, outcome: outcome, detail: result.detail,
                         seconds: Date().timeIntervalSince(began), bytes: result.bytes))
    }

    // MARK: - One file

    private func make(_ job: Job) async throws -> Result {
        switch job {
        case let .local(file):
            guard try await server.mayRecordThumbnail(fileId: file.fileId) else {
                return Result(outcome: .refused, name: file.name, detail: "Not this account's to change.")
            }
            let set = try await draw(file.kind, from: file.url, bytes: file.size, mime: file.mime, name: file.name)
            let recorded = try await handIn(set, fileId: file.fileId)
            return Result(outcome: .made, version: recorded.version, name: file.name, bytes: set.byteCount)

        case let .mirror(candidate):
            let detail = try await server.fileDetail(id: candidate.fileId)
            let file = detail.file
            status.working = file.name
            publish()
            func skip(_ outcome: ThumbnailLedger.Outcome, _ why: String) -> Result {
                Result(outcome: outcome, version: outcome == .refused ? nil : file.version, name: file.name, detail: why)
            }
            let has = FilePreviews(file)
            if has.contains(.thumbnail), has.contains(.sizes) {
                // Made meanwhile, by a browser or another Mac: the feed
                // brings it.
                return Result(name: file.name, settled: true)
            }
            guard detail.storage == "s3" else { return skip(.unusable, "It is not in the bucket, where pictures go.") }
            guard detail.canWrite != false else { return skip(.refused, "Not this account's to change.") }
            if let shown = file.thumbnailUrl.flatMap(URL.init(string:)) {
                // An image's is never remade from here (ThumbnailCandidate);
                // a video's, when it is one of the old 480px ones.
                guard candidate.kind == .video else { return skip(.kept, "It has a thumbnail.") }
                let source = PixelSize(width: file.metadata?.width, height: file.metadata?.height)
                if let poster = Self.pixelSize(of: try await server.fetch(shown)),
                   !Poster.isUndersized(poster, source: source) {
                    return skip(.kept, "Its thumbnail is new enough to keep.")
                }
            }
            if candidate.kind == .image, let size = file.size, size > Poster.thumbSourceMaxBytes {
                return skip(.unusable, "It is too big to decode for a thumbnail.")
            }
            guard try await server.mayRecordThumbnail(fileId: file.id) else {
                return skip(.refused, "Not this account's to change.")
            }
            guard let original = file.url.flatMap(URL.init(string:)) else { return skip(.unusable, "It has no link to read.") }
            let set: PreviewSet
            switch candidate.kind {
            case .video:
                set = try await drawing.video(original, mime: file.mime)
            case .image:
                // Read whole, as a browser reads it, into this worker's
                // folder, and gone again as soon as it is drawn.
                let copy = folder.appendingPathComponent(UUID().uuidString + Self.suffix(for: file.name))
                defer { try? FileManager.default.removeItem(at: copy) }
                try await server.download(original, to: copy)
                set = try await drawing.image(copy, bytes: file.size, mime: file.mime, name: file.name)
            }
            let recorded = try await handIn(set, fileId: file.id)
            return Result(outcome: .made, version: recorded.version, name: file.name, bytes: set.byteCount)
        }
    }

    private func draw(_ kind: Poster.Kind, from url: URL, bytes: Int64?, mime: String?, name: String) async throws -> PreviewSet {
        switch kind {
        case .video: return try await drawing.video(url, mime: mime)
        case .image: return try await drawing.image(url, bytes: bytes, mime: mime, name: name)
        }
    }

    /// The pictures to storage under keys the server names, then recorded
    /// on the file, with the placeholder, which goes in the row itself. A
    /// sibling or a large picture that does not land is left out, as the
    /// web leaves it out; the grid thumbnail must land.
    private func handIn(_ set: PreviewSet, fileId: String) async throws -> FileItem {
        let type = set.format.contentType
        let grid = try await server.presignThumbnail(contentType: type, sizes: set.sizes)
        try await server.put(set.grid.data, to: grid.putUrl, contentType: type, cacheControl: grid.cacheControl)
        var landed: [String] = []
        for size in set.sizes {
            guard let target = grid.siblings?[size], let picture = set.sibling(size) else { continue }
            do {
                try await server.put(picture.data, to: target.putUrl, contentType: type, cacheControl: grid.cacheControl)
                landed.append(size)
            } catch where !Task.isCancelled {
                continue
            }
        }
        var posterKey: String?
        if let large = set.large {
            do {
                let poster = try await server.presignPoster(contentType: type)
                try await server.put(large.data, to: poster.putUrl, contentType: type, cacheControl: poster.cacheControl)
                posterKey = poster.key
            } catch where !Task.isCancelled {
                posterKey = nil
            }
        }
        try Task.checkCancellation()
        return try await server.recordThumbnail(fileId: fileId, thumbnailKey: grid.key, posterKey: posterKey,
                                                thumbSizes: landed, media: set.media, placeholder: set.placeholder)
    }

    // MARK: - Helpers

    static let unsupportedDetail = "This server does not take thumbnails from Onyx for Mac yet."

    /// What an error comes to. Nothing is noted for a job stopped or signed
    /// out of. A refusal, and a file gone, are the server's answer; a
    /// picture that cannot be drawn waits a week; anything else — the
    /// network, storage, the server, a job that ran out of time — is a
    /// failure, tried again after its wait.
    private static func result(of error: Error) -> Result {
        if error is CancellationError { return Result() }
        if let error = error as? URLError, error.code == .cancelled { return Result() }
        switch error {
        case OnyxError.notAuthenticated:
            return Result()
        case let OnyxError.http(status, message):
            if status == 501 { return Result(detail: unsupportedDetail) }
            if status == 403 { return Result(outcome: .refused, detail: message) }
            if status == 404 || status == 410 { return Result(outcome: .unusable, detail: message ?? "It is gone.") }
            return Result(outcome: .failed, detail: message ?? "The server returned \(status).")
        case let failure as ThumbnailRenderer.Failure:
            return Result(outcome: .unusable, detail: failure.localizedDescription)
        default:
            return Result(outcome: .failed, detail: error.localizedDescription)
        }
    }

    struct TimedOut: LocalizedError {
        var errorDescription: String? { "It took too long." }
    }

    /// `work`, or TimedOut after `seconds` — the work cancelled either way.
    private static func within<T: Sendable>(_ seconds: TimeInterval,
                                            _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask(priority: .utility) { try await work() }
            group.addTask(priority: .utility) {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw TimedOut()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw TimedOut() }
            return first
        }
    }

    /// A picture's size from its header, without decoding it.
    static func pixelSize(of data: Data) -> PixelSize? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
        return PixelSize(width: (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
                         height: (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue)
    }

    /// ".jpg" for "Photo.jpg": a copy keeps its kind in its name, which is
    /// how AVFoundation tells a .mov from an .mp3.
    public static func suffix(for name: String) -> String {
        let ext = (name as NSString).pathExtension
        return ext.isEmpty || ext.count > 8 || !ext.allSatisfy({ $0.isLetter || $0.isNumber }) ? "" : "." + ext
    }

    private func publish() {
        guard !stopped else { return }
        var current = status
        if unsupported {
            current.waiting = 0
        } else {
            let now = clock()
            var waiting = uploads.count + (holdingUpload ? 1 : 0)
            for candidate in candidates.values where ledger.isDue(candidate.fileId, version: candidate.version, now: now) {
                waiting += 1
            }
            current.waiting = waiting
        }
        onStatus?(current)
    }

    /// One timer, for the soonest file waiting out a failure — only while
    /// there is one, and only within `longestWake`.
    private func scheduleWake() {
        wake?.cancel()
        wake = nil
        guard running == nil, !stopped, !unsupported, !candidates.isEmpty else { return }
        let now = clock()
        var soonest: Date?
        for candidate in candidates.values {
            guard let when = ledger.notBefore(candidate.fileId, version: candidate.version), when > now else { continue }
            if soonest.map({ when < $0 }) ?? true { soonest = when }
        }
        guard let soonest, soonest.timeIntervalSince(now) <= Self.longestWake else { return }
        let delay = max(1, soonest.timeIntervalSince(now))
        wake = Task(priority: .utility) { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.woke()
        }
    }

    private func woke() {
        wake = nil
        pump()
    }

    private func saveLedger(force: Bool = false) {
        guard ledgerDirty, let ledgerFile else { return }
        let now = clock()
        // Written at most every half minute while jobs run, and as the
        // queue empties or stops.
        guard force || now.timeIntervalSince(ledgerSavedAt) >= 30 else { return }
        ledger.prune(now: now)
        do {
            try FileManager.default.createDirectory(at: ledgerFile.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try JSONEncoder().encode(ledger).write(to: ledgerFile, options: .atomic)
            ledgerDirty = false
            ledgerSavedAt = now
        } catch {
            // Kept in memory; the next save tries again.
        }
    }
}

/// ThumbnailServer over OnyxAPI and URLSession: the server's routes with
/// the device token, and the pictures straight to and from storage.
public struct APIThumbnailServer: ThumbnailServer {
    let api: OnyxAPI
    let session: URLSession
    /// Each picture storage sends or is sent, for the Activity window.
    let received: (@Sendable (Int64) -> Void)?
    let sent: (@Sendable (Int64) -> Void)?

    /// No cache and no cookies: every link is presigned, and nothing here
    /// is read twice.
    public static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 60
        return URLSession(configuration: configuration)
    }()

    public init(api: OnyxAPI, session: URLSession = APIThumbnailServer.session,
                received: (@Sendable (Int64) -> Void)? = nil, sent: (@Sendable (Int64) -> Void)? = nil) {
        self.api = api
        self.session = session
        self.received = received
        self.sent = sent
    }

    public func mayRecordThumbnail(fileId: String) async throws -> Bool { try await api.mayRecordThumbnail(fileId: fileId) }
    public func fileDetail(id: String) async throws -> OnyxAPI.FileDetail { try await api.fileDetail(id: id) }

    public func presignThumbnail(contentType: String, sizes: [String]) async throws -> OnyxAPI.PreviewTarget {
        try await api.presignThumbnail(contentType: contentType, sizes: sizes)
    }

    public func presignPoster(contentType: String) async throws -> OnyxAPI.PreviewTarget {
        try await api.presignPoster(contentType: contentType)
    }

    public func recordThumbnail(fileId: String, thumbnailKey: String, posterKey: String?, thumbSizes: [String],
                                media: MediaFacts, placeholder: Placeholder?) async throws -> FileItem {
        try await api.recordThumbnail(fileId: fileId, thumbnailKey: thumbnailKey, posterKey: posterKey,
                                      thumbSizes: thumbSizes, media: media, placeholder: placeholder)
    }

    /// As the browser's putToBucket: the type, and the Cache-Control the
    /// presign route asked for, which storage keeps with the object.
    public func put(_ data: Data, to url: URL, contentType: String, cacheControl: String?) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        if let cacheControl { request.setValue(cacheControl, forHTTPHeaderField: "Cache-Control") }
        let (body, response) = try await session.upload(for: request, from: data)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // Storage's own error is XML; its code is the useful part.
            let text = String(decoding: body.prefix(2048), as: UTF8.self)
            let code = text.range(of: "<Code>(.*?)</Code>", options: .regularExpression).map { String(text[$0]) }
            throw OnyxError.http(status: status == 403 ? 503 : status,
                                 message: "Storage refused the picture (\(code ?? "HTTP \(status)")).")
        }
        sent?(Int64(data.count))
    }

    public func fetch(_ url: URL) async throws -> Data {
        let (data, response) = try await session.data(from: url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw OnyxError.http(status: status == 403 ? 503 : status, message: "Storage refused the thumbnail (HTTP \(status)).")
        }
        received?(Int64(data.count))
        return data
    }

    public func download(_ url: URL, to destination: URL) async throws {
        try await FileDownload.fetch(url, to: destination, session: session, received: received)
    }
}

/// ThumbnailDrawing by ThumbnailRenderer, in the best format this Mac writes.
public struct ThumbnailRendering: ThumbnailDrawing {
    public let format: PreviewFormat

    public init(format: PreviewFormat = .best) { self.format = format }

    public func video(_ url: URL, mime: String?) async throws -> PreviewSet {
        try await ThumbnailRenderer.video(url, mime: mime, format: format)
    }

    public func image(_ file: URL, bytes: Int64?, mime: String?, name: String) async throws -> PreviewSet {
        let hint = UTType(filenameExtension: (name as NSString).pathExtension)?.identifier
        return try ThumbnailRenderer.image(file, bytes: bytes, mime: mime, name: name, typeHint: hint, format: format)
    }
}
