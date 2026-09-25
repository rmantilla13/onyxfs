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

    private struct Running {
        let process: Process
        let mountPoint: URL
    }
    private var running: [String: Running] = [:]

    /// ~/Onyx: the folder the drives mount inside, one folder per drive.
    static var root: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Onyx", isDirectory: true)
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
            "RCLONE_CONFIG_\(remote.uppercased())_VENDOR": "other",
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
    /// system to reap.
    func unmountAllNow() {
        for (_, run) in running {
            run.process.terminate()
            Self.unmountPath(run.mountPoint, force: false)
            if Self.isMounted(run.mountPoint) { Self.unmountPath(run.mountPoint, force: true) }
        }
        running.removeAll()
        states.removeAll()
    }

    func reveal(_ scope: SyncDomain) {
        guard case let .mounted(url) = states[scope.identifier] else { return }
        NSWorkspace.shared.open(url)
    }

    private func exited(_ id: String, status: Int32, log: URL) {
        guard running[id] != nil else { return } // an unmount we asked for
        running[id] = nil
        let tail = (try? String(contentsOf: log, encoding: .utf8))?
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

    static func isMounted(_ path: URL) -> Bool {
        var info = statfs()
        guard statfs(path.path, &info) == 0 else { return false }
        let mountedOn = withUnsafePointer(to: &info.f_mntonname) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
        }
        return mountedOn == path.resolvingSymlinksInPath().path || mountedOn == path.path
    }

    /// A mount left by an earlier run (a crash, a force quit): unmount it and
    /// stop the rclone still serving it, so this run can take the path.
    private static func clearStale(_ mountPoint: URL) async {
        guard isMounted(mountPoint) else { return }
        unmountPath(mountPoint, force: false)
        if isMounted(mountPoint) { unmountPath(mountPoint, force: true) }
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        kill.arguments = ["-f", "nfsmount .* \(mountPoint.path)"]
        try? kill.run()
        kill.waitUntilExit()
    }

    private static func stop(_ process: Process, mountPoint: URL) async {
        process.terminate()
        for _ in 0..<20 where process.isRunning {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if isMounted(mountPoint) { unmountPath(mountPoint, force: false) }
        if isMounted(mountPoint) { unmountPath(mountPoint, force: true) }
    }

    /// `umount` is enough for an NFS mount this user made: no password.
    private static func unmountPath(_ path: URL, force: Bool) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/sbin/umount")
        p.arguments = force ? ["-f", path.path] : [path.path]
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
    }
}
