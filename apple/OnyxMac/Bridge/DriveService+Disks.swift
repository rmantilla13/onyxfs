import Foundation
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

    /// Settings' Turn On: the file system extension switched on from Onyx,
    /// then the drives in ~/Onyx moved to disks of their own. Why it did not
    /// work, when it did not, is turnOnProblem.
    func turnOnDisks() async {
        guard !turningOnDisks else { return }
        turningOnDisks = true
        turnOnProblem = nil
        defer { turningOnDisks = false }
        guard #available(macOS 27.0, *), let disks else {
            turnOnProblem = "Disks of their own need macOS 27."
            return
        }
        if let problem = await disks.enableExtension() {
            turnOnProblem = problem
            return
        }
        objectWillChange.send()
        await remountAsDisks()
    }

    /// Why the last drive that should have been a disk is in ~/Onyx instead.
    var diskFailure: String? {
        guard #available(macOS 27.0, *) else { return nil }
        return disks?.lastFailure
    }

    func openFileSystemSettings() {
        guard #available(macOS 27.0, *) else { return }
        disks?.openSettings()
        // Back from System Settings, it may be on now.
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await disks?.refreshAvailability()
        }
    }

    // MARK: - Uploads

    func retryUpload(_ id: UUID) {
        Task {
            await uploads?.retry(id)
            await refreshUploadSummary()
        }
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
            Task { [weak self] in
                await queue.observe { [weak self] job in
                    Task { @MainActor in await self?.uploadChanged(job) }
                }
                await queue.resume()
                await self?.refreshUploadSummary()
            }
        } catch {
            appLog.error("uploads: could not open the queue: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func uploadChanged(_ job: UploadJob) async {
        // First: once the writer hears the upload is done and the mirror
        // shows the file, the queue's copy of its bytes goes.
        if job.state == .done { onUploadFinished?(job) }
        await writers[job.scope]?.uploadChanged(job)
        await refreshUploadSummary()
        if job.state == .failed, let why = job.lastError {
            appLog.error("uploads: \(job.name, privacy: .public) failed: \(why, privacy: .public)")
        }
    }

    func refreshUploadSummary() async {
        guard let uploads else { uploadSummary = UploadSummary(); return }
        let jobs = await uploads.all()
        var summary = UploadSummary()
        for job in jobs {
            switch job.state {
            case .queued, .uploading:
                summary.waiting += 1
                summary.totalBytes += job.size
                summary.sentBytes += await uploads.sent(job.id)
                if summary.current == nil { summary.current = job.name }
            case .failed:
                summary.failed.append(job)
            case .done:
                break
            }
        }
        uploadSummary = summary
        // While something is on its way, the percentage moves every second
        // (one ticker, however many changes asked for a refresh).
        if summary.waiting > 0, uploadTicker == nil {
            uploadTicker = Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                self.uploadTicker = nil
                await self.refreshUploadSummary()
            }
        }
    }

    /// The writer for a drive with a disk: made on the first change Finder
    /// makes in it.
    func writer(for scope: SyncDomain) async -> DriveWriter? {
        if let existing = writers[scope.identifier] { return existing }
        guard let uploads, let model else { return nil }
        guard let mirror = await mirrorForWrites(scope) else { return nil }
        let filespaceId: String? = if case let .drive(id) = scope { id } else { nil }
        let tree = MirrorTree(mirror: mirror) { [weak self] in await self?.syncForWrites(scope) }
        let writer = DriveWriter(scope: scope.identifier, filespaceId: filespaceId, api: model.api,
                                 tree: tree, uploads: uploads)
        writers[scope.identifier] = writer
        return writer
    }
}

/// What the menu bar says about uploads.
struct UploadSummary: Equatable {
    var waiting = 0
    var sentBytes: Int64 = 0
    var totalBytes: Int64 = 0
    /// The name of one on its way, for "Uploading Take 1.mov".
    var current: String?
    var failed: [UploadJob] = []

    var fraction: Double { totalBytes > 0 ? min(1, Double(sentBytes) / Double(totalBytes)) : 0 }
}
