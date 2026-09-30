import Testing
import Foundation
@testable import OnyxKit

/// The update swap (UpdateSwap.script), run as the updater runs it, with
/// stand-ins for lsregister and open that write down what they were asked
/// and which copy was at the path they were given: the new copy is
/// registered before the old one is let go, so Onyx's file system extension
/// is registered throughout and keeps its switch (ONYXFS.md, "Kept on across
/// updates"); a failed swap puts the old copy back; and nothing happens
/// before Onyx has exited.
@Suite struct UpdateSwapTests {
    /// Applications/Onyx.app (the running copy, "old") and staging/Onyx.app
    /// (the new one, "new"), side by side in a folder of their own, and the
    /// two stand-ins.
    final class Stage {
        let root: URL
        let current: URL
        let fresh: URL
        let log: URL
        let lsregister: URL
        let open: URL

        init() throws {
            let fm = FileManager.default
            root = fm.temporaryDirectory.appendingPathComponent("onyx-swap-\(UUID().uuidString)", isDirectory: true)
            current = root.appendingPathComponent("Applications/Onyx.app", isDirectory: true)
            fresh = root.appendingPathComponent("staging/Onyx.app", isDirectory: true)
            log = root.appendingPathComponent("calls.log")
            lsregister = root.appendingPathComponent("bin/lsregister")
            open = root.appendingPathComponent("bin/open")
            try Self.app(current, "old")
            try Self.app(fresh, "new")
            try fm.createDirectory(at: lsregister.deletingLastPathComponent(), withIntermediateDirectories: true)
            // Its arguments, and which copy its last one was then.
            try Self.tool(lsregister, """
            #!/bin/sh
            for last; do :; done
            printf 'lsregister %s [%s]\\n' "$*" "$(cat "$last/Contents/which" 2>/dev/null || echo none)" >> '\(log.path)'
            """)
            try Self.tool(open, """
            #!/bin/sh
            printf 'open %s [%s]\\n' "$1" "$(cat "$1/Contents/which" 2>/dev/null || echo none)" >> '\(log.path)'
            """)
        }

        deinit {
            // A test may have left a folder read-only.
            let apps = root.appendingPathComponent("Applications")
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: apps.path)
            try? FileManager.default.removeItem(at: root)
        }

        static func app(_ url: URL, _ which: String) throws {
            let contents = url.appendingPathComponent("Contents", isDirectory: true)
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            try which.write(to: contents.appendingPathComponent("which"), atomically: true, encoding: .utf8)
        }

        static func tool(_ url: URL, _ text: String) throws {
            try text.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        }

        /// The swap, as a process of its own: waiting on `pid`.
        func start(waitingFor pid: Int32) throws -> Process {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = UpdateSwap.arguments(pid: pid, current: current.path, fresh: fresh.path,
                                               lsregister: lsregister.path, open: open.path)
            try p.run()
            return p
        }

        func swap() throws {
            let p = try start(waitingFor: try Stage.exitedPid())
            p.waitUntilExit()
        }

        var calls: [String] {
            ((try? String(contentsOf: log, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        }

        func which(_ url: URL) -> String? {
            try? String(contentsOf: url.appendingPathComponent("Contents/which"), encoding: .utf8)
        }

        var previous: URL { fresh.deletingLastPathComponent().appendingPathComponent("previous.app") }

        /// The pid of a process that has come and gone (and been reaped): an
        /// app that has quit.
        static func exitedPid() throws -> Int32 {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/true")
            try p.run()
            p.waitUntilExit()
            return p.processIdentifier
        }
    }

    @Test func theNewCopyIsRegisteredBeforeTheOldOneIsLetGo() throws {
        let stage = try Stage()
        try stage.swap()
        #expect(stage.calls == [
            "lsregister -f -R -trusted \(stage.current.path) [new]",
            "lsregister -u \(stage.previous.path) [old]",
            "open \(stage.current.path) [new]",
        ])
        #expect(stage.which(stage.current) == "new")
        #expect(!FileManager.default.fileExists(atPath: stage.previous.path), "the old copy is deleted")
        #expect(!FileManager.default.fileExists(atPath: stage.fresh.path))
    }

    @Test func aMissingNewCopyPutsTheOldOneBackAndLetsNothingGo() throws {
        let stage = try Stage()
        try FileManager.default.removeItem(at: stage.fresh)
        try stage.swap()
        #expect(stage.calls == [
            "lsregister -f -R -trusted \(stage.current.path) [old]",
            "open \(stage.current.path) [old]",
        ])
        #expect(stage.which(stage.current) == "old")
        #expect(!FileManager.default.fileExists(atPath: stage.previous.path))
    }

    @Test func aCopyThatCannotBeMovedAsideIsLeftAsItWas() throws {
        let stage = try Stage()
        // Nothing may be renamed out of a folder that is read-only.
        let apps = stage.current.deletingLastPathComponent()
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: apps.path)
        try stage.swap()
        #expect(stage.calls == [
            "lsregister -f -R -trusted \(stage.current.path) [old]",
            "open \(stage.current.path) [old]",
        ])
        #expect(stage.which(stage.current) == "old")
        #expect(stage.which(stage.fresh) == "new", "the new copy stays where it was unpacked")
    }

    @Test func nothingHappensUntilOnyxHasExited() async throws {
        let stage = try Stage()
        let app = Process()
        app.executableURL = URL(fileURLWithPath: "/bin/sleep")
        app.arguments = ["30"]
        try app.run()
        let swap = try stage.start(waitingFor: app.processIdentifier)
        try await Task.sleep(for: .milliseconds(700))
        #expect(stage.calls.isEmpty)
        #expect(stage.which(stage.current) == "old")
        app.terminate()
        app.waitUntilExit()
        let deadline = Date().addingTimeInterval(10)
        while swap.isRunning, Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        #expect(!swap.isRunning)
        #expect(stage.which(stage.current) == "new")
        #expect(stage.calls.first == "lsregister -f -R -trusted \(stage.current.path) [new]")
    }

    @Test func theUpdaterPassesTheRealTools() {
        let args = UpdateSwap.arguments(pid: 42, current: "/Applications/Onyx.app", fresh: "/tmp/x/Onyx.app")
        #expect(args == ["-c", UpdateSwap.script, "onyx-update", "42", "/Applications/Onyx.app", "/tmp/x/Onyx.app",
                         "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
                         "/usr/bin/open"])
    }
}
