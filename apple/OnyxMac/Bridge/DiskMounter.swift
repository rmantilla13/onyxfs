import AppKit
import FSKit
import OnyxKit

/// Each drive as a disk of its own: an onyxfs volume at /Volumes/<drive>,
/// served by the Onyx file system extension (OnyxFS.appex, apple/ONYXFS.md).
///
/// Unlike the NFS mounts in ~/Onyx (MountManager), an onyxfs volume is a
/// local file system to macOS: it has the drive's name and its own size,
/// sits in Finder's sidebar under Locations and on the Desktop, and ejects
/// like any disk. The bytes still stream — the extension reads storage in
/// chunks and keeps what it read — so a 40 GB master scrubs without being
/// downloaded first.
///
/// It needs macOS 27 (FSClient's mountSingleVolume, which mounts into
/// /Volumes without an administrator), the extension enabled in System
/// Settings › General › Login Items & Extensions › File System Extensions,
/// and the app signed with the mount entitlement. Without any of them
/// `availability` says which, and DriveService mounts the NFS way instead.
///
/// The states are MountManager's, so the menus, Settings and the page show a
/// disk exactly as they show a mount.
@available(macOS 27.0, *)
@MainActor
final class DiskMounter: ObservableObject {
    enum Availability: Equatable {
        case unknown
        /// Installed, enabled, and this copy may mount.
        case ready
        /// This copy of Onyx was built without the extension (or without
        /// the entitlement to mount it).
        case notInstalled
        /// Installed, but switched off in System Settings.
        case disabled
    }

    @Published private(set) var availability: Availability = .unknown
    @Published private(set) var states: [String: MountManager.State] = [:]
    /// Ejected from Finder (or unmounted by anything but Onyx): the drive is
    /// no longer wanted there, as with an NFS mount.
    var onEjected: ((SyncDomain) -> Void)?

    /// io.onyxfs.app.fs, or io.onyxfs.app.dev.fs for a dev build.
    static var extensionBundleID: String { (Bundle.main.bundleIdentifier ?? "io.onyxfs.app") + ".fs" }
    /// FSShortName in OnyxFS/Info.plist: what `mount` and statfs call it.
    static let fileSystemType = "onyxfs"

    private var watching: NSObjectProtocol?

    init() {
        watching = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didUnmountNotification, object: nil, queue: .main
        ) { [weak self] note in
            let url = note.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL
            MainActor.assumeIsolated { self?.unmounted(url) }
        }
    }

    func state(of scope: SyncDomain) -> MountManager.State? { states[scope.identifier] }

    /// Is the extension here and switched on? Asked again whenever Settings
    /// opens or a mount is about to happen: the person may have just enabled it.
    func refreshAvailability() async {
        do {
            let modules = try await FSClient.shared.installedExtensions
            guard let ours = modules.first(where: { $0.bundleIdentifier == Self.extensionBundleID }) else {
                availability = .notInstalled
                return
            }
            availability = ours.isEnabled ? .ready : .disabled
        } catch {
            availability = .notInstalled
            appLog.error("onyxfs: listing file system extensions failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// System Settings, at the pane where the extension is switched on.
    func openSettings() {
        _ = FSClient.shared.openFileSystemExtensionsSettings()
    }

    /// Mount one drive from its resource URL (a one-time ticket to the
    /// app's bridge — see DriveService.onyxfsResourceURL). Always writable at
    /// the mount: what this account may change is the drive's role, checked
    /// by the extension (EACCES) and the bridge (403) as it is now — a
    /// viewer made an editor needs no remount, and Finder keeps its own
    /// window files on a drive it may only view.
    func mount(_ scope: SyncDomain, name: String, resource: URL) async {
        let id = scope.identifier
        switch states[id] {
        case .mounted?, .mounting?: return
        default: break
        }
        states[id] = .mounting
        do {
            let path = try await FSClient.shared.mountSingleVolume(
                resource: FSGenericURLResource(url: resource),
                bundleID: Self.extensionBundleID,
                options: [])
            // Turned off while it mounted.
            guard states[id] == .mounting else {
                Self.unmountPath(path)
                return
            }
            states[id] = .mounted(path)
            appLog.info("onyxfs: \(id, privacy: .public) is a disk at \(path.path, privacy: .public)")
        } catch {
            states[id] = .failed(Self.describe(error))
            appLog.error("onyxfs: mounting \(id, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func unmount(_ scope: SyncDomain) async {
        let id = scope.identifier
        let state = states[id]
        states[id] = nil
        guard case let .mounted(url)? = state else { return }
        await Self.eject(url)
    }

    /// Quitting or signing out: every disk goes now, without waiting, as
    /// MountManager does with its mounts.
    func unmountAllNow() {
        let urls = states.values.compactMap { state -> URL? in
            if case let .mounted(url) = state { return url }
            return nil
        }
        states = [:]
        for url in urls { Self.unmountPath(url) }
    }

    func reveal(_ scope: SyncDomain) {
        guard case let .mounted(url) = states[scope.identifier] else { return }
        NSWorkspace.shared.open(url)
    }

    /// onyxfs volumes left by an earlier run of the app. Their extension's
    /// session with the bridge ended when that run did, so they can list
    /// nothing any more: they go before this run mounts its own.
    static func clearStale() {
        for url in FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: []) ?? [] {
            var fs = statfs()
            guard statfs(url.path, &fs) == 0 else { continue }
            let type = withUnsafeBytes(of: fs.f_fstypename) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
            if type == fileSystemType { unmountPath(url) }
        }
    }

    // MARK: -

    private func unmounted(_ url: URL?) {
        guard let url else { return }
        for (id, state) in states {
            guard case let .mounted(mounted) = state, mounted.standardizedFileURL == url.standardizedFileURL else { continue }
            states[id] = nil
            if let scope = SyncDomain(identifier: id) { onEjected?(scope) }
        }
    }

    private static func eject(_ url: URL) async {
        do {
            try await FileManager.default.unmountVolume(at: url, options: [.withoutUI])
        } catch {
            // In use (a file open in an editor): unmounted by force, as
            // quitting would do anyway.
            unmountPath(url)
        }
    }

    nonisolated private static func unmountPath(_ url: URL) {
        if Darwin.unmount(url.path, 0) != 0 { _ = Darwin.unmount(url.path, MNT_FORCE) }
    }

    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSPOSIXErrorDomain, ns.code == Int(EPERM) || ns.code == Int(EACCES) {
            return "macOS did not allow Onyx to mount this drive as a disk. Check that Onyx is on in System Settings › General › Login Items & Extensions › File System Extensions."
        }
        return "The drive could not be mounted as a disk: \(error.localizedDescription)"
    }
}
