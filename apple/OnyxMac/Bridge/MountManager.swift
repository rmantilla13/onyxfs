import Foundation
import AppKit
import OnyxKit

/// The Finder mounts: one rclone process per drive, each mounting the app's
/// WebDAV bridge (DAVServer) over macOS's own NFS client — no macFUSE, no
/// system extension, no admin password.
///
/// rclone is the part that makes it stream: its VFS reads a file a chunk at a
/// time as an app asks for it (the bridge redirects each read to storage, so
/// the bytes come straight from the bucket), and keeps what was read in a
/// cache under the location chosen in Settings, so a second look is local.
@MainActor
final class MountManager: ObservableObject {
    enum State: Equatable {
        case mounting
        case mounted(URL)
        case failed(String)
    }

    @Published private(set) var states: [String: State] = [:]
    /// Told when someone ejects a drive in Finder, so it counts as turned off
    /// (and is not mounted again at the next launch).
    var onEjected: ((SyncDomain) -> Void)?

    private struct Running {
        let process: Process
        let mountPoint: URL
    }
    private var running: [String: Running] = [:]

    /// Each scope's mount under way or in place: which attempt it is, and the
    /// folder it holds, which no other scope is given (MountFolder). unmount
    /// and unmountAllNow take it away, and an attempt that finds it gone after
    /// a wait stops there — rather than start rclone for a drive turned off,
    /// or an account signed out, while it waited.
    private struct Claim {
        let attempt: Int
        let mountPoint: URL
    }
    private var claims: [String: Claim] = [:]
    private var attempts = 0

    /// rclone's argument after the mount point, which the stale-mount search
    /// anchors on (MountFolder.rclonePattern). Moving it moves that too.
    nonisolated private static let flagAfterMountPoint = "--read-only"

