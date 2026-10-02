import Foundation
import os
import OnyxKit

/// Drives as disks of their own (onyxfs, ONYXFS.md) and the writes that come
/// with them. Kept apart from DriveService's own file, which is about the
/// mirrors, the pins and the NFS mounts; here is only what decides between a
/// disk and a mount, and the upload queue behind a disk's writes.
extension DriveService {
    // MARK: - Disks

    @available(macOS 27.0, *)
    var disks: DiskMounter? { diskMounter as? DiskMounter }

    func setUpDisks() {
        guard #available(macOS 27.0, *) else { return }
        let mounter = DiskMounter()
        // Ejected in Finder: no longer wanted there, as with an NFS mount.
        mounter.onEjected = { [weak self] scope in
            guard let self else { return }
            self.forgetWanted(scope)
            self.writers[scope.identifier] = nil
        }
        diskMounter = mounter
        // A disk mounting, failing or ejected shows in the menus and Settings.
        diskForwarding = mounter.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        // Switched on in System Settings while Onyx runs: the drives in
        // ~/Onyx become disks at once (fileSystemSwitchChanged).
        mounter.onAvailabilityChange = { [weak self] old, new in
            self?.fileSystemSwitchChanged(from: FileSystemSwitch.State(old), to: FileSystemSwitch.State(new))
        }
        // macOS's record of this copy, made again before the first disk
        // mounts: an update swapped in by rename can leave it describing the
        // copy it replaced, and the extension will not start (DiskMounter.register).
        mounter.registerCopy()
        // Volumes an earlier run left can no longer reach this run's bridge.
        mounter.clearStale()
        Task { await mounter.refreshAvailability() }
    }

    var diskStates: [MountManager.State] {
        guard #available(macOS 27.0, *), let disks else { return [] }
        return Array(disks.states.values)
    }

    func diskState(of scope: SyncDomain) -> MountManager.State? {
        guard #available(macOS 27.0, *) else { return nil }
        return disks?.state(of: scope)
    }

