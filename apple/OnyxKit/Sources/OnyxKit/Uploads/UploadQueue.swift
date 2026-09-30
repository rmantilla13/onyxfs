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
///
/// Jobs start in the order they came. A new one first waits out its settle
/// moment (`settle`) beside every other, not in one of the four slots: a
/// thousand files copied at once all settle together, then go as fast as
/// the line takes them. It went two files a second when each waited in a
/// slot of its own.
///
/// Every change is on disk before anything is done about it, as one line
/// added to jobs.log; now and then jobs.json is written whole and the log
/// emptied (`compact`). Written whole on every change, a thousand files
/// copied in cost some 700 MB of writing.
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
    /// Parts signed in one request to the server. The next batch is asked
    /// for while this one's parts are sending, so the line never stops to
    /// wait for signatures (`send`).
    static let signBatch = 16
    static let maxAttempts = 12
    /// jobs.log is folded into jobs.json once it has outgrown the queue it
    /// describes: past twice what jobs.json last took, and past this. So
    /// what is written whole is of the order of what was added since, never
    /// the whole queue again for each change.
    static let logFloor = 256 << 10
    /// And not more often than this, however fast jobs change.
    static let compactInterval: Duration = .seconds(1)
    static let jobsFile = "jobs.json"
    static let logFile = "jobs.log"

    /// What the menu bar says about uploads, asked for in one go.
    public struct Summary: Sendable, Equatable {
        /// Jobs not done yet: waiting, sending, or between tries.
        public var waiting = 0
        public var sentBytes: Int64 = 0
        public var totalBytes: Int64 = 0
        /// The name of one on its way, for "Uploading Take 1.mov".
        public var current: String?
        public var failed: [UploadJob] = []

        public init() {}

        public var fraction: Double { totalBytes > 0 ? min(1, Double(sentBytes) / Double(totalBytes)) : 0 }
    }

    private let directory: URL
    private let transport: any UploadTransport
    /// Seconds a new job waits before anything is sent: see `settleLater`.
    private let settle: Double
    private var jobs: [UUID: UploadJob] = [:]
    /// The task sending each job, under a token of its own: a job started
    /// over gets a new task, and the old one, still unwinding, changes
    /// nothing.
    private var running: [UUID: (token: UUID, task: Task<Void, Never>)] = [:]
    /// Bytes sent so far, for the jobs still here that have sent any.
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

    /// Every job in the order it came, for jobs.json and `all`: a restart
    /// goes on in the same order. Ids of jobs that have left stay until the
    /// next `compact`.
    private var arrival: [UUID] = []
    /// Each job waiting out its settle moment, and when that moment ends.
    /// A job with none here has settled (or never had to), and may start.
    private var notBefore: [UUID: ContinuousClock.Instant] = [:]
    /// Jobs waiting out their settle moment, soonest first — each waits the
    /// same, so in the order they came. An entry whose job has left, or was
    /// started over (a later moment in `notBefore`), is passed over.
    private var settling = Line<(id: UUID, at: ContinuousClock.Instant)>()
    /// Jobs whose moment has passed, in order, each waiting for a slot.
    private var ready = Line<UUID>()
    /// Large ones that came up while both large slots were taken: they go
    /// first when one frees, and a small one behind them goes meanwhile.
    private var heldLarge = Line<UUID>()
    /// The one timer: for the soonest settle moment still to come.
    private var timer: (at: ContinuousClock.Instant, task: Task<Void, Never>)?

    /// Kept as jobs change, so the menu bar's summary counts nothing.
    private var waitingCount = 0
    private var waitingBytes: Int64 = 0
    private var failedIDs = Set<UUID>()

    /// jobs.log, open for adding to while the queue lives; -1 until first used.
    private var log: Int32 = -1
    /// Bytes of whole lines in jobs.log.
    private var logBytes = 0
    /// What jobs.json took when last written.
    private var snapshotBytes = 0
    private var compactedAt: ContinuousClock.Instant?

    /// What the queue has written, for tests and the bench.
    struct DiskWrites: Sendable, Equatable {
        /// jobs.json written whole.
        var snapshots = 0
        var snapshotBytes = 0
        /// Lines added to jobs.log.
        var appends = 0
        var appendBytes = 0
    }
    private(set) var disk = DiskWrites()

    public init(directory: URL, transport: any UploadTransport, settle: Double = 2,
                sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1e9)) }) throws {
        self.directory = directory
        self.transport = transport
        self.settle = settle
        self.sleep = sleep
        let files = directory.appendingPathComponent("files")
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        let (saved, logged) = Self.load(directory)
        var jobs: [UUID: UploadJob] = [:]
        var arrival: [UUID] = []
        var ready = Line<UUID>()
        var waitingCount = 0, waitingBytes: Int64 = 0, failedIDs = Set<UUID>()
        for var job in saved where job.state != .done && jobs[job.id] == nil {
            // Interrupted mid-upload: it starts again (resuming its parts).
            if job.state == .uploading { job.state = .queued }
            jobs[job.id] = job
            arrival.append(job.id)
            switch job.state {
            case .queued, .uploading:
                // No settle moment: what it was for (an app's save, the move
                // that follows it) cannot reach a job from before a restart.
                waitingCount += 1
                waitingBytes += job.size
                ready.append(job.id)
            case .failed:
                failedIDs.insert(job.id)
            case .done:
                break
            }
        }
        self.jobs = jobs
        self.arrival = arrival
        self.ready = ready
        self.waitingCount = waitingCount
        self.waitingBytes = waitingBytes
        self.failedIDs = failedIDs
        if let whole = logged {
            // Folded in now, so jobs.log starts empty and stays short.
            let logURL = directory.appendingPathComponent(Self.logFile)
            let list = arrival.compactMap { jobs[$0] }
            if let data = try? JSONEncoder().encode(list),
               (try? data.write(to: directory.appendingPathComponent(Self.jobsFile), options: .atomic)) != nil {
                try? FileManager.default.removeItem(at: logURL)
                snapshotBytes = data.count
                disk.snapshots = 1
                disk.snapshotBytes = data.count
            } else {
                // Kept, to be added to: it holds what jobs.json lacks. A line
                // a crash cut short goes first, or the next would join it.
                _ = logURL.withUnsafeFileSystemRepresentation { $0.map { truncate($0, off_t(whole)) } }
                logBytes = whole
            }
        }
        // Copies kept for reading by the last run: nothing reads them now.
        let wanted = Set(jobs.values.map { URL(fileURLWithPath: $0.staged).lastPathComponent })
        for name in (try? FileManager.default.contentsOfDirectory(atPath: files.path)) ?? [] where !wanted.contains(name) {
            try? FileManager.default.removeItem(at: files.appendingPathComponent(name))
        }
    }

    deinit {
        if log >= 0 { close(log) }
        timer?.task.cancel()
    }

    /// Told of every change to a job (for the menu bar, and the bridge's
    /// pending entries).
    public func observe(_ handler: @escaping @Sendable (UploadJob) -> Void) { onChange = handler }

    /// Takes the file at `source` into the queue's own folder (moved, not
    /// copied, when it is on the same disk) and starts it. `replaceOf`: the
    /// file it was saved over, whose contents it becomes.
    ///
    /// On disk before it returns: the bridge answers Finder's copy with it,
    /// and a job lost to a crash after that would be a file that never
    /// arrives, its bytes swept away at the next launch.
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
        arrival.append(id)
        update(job)
        settleLater(id)
        pump()
        return job
    }

    /// Start whatever is waiting (at launch, or after a sign-in).
    public func resume() { pump() }

    /// Every job still here, in the order they came.
    public func all() -> [UploadJob] { arrival.compactMap { jobs[$0] } }

    public func job(_ id: UUID) -> UploadJob? { jobs[id] }

    /// The file a finished job became, if it has.
    public func fileId(for id: UUID) -> String? { recorded[id] }

    /// A finished job's copy is no longer read: it goes.
    public func release(_ id: UUID) {
        recorded[id] = nil
        guard let staged = retained.removeValue(forKey: id) else { return }
        try? FileManager.default.removeItem(atPath: staged)
    }

    /// Bytes sent so far, for progress.
    public func sent(_ id: UUID) -> Int64 { progress[id] ?? 0 }

    /// How many are on their way, how far they have got, and which did not
    /// make it: one question, however many jobs there are. The menu bar
    /// asked for every job, then for each one's progress in turn, on every
    /// change to any of them.
    public func summary() -> Summary {
        var summary = Summary()
        summary.waiting = waitingCount
        summary.totalBytes = waitingBytes
        for (id, sent) in progress where jobs[id].map(Self.isWaiting) ?? false { summary.sentBytes += sent }
        summary.current = running.keys.lazy.compactMap { self.jobs[$0]?.name }.first
            ?? arrival.lazy.compactMap { self.jobs[$0] }.first(where: Self.isWaiting)?.name
        summary.failed = failedIDs.compactMap { jobs[$0] }.sorted { $0.path < $1.path }
        return summary
    }

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
    /// other kind starts again, with a settle moment of its own.
    public func retarget(_ id: UUID, folder: String, name: String, replacing: String?) {
        guard var job = jobs[id], job.fileId == nil else { return }
        job.folder = folder
        job.name = name
        var startedOver = false
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
                startedOver = true
            }
        }
        update(job)
        if startedOver { settleLater(id) }
        pump()
    }

    /// Deleted in Finder before it finished: it never arrives.
    public func cancel(_ id: UUID) {
        running.removeValue(forKey: id)?.task.cancel()
        guard var job = remove(id) else { return }
        abortLater(forget(&job))
        try? FileManager.default.removeItem(atPath: job.staged)
        pump()
    }

    /// Try a failed one again (the menu's "Retry"): at once, since nothing
    /// Finder does now can make it another kind of upload.
    public func retry(_ id: UUID) {
        guard var job = jobs[id], job.state == .failed else { return }
        job.state = .queued
        job.attempts = 0
        job.lastError = nil
        update(job)
        notBefore[id] = nil
        ready.append(id)
        pump()
    }

    // MARK: - Running

    /// A new job, or one started over as the other kind, waits `settle`
    /// before anything is sent: an app saving a document writes a new copy,
    /// then moves it over the old one — and the move decides what this is
    /// (a new file, or new contents for that one). Deleted in that moment,
    /// nothing is sent at all. It waits outside the four slots, so every
    /// job copied in at once waits out the same moment together.
    private func settleLater(_ id: UUID) {
        let at = ContinuousClock.now + .seconds(settle)
        notBefore[id] = at
        settling.append((id, at))
    }

    /// Starts what can start: each job past its settle moment, in the order
    /// they came, while there are slots. `deadline`: the moment the timer
    /// was set for, and has reached — every job settled by then is due,
    /// whatever the clock says (a test's timer is let go by hand).
    private func pump(dueBy deadline: ContinuousClock.Instant? = nil) {
        let now = ContinuousClock.now
        let due = deadline.map { max($0, now) } ?? now
        while let next = settling.first, next.at <= due {
            settling.removeFirst()
            guard notBefore[next.id] == next.at else { continue }
            notBefore[next.id] = nil
            ready.append(next.id)
        }
        arm()
        var free = Self.concurrency - running.count
        guard free > 0 else { return }
        var largeFree = Self.largeConcurrency - running.keys.filter { jobs[$0].map(Self.sendsParts) ?? false }.count
        // A large one that had to wait for a slot of its own goes first.
        while free > 0, largeFree > 0, let id = heldLarge.removeFirst() {
            guard startable(id) != nil else { continue }
            start(id)
            free -= 1
            largeFree -= 1
        }
        while free > 0, let id = ready.removeFirst() {
            guard let job = startable(id) else { continue }
            if Self.sendsParts(job) {
                // A large one waits for another to finish; a small one
                // behind it may go meanwhile.
                guard largeFree > 0 else {
                    heldLarge.append(id)
                    continue
                }
                largeFree -= 1
            }
            start(id)
            free -= 1
        }
    }

    /// The job, if it is waiting to start and may: queued, not running, not
    /// waiting out a settle moment. An entry for anything else is stale —
    /// the job left, started, or was started over — and dropped.
    private func startable(_ id: UUID) -> UploadJob? {
        guard let job = jobs[id], job.state == .queued, running[id] == nil, notBefore[id] == nil else { return nil }
        return job
    }

    private func start(_ id: UUID) {
        let token = UUID()
        running[id] = (token, Task { await self.run(id, token: token) })
    }

    /// The one timer, set for the soonest settle moment still to come, or
    /// none when no job is waiting one out.
    private func arm() {
        while let next = settling.first, notBefore[next.id] != next.at { settling.removeFirst() }
        guard let next = settling.first else {
            timer?.task.cancel()
            timer = nil
            return
        }
        if let timer, timer.at <= next.at { return }
        timer?.task.cancel()
        let at = next.at
        let wait = sleep
        timer = (at, Task { [weak self] in
            let left = ContinuousClock.now.duration(to: at)
            if left > .zero { await wait(Self.seconds(left)) }
            guard !Task.isCancelled else { return }
            await self?.fired(at)
        })
    }

    private func fired(_ at: ContinuousClock.Instant) {
        if timer?.at == at { timer = nil }
        pump(dueBy: at)
    }

    static func seconds(_ duration: Duration) -> Double {
        let (seconds, attoseconds) = duration.components
        return Double(seconds) + Double(attoseconds) / 1e18
    }

    static func isWaiting(_ job: UploadJob) -> Bool { job.state == .queued || job.state == .uploading }

    /// Whether a job still has parts to send: large, and not in storage yet.
    static func sendsParts(_ job: UploadJob) -> Bool {
        job.size >= multipartThreshold && job.uploadedKey == nil
    }

    private func run(_ id: UUID, token: UUID) async {
        defer {
            if running[id]?.token == token { running[id] = nil }
            pump()
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
                remove(id)
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
                    progress[id] = nil
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
                    progress[id] = nil
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
            // On disk before the record is asked for: a crash after the
            // server has the file then asks again for this key, and its 409
            // says done. Without the key a restart would send the bytes
            // afresh, under a new key, and record a second file.
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
        let batches = stride(from: 0, to: missing.count, by: Self.signBatch).map {
            Array(missing[$0..<min($0 + Self.signBatch, missing.count)])
        }
        let transport = self.transport
        let size = job.size
        /// Signed URLs for the batch at `index`; none past the last.
        @Sendable func signed(_ index: Int) async throws -> [Int: URL] {
            guard index < batches.count else { return [:] }
            return try await Self.expiring { try await transport.signParts(uploadId: uploadId, parts: batches[index]) }
        }
        // One stream of parts, partConcurrency at a time, from the first
        // missing to the last. Each batch's URLs are asked for while the
        // batch before it sends: waiting for all sixteen to land before
        // asking, the line went idle every 128 MB for a round trip to the
        // server and the slowest part. A part that fails stops the rest of
        // this attempt; the next asks storage which parts it has, and sends
        // only the others.
        try await withThrowingTaskGroup(of: Void.self) { group in
            var inFlight = 0
            var urls = try await signed(0)
            for index in batches.indices {
                // The next batch's URLs, asked for in a task of their own
                // beside the group rather than an `async let` among its
                // children: 0.5.14's drive sync crashed on macOS 27 as a task
                // group's children reported back, and this was the one other
                // place that release mixed the two. Cancelled with this
                // attempt.
                let upcoming = Task { try await signed(index + 1) }
                do {
                    for part in batches[index] {
                        if inFlight == Self.partConcurrency {
                            try await group.next()
                            inFlight -= 1
                        }
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
                } catch {
                    upcoming.cancel()
                    throw error
                }
                do {
                    urls = try await withTaskCancellationHandler {
                        try await upcoming.value
                    } onCancel: {
                        upcoming.cancel()
                    }
                } catch {
                    // The parts already on their way are let land, so the
                    // next attempt need not send them again.
                    try? await group.waitForAll()
                    throw error
                }
            }
            try await group.waitForAll()
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

    /// Only for a job still here: a report from a PUT that outlived its job
    /// would otherwise count bytes for nothing, for good.
    private func setProgress(_ id: UUID, _ sent: Int64) {
        guard jobs[id] != nil else { return }
        progress[id] = sent
    }

    // MARK: - Keeping the books

    /// Every change to a job comes through here: kept, counted, on disk,
    /// and told.
    private func update(_ job: UploadJob) {
        let old = jobs.updateValue(job, forKey: job.id)
        tally(old, -1)
        tally(job, 1)
        note(Change(job: job))
        onChange?(job)
    }

    /// A job leaving the queue, done or cancelled: no longer counted, and
    /// on disk as gone. Not told: the caller says what became of it.
    @discardableResult
    private func remove(_ id: UUID) -> UploadJob? {
        guard let job = jobs.removeValue(forKey: id) else { return nil }
        tally(job, -1)
        progress[id] = nil
        notBefore[id] = nil
        note(Change(gone: id))
        return job
    }

    private func tally(_ job: UploadJob?, _ sign: Int) {
        guard let job else { return }
        switch job.state {
        case .queued, .uploading:
            waitingCount += sign
            waitingBytes += Int64(sign) * job.size
        case .failed:
            if sign > 0 { failedIDs.insert(job.id) } else { failedIDs.remove(job.id) }
        case .done:
            break
        }
    }

    // MARK: - On disk

    /// One line of jobs.log: a job as it is now, or one that has left.
    struct Change: Codable {
        var job: UploadJob?
        var gone: UUID?
    }

    /// The change, added to jobs.log at once: a few hundred bytes, whatever
    /// else is waiting. Then jobs.json, if it is time (`compactIfDue`).
    private func note(_ change: Change) {
        guard var line = try? JSONEncoder().encode(change) else { return }
        line.append(0x0A)
        if append(line) {
            logBytes += line.count
            disk.appends += 1
            disk.appendBytes += line.count
            compactIfDue()
        } else {
            // Not added (the disk full, say): the log goes back to its whole
            // lines, and the queue is written whole instead.
            if log >= 0 { ftruncate(log, off_t(logBytes)) }
            compact()
        }
    }

    private func append(_ line: Data) -> Bool {
        if log < 0 {
            log = open(directory.appendingPathComponent(Self.logFile).path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
            guard log >= 0 else { return false }
        }
        let written = line.withUnsafeBytes { Darwin.write(log, $0.baseAddress, $0.count) }
        return written == line.count
    }

    /// When the log has grown past the queue it describes (`logFloor`), or
    /// the queue is empty and the log is not — at most once a
    /// `compactInterval`. A log left longer is no harm: it holds every
    /// change, and the next launch folds it in.
    private func compactIfDue() {
        guard logBytes > 0, logBytes > max(Self.logFloor, 2 * snapshotBytes) || jobs.isEmpty else { return }
        if let compactedAt, ContinuousClock.now - compactedAt < Self.compactInterval { return }
        compact()
    }

    /// jobs.json, written whole in the order the jobs came, and the log
    /// emptied, all of it being in jobs.json now. If jobs.json cannot be
    /// written the log stays as it is: nothing is lost.
    private func compact() {
        arrival = arrival.filter { jobs[$0] != nil }
        guard let data = try? JSONEncoder().encode(arrival.compactMap { jobs[$0] }),
              (try? data.write(to: directory.appendingPathComponent(Self.jobsFile), options: .atomic)) != nil else { return }
        if log >= 0 {
            ftruncate(log, 0)
        } else {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(Self.logFile))
        }
        logBytes = 0
        snapshotBytes = data.count
        compactedAt = .now
        disk.snapshots += 1
        disk.snapshotBytes += data.count
    }

    /// jobs.json, then each change jobs.log holds since, in order; and, when
    /// there is a log, how much of it is whole lines. A line cut short — a
    /// crash as it was written — says nothing, and is passed over.
    static func load(_ directory: URL) -> (jobs: [UploadJob], logged: Int?) {
        var order: [UUID] = []
        var byID: [UUID: UploadJob] = [:]
        if let data = try? Data(contentsOf: directory.appendingPathComponent(jobsFile)),
           let saved = try? JSONDecoder().decode([UploadJob].self, from: data) {
            for job in saved where byID.updateValue(job, forKey: job.id) == nil { order.append(job.id) }
        }
        guard let log = try? Data(contentsOf: directory.appendingPathComponent(logFile)) else {
            return (order.compactMap { byID[$0] }, nil)
        }
        let decoder = JSONDecoder()
        for line in log.split(separator: 0x0A) {
            guard let change = try? decoder.decode(Change.self, from: Data(line)) else { continue }
            if let job = change.job {
                if byID.updateValue(job, forKey: job.id) == nil { order.append(job.id) }
            } else if let gone = change.gone {
                byID[gone] = nil
            }
        }
        let whole = log.lastIndex(of: 0x0A).map { log.distance(from: log.startIndex, to: $0) + 1 } ?? 0
        return (order.compactMap { byID[$0] }, whole)
    }

    /// First in, first out, taking from the front without moving what is
    /// behind it: a thousand jobs waiting cost a thousand steps, not a million.
    struct Line<Element> {
        private var items: [Element] = []
        private var head = 0

        var first: Element? { head < items.count ? items[head] : nil }
        var isEmpty: Bool { head == items.count }
        var count: Int { items.count - head }

        mutating func append(_ element: Element) { items.append(element) }

        @discardableResult
        mutating func removeFirst() -> Element? {
            guard head < items.count else { return nil }
            let element = items[head]
            head += 1
            if head == items.count {
                items.removeAll(keepingCapacity: true)
                head = 0
            } else if head >= 1024, head * 2 >= items.count {
                // What was taken is let go of once it is half the line.
                items.removeFirst(head)
                head = 0
            }
            return element
        }
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
