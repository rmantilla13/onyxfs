import Foundation
import SwiftUI
import os
import OnyxKit

private let log = Logger(subsystem: OnyxIdentifiers.app, category: "proxies")

/// Streamable versions of heavy videos, made on this Mac.
///
/// A 4K master streams badly from storage — an action camera's HEVC runs at
/// 60 to 120 Mbps, more than a phone's connection carries — so the server
/// asks for a proxy of every large video uploaded (lib/proxies.js): a 1080p
/// H.264 copy the web and the iPhone play instead. It never transcodes;
/// a Mac that is signed in, running and has this on (Settings › General)
/// takes the jobs, one at a time, as it does transcripts:
///
///   claim      the job is this Mac's for 10 minutes; each progress report
///              extends that, so a Mac that quits or sleeps loses it
///   download   the master, from its presigned link, to this app's caches —
///              streamed to disk, never held in memory — unless it is on
///              this Mac already (below)
///   transcode  on the media engine (ProxyTranscoder), to the server's spec
///   upload     to the link the claim gave, then say it is done
///
/// The master is often here already. The server asks for a proxy as a large
/// video is uploaded, and the Mac that uploaded it usually takes the job:
/// so as each upload from this Mac finishes, its bytes are kept for the job
/// (`uploaded`, ProxySources), the queue is asked at once, and a job whose
/// master is kept is taken before the others. A claim is checked against
/// what is kept — the same file, uploaded to the object the claim reads, at
/// its size — and the transcode reads the bytes where they are, as it does
/// a copy kept offline at the version the drive's mirror has now. Anything
/// else is downloaded, as before.
///
/// The queue is asked every 2 minutes, and at once when an upload from this
/// Mac might have added to it. A job taken back meanwhile (409 `lost`) is
/// stopped and thrown away; one that fails is reported with a sentence that
/// says why. Nothing is left on disk after a job, whatever its end.
@MainActor
final class ProxyService: ObservableObject {
    @Published var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: Keys.enabled)
            if enabled, let model { start(model: model) } else if !enabled { turnedOff() }
        }
    }
    /// The video being made streamable now, for the menu bar's panel. A job
    /// under way — download, transcode, upload — keeps Onyx out of App Nap
    /// (WorkActivity).
    @Published private(set) var busyFileId: String? {
        didSet { WorkActivity.app.set(.proxies, busyFileId != nil) }
    }
    @Published private(set) var busyName: String?
    /// 0…1 across the whole job: download, transcode, upload.
    @Published private(set) var progress: Double = 0

    private weak var model: AppModel?
    private var timer: Timer?
    private var pass: Task<Void, Never>?
    private var again = false
    private var generation = 0
    /// This Mac's own large uploads, kept for their proxies.
    private let sources = ProxySources(folder: ProxyService.sourcesRoot)

    private enum Keys {
        static let enabled = "proxies.enabled"
    }

    static let pollInterval: TimeInterval = 120
    /// lib/proxies.js QUEUE_LIMIT: a queue that answers with fewer jobs than
    /// this has listed every one there is.
    static let queuePage = 10

    init() {
        enabled = UserDefaults.standard.object(forKey: Keys.enabled) as? Bool ?? true
    }

    /// Once, as the app starts: hears this Mac's uploads as they finish,
    /// after whoever heard them before (ThumbnailService, which wants the
    /// bytes still here too).
    func attach(to model: AppModel) {
        self.model = model
        let before = model.finder.onUploadFinished
        model.finder.onUploadFinished = { [weak self] job in
            before?(job)
            self?.uploaded(job)
        }
    }

    /// An upload the server has now (DriveService, before the queue lets go
    /// of its copy). A large video will have a proxy asked for (ProxyRule),
    /// and this Mac is likely to be the one to make it: its bytes are kept
    /// for that — linked now, while the queue's copy is still there — and
    /// the queue is asked at once. New contents for a file are not kept: the
    /// server asks for no proxy of those.
    func uploaded(_ job: UploadJob) {
        guard enabled, timer != nil, job.state == .done, job.replaceOf == nil,
              let fileId = job.fileId, let key = job.uploadedKey,
              ProxyRule.asksForProxy(name: job.name, mime: job.mime, size: job.size),
              Poster.Kind.of(name: job.name, mime: job.mime) == .video,
              let link = sources.link(URL(fileURLWithPath: job.staged), name: job.name) else { return }
        let size = job.size
        Task {
            guard await sources.hold(link, fileId: fileId, key: key, size: size) else { return }
            log.info("keeping \(fileId, privacy: .public) here for its proxy")
            pollNow()
        }
    }

    // MARK: - Life cycle

    /// After sign-in, and when turned on.
    func start(model: AppModel) {
        self.model = model
        guard enabled, model.phase == .signedIn else { return }
        guard timer == nil else { pollNow(); return }
        generation += 1
        // Left by a run that did not end cleanly (a crash, a forced quit).
        if busyFileId == nil { try? FileManager.default.removeItem(at: Self.workRoot) }
        timer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pollNow() }
        }
        pollNow()
    }

    /// Sign-out, quit, or turned off: stop asking, and stop the job at hand.
    /// Its lease runs out on the server and the job can be taken again. What
    /// was kept for jobs to come goes: another Mac will make them.
    func stop() {
        timer?.invalidate()
        timer = nil
        generation += 1
        pass?.cancel()
        pass = nil
        again = false
        busyFileId = nil
        busyName = nil
        progress = 0
        Task { [sources] in await sources.clear() }
    }

    private func turnedOff() {
        if let fileId = busyFileId, let api = model?.api {
            let message = "Making streamable versions was turned off on \(TranscriptionService.deviceName)."
            Task { try? await api.reportProxyFailure(fileId: fileId, message: message) }
        }
        stop()
    }

    /// Ask the queue now, or right after the job at hand.
    func pollNow() {
        guard enabled, let model, model.phase == .signedIn, timer != nil else { return }
        if pass != nil { again = true; return }
        let started = generation
        pass = Task { [weak self] in
            await self?.drain(generation: started)
            guard let self, started == generation else { return }
            pass = nil
            if again {
                again = false
                pollNow()
            }
        }
    }

    // MARK: - The queue

    private func drain(generation started: Int) async {
        var passed: Set<String> = []
        await sources.prune()
        while started == generation, !Task.isCancelled, let api = model?.api {
            let jobs: [ProxyJob]
            let asked = Date()
            do {
                jobs = try await api.proxyQueue()
            } catch {
                // A server without proxies, or out of reach: quietly, until
                // the next poll.
                log.debug("queue: \(error.localizedDescription, privacy: .public)")
                return
            }
            // The whole queue: a master kept for a job not in it has none
            // coming. (A server with proxies off answers with none at all.)
            if jobs.count < Self.queuePage { await sources.queueSeen(Set(jobs.map(\.fileId)), askedAt: asked) }
            // A job whose master is kept here goes first: there is nothing to
            // download, and the disk it holds comes back sooner.
            let kept = Set(await sources.all.keys)
            let waiting = jobs.filter { !passed.contains($0.fileId) }
            guard started == generation, let job = waiting.first(where: { kept.contains($0.fileId) }) ?? waiting.first
            else { return }
            passed.insert(job.fileId)
            let claim: ProxyClaim
            do {
                claim = try await api.claimProxy(fileId: job.fileId, device: TranscriptionService.deviceName)
            } catch ProxyConflict.taken {
                continue
            } catch OnyxError.http(let status, _) where status == 404 {
                continue
            } catch {
                log.error("claim: \(error.localizedDescription, privacy: .public)")
                return
            }
            guard started == generation, !Task.isCancelled else { return }
            await run(claim, api: api, generation: started)
        }
    }

    // MARK: - One job

    private func run(_ claim: ProxyClaim, api: OnyxAPI, generation started: Int) async {
        busyFileId = claim.fileId
        busyName = claim.name
        progress = 0
        log.info("making a proxy of \(claim.fileId, privacy: .public)")
        let folder = Self.workRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let fileId = claim.fileId
        let relay = ProxyProgress { [weak self] p in
            Task { @MainActor in if let self, self.busyFileId == fileId { self.progress = p } }
        }
        let transfers = model?.finder.transfers
        let master = await localMaster(for: claim)
        if master != nil { log.info("\(claim.fileId, privacy: .public): its master is on this Mac already") }
        let work = Task(priority: .utility) {
            try await Self.make(claim, in: folder, master: master, transfers: transfers, progress: relay.send)
        }
        let lease = ProxyLease()
        let heartbeat = Task { await keepAlive(claim.fileId, api: api, lease: lease, stopping: work) }
        defer {
            heartbeat.cancel()
            try? FileManager.default.removeItem(at: folder)
            if started == generation {
                busyFileId = nil
                busyName = nil
                progress = 0
            }
        }
        do {
            let result = try await withTaskCancellationHandler {
                try await work.value
            } onCancel: {
                work.cancel()
            }
            heartbeat.cancel()
            await heartbeat.value
            if lease.lost { throw ProxyConflict.lost }
            try await Self.finish(result, for: claim.fileId, api: api)
            log.info("proxy of \(claim.fileId, privacy: .public) is in: \(result.width)x\(result.height), \(result.size) bytes")
        } catch {
            if lease.lost || error as? ProxyConflict == .lost {
                log.info("\(claim.fileId, privacy: .public) was taken back; its proxy is discarded")
            } else if started != generation || Task.isCancelled || error is CancellationError {
                // Stopped (sign-out, quit): nothing to report; the lease ends.
            } else {
                let message = TranscriptionService.describe(error)
                log.error("\(claim.fileId, privacy: .public) failed: \(message, privacy: .public)")
                try? await api.reportProxyFailure(fileId: claim.fileId, message: message)
            }
        }
        // However the job ended, it was the one its master was kept for.
        await sources.release(claim.fileId)
    }

    /// The master, when it is on this Mac already and provably the one the
    /// claim is for: this Mac's own upload of it (ProxySources checks the
    /// object and the size), or its copy kept offline, at the version the
    /// drive's mirror has now, at the size the claim says, and of the content
    /// hash the claim carries, when it carries one. Nil: it is downloaded.
    private func localMaster(for claim: ProxyClaim) async -> URL? {
        if let held = await sources.master(for: claim) { return held }
        guard let size = claim.size, let kept = await model?.finder.keptCopy(fileId: claim.fileId),
              kept.entry.size == size else { return nil }
        if let hash = claim.contentHash, kept.entry.contentHash != hash { return nil }
        return kept.url
    }

    /// Progress reports while the job runs — every 5 seconds at most, and at
    /// least once a minute, since each is also what keeps the job this
    /// Mac's. A 409 `lost` stops the job.
    private func keepAlive(_ fileId: String, api: OnyxAPI, lease: ProxyLease,
                           stopping work: Task<ProxyResult, Error>) async {
        var sent = -1.0
        var sentAt = Date.distantPast
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            let now = progress
            guard now - sent >= 0.01 || Date().timeIntervalSince(sentAt) >= 60 else { continue }
            do {
                try await api.reportProxyProgress(fileId: fileId, progress: now)
                sent = now
                sentAt = Date()
            } catch ProxyConflict.lost {
                lease.lost = true
                work.cancel()
                return
            } catch {
                // Out of reach for a moment: the lease is ten minutes.
            }
        }
    }

    /// A finished proxy is worth a second try at saying so: the copy is in
    /// the bucket already. A refusal (400, 409) is final.
    private static func finish(_ result: ProxyResult, for fileId: String, api: OnyxAPI) async throws {
        for attempt in 1... {
            do {
                return try await api.finishProxy(fileId: fileId, result)
            } catch where attempt < 3 && TranscriptionService.isTransient(error) {
                try await Task.sleep(nanoseconds: UInt64(attempt) * 10_000_000_000)
            }
        }
    }

    /// The work, off the main actor: download (the first 40%), transcode
    /// (to 97%), upload. What it moves shows in the Activity graphs. A
    /// `master` already here (localMaster) is read where it is, through a
    /// link in the job's folder, and the transcode is all of the first 97%.
    nonisolated private static func make(_ claim: ProxyClaim, in folder: URL, master: URL?, transfers: TransferLog?,
                                         progress: @escaping @Sendable (Double) -> Void) async throws -> ProxyResult {
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let size = Double(claim.size ?? 0)
        let source = folder.appendingPathComponent("source." + TranscriptionService.fileExtension(name: claim.name, mime: claim.mime))
        var here = false
        if let master, let bytes = claim.size { here = ProxySources.place(master, at: source, size: bytes) }
        try roomFor(size, in: folder, downloading: !here)
        if !here {
            do {
                try await FileDownload.fetch(claim.downloadUrl, to: source, progress: { bytes in
                    if size > 0 { progress(0.40 * min(1, Double(bytes) / size)) }
                }, received: { transfers?.add(.download, $0) })
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch {
                throw Failure.download(error.localizedDescription)
            }
        }
        let transcoding = here ? 0 : 0.40
        progress(transcoding)
        let proxy = folder.appendingPathComponent("proxy.mp4")
        let out = try await ProxyTranscoder.transcode(source, to: proxy, spec: claim.spec) { p in
            progress(transcoding + (0.97 - transcoding) * p)
        }
        // The master is not needed any more, and may be large.
        try? fm.removeItem(at: source)
        if let limit = claim.maxBytes, out.size > limit { throw Failure.tooLarge }
        progress(0.97)
        try await upload(proxy, to: claim.uploadUrl)
        transfers?.add(.upload, out.size)
        progress(1)
        return ProxyResult(width: out.width, height: out.height, size: out.size, duration: out.duration)
    }

    /// One PUT, with the two headers the link was signed with.
    nonisolated private static func upload(_ file: URL, to url: URL) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("video/mp4", forHTTPHeaderField: "Content-Type")
        request.setValue("private, max-age=31536000, immutable", forHTTPHeaderField: "Cache-Control")
        let status: Int
        do {
            let (_, response) = try await URLSession.shared.upload(for: request, fromFile: file)
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw Failure.upload(error.localizedDescription)
        }
        guard (200..<300).contains(status) else { throw Failure.upload("storage answered \(status)") }
    }

    /// Room for the proxy — and for the master, when it is downloaded — with
    /// some to spare: a job that would fill the disk fails at once, saying so.
    nonisolated private static func roomFor(_ bytes: Double, in folder: URL, downloading: Bool) throws {
        guard bytes > 0,
              let free = try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
                .volumeAvailableCapacityForImportantUsage else { return }
        let needed = Int64(bytes * (downloading ? 1.15 : 0.15)) + 2_000_000_000
        if free < needed {
            throw Failure.noRoom(ByteCountFormatter.string(fromByteCount: needed, countStyle: .file))
        }
    }

    enum Failure: LocalizedError {
        case download(String)
        case upload(String)
        case noRoom(String)
        case tooLarge

        var errorDescription: String? {
            switch self {
            case let .download(why): return "Onyx for Mac could not download the video: \(why)"
            case let .upload(why): return "Onyx for Mac could not upload the streamable version: \(why)"
            case let .noRoom(needed): return "This Mac needs \(needed) free to make the streamable version."
            case .tooLarge: return "The streamable version came out larger than one upload may be."
            }
        }
    }

    /// ~/Library/Caches/<bundle id>/Proxies: nothing here outlives its job.
    nonisolated static var workRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? OnyxIdentifiers.app, isDirectory: true)
            .appendingPathComponent("Proxies", isDirectory: true)
    }

    /// ~/Library/Caches/<bundle id>/Proxy masters: this Mac's own uploads,
    /// kept for their proxies (ProxySources), on the disk the upload queue
    /// stages on so a hard link reaches them. Emptied as the app opens.
    nonisolated static var sourcesRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? OnyxIdentifiers.app, isDirectory: true)
            .appendingPathComponent("Proxy masters", isDirectory: true)
    }
}

