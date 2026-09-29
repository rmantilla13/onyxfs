import Foundation
import os
import OnyxKit

private let log = Logger(subsystem: OnyxIdentifiers.app, category: "thumbnails")

/// Thumbnails the web is missing, made on this Mac.
///
/// A browser makes a file's thumbnail as it uploads it, or later, in the
/// background, while someone who may change the file has the web open. A
/// file that came another way — copied in Finder, or a 4K master a browser
/// gave up on — waits for that. This Mac does not wait: it makes them
/// (ThumbnailWorker, OnyxKit) for
///
///   - each file it uploads, from the bytes still on this disk, as soon as
///     the server has the file;
///   - the files of the drives it syncs — in Finder, or kept offline —
///     whose mirror says they have no thumbnail, or (a video) only one of
///     the old small ones; and only in a drive this account may change.
///
/// A sound it uploads gets its waveform the same way, from the bytes here
/// (WaveformMaker, OnyxKit), for the web's tiles and players and the iOS
/// app's.
///
/// It wakes when a mirror's pass brings a change (DriveService tells it,
/// with the pass's diff) and when an upload finishes; it never polls. Its
/// worker does one file at a time at utility priority, and remembers what
/// failed so it is not tried again straight away. On unless turned off in
/// Settings › General; stopped by sign-out and quit.
@MainActor
final class ThumbnailService: ObservableObject {
    /// Stored with the app's other settings, which a dev build keeps apart.
    @Published var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            defaults.set(enabled, forKey: Keys.enabled)
            if enabled { start() } else { stop() }
        }
    }
    /// What the worker is doing, for Settings.
    @Published private(set) var status = ThumbnailWorker.Status()

    private weak var model: AppModel?
    private let defaults = UserDefaults.standard
    private var worker: ThumbnailWorker?
    private var waveforms: WaveformMaker?
    /// The mirror each drive was last looked at whole in: one opened afresh
    /// (a drive mounted, the app opened) is looked at whole once, and after
    /// that only what each pass changed. Held weakly: a mirror let go of is
    /// not kept for this, and one that replaces it is new.
    private var scanned: [String: Seen] = [:]

    private struct Seen {
        weak var mirror: DriveMirror?
    }

    private enum Keys {
        static let enabled = "thumbnails.enabled"
    }

    init() {
        enabled = UserDefaults.standard.object(forKey: Keys.enabled) as? Bool ?? true
    }

    /// Once, as the app starts: hears the drives' passes and uploads from
    /// then on, whether or not it is working.
    func attach(to model: AppModel) {
        self.model = model
        model.finder.onMirrorSynced = { [weak self] mirror, diff in self?.mirrorSynced(mirror, diff) }
        // After whoever heard them before, as ProxyService does: one hook,
        // shared, so neither depends on which attaches first.
        let before = model.finder.onUploadFinished
        model.finder.onUploadFinished = { [weak self] job in
            before?(job)
            self?.uploaded(job)
        }
    }

    // MARK: - Life cycle

    /// After sign-in, once the account is known, and when turned on. A
    /// worker of its own for the account: what came of each file is kept
    /// per account on one server, as the mirrors are.
    func start() {
        guard enabled, worker == nil, let model, model.phase == .signedIn,
              let account = model.email, !account.isEmpty else { return }
        let transfers = model.finder.transfers
        let server = APIThumbnailServer(api: model.api,
                                        received: { transfers.add(.download, $0) },
                                        sent: { transfers.add(.upload, $0) })
        let worker = ThumbnailWorker(server: server, drawing: ThumbnailRendering(), folder: Self.workRoot,
                                     ledgerFile: Self.ledger(server: model.config.baseURL, account: account))
        self.worker = worker
        scanned = [:]
        let shown: @Sendable (ThumbnailWorker.Status) -> Void = { [weak self] status in
            Task { @MainActor in
                // Not a late word from a worker already stopped.
                guard let self, self.worker === worker, self.status != status else { return }
                self.status = status
            }
        }
        Task { await worker.observe(status: shown, reports: { ThumbnailService.note($0) }) }
        let api = model.api
        let waveforms = WaveformMaker(record: { fileId, waveform in
            try await api.recordWaveform(fileId: fileId, waveform: waveform)
        })
        self.waveforms = waveforms
        try? FileManager.default.removeItem(at: Self.soundRoot)
        try? FileManager.default.createDirectory(at: Self.soundRoot, withIntermediateDirectories: true)
        Task { await waveforms.observe { ThumbnailService.note($0, $1) } }
        // The drives open already; each opened later is looked at as it syncs.
        for mirror in model.finder.openMirrors { mirrorSynced(mirror, nil) }
        log.info("making thumbnails on this Mac (\(PreviewFormat.best.rawValue, privacy: .public))")
    }

    /// Sign-out, quit, or turned off: the file in hand is dropped; nothing
    /// is left half-recorded, since a thumbnail is only recorded whole.
    func stop() {
        if let waveforms {
            self.waveforms = nil
            Task { await waveforms.stop() }
        }
        guard let worker else { return }
        self.worker = nil
        scanned = [:]
        status = ThumbnailWorker.Status()
        Task { await worker.stop() }
    }

    // MARK: - Work in

    /// A drive's mirror has been brought up to date: the files the pass
    /// changed are looked at — or every file, the first time this mirror
    /// is seen (`diff` nil: no pass, only the mirror as it is).
    func mirrorSynced(_ mirror: DriveMirror, _ diff: Replica.Diff?) {
        guard let worker, mayChange(in: mirror.scope) else { return }
        let scope = mirror.scope.identifier
        if scanned[scope]?.mirror !== mirror {
            scanned[scope] = Seen(mirror: mirror)
            Task(priority: .utility) {
                let files = await mirror.files(where: ThumbnailCandidate.lacksPreviews)
                await worker.update(scope: scope, files: files, whole: true)
            }
            return
        }
        guard let diff else { return }
        let changed = diff.updated.filter { Replica.folderPath(ofID: $0) == nil } + diff.previews
        let gone = diff.deleted.filter { Replica.folderPath(ofID: $0) == nil }
        guard !changed.isEmpty || !gone.isEmpty else { return }
        Task(priority: .utility) {
            let files = changed.isEmpty ? [] : await mirror.files(among: changed, where: { _ in true })
            await worker.update(scope: scope, files: files, settled: gone)
        }
    }

    /// An upload the server has now (DriveService, before the queue lets go
    /// of its copy): its thumbnail is made from the bytes here, the cheapest
    /// they will ever be. A link of the worker's own keeps them until then.
    func uploaded(_ job: UploadJob) {
        guard let worker, job.state == .done, let fileId = job.fileId else { return }
        if Waveform.isSound(name: job.name, mime: job.mime) {
            soundUploaded(job, fileId: fileId)
            return
        }
        guard let kind = Poster.Kind.of(name: job.name, mime: job.mime) else { return }
        if kind == .image, job.size > Poster.thumbSourceMaxBytes { return }
        let link = Self.workRoot.appendingPathComponent(UUID().uuidString + ThumbnailWorker.suffix(for: job.name))
        do {
            try FileManager.default.linkItem(at: URL(fileURLWithPath: job.staged), to: link)
        } catch {
            // Gone already, or on another disk: the drive's mirror brings the
            // file, and it is made from storage instead.
            log.debug("no link to \(job.name, privacy: .private): \(error.localizedDescription, privacy: .public)")
            return
        }
        let file = ThumbnailWorker.LocalFile(fileId: fileId, scope: job.scope, name: job.name, mime: job.mime,
                                             size: job.size, kind: kind, url: link)
        Task { await worker.offer(file) }
    }

    /// A sound the server has now: its waveform is drawn from the bytes
    /// here, through a link of the maker's own, as a picture is.
    private func soundUploaded(_ job: UploadJob, fileId: String) {
        guard let waveforms else { return }
        let link = Self.soundRoot.appendingPathComponent(UUID().uuidString + ThumbnailWorker.suffix(for: job.name))
        do {
            try FileManager.default.linkItem(at: URL(fileURLWithPath: job.staged), to: link)
        } catch {
            log.debug("no link to \(job.name, privacy: .private): \(error.localizedDescription, privacy: .public)")
            return
        }
        let sound = WaveformMaker.Sound(fileId: fileId, name: job.name, url: link)
        Task { await waveforms.offer(sound) }
    }

    /// Whether this account may change files in the drive, as the drive
    /// list says (`can`, or from an older server the drive role). A drive
    /// it may only view is not looked at: every file would be a refusal.
    /// The server checks each file whatever this says.
    private func mayChange(in scope: SyncDomain) -> Bool {
        guard let model else { return false }
        switch scope {
        case .library:
            if let can = model.libraryCan { return can.edit == true }
            return model.isAdmin
        case let .drive(id):
            // Not listed yet: the server is asked, file by file.
            guard let drive = model.drives.first(where: { $0.id == id }) else { return true }
            if let can = drive.can { return can.edit == true }
            return drive.role == "editor" || drive.role == "owner"
        }
    }

    // MARK: - Where things are

    /// ~/Library/Caches/<bundle id>/Thumbnails: this app's own, a dev
    /// build's apart from the real one's. The worker empties it as it
    /// starts; nothing in it outlives its job.
    nonisolated static var workRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? OnyxIdentifiers.app, isDirectory: true)
            .appendingPathComponent("Thumbnails", isDirectory: true)
    }

    /// Beside workRoot, for the sounds WaveformMaker has in hand: emptied as
    /// it starts, and nothing in it outlives its sound.
    nonisolated static var soundRoot: URL {
        workRoot.deletingLastPathComponent().appendingPathComponent("Waveforms", isDirectory: true)
    }

    /// ~/Library/Application Support/Onyx/Thumbnails/account-<hash>.json:
    /// what came of each file, for one account on one server.
    nonisolated static func ledger(server: URL, account: String) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("\(OnyxIdentifiers.folderName)/Thumbnails", isDirectory: true)
            .appendingPathComponent(AccountFolder.name(server: server, account: account) + ".json")
    }

    /// Each sound's end, in the log.
    nonisolated static func note(_ sound: WaveformMaker.Sound, _ outcome: WaveformMaker.Outcome) {
        switch outcome {
        case .made:
            log.info("waveform for \(sound.fileId, privacy: .public)")
        case .none:
            log.debug("\(sound.fileId, privacy: .public): no sound to draw")
        case let .failed(why):
            log.error("waveform for \(sound.fileId, privacy: .public) failed: \(why, privacy: .public)")
        }
    }

    /// Each file's end, in the log.
    nonisolated static func note(_ report: ThumbnailWorker.Report) {
        let seconds = String(format: "%.1f", report.seconds)
        switch report.outcome {
        case .made:
            log.info("made \(report.fileId, privacy: .public) in \(seconds, privacy: .public) s, \(report.bytes) bytes")
        case .failed:
            log.error("\(report.fileId, privacy: .public) failed: \(report.detail ?? "", privacy: .public)")
        case .kept, .refused, .unusable:
            log.debug("\(report.fileId, privacy: .public) \(report.outcome.rawValue, privacy: .public): \(report.detail ?? "", privacy: .public)")
        }
    }
}
