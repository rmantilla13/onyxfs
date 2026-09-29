import AppKit
import CoreServices
import DiskArbitration
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
/// the app signed with the mount entitlement, and macOS to have taken in
/// this copy's extension. Without any of them `availability` says which,
/// and DriveService mounts the NFS way instead.
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
        /// This copy carries its extension, signed to run, but FSKit does not
        /// list it: macOS is still holding on to an earlier one. Seen after
        /// 0.5.2 replaced a 0.5.1 whose extension had failed as it started —
        /// fskit_agent listed no module for it until fskit_agent restarted,
        /// which a restart of the Mac does.
        case notLoaded
    }

    @Published private(set) var availability: Availability = .unknown
    @Published private(set) var states: [String: MountManager.State] = [:]
    /// Why the last disk that failed to mount did (that drive went to
    /// ~/Onyx instead), for Settings; nil once a disk mounts.
    @Published private(set) var lastFailure: String?
    /// Whether that failure was the extension not starting at all
    /// (didNotStart): DriveService registers this copy again and tries once
    /// more before settling for ~/Onyx.
    private(set) var extensionDidNotStart = false
    /// Ejected from Finder (or unmounted by anything but Onyx): the drive is
    /// no longer wanted there, as with an NFS mount.
    var onEjected: ((SyncDomain) -> Void)?

    /// io.onyxfs.app.fs, or io.onyxfs.app.dev.fs for a dev build.
    static var extensionBundleID: String { (Bundle.main.bundleIdentifier ?? "io.onyxfs.app") + ".fs" }
    /// FSShortName in the extension's Info.plist: what `mount` and statfs call
    /// it — "onyxfs", or "onyxfsdev" for a dev build, so a dev build and the
    /// real Onyx each clear only their own disks (clearStale).
    nonisolated static let fileSystemType: String = {
        let appex = Bundle.main.bundleURL.appendingPathComponent("Contents/Extensions/OnyxFS.appex")
        let attributes = Bundle(url: appex)?.object(forInfoDictionaryKey: "EXAppExtensionAttributes") as? [String: Any]
        return attributes?["FSShortName"] as? String ?? "onyxfs"
    }()

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
            if let ours = modules.first(where: { $0.bundleIdentifier == Self.extensionBundleID }) {
                availability = ours.isEnabled ? .ready : .disabled
            } else {
                availability = BuildInfo.carriesFileSystem ? .notLoaded : .notInstalled
            }
        } catch {
            availability = .notInstalled
            appLog.error("onyxfs: listing file system extensions failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// System Settings, at the pane where the extension is switched on.
    func openSettings() {
        _ = FSClient.shared.openFileSystemExtensionsSettings()
    }

    /// Settings' Turn On: switches the extension on from Onyx itself, through
    /// the call System Settings' own switch makes (FSClient's
    /// setEnabledStateForIdentifier:newState:replyHandler:, declared in FSKit's
    /// FSClientXPC protocol but not in its headers — so looked up at run time).
    ///
    /// On macOS 27.0 that switch refuses every extension not Apple's: fskitd
    /// counts the Settings pane as an unentitled caller with no team, and
    /// answers EPERM before the extension is looked at. Onyx holds FSKit's
    /// mount entitlement and signs its extension with its own team.
    ///
    /// Nil when the extension is on; else why not, in words for Settings.
    func enableExtension() async -> String? {
        let client = FSClient.shared
        let selector = NSSelectorFromString("setEnabledStateForIdentifier:newState:replyHandler:")
        guard client.responds(to: selector) else {
            return "This version of macOS gives Onyx no way to switch it on. Use System Settings instead."
        }
        typealias Call = @convention(c) (AnyObject, Selector, NSString, ObjCBool,
                                         @escaping @convention(block) (NSError?) -> Void) -> Void
        let call = unsafeBitCast(client.method(for: selector), to: Call.self)
        let identifier = Self.extensionBundleID as NSString
        // The daemon answers at once; should its answer never come (its
        // connection dropped), Settings is not left waiting on it.
        let answer: NSError?? = await withCheckedContinuation { done in
            let once = Once()
            call(client, selector, identifier, ObjCBool(true)) { error in
                if once.first() { done.resume(returning: .some(error)) }
            }
            Task {
                try? await Task.sleep(for: .seconds(15))
                if once.first() { done.resume(returning: .none) }
            }
        }
        await refreshAvailability()
        if availability == .ready {
            appLog.info("onyxfs: the file system extension is on (Turn On)")
            return nil
        }
        switch answer {
        case .none:
            return "macOS did not answer. Try again, or switch Onyx on in System Settings."
        case let .some(error?):
            appLog.error("onyxfs: switching the extension on failed: \(error.localizedDescription, privacy: .public)")
            let ns = error as NSError
            if ns.domain == NSPOSIXErrorDomain, ns.code == Int(EPERM) || ns.code == Int(EACCES) {
                return "macOS did not let Onyx switch its file system on. Your drives stay in the Onyx folder, where they stream as before."
            }
            return "macOS could not switch the file system on: \(error.localizedDescription)"
        case .some(nil):
            return "macOS accepted, but the file system is still off. Try again in a moment."
        }
    }

    /// The first of two racing answers wins; the other is dropped.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func first() -> Bool { lock.withLock { defer { done = true }; return !done } }
    }

    /// Mount one drive from its resource URL (a one-time ticket to the
    /// app's bridge — see DriveService.onyxfsResourceURL). Always writable at
    /// the mount: what this account may change is the drive's role, checked
    /// by the extension (EACCES) and the bridge (403) as it is now — a
    /// viewer made an editor needs no remount, and Finder keeps its own
    /// window files on a drive it may only view.
    ///
    /// False when it did not mount: the drive has no disk state left, so
    /// the caller mounts it the NFS way and that mount's state is the one
    /// shown. (Whatever the cause — the app not entitled to mount, the
    /// extension refusing — the drive is still reachable.)
    @discardableResult
    func mount(_ scope: SyncDomain, name: String, resource: URL) async -> Bool {
        let id = scope.identifier
        switch states[id] {
        case .mounted?, .mounting?: return true
        default: break
        }
        states[id] = .mounting
        // macOS's record of this copy is made again first (registerCopy), and
        // a disk the last run left under this drive's name goes.
        await registered?.value
        await staleCleared?.value
        do {
            let path = try await FSClient.shared.mountSingleVolume(
                resource: FSGenericURLResource(url: resource),
                bundleID: Self.extensionBundleID,
                options: [])
            // Turned off while it mounted.
            guard states[id] == .mounting else {
                Self.forceUnmount([path])
                return true
            }
            states[id] = .mounted(path)
            lastFailure = nil
            extensionDidNotStart = false
            // In Finder's sidebar too, which never lists one by itself.
            FinderSidebar.add(path)
            appLog.info("onyxfs: \(id, privacy: .public) is a disk at \(path.path, privacy: .public)")
            return true
        } catch {
            states[id] = nil
            lastFailure = Self.describe(error)
            extensionDidNotStart = Self.didNotStart(error)
            appLog.error("onyxfs: mounting \(id, privacy: .public) failed, so it mounts in ~/Onyx: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Turned off in Onyx: out of the sidebar as well as off the Desktop.
    func unmount(_ scope: SyncDomain) async {
        let id = scope.identifier
        let state = states[id]
        states[id] = nil
        guard case let .mounted(url)? = state else { return }
        FinderSidebar.remove(url)
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
        Self.forceUnmount(urls)
    }

    func reveal(_ scope: SyncDomain) {
        guard case let .mounted(url) = states[scope.identifier] else { return }
        NSWorkspace.shared.open(url)
    }

    /// onyxfs volumes left by an earlier run of the app. Their extension's
    /// session with the bridge ended when that run did, so they can list
    /// nothing any more — and one left in place takes the drive's name, so
    /// this run's disk would be "Footage 1". They go before this run mounts
    /// its own: `mount` waits for this.
    func clearStale() {
        staleCleared = Task.detached(priority: .userInitiated) {
            var stale: [URL] = []
            for url in FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: []) ?? [] {
                var fs = statfs()
                guard statfs(url.path, &fs) == 0 else { continue }
                let type = withUnsafeBytes(of: fs.f_fstypename) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
                if type == Self.fileSystemType { stale.append(url) }
            }
            Self.forceUnmount(stale)
        }
    }

    /// clearStale's work, until it is done.
    private var staleCleared: Task<Void, Never>?

    /// macOS's record of this copy of Onyx, made again before this run
    /// mounts its first disk (register): `mount` waits for this.
    func registerCopy() {
        registered = Task.detached(priority: .userInitiated) { Self.register() }
    }

    /// registerCopy's work, until it is done.
    private var registered: Task<Void, Never>?

    /// For a second try after the extension did not start: the record made
    /// again, now.
    func reregister() async {
        await Task.detached(priority: .userInitiated) { Self.register() }.value
    }

    /// LaunchServices' record of this copy of Onyx and of the extension
    /// inside it, brought up to date, as `lsregister -f` would.
    ///
    /// The extension looks itself up as it starts. An update swaps the new
    /// bundle in by rename, and until something tells LaunchServices, its
    /// record can still describe the copy that was replaced: the extension
    /// finds no record for the bundle it runs from and stops at once
    /// ("Invalid bundle record for current process"), which FSKit reports
    /// as NSCocoaErrorDomain 4099 — didNotStart. After the updates to 0.5.5
    /// and 0.5.6 every drive stayed in ~/Onyx, read-only, until the record
    /// was made again by hand. The updater now does it as it swaps; this is
    /// for a copy an older updater installed, or moved since.
    nonisolated static func register() {
        let status = LSRegisterURL(Bundle.main.bundleURL as CFURL, true)
        if status != 0 {
            appLog.error("onyxfs: registering this copy with LaunchServices failed (\(status, privacy: .public))")
        }
    }

    // MARK: -

    private func unmounted(_ url: URL?) {
        guard let url else { return }
        for (id, state) in states {
            guard case let .mounted(mounted) = state, mounted.standardizedFileURL == url.standardizedFileURL else { continue }
            states[id] = nil
            FinderSidebar.remove(mounted)
            if let scope = SyncDomain(identifier: id) { onEjected?(scope) }
        }
    }

    private static func eject(_ url: URL) async {
        do {
            try await FileManager.default.unmountVolume(at: url, options: [.withoutUI])
        } catch {
            // In use (a file open in an editor): unmounted by force, as
            // quitting would do anyway.
            forceUnmount([url])
        }
    }

    /// Unmounted by force through Disk Arbitration, as Finder's Eject does,
    /// waiting at most `timeout` for all of them. fskitd mounted these, not
    /// this app, so unmount(2) is EPERM here: Disk Arbitration is the way
    /// this app may take its own disks down.
    ///
    /// Blocks: for quitting, which cannot wait for anything, and for work
    /// already off the main thread. Not for long: on macOS 27.0 an onyxfs
    /// disk takes some 10 s to go whatever this app does (Disk Arbitration
    /// waits out an approval nobody gives, then unmounts in milliseconds),
    /// and the request goes on without this app, so quitting does not wait
    /// for it.
    nonisolated static func forceUnmount(_ urls: [URL], timeout: TimeInterval = 2) {
        guard !urls.isEmpty, let session = DASessionCreate(kCFAllocatorDefault) else { return }
        let queue = DispatchQueue(label: "io.onyxfs.disks.unmount")
        DASessionSetDispatchQueue(session, queue)
        defer { DASessionSetDispatchQueue(session, nil) }
        let group = DispatchGroup()
        for url in urls {
            guard let disk = DADiskCreateFromVolumePath(kCFAllocatorDefault, session, url as CFURL) else { continue }
            group.enter()
            DADiskUnmount(disk, DADiskUnmountOptions(kDADiskUnmountOptionForce), { _, dissenter, context in
                if let dissenter {
                    let status = DADissenterGetStatus(dissenter)
                    appLog.error("onyxfs: unmounting a disk failed: \(String(format: "0x%08x", status), privacy: .public)")
                }
                guard let context else { return }
                Unmanaged<DispatchGroup>.fromOpaque(context).takeRetainedValue().leave()
            }, Unmanaged.passRetained(group).toOpaque())
        }
        if group.wait(timeout: .now() + timeout) == .timedOut {
            appLog.info("onyxfs: disks still unmounting after \(Int(timeout), privacy: .public) s; they go on their own")
        }
    }

    /// FSKit could not reach the extension at all: it did not start, or
    /// stopped as it did — NSCocoaErrorDomain 4099 (or 4097), "Couldn't
    /// communicate with a helper application". What a stale LaunchServices
    /// record looks like (register).
    nonisolated static func didNotStart(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == NSCocoaErrorDomain
            && [CocoaError.Code.xpcConnectionInvalid.rawValue, CocoaError.Code.xpcConnectionInterrupted.rawValue].contains(ns.code)
    }

    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSPOSIXErrorDomain, ns.code == Int(EPERM) || ns.code == Int(EACCES) {
            return "macOS did not allow Onyx to mount this drive as a disk. Check that Onyx is on in System Settings › General › Login Items & Extensions › File System Extensions."
        }
        if didNotStart(error) {
            // Registering this copy again did not help (DriveService tried):
            // macOS still holds the old record, which a restart lets go of.
            return "macOS could not start the Onyx file system, as can happen right after Onyx updates. Restart your Mac to make each drive a disk of its own again."
        }
        return "The drive could not be mounted as a disk: \(error.localizedDescription)"
    }
}
