import Foundation

/// A file copied onto a drive in Finder, on its way to Onyx.
public struct UploadJob: Codable, Identifiable, Sendable, Equatable {
    public enum State: String, Codable, Sendable {
        case queued, uploading, done, failed
    }

    public let id: UUID
    /// The drive's SyncDomain identifier ("drive.<id>" or "library").
    public var scope: String
    public var filespaceId: String?
    /// Its folder within the drive ("" for the top level), and its name.
    public var folder: String
    public var name: String
    /// The bytes, in the queue's own folder: they stay until they are on
    /// the server, whatever happens to the file in Finder meanwhile.
    public var staged: String
    public var size: Int64
    public var mime: String
    /// Saved over a file already there: that file's id. These bytes become
    /// its contents — the same file on the web, its tags, comments and
    /// links kept — rather than a file of their own.
    public var replaceOf: String? = nil
    /// Resuming a large upload: the server's id for it.
    public var multipartId: String?
    /// In storage already (an attempt got that far, and its answer may have
    /// been lost): what is left is to record it, or swap it in.
    public var uploadedKey: String? = nil
    public var uploadedUrl: String? = nil
    public var state: State
    public var attempts: Int
    public var lastError: String?
    /// The file row, once recorded.
    public var fileId: String?
    /// When the server made the change, once it has: the mirror shows it
    /// once its entry is this new.
    public var changedAt: Date? = nil
    /// The file's own dates where it was written (Finder's copy keeps a
    /// file's), sent when it is recorded; nil when the writer did not say.
    public var fileCreatedAt: Date? = nil
    public var fileModifiedAt: Date? = nil

    public var path: String { folder.isEmpty ? "/\(name)" : "/\(folder)/\(name)" }
}

/// What the queue needs from the network — OnyxAPI and URLSession in the
/// app, a stub in tests. `presign` and `startMultipart` ask for a new
/// file's key, or, for a job with `replaceOf`, new contents' for that file.
public protocol UploadTransport: Sendable {
    func presign(_ job: UploadJob) async throws -> OnyxAPI.PresignedPut
    func startMultipart(_ job: UploadJob) async throws -> OnyxAPI.MultipartUpload
    func signParts(uploadId: String, parts: [Int]) async throws -> [Int: URL]
    func multipartStatus(uploadId: String) async throws -> OnyxAPI.MultipartStatus
    func completeMultipart(uploadId: String) async throws -> OnyxAPI.CompletedUpload
    func abortMultipart(uploadId: String) async throws
    func record(_ job: UploadJob, key: String, publicUrl: String?) async throws -> OnyxAPI.RecordedFile
    /// The bytes at `key` become the contents of `job.replaceOf`.
    func replaceContent(_ job: UploadJob, key: String) async throws -> OnyxAPI.RecordedFile
    /// PUT `length` bytes of `file` from `offset` to a presigned URL.
    func put(_ file: URL, offset: Int64, length: Int64, to url: URL, contentType: String?,
             progress: @escaping @Sendable (Int64) -> Void) async throws
}

