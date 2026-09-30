import Testing
import Foundation
@testable import OnyxFinderCore

/// A thread with a run loop of its own, for the app's end of the port: the
/// test asks from another thread, as the extension asks from another process.
private final class RunLoopThread: Thread, @unchecked Sendable {
    private let ready = DispatchSemaphore(value: 0)
    private(set) var runLoop: CFRunLoop!

    override func main() {
        runLoop = CFRunLoopGetCurrent()
        // Something to wait on, so the run loop runs until stopped.
        let keepAlive = CFRunLoopTimerCreateWithHandler(nil, .greatestFiniteMagnitude, 0, 0, 0) { _ in }
        CFRunLoopAddTimer(runLoop, keepAlive, .defaultMode)
        ready.signal()
        CFRunLoopRun()
    }

    func startAndWait() -> CFRunLoop {
        start()
        ready.wait()
        return runLoop
    }

    func stop() { CFRunLoopStop(runLoop) }
}

/// The transport itself: a request crosses a real Mach port, as between the
/// app and its extension, and a port no one answers says so at once.
struct FinderPortTests {
    let name = "io.onyxfs.test.finder.\(getpid()).\(UUID().uuidString.prefix(8))"

    @Test func aRequestIsAnsweredOnTheServersRunLoop() throws {
        let thread = RunLoopThread()
        let runLoop = thread.startAndWait()
        defer { thread.stop() }
        let server = try #require(FinderPortServer(name: name, runLoop: runLoop) { message, body in
            Data("\(message):".utf8) + body
        })
        defer { server.invalidate() }
        CFRunLoopWakeUp(runLoop)

        let client = FinderPortClient(name: name)
        #expect(client.isReachable)
        let reply = client.request(.keep, Data("paths".utf8), timeout: 5)
        #expect(reply.map { String(decoding: $0, as: UTF8.self) } == "2:paths")
        // An index is a few hundred kilobytes at most; well past that crosses too.
        let big = Data(repeating: 7, count: 2 << 20)
        #expect(client.request(.index, big, timeout: 5)?.count == big.count + 2)
    }

    @Test func aNameTakenIsRefused() throws {
        let thread = RunLoopThread()
        let runLoop = thread.startAndWait()
        defer { thread.stop() }
        let first = try #require(FinderPortServer(name: name, runLoop: runLoop) { _, _ in Data() })
        defer { first.invalidate() }
        #expect(FinderPortServer(name: name, runLoop: runLoop) { _, _ in Data() } == nil)
    }

    @Test func noOneAnsweringIsNil() {
        let client = FinderPortClient(name: name + ".nobody")
        #expect(!client.isReachable)
        #expect(client.request(.index, timeout: 0.5) == nil)
        #expect(client.ask(.index, timeout: 0.5) == .gone)
    }

    /// A stall is not a quit: the extension keeps its marks through one.
    @Test func anAppTooBusyToAnswerIsNotTakenForGone() throws {
        let thread = RunLoopThread()
        let runLoop = thread.startAndWait()
        defer { thread.stop() }
        let server = try #require(FinderPortServer(name: name, runLoop: runLoop) { _, _ in
            Thread.sleep(forTimeInterval: 1)
            return Data("late".utf8)
        })
        defer { server.invalidate() }
        #expect(FinderPortClient(name: name).ask(.index, timeout: 0.2) == .noAnswer)
    }

    @Test func aServerGoneIsNoLongerReached() throws {
        let thread = RunLoopThread()
        let runLoop = thread.startAndWait()
        defer { thread.stop() }
        let server = try #require(FinderPortServer(name: name, runLoop: runLoop) { _, _ in Data("ok".utf8) })
        let client = FinderPortClient(name: name)
        #expect(client.request(.open, timeout: 5) == Data("ok".utf8))
        server.invalidate()
        #expect(client.request(.open, timeout: 1) == nil)
    }
}