    /// Mounts the drive as a disk if this Mac can: macOS 27, the extension
    /// switched on in System Settings, and this copy entitled to mount.
    /// False when it cannot — or tried and the disk did not mount — and the
    /// NFS way is taken instead.
    func mountAsDisk(_ scope: SyncDomain, name: String, mirror: DriveMirror) async -> Bool {
        guard #available(macOS 27.0, *), let disks else { return false }
        await disks.refreshAvailability()
        guard disks.availability == .ready else {
            appLog.info("onyxfs: \(scope.identifier, privacy: .public) mounts in ~/Onyx, as the file system is \(String(describing: disks.availability), privacy: .public)")
            return false
        }
        // Twice at most. When the extension did not start at all — most often
        // a stale record of this copy after an update (DiskMounter.register)
        // — the record is made again and the disk tried once more, on a new
        // ticket: the first one's session ended with its failure.
        for attempt in 1...2 {
            do {
                let resource = try await onyxfsResourceURL(for: scope)
                if await disks.mount(scope, name: name, resource: resource) {
                    syncDiskIcon(scope)
                    return true
                }
            } catch {
                appLog.error("onyxfs: no resource for \(scope.identifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
                return false
            }
            // Its bridge session and writer are for a disk that is not there.
            writers[scope.identifier] = nil
            endOnyxfsSessions(for: scope)
            guard attempt == 1, disks.extensionDidNotStart else { return false }
            appLog.info("onyxfs: the file system did not start for \(scope.identifier, privacy: .public); registering this copy with macOS and trying again")
            await disks.reregister()
        }
        return false
    }

    /// Each mounted disk's icon, as its drive now is on the web (DiskIcons):
    /// after the drive list comes, which may bring a new colour or name.
    func drivesChanged() {
        guard let model else { return }
        for drive in model.finderDrives { syncDiskIcon(.drive(id: drive.id)) }
    }

    /// The library's disk is the app's own icon, which no drive changes.
    func syncDiskIcon(_ scope: SyncDomain) {
        guard #available(macOS 27.0, *), let disks, case let .drive(id) = scope,
              case let .mounted(volume)? = disks.state(of: scope),
              let drive = model?.drives.first(where: { $0.id == id }) else { return }
        DiskIcons.sync(scope, volume: volume, color: drive.color, name: drive.name)
    }

    func diskUnmount(_ scope: SyncDomain) async {
        writers[scope.identifier] = nil
        guard #available(macOS 27.0, *), let disks else { return }
        await disks.unmount(scope)
        endOnyxfsSessions(for: scope)
    }

    func diskReveal(_ scope: SyncDomain) {
        guard #available(macOS 27.0, *) else { return }
        disks?.reveal(scope)
    }

    func disksUnmountAllNow() {
        guard #available(macOS 27.0, *) else { return }
        disks?.unmountAllNow()
    }

    func stopDisks() {
        disksUnmountAllNow()
        writers = [:]
        uploads = nil
        uploadSummaryRound += 1
        uploadTicker?.cancel()
        uploadTicker = nil
        uploadSummary = UploadSummary()
    }

    enum DiskMode { case disks, needsEnabling, needsRestart, folder }

    /// How drives mount on this Mac: as disks (onyxfs), or in ~/Onyx —
    /// because this Mac cannot, because the extension is off, or because
    /// macOS has not taken in this copy's extension yet.
    var diskMode: DiskMode {
        guard #available(macOS 27.0, *), let disks else { return .folder }
        switch disks.availability {
        case .ready: return .disks
        case .disabled: return .needsEnabling
        case .notLoaded: return .needsRestart
        case .unknown, .notInstalled: return .folder
        }
    }

    var drivesAreDisks: Bool { diskMode == .disks }

    /// Turn On: the file system extension switched on from Onyx, then the
    /// drives in ~/Onyx moved to disks of their own. Offered only where macOS
    /// may allow it (offersTurnOn); a refusal is remembered for this macOS, and
    /// the button goes. Why it did not work, when it did not, is turnOnProblem.
    func turnOnDisks() async {
        guard !turningOnDisks else { return }
        turningOnDisks = true
        turnOnProblem = nil
        defer { turningOnDisks = false }
        guard #available(macOS 27.0, *), let disks else {
            turnOnProblem = "Disks of their own need macOS 27."
            return
        }
        switch await disks.enableExtension() {
        case .on:
            objectWillChange.send()
            await remountAsDisks()
        case let .refused(why):
            FileSystemSwitch.refused(on: .current, memory: &switchMemory)
            switchMemory.save()
            turnOnProblem = why
        case let .failed(why):
            turnOnProblem = why
        }
    }

    /// Why the last drive that should have been a disk is in ~/Onyx instead.
    var diskFailure: String? {
        guard #available(macOS 27.0, *) else { return nil }
        return disks?.lastFailure
    }

    /// System Settings, at the File System Extensions switch: the way to
    /// switch the Onyx file system on (only the person can, FileSystemSwitch).
    /// Then Onyx watches for it coming on (watchForSwitch), and moves the
    /// drives in ~/Onyx to disks the moment it does.
    func openFileSystemSettings() {
        guard #available(macOS 27.0, *), let disks else { return }
        disks.openSettings()
        settingsOpenedAt = .now
        watchForSwitch()
    }

    // MARK: - The file system's switch

    /// Whether Onyx offers its own Turn On here, beside System Settings
    /// (FileSystemSwitch.offersTurnOn): macOS 27.0 only, until refused.
    var offersTurnOn: Bool { FileSystemSwitch.offersTurnOn(switchMemory, on: .current) }