/// Uploads, several at once, surviving a restart of the app and a network
/// that comes and goes. The web's own flow (OnyxAPI.Writes): a
/// small file in one presigned PUT, a large one in parts, then recorded —
/// or, for a file saved over, swapped in as that file's new contents.
///
/// A failure the server means (403: this account may not add to the drive;
/// 413: over a quota) fails the job at once, with the server's sentence; one
/// it does not (no network, a 5xx, storage timing out) is retried with
/// backoff, a large upload picking up at the parts the bucket already has,
/// and bytes already in storage are never sent twice.
public actor UploadQueue {
    public static let multipartThreshold: Int64 = 64 << 20
    /// Files at once. A small one is a presign, one PUT from the file on disk
    /// and a record — mostly waiting on the network, little of this Mac's —
    /// so a folder of photos goes four at a time.
    static let concurrency = 4
    /// Of those, large ones (in parts) at once: each sends its own parts in
    /// parallel already.
    static let largeConcurrency = 2
    /// A large file's parts in flight at once. One after another, each part
    /// waited out a round trip to storage before the next began, which on a
    /// fast line is most of the time; in parallel the line stays full. Each
    /// is read into memory (8 MB at the server's usual part size), so at
    /// most largeConcurrency × this — 64 MB — while two large files go up,
    /// and nothing when none does.
    static let partConcurrency = 4
    static let maxAttempts = 12

    private let directory: URL
    private let transport: any UploadTransport
    /// Seconds a new job waits before anything is sent (UploadQueue.run).
    private let settle: Double
    private var jobs: [UUID: UploadJob] = [:]
    /// The task sending each job, under a token of its own: a job started
    /// over gets a new task, and the old one, still unwinding, changes
    /// nothing.
    private var running: [UUID: (token: UUID, task: Task<Void, Never>)] = [:]
    private var progress: [UUID: Int64] = [:]
    /// Jobs finished this run → the file each became. The writer asks this
    /// rather than waiting to be told, so a rename or delete that comes
    /// right as an upload finishes is applied to the file, not lost.
    private var recorded: [UUID: String] = [:]
    /// Finished jobs whose bytes are still read from here: a file the server
    /// has now, but the mirror does not show yet, is still read by Finder
    /// from this copy. Removed when the writer lets go of it (`release`).
    private var retained: [UUID: String] = [:]
    private var onChange: (@Sendable (UploadJob) -> Void)?
    private var sleep: @Sendable (Double) async -> Void

    public init(directory: URL, transport: any UploadTransport, settle: Double = 2,
                sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1e9)) }) throws {
        self.directory = directory
        self.transport = transport
        self.settle = settle
        self.sleep = sleep
        let files = directory.appendingPathComponent("files")
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: directory.appendingPathComponent("jobs.json")),
           let saved = try? JSONDecoder().decode([UploadJob].self, from: data) {
            for var job in saved where job.state != .done {
                // Interrupted mid-upload: it starts again (resuming its parts).
                if job.state == .uploading { job.state = .queued }
                jobs[job.id] = job
            }
        }
        // Copies kept for reading by the last run: nothing reads them now.
        let wanted = Set(jobs.values.map { URL(fileURLWithPath: $0.staged).lastPathComponent })
        for name in (try? FileManager.default.contentsOfDirectory(atPath: files.path)) ?? [] where !wanted.contains(name) {
            try? FileManager.default.removeItem(at: files.appendingPathComponent(name))
        }
    }

    /// Told of every change to a job (for the menu bar, and the bridge's
    /// pending entries).
    public func observe(_ handler: @escaping @Sendable (UploadJob) -> Void) { onChange = handler }

    /// Takes the file at `source` into the queue's own folder (moved, not
    /// copied, when it is on the same disk) and starts it. `replaceOf`: the
    /// file it was saved over, whose contents it becomes.
    @discardableResult
    public func enqueue(from source: URL, scope: String, filespaceId: String?, folder: String,
                        name: String, mime: String, replaceOf: String? = nil,
                        created: Date? = nil, modified: Date? = nil) throws -> UploadJob {
        let id = UUID()
        let staged = directory.appendingPathComponent("files").appendingPathComponent(id.uuidString)
        do {
            try FileManager.default.moveItem(at: source, to: staged)
        } catch {
            try FileManager.default.copyItem(at: source, to: staged)
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: staged.path)[.size] as? NSNumber)?.int64Value ?? 0
        let job = UploadJob(id: id, scope: scope, filespaceId: filespaceId, folder: folder, name: name,
                            staged: staged.path, size: size, mime: mime, replaceOf: replaceOf, multipartId: nil,
                            state: .queued, attempts: 0, lastError: nil, fileId: nil,
                            fileCreatedAt: created, fileModifiedAt: modified)
        jobs[id] = job
        save()
        onChange?(job)
        pump()
        return job
    }

    /// Start whatever is waiting (at launch, or after a sign-in).
    public func resume() { pump() }

    public func all() -> [UploadJob] { jobs.values.sorted { $0.path < $1.path } }

    public func job(_ id: UUID) -> UploadJob? { jobs[id] }

    /// The file a finished job became, if it has.
    public func fileId(for id: UUID) -> String? { recorded[id] }

    /// A finished job's copy is no longer read: it goes.
    public func release(_ id: UUID) {
        guard let staged = retained.removeValue(forKey: id) else { return }
        try? FileManager.default.removeItem(atPath: staged)
    }

    /// Bytes sent so far, for progress.
    public func sent(_ id: UUID) -> Int64 { progress[id] ?? 0 }

    /// A job not yet done whose file is at `path` in `scope` — a rename in
    /// Finder of a file still uploading moves where it will land.
    public func pending(scope: String, path: String) -> UploadJob? {
        jobs.values.first { $0.scope == scope && $0.path == path && $0.state != .done }
    }

    /// Renamed or moved in Finder before it reached the server: it lands at
    /// the new place instead. (Once recorded, a rename is the server's.)
    ///
    /// `replacing`: the file at the new place it was moved over, whose
    /// contents it becomes (how an app saves: a new copy, moved over the
    /// old). A key is issued for one or the other — a new file's cannot be
    /// swapped into a file, nor the reverse — so an upload under way as the
    /// other kind starts again.
    public func retarget(_ id: UUID, folder: String, name: String, replacing: String?) {
        guard var job = jobs[id], job.fileId == nil else { return }
        job.folder = folder
        job.name = name
        if job.replaceOf != replacing {
            job.replaceOf = replacing
            // Waiting its moment, or between attempts, with nothing sent:
            // the next attempt simply is the other kind.
            if job.state == .uploading || job.multipartId != nil || job.uploadedKey != nil {
                running.removeValue(forKey: id)?.task.cancel()
                abortLater(forget(&job))
                job.state = .queued
                job.attempts = 0
                progress[id] = nil
            }
        }
        jobs[id] = job
        save()
        onChange?(job)
        pump()
    }

    /// Deleted in Finder before it finished: it never arrives.
    public func cancel(_ id: UUID) {
        running.removeValue(forKey: id)?.task.cancel()
        guard var job = jobs.removeValue(forKey: id) else { return }
        abortLater(forget(&job))
        try? FileManager.default.removeItem(atPath: job.staged)
        save()
    }

    /// Try a failed one again (the menu's "Retry").
    public func retry(_ id: UUID) {
        guard var job = jobs[id], job.state == .failed else { return }
        job.state = .queued
        job.attempts = 0
        job.lastError = nil
        jobs[id] = job
        save()
        onChange?(job)
        pump()
    }

    // MARK: - Running

    private func pump() {
        let waiting = jobs.values.filter { $0.state == .queued && running[$0.id] == nil }
            .sorted { $0.id.uuidString < $1.id.uuidString }
        var free = Self.concurrency - running.count
        var largeFree = Self.largeConcurrency - running.keys.filter { jobs[$0].map(Self.sendsParts) ?? false }.count
        for job in waiting where free > 0 {
            if Self.sendsParts(job) {
                // A large one waits for another to finish; a small one
                // behind it may go meanwhile.
                guard largeFree > 0 else { continue }
                largeFree -= 1
            }
            free -= 1
            let token = UUID()
            running[job.id] = (token, Task { await self.run(job.id, token: token) })
        }
    }

    /// Whether a job still has parts to send: large, and not in storage yet.
    static func sendsParts(_ job: UploadJob) -> Bool {
        job.size >= multipartThreshold && job.uploadedKey == nil
    }

    private func run(_ id: UUID, token: UUID) async {
        defer {
            if running[id]?.token == token { running[id] = nil }
            pump()
        }
        if settle > 0, jobs[id]?.attempts == 0 {
            // A moment before anything is sent: an app saving a document
            // writes a new copy, then moves it over the old one — and the
            // move decides what this is (a new file, or new contents for
            // that one). Deleted in that moment, nothing is sent at all.
            await sleep(settle)
        }
        while running[id]?.token == token, !Task.isCancelled,
              var job = jobs[id], job.state == .queued || job.state == .uploading {
            job.state = .uploading
            job.attempts += 1
            update(job)
            do {
                let file = try await upload(id, token: token)
                guard running[id]?.token == token, var done = jobs[id] else { return }
                done.state = .done
                done.fileId = file?.id
                done.changedAt = file?.updatedAt?.date
                done.lastError = nil
                if let file { recorded[id] = file.id }
                retained[id] = done.staged
                jobs[id] = nil
                save()
                onChange?(done)
                return
            } catch is CancellationError {
                return
            } catch {
                guard running[id]?.token == token, var failed = jobs[id] else { return }
                failed.lastError = error.localizedDescription
                var abandoned: String?
                switch Self.next(after: error, replacing: failed.replaceOf != nil) {
                case .fail:
                    failed.state = .failed
                    update(failed)
                    return
                case .again:
                    break
                case .anew:
                    abandoned = forget(&failed)
                case .asNewFile:
                    // The file it was saved over is gone from the web (deleted
                    // meanwhile): these bytes become a file of their own, where
                    // Finder shows them.
                    abandoned = forget(&failed)
                    failed.replaceOf = nil
                }
                guard failed.attempts < Self.maxAttempts else {
                    failed.state = .failed
                    update(failed)
                    return
                }
                // Saved before anything is awaited: a rename meanwhile is
                // made to this, not lost under it.
                failed.state = .queued
                update(failed)
                if let abandoned { try? await transport.abortMultipart(uploadId: abandoned) }
                // 2, 4, 8 … seconds, at most five minutes.
                await sleep(min(300, pow(2, Double(failed.attempts))))
            }
        }
    }

    /// The bytes to storage, if they are not there yet; then recorded as a
    /// file, or swapped in as `replaceOf`'s new contents. Nil: recorded, but
    /// by an attempt whose answer was lost — the mirror knows its id.
    private func upload(_ id: UUID, token: UUID) async throws -> OnyxAPI.RecordedFile? {
        guard let first = jobs[id] else { throw CancellationError() }
        if first.uploadedKey == nil {
            let (key, url) = try await send(first)
            guard running[id]?.token == token, var sent = jobs[id] else { throw CancellationError() }
            sent.uploadedKey = key
            sent.uploadedUrl = url
            update(sent)
        }
        // As it is now: renamed while its bytes went up, it lands at the new name.
        guard let job = jobs[id], let key = job.uploadedKey else { throw CancellationError() }
        if job.replaceOf != nil {
            return try await transport.replaceContent(job, key: key)
        }
        do {
            return try await transport.record(job, key: key, publicUrl: job.uploadedUrl)
        } catch let refusal as OnyxAPI.Refusal where refusal.status == 409 && refusal.code == nil {
            // "That stored object already belongs to a file": this key's own,
            // recorded by the attempt before, whose answer never came back.
            return nil
        }
    }

    /// One presigned PUT, or parts; the key the bytes are at.
    private func send(_ job: UploadJob) async throws -> (key: String, url: String?) {
        let file = URL(fileURLWithPath: job.staged)
        guard FileManager.default.fileExists(atPath: job.staged) else {
            throw OnyxError.http(status: 410, message: "The copy of “\(job.name)” waiting to upload is gone.")
        }
        let id = job.id
        if job.size < Self.multipartThreshold {
            let presigned = try await transport.presign(job)
            try await transport.put(file, offset: 0, length: job.size, to: presigned.putUrl, contentType: job.mime) { sent in
                Task { await self.setProgress(id, sent) }
            }
            return (presigned.key, presigned.publicUrl)
        }

        // In parts: the upload's id is kept with the job, so a restart asks
        // the bucket what it already has and sends only the rest.
        var uploadId = job.multipartId
        var partSize: Int64 = 0
        var partCount = 0
        if uploadId == nil {
            let started = try await transport.startMultipart(job)
            uploadId = started.id
            partSize = started.partSize
            partCount = started.partCount
            if var current = jobs[id] {
                current.multipartId = started.id
                update(current)
            }
        }
        guard let uploadId else { throw OnyxError.decoding("no upload id") }
        let status = try await Self.expiring { try await self.transport.multipartStatus(uploadId: uploadId) }
        if partSize == 0 {
            // Resumed: the plan is the one the server made at the start.
            partSize = status.partSize
            partCount = status.partCount
        }
        let done = status.done
        let tally = PartTally(sent: Int64(done.count) * partSize)
        setProgress(id, tally.total)
        let missing = (1...max(1, partCount)).filter { !done.contains($0) }
        let transport = self.transport
        let size = job.size
        for batch in stride(from: 0, to: missing.count, by: 16).map({ Array(missing[$0..<min($0 + 16, missing.count)]) }) {
            let urls = try await Self.expiring { try await self.transport.signParts(uploadId: uploadId, parts: batch) }
            // partConcurrency at a time. A part that fails stops the rest of
            // this attempt; the next asks storage which parts it has, and
            // sends only the others.
            try await withThrowingTaskGroup(of: Void.self) { group in
                var next = batch.makeIterator()
                var inFlight = 0
                while true {
                    while inFlight < Self.partConcurrency, let part = next.next() {
                        try Task.checkCancellation()
                        guard let url = urls[part] else { throw OnyxError.decoding("part \(part) was not signed") }
                        let offset = Int64(part - 1) * partSize
                        let length = min(partSize, size - offset)
                        group.addTask {
                            try await transport.put(file, offset: offset, length: length, to: url, contentType: nil) { sent in
                                let total = tally.sending(part, sent)
                                Task { await self.setProgress(id, total) }
                            }
                            await self.setProgress(id, tally.finished(part, length))
                        }
                        inFlight += 1
                    }
                    guard inFlight > 0 else { break }
                    try await group.next()
                    inFlight -= 1
                }
            }
        }
        let completed = try await Self.expiring { try await self.transport.completeMultipart(uploadId: uploadId) }
        return (completed.key, completed.publicUrl)
    }

    /// A large upload the server no longer knows (aborted after a week
    /// untouched): not a refusal, but a reason to start again.
    struct UploadExpired: Error {}

    private static func expiring<T>(_ call: () async throws -> T) async throws -> T {
        do { return try await call() } catch {
            if status(of: error)?.status == 404 { throw UploadExpired() }
            throw error
        }
    }

    /// Whatever was sent is let go, so the next attempt starts again from
    /// the bytes. Returns a large upload still open, whose parts are to be
    /// aborted.
    private func forget(_ job: inout UploadJob) -> String? {
        let open = job.uploadedKey == nil ? job.multipartId : nil
        job.multipartId = nil
        job.uploadedKey = nil
        job.uploadedUrl = nil
        return open
    }

    private func abortLater(_ upload: String?) {
        guard let upload else { return }
        let transport = self.transport
        Task { try? await transport.abortMultipart(uploadId: upload) }
    }

    enum Next: Equatable {
        /// The server means it: the job fails, with its sentence.
        case fail
        /// Try again as it is (later).
        case again
        /// Try again from the bytes: the key it had is no good now.
        case anew
        /// Try again from the bytes, as a file of its own.
        case asNewFile
    }

    static func next(after error: Error, replacing: Bool) -> Next {
        if error is UploadExpired { return .anew }
        guard let (status, code) = status(of: error) else { return .again } // no network, a timeout
        switch (status, code) {
        case (403, "not_issued"), (409, "moved"), (409, "conflict"), (409, "changed"), (409, "version_mismatch"):
            // A key too old or used, or a file moved while this went up: a new key.
            return .anew
        case (409, "not_uploaded"):
            return .again
        case (404, _) where replacing:
            return .asNewFile
        default:
            return isPermanent(status) ? .fail : .again
        }
    }

    static func status(of error: Error) -> (status: Int, code: String?)? {
        switch error {
        case let refusal as OnyxAPI.Refusal: return (refusal.status, refusal.code)
        case let OnyxError.http(status, _): return (status, nil)
        default: return nil
        }
    }

    static func isPermanent(_ error: Error) -> Bool {
        guard let (status, _) = status(of: error) else { return false }
        return isPermanent(status)
    }

    static func isPermanent(_ status: Int) -> Bool {
        status == 400 || status == 403 || status == 404 || status == 409 || status == 410 || status == 413
    }

    private func setProgress(_ id: UUID, _ sent: Int64) { progress[id] = sent }

    private func update(_ job: UploadJob) {
        jobs[job.id] = job
        save()
        onChange?(job)
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(Array(jobs.values)) else { return }
        try? data.write(to: directory.appendingPathComponent("jobs.json"), options: .atomic)
    }
}

/// A large upload's bytes sent: the parts done, and how far each part in
/// flight has got — several at once, so each reports into this rather than
/// adding to a running total of its own.
final class PartTally: @unchecked Sendable {
    private let lock = NSLock()
    private var done: Int64
    private var inFlight: [Int: Int64] = [:]

    init(sent: Int64) { done = sent }

    var total: Int64 { lock.withLock { done + inFlight.values.reduce(0, +) } }

    /// `part` has sent `bytes` so far. → the total now.
    func sending(_ part: Int, _ bytes: Int64) -> Int64 {
        lock.withLock {
            inFlight[part] = bytes
            return done + inFlight.values.reduce(0, +)
        }
    }

    /// `part` is in storage, all `length` of it. → the total now.
    func finished(_ part: Int, _ length: Int64) -> Int64 {
        lock.withLock {
            inFlight[part] = nil
            done += length
            return done + inFlight.values.reduce(0, +)
        }
    }
}
