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
        // Volumes an earlier run left can no longer reach this run's bridge.
        DiskMounter.clearStale()
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
    /// False when it cannot, and the NFS way is taken instead.
    func mountAsDisk(_ scope: SyncDomain, name: String, mirror: DriveMirror) async -> Bool {
        guard #available(macOS 27.0, *), let disks else { return false }
        await disks.refreshAvailability()
        guard disks.availability == .ready else { return false }
        do {
            let resource = try await onyxfsResourceURL(for: scope)
            await disks.mount(scope, name: name, resource: resource)
            return true
        } catch {
            appLog.error("onyxfs: no resource for \(scope.identifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
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

    enum DiskMode { case disks, needsEnabling, folder }

    /// How drives mount on this Mac: as disks (onyxfs), or in ~/Onyx —
    /// either because this Mac cannot, or because the extension is off.
    var diskMode: DiskMode {
        guard #available(macOS 27.0, *), let disks else { return .folder }
        switch disks.availability {
        case .ready: return .disks
        case .disabled: return .needsEnabling
        case .unknown, .notInstalled: return .folder
        }
    }

    var drivesAreDisks: Bool { diskMode == .disks }

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
            let queue = try UploadQueue(directory: Self.uploadsDirectory(server: server, account: account),
                                        transport: APIUploadTransport(api: model.api))
            uploads = queue
            Task {
                await queue.observe { [weak self] job in
                    Task { @MainActor in await self?.uploadChanged(job) }
                }
                await queue.resume()
                await self.refreshUploadSummary()
            }
        } catch {
            appLog.error("uploads: could not open the queue: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func uploadChanged(_ job: UploadJob) async {
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