    /// ~/Onyx: the folder the drives mount inside, one folder per drive.
    /// Private to this account (0700): see prepare(_:).
    static var root: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(OnyxIdentifiers.folderName, isDirectory: true)
    }

    static var rcloneURL: URL? {
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/rclone")
        return FileManager.default.isExecutableFile(atPath: bundled.path) ? bundled : nil
    }

    func state(of scope: SyncDomain) -> State? { states[scope.identifier] }

    /// Mount one drive, reading through `bridge` (http://127.0.0.1:<port>/<segment>).
    func mount(_ scope: SyncDomain, name: String, bridge: URL, token: String,
               cache: URL, cacheLimitGB: Int, logs: URL) async {
        let id = scope.identifier
        switch states[id] {
        case .mounted?, .mounting?:
            // In place, or on its way: one rclone per drive. A second would
            // mount on top of the first, and only one could be stopped.
            return
        case .failed?, nil:
            break
        }
        guard let rclone = Self.rcloneURL else {
            states[id] = .failed("This copy of Onyx has no rclone inside it; build it with scripts/build-mac.sh.")
            return
        }

        // A folder no other scope holds. clearStale below unmounts whatever
        // is at it and stops the rclone serving it, which must never be
        // another drive's.
        let taken = claims.filter { $0.key != id }.map(\.value.mountPoint.lastPathComponent)
        let mountPoint = Self.root.appendingPathComponent(MountFolder.unique(for: scope, name: name, taken: taken),
                                                          isDirectory: true)
        attempts += 1
        let attempt = attempts
        claims[id] = Claim(attempt: attempt, mountPoint: mountPoint)
        states[id] = .mounting
        /// Still wanted: not unmounted, nor signed out, since this began.
        func current() -> Bool { claims[id]?.attempt == attempt }

        await Self.clearStale(mountPoint)
        guard current() else { return }
        do {
            try Self.prepare(mountPoint)
            try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        } catch {
            claims[id] = nil
            states[id] = .failed(error.localizedDescription)
            return
        }

        // A remote name per drive, so each drive's cache is its own
        // (rclone keys its VFS cache by remote name).
        let remote = Self.remoteName(scope)
        let env = ProcessInfo.processInfo.environment.merging([
            "RCLONE_CONFIG_\(remote.uppercased())_TYPE": "webdav",
            "RCLONE_CONFIG_\(remote.uppercased())_URL": bridge.absoluteString,
            // "rclone", not "other": its modification times count (to the
            // second), so they are part of the fingerprint the VFS cache
            // checks a cached file against. Under "other" that is the size
            // alone, and a file replaced by another of the same size would
            // be served from the old one's cached bytes. The bridge's times
            // move with every change to a file (MirrorEntry.modified).
            "RCLONE_CONFIG_\(remote.uppercased())_VENDOR": "rclone",
            // Sent on every request to the bridge. It is not forwarded when
            // rclone follows a read to storage (another host), which is right:
            // the presigned URL carries its own authority.
            "RCLONE_CONFIG_\(remote.uppercased())_BEARER_TOKEN": token,
            // No config file: everything is in the environment.
            "RCLONE_CONFIG": "/dev/null",
        ]) { $1 }

        let log = logs.appendingPathComponent("mount-\(remote).log")
        let process = Process()
        process.executableURL = rclone
        process.environment = env
        process.arguments = [
            "nfsmount", "\(remote):", mountPoint.path,
            // Read-only until saving from Finder goes through Onyx (so what
            // is saved there shows on the web too). Right after the mount
            // point: clearStale finds a leftover rclone by the two together.
            Self.flagAfterMountPoint,
            "--volname", name,
            // This account's files, closed to every other (0600, folders
            // 0700), like ~/Onyx itself. rclone's NFS server on 127.0.0.1
            // cannot tell one local account from another (apple/README.md,
            // "Who can read a mounted drive"); these modes at least keep the
            // other accounts out by way of the file system.
            "--uid", String(getuid()), "--gid", String(getgid()), "--umask", "077",
            // Streaming: read in chunks as asked, keep what was read on disk.
            "--vfs-cache-mode", "full",
            "--cache-dir", cache.path,
            "--vfs-cache-max-size", cacheLimitGB > 0 ? "\(cacheLimitGB)G" : "off",
            "--vfs-cache-max-age", "2160h",
            "--vfs-read-chunk-size", "8M",
            "--vfs-read-chunk-size-limit", "256M",
            "--vfs-read-chunk-streams", "4",
            "--vfs-read-ahead", "128M",
            "--buffer-size", "16M",
            // The bridge is local and answers listings from the synced mirror,
            // so asking again often is cheap — and keeps Finder close to the web.
            "--dir-cache-time", "10s",
            "--attr-timeout", "5s",
            // Soft, so a mount whose rclone is gone fails an operation after
            // a while instead of hanging Finder for ever; 30 s per attempt is
            // far longer than any chunk takes from storage.
            "-o", "soft", "-o", "timeo=300", "-o", "retrans=2",
            // Offline, a file that is neither kept offline nor cached should
            // fail soon, not after rclone's default ten tries.
            "--low-level-retries", "3",
            "--no-checksum",
            "--daemon=false",
            "--log-file", log.path,
            "--log-level", "INFO",
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] p in
            // Which rclone ended, by pid: a late end of one stopped before a
            // remount must not be taken for the new one's.
            let pid = p.processIdentifier, status = p.terminationStatus
            Task { @MainActor in self?.exited(id, pid: pid, status: status, log: log) }
        }
        do {
            try process.run()
        } catch {
            claims[id] = nil
            states[id] = .failed("rclone could not start: \(error.localizedDescription)")
            return
        }
        running[id] = Running(process: process, mountPoint: mountPoint)
        Self.watch(rclone: process.processIdentifier, mountPoint: mountPoint)

        // Mounted once the path is a mount point; give it a few seconds.
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            // Unmounted or signed out meanwhile, which stopped rclone too.
            guard current() else { return }
            if !process.isRunning { return } // exited() said why
            if Self.isMounted(mountPoint) {
                states[id] = .mounted(mountPoint)
                appLog.info("mount: \(id, privacy: .public) at \(mountPoint.path, privacy: .public)")
                return
            }
        }
        // Stopped here rather than by unmount(), which would clear the state
        // — and with it the only sign of why the drive is not in Finder.
        let message = "The drive did not mount. The log is at \(log.path)."
        if let run = running.removeValue(forKey: id) { await Self.stop(run.process, mountPoint: run.mountPoint) }
        guard current() else { return }
        claims[id] = nil
        states[id] = .failed(message)
        appLog.error("mount: \(id, privacy: .public) timed out")
    }

    func unmount(_ scope: SyncDomain) async {
        let id = scope.identifier
        // Also stops an attempt still on its way (see Claim).
        claims[id] = nil
        states[id] = nil
        guard let run = running.removeValue(forKey: id) else { return }
        await Self.stop(run.process, mountPoint: run.mountPoint)
    }

    /// On quit: every mount, synchronously, so none is left behind for the
    /// system to reap. Unmounted first, rclone stopped after (see stop()).
    /// Attempts still on their way stop at their next step.
    func unmountAllNow() {
        let runs = Array(running.values)
        running.removeAll()
        claims.removeAll()
        states.removeAll()
        for run in runs {
            Self.unmountPath(run.mountPoint, force: false)
            if Self.isMounted(run.mountPoint) { Self.unmountPath(run.mountPoint, force: true) }
        }
        for run in runs where run.process.isRunning {
            // Unmounted, rclone exits on its own; a moment, then make it.
            for _ in 0..<10 where run.process.isRunning { usleep(100_000) }
            if run.process.isRunning { run.process.terminate() }
        }
    }

    func reveal(_ scope: SyncDomain) {
        guard case let .mounted(url) = states[scope.identifier] else { return }
        NSWorkspace.shared.open(url)
    }

    private func exited(_ id: String, pid: Int32, status: Int32, log: URL) {
        // An unmount we asked for, or an rclone this drive no longer has —
        // stopped before a remount — whose end says nothing of the mount in
        // place now.
        guard let run = running[id], run.process.processIdentifier == pid else { return }
        running[id] = nil
        claims[id] = nil
        let text = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        // Ejected in Finder: rclone notices its mount went away and exits
        // cleanly. That is someone turning the drive off, not a failure.
        if status == 0, text.split(separator: "\n").suffix(20).contains(where: { $0.contains("unmount detected") }) {
            states[id] = nil
            appLog.info("mount: \(id, privacy: .public) ejected in Finder")
            if let scope = SyncDomain(identifier: id) { onEjected?(scope) }
            return
        }
        let tail = text
            .split(separator: "\n").last(where: { $0.contains("ERROR") || $0.contains("CRITICAL") })
            .map { String($0.suffix(200)) }
        states[id] = .failed(tail ?? "The mount stopped (rclone exited with \(status)).")
        appLog.error("mount: \(id, privacy: .public) exited \(status)")
    }

    // MARK: - Helpers

    static func remoteName(_ scope: SyncDomain) -> String {
        "onyx" + scope.identifier.filter { $0.isLetter || $0.isNumber }.lowercased().prefix(40)
    }

    /// ~/Onyx and the drive's folder in it, private to this account (0700) —
    /// folders an earlier version made readable by everyone included. With
    /// the uid and umask rclone is given, another account on this Mac cannot
    /// reach a mounted drive through the file system. (It can through
    /// rclone's NFS port, which has no authentication: README.)
    ///
    /// A folder that is still a mount point is left alone: asking a mount
    /// whose server has gone can hang, and its mode is the mount's anyway.
    private static func prepare(_ mountPoint: URL) throws {
        let fm = FileManager.default
        let ownerOnly: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        for folder in [root, mountPoint] where !isMounted(folder) {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true, attributes: ownerOnly)
            // createDirectory leaves one that was there as it was.
            do {
                try fm.setAttributes(ownerOnly, ofItemAtPath: folder.path)
            } catch {
                // Not fatal: the mount's own files are 0600/0700 all the
                // same, and the NFS port is open either way.
                appLog.error("mount: could not make \(folder.path, privacy: .public) private: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// From the kernel's mount table, without asking the mount itself: a
    /// statfs on a mount whose server has gone can block, and this runs on
    /// the main thread. getfsstat into a buffer of its own (not getmntinfo's
    /// shared one), since it is called off the main thread too.
    nonisolated static func isMounted(_ path: URL) -> Bool {
        let count = getfsstat(nil, 0, MNT_NOWAIT)
        guard count > 0 else { return false }
        let capacity = Int(count) + 4
        let list = UnsafeMutablePointer<statfs>.allocate(capacity: capacity)
        defer { list.deallocate() }
        let got = getfsstat(list, Int32(capacity * MemoryLayout<statfs>.stride), MNT_NOWAIT)
        guard got > 0 else { return false }
        let wanted = [path.path, path.resolvingSymlinksInPath().path]
        for i in 0..<Int(got) {
            let on = withUnsafePointer(to: &list[i].f_mntonname) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
            }
            if wanted.contains(on) { return true }
        }
        return false
    }

    /// Unmounts, and stops rclone, if Onyx dies without doing it itself — a
    /// crash, a force quit. Otherwise the mount would outlive the bridge it
    /// reads through, and anything touching it would wait on a server that
    /// never answers. A small shell per mount: it outlives the app by design.
    ///
    /// Unmount first, as stop() does, while rclone still answers NFS: rclone
    /// then exits on its own. Signalled while still mounted, rclone runs
    /// `diskutil umount force` itself, which with the bridge gone hangs for
    /// ever — and keeps the folder busy, so the next launch cannot mount it.
    /// The watch ends early if rclone does (so its pid is never reused) —
    /// including once the app has gone: with rclone gone too, the app quit
    /// and unmounted it itself, and what is at the path now may be a new
    /// launch's mount (an update relaunches within a second or two).
    private static func watch(rclone: Int32, mountPoint: URL) {
        let app = ProcessInfo.processInfo.processIdentifier
        let script = """
        ours() { /bin/ps -p \(rclone) -o command= 2>/dev/null | /usr/bin/grep -q nfsmount; }
        while /bin/kill -0 \(app) 2>/dev/null; do ours || exit 0; /bin/sleep 2; done
        ours || exit 0
        /sbin/umount -f "$1" 2>/dev/null
        for i in 1 2 3; do ours || break; /bin/sleep 1; done
        ours && /bin/kill -TERM \(rclone) 2>/dev/null && /bin/sleep 2
        ours && /bin/kill -9 \(rclone) 2>/dev/null
        /usr/bin/pkill -f "diskutil umount force $2\\$" 2>/dev/null
        exit 0
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script, "onyx-mount-watch", mountPoint.path,
                       MountFolder.ereEscaped(mountPoint.path)]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    /// What an earlier run left (a crash the watchdog missed, a force quit
    /// mid-launch): a mount and the rclone still serving it, or rclone's own
    /// `diskutil umount force`, hung on a dead mount — which keeps the folder
    /// busy ("Resource busy") even once nothing is mounted there. Off the
    /// main thread: unmounting a dead mount can take a while.
    ///
    /// Only the rclone whose mount point is exactly this path: not a sibling
    /// whose name begins the same ("Library Archive" beside "Library"). And
    /// only a path no other drive holds (mount() sees to that).
    private static func clearStale(_ mountPoint: URL) async {
        let path = mountPoint.path
        let mounted = isMounted(mountPoint)
        await Task.detached {
            if mounted {
                unmountPath(URL(fileURLWithPath: path), force: true)
                pkill(MountFolder.rclonePattern(mountPoint: path, nextArgument: flagAfterMountPoint))
            }
            pkill("diskutil umount force " + MountFolder.ereEscaped(path) + "$")
        }.value
    }

    nonisolated private static func pkill(_ pattern: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        p.arguments = ["-f", pattern]
        try? p.run()
        p.waitUntilExit()
    }

    /// Unmount first, then stop rclone. Unmounted, rclone exits by itself; a
    /// signal to a still-mounted rclone has it run `diskutil umount force`,
    /// which is slow at best and, with the bridge gone, never finishes.
    private static func stop(_ process: Process, mountPoint: URL) async {
        let path = mountPoint.path
        await Task.detached {
            if isMounted(URL(fileURLWithPath: path)) { unmountPath(URL(fileURLWithPath: path), force: false) }
            if isMounted(URL(fileURLWithPath: path)) { unmountPath(URL(fileURLWithPath: path), force: true) }
        }.value
        for _ in 0..<20 where process.isRunning {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if process.isRunning { process.terminate() }
    }

    /// `umount` is enough for an NFS mount this user made: no password.
    nonisolated private static func unmountPath(_ path: URL, force: Bool) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/sbin/umount")
        p.arguments = force ? ["-f", path.path] : [path.path]
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
    }
}