    /// Why drives in Finder are in ~/Onyx rather than disks of their own: the
    /// Onyx file system switched off, or not yet taken in by macOS, or a disk
    /// that would not mount. For the menu bar's panel, so the fallback is
    /// never silent. Nil while they are disks, while no drive is in ~/Onyx,
    /// and on a Mac that cannot have disks at all.
    enum FileSystemNote: Equatable {
        case switchedOff
        case needsRestart
        /// On, but a disk did not mount (DiskMounter.lastFailure, in words).
        case failed(String)
    }

    var fileSystemNote: FileSystemNote? {
        guard !mounts.states.isEmpty else { return nil }
        switch diskMode {
        case .needsEnabling: return .switchedOff
        case .needsRestart: return .needsRestart
        case .disks: return diskFailure.map(FileSystemNote.failed)
        case .folder: return nil
        }
    }

    /// Drives are in ~/Onyx because the switch is off, or macOS has not taken
    /// the file system in: what FSKit is asked about again, and again.
    private var waitingForSwitch: Bool {
        !mounts.states.isEmpty && (diskMode == .needsEnabling || diskMode == .needsRestart)
    }

    /// Once a run, as the drives first come back: is the Onyx file system as
    /// the person left it? Off, when it was on the last time Onyx looked,
    /// they are told why their drives are in ~/Onyx, once (a notice, and the
    /// panel's row) — or, only after Onyx was replaced and only where macOS
    /// may allow it, Onyx switches it back on itself, once (FileSystemSwitch).
    func decideFileSystemSwitch() async {
        guard #available(macOS 27.0, *), let disks, !switchDecided else { return }
        if disks.availability == .unknown { await disks.refreshAvailability() }
        guard !switchDecided else { return }
        switchDecided = true
        let state = FileSystemSwitch.State(disks.availability)
        let action = FileSystemSwitch.atLaunch(state, drivesInFinder: !wantMounted.isEmpty,
                                               build: BuildInfo.fullVersion, system: .current, memory: &switchMemory)
        switchMemory.save()
        await perform(action)
    }

    private func perform(_ action: FileSystemSwitch.Action) async {
        guard #available(macOS 27.0, *), let disks else { return }
        switch action {
        case .none:
            return
        case .turnOn:
            appLog.info("onyxfs: the file system is off since Onyx was replaced, though it was on before; switching it back on, once")
            let answer = await disks.enableExtension()
            if answer == .on {
                appLog.info("onyxfs: switched back on")
                await remountAsDisks()
            }
            var refused = false
            if case .refused = answer { refused = true }
            let next = FileSystemSwitch.turnOnAnswered(on: answer == .on, refused: refused,
                                                       drivesInFinder: !wantMounted.isEmpty,
                                                       system: .current, memory: &switchMemory)
            switchMemory.save()
            await perform(next)
        case let .tell(reason):
            appLog.info("onyxfs: drives are in ~/Onyx, as the file system is \(reason == .needsRestart ? "not taken in by macOS" : "off", privacy: .public) though it was on before; telling the person")
            SystemNotices.shared.fileSystemOff(needsRestart: reason == .needsRestart)
        }
    }

    /// FSKit answered differently. On again — switched on in System Settings,
    /// most likely while the person was there, or FSKit answering again after
    /// a failure — the drives in ~/Onyx become disks of their own now, not at
    /// the next launch.
    func fileSystemSwitchChanged(from old: FileSystemSwitch.State, to new: FileSystemSwitch.State) {
        let change = FileSystemSwitch.changed(from: old, to: new, memory: &switchMemory)
        switchMemory.save()
        switch change {
        case .becameReady:
            appLog.info("onyxfs: the file system is on now; the drives in ~/Onyx become disks of their own")
            switchWatch?.cancel()
            switchWatch = nil
            settingsOpenedAt = nil
            switchDidNotTake = false
            turnOnProblem = nil
            Task { await remountAsDisks() }
        case .switchedOff:
            appLog.info("onyxfs: the file system was switched off while Onyx ran")
        case .none:
            break
        }
    }

