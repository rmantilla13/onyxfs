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

    /// ~/Onyx: the folder the drives mount inside, one folder per drive.
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
        if case .mounted = states[id] { return }
        guard let rclone = Self.rcloneURL else {
            states[id] = .failed("This copy of Onyx has no rclone inside it; build it with scripts/build-mac.sh.")
            return
        }
        states[id] = .mounting

        let mountPoint = Self.root.appendingPathComponent(Self.folderName(name), isDirectory: true)
        await Self.clearStale(mountPoint)
        do {
            try FileManager.default.createDirectory(at: mountPoint, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        } catch {
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
            // is saved there shows on the web too).
            "--read-only",
            "--volname", name,
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
            Task { @MainActor in self?.exited(id, status: p.terminationStatus, log: log) }
        }
        do {
            try process.run()
        } catch {
            states[id] = .failed("rclone could not start: \(error.localizedDescription)")
            return
        }
        running[id] = Running(process: process, mountPoint: mountPoint)
        Self.watch(rclone: process.processIdentifier, mountPoint: mountPoint)

        // Mounted once the path is a mount point; give it a few seconds.
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if !process.isRunning { return } // exited() said why
            if Self.isMounted(mountPoint) {
                states[id] = .mounted(mountPoint)
                appLog.info("mount: \(id, privacy: .public) at \(mountPoint.path, privacy: .public)")
                return
            }
        }
        states[id] = .failed("The drive did not mount. The log is at \(log.path).")
        await unmount(scope)
    }

    func unmount(_ scope: SyncDomain) async {
        let id = scope.identifier
        guard let run = running.removeValue(forKey: id) else { states[id] = nil; return }
        states[id] = nil
        await Self.stop(run.process, mountPoint: run.mountPoint)
    }

    /// On quit: every mount, synchronously, so none is left behind for the
    /// system to reap. Unmounted first, rclone stopped after (see stop()).
    func unmountAllNow() {
        let runs = Array(running.values)
        running.removeAll()
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

    private func exited(_ id: String, status: Int32, log: URL) {
        guard running[id] != nil else { return } // an unmount we asked for
        running[id] = nil
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

    /// A drive's folder under ~/Onyx: its name, made safe for a path.
    static func folderName(_ name: String) -> String {
        let cleaned = name.map { $0 == "/" || $0 == ":" ? "-" : $0 }.filter { !$0.isNewline }
        let s = String(cleaned).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return s.isEmpty ? "Drive" : s
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
    /// The watch ends early if rclone does (so its pid is never reused).
    private static func watch(rclone: Int32, mountPoint: URL) {
        let app = ProcessInfo.processInfo.processIdentifier
        let script = """
        ours() { /bin/ps -p \(rclone) -o command= 2>/dev/null | /usr/bin/grep -q nfsmount; }
        while /bin/kill -0 \(app) 2>/dev/null; do ours || exit 0; /bin/sleep 2; done
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
                       NSRegularExpression.escapedPattern(for: mountPoint.path)]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    /// What an earlier run left (a crash the watchdog missed, a force quit
    /// mid-launch): a mount and the rclone still serving it, or rclone's own
    /// `diskutil umount force`, hung on a dead mount — which keeps the folder
    /// busy ("Resource busy") even once nothing is mounted there. Off the
    /// main thread: unmounting a dead mount can take a while.
    private static func clearStale(_ mountPoint: URL) async {
        let path = mountPoint.path
        let mounted = isMounted(mountPoint)
        await Task.detached {
            let pattern = NSRegularExpression.escapedPattern(for: path)
            if mounted {
                unmountPath(URL(fileURLWithPath: path), force: true)
                pkill("nfsmount .* " + pattern + "( |$)")
            }
            pkill("diskutil umount force " + pattern + "$")
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
