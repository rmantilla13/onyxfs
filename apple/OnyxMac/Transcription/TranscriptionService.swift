import Foundation
import SystemConfiguration
import UniformTypeIdentifiers
import os
import OnyxKit

private let log = Logger(subsystem: OnyxIdentifiers.app, category: "transcripts")

/// Transcripts requested on the web, made on this Mac.
///
/// The server keeps a queue and never touches the media; a Mac that is
/// signed in, running and has this turned on (Settings → Account) takes jobs
/// from it one at a time:
///
///   claim      the job is this Mac's for 10 minutes; each progress report
///              extends that, so a Mac that quits or sleeps loses it and
///              another may take it
///   download   the file, from its presigned link, to this app's caches —
///              streamed to disk, never held in memory
///   extract    its audio (AudioExtractor)
///   recognize  on this Mac (SpeechEngine)
///   submit     the segments, with the version of the file they are of
///
/// The queue is asked every 2 minutes, and at once when the page nudges
/// (`window.onyxMac.transcribe`). A job taken back meanwhile (409 `lost`) is
/// stopped and thrown away; one that fails is reported with a sentence that
/// says why. Nothing is left on disk after a job, whatever its end.
@MainActor
final class TranscriptionService: ObservableObject {
    /// Stored with the app's other settings, which a dev build keeps apart.
    @Published var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            defaults.set(enabled, forKey: Keys.enabled)
            if enabled, let model { start(model: model) } else if !enabled { turnedOff() }
            model?.web.publishOfflineState()
        }
    }
    /// The file being transcribed now, for the page and the menu bar.
    @Published private(set) var busyFileId: String?
    @Published private(set) var busyName: String?
    /// 0…1 across the whole job: download, audio, then speech.
    @Published private(set) var progress: Double = 0

    private weak var model: AppModel?
    private let defaults = UserDefaults.standard
    private var timer: Timer?
    private var pass: Task<Void, Never>?
    /// A nudge that came while a pass was running: ask again after it.
    private var again = false
    /// Moved on by every start and stop; work begun under an older one stops
    /// rather than act for a sign-in that has ended.
    private var generation = 0

    private enum Keys {
        static let enabled = "transcripts.enabled"
    }

    static let pollInterval: TimeInterval = 120

    init() {
        enabled = UserDefaults.standard.object(forKey: Keys.enabled) as? Bool ?? true
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
    /// Its lease runs out on the server and the job can be taken again.
    func stop() {
        timer?.invalidate()
        timer = nil
        generation += 1
        pass?.cancel()
        pass = nil
        again = false
        if busyFileId != nil {
            busyFileId = nil
            busyName = nil
            progress = 0
            model?.web.publishOfflineState()
        }
    }

    /// Turned off by hand in the middle of a job: say so on the web now,
    /// rather than leave it looking busy until the lease runs out.
    private func turnedOff() {
        if let fileId = busyFileId, let api = model?.api {
            let message = "Transcription was turned off on \(Self.deviceName)."
            Task { try? await api.reportTranscriptionFailure(fileId: fileId, message: message) }
        }
        stop()
    }

    /// Ask the queue now (the page's nudge after a request), or right after
    /// the job at hand.
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

    /// Take and do jobs until none is left that this Mac can take.
    private func drain(generation started: Int) async {
        // Taken by another Mac, or gone, as far as this pass is concerned.
        var passed: Set<String> = []
        while started == generation, !Task.isCancelled, let api = model?.api {
            let jobs: [TranscriptionJob]
            do {
                jobs = try await api.transcriptionQueue()
            } catch {
                // A server without transcripts, or out of reach: quietly,
                // until the next poll.
                log.debug("queue: \(error.localizedDescription, privacy: .public)")
                return
            }
            guard started == generation, let job = jobs.first(where: { !passed.contains($0.fileId) }) else { return }
            passed.insert(job.fileId)
            let claim: TranscriptionClaim
            do {
                claim = try await api.claimTranscription(fileId: job.fileId, device: Self.deviceName)
            } catch TranscriptionConflict.taken {
                continue
            } catch OnyxError.http(let status, _) where status == 404 {
                continue
            } catch {
                log.error("claim: \(error.localizedDescription, privacy: .public)")
                return
            }
            // Stopped while claiming: the lease runs out, as for any stop.
            guard started == generation, !Task.isCancelled else { return }
            await run(claim, api: api, generation: started)
        }
    }

    // MARK: - One job

    private func run(_ claim: TranscriptionClaim, api: OnyxAPI, generation started: Int) async {
        busyFileId = claim.fileId
        busyName = claim.name
        progress = 0
        model?.web.publishOfflineState()
        log.info("transcribing \(claim.fileId, privacy: .public)")
        let folder = Self.workRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let fileId = claim.fileId
        let relay = ProgressRelay { [weak self] p in
            // Not a late report from a job already over.
            Task { @MainActor in if let self, self.busyFileId == fileId { self.progress = p } }
        }
        let work = Task(priority: .utility) {
            try await Self.transcribe(claim, in: folder, progress: relay.send)
        }
        let lease = Lease()
        let heartbeat = Task { await keepAlive(claim.fileId, api: api, lease: lease, stopping: work) }
        defer {
            heartbeat.cancel()
            try? FileManager.default.removeItem(at: folder)
            if started == generation {
                busyFileId = nil
                busyName = nil
                progress = 0
                model?.web.publishOfflineState()
            }
        }
        do {
            let result = try await withTaskCancellationHandler {
                try await work.value
            } onCancel: {
                work.cancel()
            }
            // No progress report crossing the result on its way in.
            heartbeat.cancel()
            await heartbeat.value
            if lease.lost { throw TranscriptionConflict.lost }
            guard result.segments.count <= 20_000 else {
                throw Failure.tooLong
            }
            try await Self.submit(TranscriptSubmission(segments: result.segments, resultLanguage: result.language,
                                                       engine: result.engine, sourceKey: claim.sourceKey),
                                  for: claim.fileId, api: api)
            log.info("transcribed \(claim.fileId, privacy: .public): \(result.segments.count) segments, \(result.engine, privacy: .public)")
        } catch {
            if lease.lost || error as? TranscriptionConflict == .lost {
                log.info("\(claim.fileId, privacy: .public) was taken back; its work is discarded")
            } else if started != generation || Task.isCancelled || error is CancellationError {
                // Stopped (sign-out, quit): nothing to report; the lease ends.
            } else {
                let message = Self.describe(error)
                log.error("\(claim.fileId, privacy: .public) failed: \(message, privacy: .public)")
                try? await api.reportTranscriptionFailure(fileId: claim.fileId, message: message)
            }
        }
    }

    /// Reports progress while the job runs — every 5 seconds at most, and
    /// at least once a minute even when it has not moved, since each report
    /// is also what keeps the job this Mac's. A 409 `lost` stops the job.
    private func keepAlive(_ fileId: String, api: OnyxAPI, lease: Lease,
                           stopping work: Task<SpeechEngine.Result, Error>) async {
        var sent = -1.0
        var sentAt = Date.distantPast
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            let now = progress
            guard now - sent >= 0.01 || Date().timeIntervalSince(sentAt) >= 60 else { continue }
            do {
                try await api.reportTranscriptionProgress(fileId: fileId, progress: now)
                sent = now
                sentAt = Date()
            } catch TranscriptionConflict.lost {
                lease.lost = true
                work.cancel()
                return
            } catch {
                // Out of reach for a moment: the lease is ten minutes, and
                // the next report tries again.
            }
        }
    }

    /// An hour of recognition is worth a second try at handing it in: a
    /// moment offline, or a server restarting, should not lose it. A refusal
    /// (400, 409) is final.
    private static func submit(_ submission: TranscriptSubmission, for fileId: String, api: OnyxAPI) async throws {
        for attempt in 1... {
            do {
                return try await api.submitTranscript(fileId: fileId, submission)
            } catch where attempt < 3 && isTransient(error) {
                try await Task.sleep(nanoseconds: UInt64(attempt) * 10_000_000_000)
            }
        }
    }

    nonisolated static func isTransient(_ error: Error) -> Bool {
        if let error = error as? URLError { return error.code != .cancelled }
        if case let OnyxError.http(status, _) = error { return status >= 500 }
        return false
    }

    /// The work itself, off the main actor: download, audio, speech.
    nonisolated private static func transcribe(_ claim: TranscriptionClaim, in folder: URL,
                                               progress: @escaping @Sendable (Double) -> Void) async throws -> SpeechEngine.Result {
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let source = folder.appendingPathComponent("source." + fileExtension(name: claim.name, mime: claim.mime))
        let size = Double(claim.size ?? 0)
        do {
            try await FileDownload.fetch(claim.downloadUrl, to: source, progress: { bytes in
                if size > 0 { progress(0.10 * min(1, Double(bytes) / size)) }
            })
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw Failure.download(error.localizedDescription)
        }
        progress(0.10)
        let audio = folder.appendingPathComponent("audio.m4a")
        let duration = try await AudioExtractor.extract(from: source, to: audio)
        // The video is not needed any more, and may be large.
        try? fm.removeItem(at: source)
        progress(0.15)
        return try await SpeechEngine.transcribe(audio: audio, duration: duration, language: claim.language) { p in
            progress(0.15 + 0.85 * p)
        }
    }

    // MARK: - Helpers

    enum Failure: LocalizedError {
        case download(String)
        case tooLong

        var errorDescription: String? {
            switch self {
            case let .download(why): return "Onyx for Mac could not download the file: \(why)"
            case .tooLong: return "This recording is too long for one transcript."
            }
        }
    }

    /// The sentence the web shows for a failed job.
    nonisolated static func describe(_ error: Error) -> String {
        let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        return String(text.prefix(500))
    }

    /// ~/Library/Caches/<bundle id>/Transcription: this app's own, a dev
    /// build's apart from the real one's. Caches, because nothing here
    /// outlives its job.
    nonisolated static var workRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? OnyxIdentifiers.app, isDirectory: true)
            .appendingPathComponent("Transcription", isDirectory: true)
    }

    /// The downloaded file keeps its kind in its name, which is how
    /// AVFoundation tells a .mov from an .mp3.
    nonisolated static func fileExtension(name: String, mime: String?) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        if !ext.isEmpty, ext.count <= 8, ext.allSatisfy({ $0.isLetter || $0.isNumber }) { return ext }
        if let mime, let type = UTType(mimeType: mime), let preferred = type.preferredFilenameExtension { return preferred }
        return "mov"
    }

    /// The Mac's name as Sharing settings has it ("Ricky's MacBook Pro"),
    /// shown on the web beside the job. Read from the system configuration,
    /// which Host.current() would also do after a round of DNS lookups.
    static let deviceName: String = {
        let name = (SCDynamicStoreCopyComputerName(nil, nil) as String?)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((name?.isEmpty == false ? name! : "Mac").prefix(80))
    }()
}

/// One job's hold on the server: whether the server has taken it back
/// (409 `lost`), in which case nothing more is said about it.
@MainActor
private final class Lease {
    var lost = false
}

/// Progress from the work's threads to the main actor, at most once per
/// thousandth: the download reports every chunk it writes.
private final class ProgressRelay: @unchecked Sendable {
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