    /// FSKit asked again whether the Onyx file system is on — only while
    /// drives are in ~/Onyx because it is not (or `always`, for Settings ›
    /// Finder, which says either way). One message to FSKit; nothing at all
    /// while drives are disks. With each tick, and as the menu bar's panel
    /// or Onyx comes forward: switched on in System Settings by any way, the
    /// drives move within a tick.
    func checkFileSystemSwitch(always: Bool = false) async {
        guard #available(macOS 27.0, *), let disks else { return }
        guard always || waitingForSwitch else { return }
        await disks.refreshAvailability()
    }

    /// Onyx came forward: from System Settings, perhaps. Sent there a while
    /// ago and the file system still off, the note adds that a restart may
    /// be what it takes (in this Mac's case, the one thing that did).
    func cameForward() {
        guard let opened = settingsOpenedAt, ContinuousClock.now - opened > Self.settingsGrace else {
            Task { await checkFileSystemSwitch() }
            return
        }
        Task {
            await checkFileSystemSwitch(always: true)
            if diskMode == .needsEnabling { switchDidNotTake = true }
        }
    }

    /// Long enough in System Settings to have found the switch.
    static let settingsGrace: Duration = .seconds(15)

    /// While the person is in System Settings: FSKit asked every 2 s, for up
    /// to three minutes, whether the file system is on, and it stops the
    /// moment it is (fileSystemSwitchChanged moves the drives). Still off at
    /// the end, the note adds the restart. Nothing is asked otherwise.
    private func watchForSwitch() {
        switchWatch?.cancel()
        switchDidNotTake = false
        switchWatch = Task { [weak self] in
            let until = ContinuousClock.now + .seconds(180)
            while ContinuousClock.now < until {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                guard self.diskMode == .needsEnabling || self.diskMode == .needsRestart else { return }
                await self.checkFileSystemSwitch(always: true)
            }
            guard !Task.isCancelled, let self else { return }
            self.switchWatch = nil
            if self.diskMode == .needsEnabling { self.switchDidNotTake = true }
        }
    }

    // MARK: - Uploads

    /// The queue's news of it moves the menu (summarizeUploads).
    func retryUpload(_ id: UUID) {
        Task { await uploads?.retry(id) }
    }