@MainActor
private final class ProxyLease {
    var lost = false
}

/// Progress from the work's threads to the main actor, at most once per
/// thousandth.
private final class ProxyProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var last = -1.0
    private let deliver: @Sendable (Double) -> Void

    init(_ deliver: @escaping @Sendable (Double) -> Void) { self.deliver = deliver }

    @Sendable func send(_ p: Double) {
        lock.lock()
        let moved = abs(p - last) >= 0.001
        if moved { last = p }
        lock.unlock()
        if moved { deliver(p) }
    }
}

/// The panel's line while a video is being made streamable.
struct ProxyMenuLine: View {
    @ObservedObject var proxies: ProxyService

    var body: some View {
        if let name = proxies.busyName {
            Text("Making \(TranscriptionMenuLine.shortened(name)) streamable — \(Int(proxies.progress * 100))%")
        }
    }
}

/// The setting, in Settings › General.
struct ProxySettings: View {
    @ObservedObject var proxies: ProxyService

    var body: some View {
        Section("Streamable versions") {
            Toggle("Make streamable versions of large videos on this Mac", isOn: $proxies.enabled)
            Text("A large video, like an action camera's 4K, plays slowly from storage on a phone or in a browser. This Mac makes each one a 1080p copy that plays straight away, while Onyx is running. The original is never changed.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
