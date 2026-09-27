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
    /// Resuming a large upload: the server's id for it.
    public var multipartId: String?
    public var state: State
    public var attempts: Int
    public var lastError: String?
    /// The file row, once recorded.
    public var fileId: String?

    public var path: String { folder.isEmpty ? "/\(name)" : "/\(folder)/\(name)" }
}

/// What the queue needs from the network — OnyxAPI and URLSession in the
/// app, a stub in tests.
public protocol UploadTransport: Sendable {
    func presign(_ job: UploadJob) async throws -> OnyxAPI.PresignedPut
    func startMultipart(_ job: UploadJob) async throws -> OnyxAPI.MultipartUpload
    func signParts(uploadId: String, parts: [Int]) async throws -> [Int: URL]
    func multipartStatus(uploadId: String) async throws -> OnyxAPI.MultipartStatus
    func completeMultipart(uploadId: String) async throws -> OnyxAPI.CompletedUpload
    func record(_ job: UploadJob, key: String, publicUrl: String?) async throws -> OnyxAPI.RecordedFile
    /// PUT `length` bytes of `file` from `offset` to a presigned URL.
    func put(_ file: URL, offset: Int64, length: Int64, to url: URL, contentType: String?,
             progress: @escaping @Sendable (Int64) -> Void) async throws
}

/// Uploads, one after another in pairs, surviving a restart of the app and
/// a network that comes and goes. The web's own flow (OnyxAPI.Writes): a
/// small file in one presigned PUT, a large one in parts, then recorded.
///
/// A failure the server means (403: this account may not add to the drive;
/// 413: over a quota) fails the job at once, with the server's sentence; one
/// it does not (no network, a 5xx, storage timing out) is retried with
/// backoff, a large upload picking up at the parts the bucket already has.
public actor UploadQueue {
    public static let multipartThreshold: Int64 = 64 << 20
    static let concurrency = 2
    static let maxAttempts = 12

    private let directory: URL
    private let transport: any UploadTransport
    private var jobs: [UUID: UploadJob] = [:]
    private var running: [UUID: Task<Void, Never>] = [:]
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

    public init(directory: URL, transport: any UploadTransport,
                sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1e9)) }) throws {
        self.directory = directory
        self.transport = transport
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
    /// copied, when it is on the same disk) and starts it.
    @discardableResult
    public func enqueue(from source: URL, scope: String, filespaceId: String?, folder: String,
                        name: String, mime: String) throws -> UploadJob {
        let id = UUID()
        let staged = directory.appendingPathComponent("files").appendingPathComponent(id.uuidString)
        do {
            try FileManager.default.moveItem(at: source, to: staged)
        } catch {
            try FileManager.default.copyItem(at: source, to: staged)
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: staged.path)[.size] as? NSNumber)?.int64Value ?? 0
        let job = UploadJob(id: id, scope: scope, filespaceId: filespaceId, folder: folder, name: name,
                            staged: staged.path, size: size, mime: mime, multipartId: nil,
                            state: .queued, attempts: 0, lastError: nil, fileId: nil)
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
    public func retarget(_ id: UUID, folder: String, name: String) {
        guard var job = jobs[id], job.fileId == nil else { return }
        job.folder = folder
        job.name = name
        jobs[id] = job
        save()
        onChange?(job)
    }

    /// Deleted in Finder before it finished: it never arrives.
    public func cancel(_ id: UUID) {
        running.removeValue(forKey: id)?.cancel()
        guard let job = jobs.removeValue(forKey: id) else { return }
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
        for job in waiting.prefix(max(0, Self.concurrency - running.count)) {
            running[job.id] = Task { await self.run(job.id) }
        }
    }

    private func run(_ id: UUID) async {
        defer {
            running[id] = nil
            pump()
        }
        while var job = jobs[id], job.state == .queued || job.state == .uploading {
            job.state = .uploading
            job.attempts += 1
            update(job)
            do {
                let file = try await upload(job)
                guard var done = jobs[id] else { return }
                done.state = .done
                done.fileId = file.id
                done.lastError = nil
                recorded[id] = file.id
                retained[id] = done.staged
                jobs[id] = nil
                save()
                onChange?(done)
                return
            } catch is CancellationError {
                return
            } catch {
                guard var failed = jobs[id] else { return }
                failed.lastError = error.localizedDescription
                if Self.isPermanent(error) || failed.attempts >= Self.maxAttempts {
                    failed.state = .failed
                    update(failed)
                    return
                }
                failed.state = .queued
                update(failed)
                // 2, 4, 8 … seconds, at most five minutes.
                await sleep(min(300, pow(2, Double(failed.attempts))))
                if Task.isCancelled { return }
            }
        }
    }

    private func upload(_ job: UploadJob) async throws -> OnyxAPI.RecordedFile {
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
            return try await transport.record(job, key: presigned.key, publicUrl: presigned.publicUrl)
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
        let status = try await transport.multipartStatus(uploadId: uploadId)
        if partSize == 0 {
            // Resumed: the plan is the one the server made at the start.
            partSize = status.partSize
            partCount = status.partCount
        }
        let done = status.done
        var sentBefore = Int64(done.count) * partSize
        setProgress(id, sentBefore)
        let missing = (1...max(1, partCount)).filter { !done.contains($0) }
        for batch in stride(from: 0, to: missing.count, by: 16).map({ Array(missing[$0..<min($0 + 16, missing.count)]) }) {
            let urls = try await transport.signParts(uploadId: uploadId, parts: batch)
            for part in batch {
                try Task.checkCancellation()
                guard let url = urls[part] else { throw OnyxError.decoding("part \(part) was not signed") }
                let offset = Int64(part - 1) * partSize
                let length = min(partSize, job.size - offset)
                let base = sentBefore
                try await transport.put(file, offset: offset, length: length, to: url, contentType: nil) { sent in
                    Task { await self.setProgress(id, base + sent) }
                }
                sentBefore += length
            }
        }
        let completed = try await transport.completeMultipart(uploadId: uploadId)
        return try await transport.record(job, key: completed.key, publicUrl: completed.publicUrl)
    }

    static func isPermanent(_ error: Error) -> Bool {
        guard case let OnyxError.http(status, _) = error else { return false }
        return status == 400 || status == 403 || status == 404 || status == 409 || status == 410 || status == 413
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