    /// ~/Library/Application Support/Onyx/Uploads/<account>: what is on its
    /// way, per account, so a sign-in as someone else neither sends nor
    /// sees another account's files.
    static func uploadsDirectory(server: URL, account: String) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("\(OnyxIdentifiers.folderName)/Uploads", isDirectory: true)
            .appendingPathComponent(AccountFolder.name(server: server, account: account), isDirectory: true)
    }

    func openUploads(account: String, server: URL) {
        guard let model else { return }
        do {
            let transfers = self.transfers
            let queue = try UploadQueue(directory: Self.uploadsDirectory(server: server, account: account),
                                        transport: APIUploadTransport(api: model.api,
                                                                      sent: { transfers.add(.upload, $0) }))
            uploads = queue
            let wanted = uploadSummaryWanted
            Task { [weak self] in
                await queue.observe { [weak self] job in
                    // The writer and the thumbnails hear what they act on;
                    // a job going from waiting to sending is not that, and
                    // a thousand files copied in are four thousand changes.
                    if Self.writerHears(job) {
                        Task { @MainActor in await self?.uploadChanged(job) }
                    }
                    // The menu's summary: one loop, however many changes.
                    let first = wanted.withLock { asked in
                        defer { asked = true }
                        return !asked
                    }
                    if first { Task { @MainActor in self?.summarizeUploads() } }
                }
                await queue.resume()
                self?.summarizeUploads()
            }
        } catch {
            appLog.error("uploads: could not open the queue: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// What the drive's writer acts on (DriveWriter.uploadChanged): a job
    /// done, failed, or waiting afresh (just queued, or tried again).
    nonisolated static func writerHears(_ job: UploadJob) -> Bool {
        job.state == .done || job.state == .failed || (job.state == .queued && job.attempts == 0)
    }

    private func uploadChanged(_ job: UploadJob) async {
        // First: once the writer hears the upload is done and the mirror
        // shows the file, the queue's copy of its bytes goes.
        if job.state == .done { onUploadFinished?(job) }
        await writers[job.scope]?.uploadChanged(job)
        if job.state == .failed, let why = job.lastError {
            appLog.error("uploads: \(job.name, privacy: .public) failed: \(why, privacy: .public)")
        }
    }

    /// The menu's summary, asked of the queue in one question
    /// (UploadQueue.summary) at most four times a second: while anything
    /// is on its way, so the percentage moves, and after any change. Not at
    /// all while nothing is. It asked for every job, and each one's
    /// progress in turn, on every change to any of them.
    func summarizeUploads() {
        guard uploadTicker == nil else { return }
        let round = uploadSummaryRound, wanted = uploadSummaryWanted
        uploadTicker = Task { [weak self] in
            while let self, let uploads = self.uploads, round == self.uploadSummaryRound, !Task.isCancelled {
                wanted.withLock { $0 = false }
                let summary = await uploads.summary()
                guard round == self.uploadSummaryRound else { return }
                if summary != self.uploadSummary { self.uploadSummary = summary }
                // How much is left, and how long it should take.
                if summary.waiting > 0 {
                    self.uploadPace.note(moved: summary.movedBytes, at: ProcessInfo.processInfo.systemUptime)
                } else {
                    self.uploadPace.reset()
                }
                let estimate = self.uploadPace.estimate(remaining: summary.remainingBytes)
                if estimate?.rounded != self.uploadEstimate?.rounded { self.uploadEstimate = estimate }
                // Uploads on their way keep the drives' ticks at their pace.
                if summary.waiting > 0 { self.noteActivity() }
                guard summary.waiting > 0 || wanted.withLock({ $0 }) else { break }
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard let self, round == self.uploadSummaryRound else { return }
            self.uploadTicker = nil
            // Told of a change after the last look: one more loop for it.
            if wanted.withLock({ $0 }) { self.summarizeUploads() }
        }
    }

    /// The writer for a drive with a disk: made on the first change Finder
    /// makes in it.
    func writer(for scope: SyncDomain) async -> DriveWriter? {
        if let existing = writers[scope.identifier] { return existing }
        guard let uploads, let model else { return nil }
        guard let mirror = await mirrorForWrites(scope) else { return nil }
        let filespaceId: String? = if case let .drive(id) = scope { id } else { nil }
        let tree = MirrorTree(mirror: mirror,
                              refresh: { [weak self] in await self?.syncForWrites(scope) },
                              refreshSoon: { [weak self] in await self?.syncSoon(scope) })
        let writer = DriveWriter(scope: scope.identifier, filespaceId: filespaceId, api: model.api,
                                 tree: tree, uploads: uploads)
        writers[scope.identifier] = writer
        return writer
    }
}

/// What the menu bar says about uploads: the queue's own summary.
typealias UploadSummary = UploadQueue.Summary

extension UploadPace.Estimate {
    /// As much as the panel shows of it: the panel is drawn again only when
    /// this changes, not four times a second.
    var rounded: [Int] { [Int(secondsLeft.rounded()), Int((bytesPerSecond / 10_000).rounded())] }
}

@available(macOS 27.0, *)
extension FileSystemSwitch.State {
    /// FSKit's answer, as FileSystemSwitch (OnyxKit, no FSKit) takes it.
    init(_ availability: DiskMounter.Availability) {
        switch availability {
        case .unknown: self = .unknown
        case .ready: self = .ready
        case .disabled: self = .disabled
        case .notLoaded: self = .notLoaded
        case .notInstalled: self = .notInstalled
        }
    }
}
