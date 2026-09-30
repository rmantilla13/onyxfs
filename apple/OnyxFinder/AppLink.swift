import AppKit
import OnyxFinderCore

/// The extension's way to its app (FinderWire): the app's Mach port for
/// questions and requests, the app's one notification for "the index
/// changed", and LaunchServices to open it. Requests go out on a queue of
/// their own, so Finder's thread never waits on the app.
final class AppLink: @unchecked Sendable {
    /// The app's bundle identifier: io.onyxfs.app, or io.onyxfs.app.dev for
    /// Onyx Dev, whose extension is io.onyxfs.app.dev.findersync.
    let app: String
    /// The Onyx.app this extension is inside.
    let appURL: URL?
    private let client: FinderPortClient
    private let queue = DispatchQueue(label: "io.onyxfs.finder.link", qos: .userInitiated)
    private var signal: FinderSignal?
    /// A fetch is waiting on the queue: more notifications meanwhile are
    /// answered by it. Touched only on `queue`.
    private var fetchQueued = false

    init?(bundle: Bundle) {
        guard let id = bundle.bundleIdentifier, let app = FinderWire.app(forExtension: id) else { return nil }
        self.app = app
        client = FinderPortClient(name: FinderWire.portName(app: app))
        // …/Onyx.app/Contents/PlugIns/OnyxFinder.appex
        let container = bundle.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        appURL = container.pathExtension == "app" ? container : nil
    }

    /// Calls `changed` each time the app says the index changed — it says so
    /// once as it opens, too.
    func watch(_ changed: @escaping @Sendable () -> Void) {
        signal = FinderSignal(name: FinderWire.changedNotification(app: app), queue: queue, handler: changed)
        if signal == nil { finderLog.error("could not watch for the app's changes") }
    }

    /// Whether the app is running to answer: one lookup, nothing sent.
    var isReachable: Bool { client.isReachable }

    /// The app's index, or nil once it is not running; `done` is called on
    /// the link's queue. Asked for again while one fetch waits, it waits for
    /// that one. An app too busy to answer is asked once more, a second
    /// later, and otherwise left: what Finder shows stays as it was, rather
    /// than every mark going for a moment's stall.
    func fetchIndex(_ done: @escaping @Sendable (FinderIndex?) -> Void) {
        queue.async { [self] in
            guard !fetchQueued else { return }
            fetchQueued = true
            queue.async { [self] in
                fetchQueued = false
                fetch(done, retry: true)
            }
        }
    }

    private func fetch(_ done: @escaping @Sendable (FinderIndex?) -> Void, retry: Bool) {
        switch client.ask(.index) {
        case let .answered(data):
            done(FinderIndex.decode(data))
        case .gone:
            done(nil)
        case .noAnswer:
            finderLog.info("Onyx did not answer in time")
            guard retry else { return }
            queue.asyncAfter(deadline: .now() + 1) { [self] in fetch(done, retry: false) }
        }
    }

    /// Keep Offline, Remove Offline Copy, Show in Onyx: sent, not waited for.
    /// What they change comes back as a new index.
    func send(_ message: FinderWire.Message, paths: [String]) {
        guard !paths.isEmpty else { return }
        let body = FinderWire.Request(paths: paths).encoded()
        queue.async { [client] in
            guard let data = client.request(message, body) else {
                finderLog.error("Onyx did not answer a Finder request")
                return
            }
            if let reply = FinderWire.Reply.decode(data), !reply.ok {
                finderLog.info("Onyx declined a Finder request: \(reply.message ?? "", privacy: .public)")
            }
        }
    }

    /// Onyx, brought forward — or opened, when it is not running.
    func openApp() {
        guard let appURL else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, error in
            if let error { finderLog.error("could not open Onyx: \(error.localizedDescription, privacy: .public)") }
        }
    }
}
