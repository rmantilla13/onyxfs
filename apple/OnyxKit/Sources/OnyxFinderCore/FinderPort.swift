#if os(macOS)
import Foundation
import notify

/// The app's end of FinderWire: a Mach port registered under a name
/// (CFMessagePort), answering on a run loop — the main one — as each
/// request comes. Costs nothing while no one asks.
///
/// A Mach port, not XPC: an XPC service by name must be one launchd starts,
/// and this is the app itself, running when it runs. The extension is
/// sandboxed and reaches the port only because its entitlements name it.
/// Anything else running as this user outside a sandbox could reach it too
/// (and could as well read the pins it asks about straight off the disk),
/// so the app acts only on paths inside the drives it has mounted now, and
/// only as Keep Offline and Remove Offline Copy would.
public final class FinderPortServer {
    public typealias Handler = (_ message: Int32, _ body: Data) -> Data

    private final class Box {
        let handler: Handler
        init(_ handler: @escaping Handler) { self.handler = handler }
    }

    private let box: Box
    private var port: CFMessagePort?
    private var source: CFRunLoopSource?
    public let name: String

    /// Nil when the name is taken: another copy of the app answers it.
    public init?(name: String, runLoop: CFRunLoop = CFRunLoopGetMain(), handler: @escaping Handler) {
        self.name = name
        box = Box(handler)
        var context = CFMessagePortContext(version: 0, info: Unmanaged.passUnretained(box).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        var existing: DarwinBoolean = false
        let made = CFMessagePortCreateLocal(nil, name as CFString, { _, message, data, info in
            guard let info else { return nil }
            let box = Unmanaged<Box>.fromOpaque(info).takeUnretainedValue()
            let reply = box.handler(message, (data as Data?) ?? Data())
            return Unmanaged.passRetained(reply as CFData)
        }, &context, &existing)
        // `existing`: a port of that name was made in this process already,
        // and it is that one, answering with its own handler.
        guard let made, !existing.boolValue else { return nil }
        port = made
        let source = CFMessagePortCreateRunLoopSource(nil, made, 0)
        CFRunLoopAddSource(runLoop, source, .commonModes)
        self.source = source
    }

    /// No more answers; the name is free again.
    public func invalidate() {
        if let source { CFRunLoopSourceInvalidate(source) }
        if let port { CFMessagePortInvalidate(port) }
        source = nil
        port = nil
    }

    deinit { invalidate() }
}

/// The extension's end: asks the app's port and waits for its answer, on
/// whatever thread asks (never the main one, in the extension).
public final class FinderPortClient: @unchecked Sendable {
    public let name: String
    private let lock = NSLock()
    private var remote: CFMessagePort?

    public init(name: String) { self.name = name }

    /// The app's port: the one held, while it is good, else looked up again
    /// — the app may have quit, or opened since.
    private func port() -> CFMessagePort? {
        lock.withLock {
            if let remote, CFMessagePortIsValid(remote) { return remote }
            remote = CFMessagePortCreateRemote(nil, name as CFString)
            return remote
        }
    }

    /// Whether the app is there to answer: a lookup, nothing sent.
    public var isReachable: Bool { port() != nil }

    public enum Outcome: Equatable, Sendable {
        case answered(Data)
        /// Not running: no port by that name, or it went.
        case gone
        /// Running, but no answer in time: busy, not gone.
        case noAnswer
    }

    /// Sends and waits at most `timeout` each way.
    public func ask(_ message: FinderWire.Message, _ body: Data = Data(), timeout: TimeInterval = 2) -> Outcome {
        guard let port = port() else { return .gone }
        var reply: Unmanaged<CFData>?
        let status = CFMessagePortSendRequest(port, message.rawValue, body as CFData, timeout, timeout,
                                              Self.replyMode, &reply)
        if status == kCFMessagePortSuccess, let reply { return .answered(reply.takeRetainedValue() as Data) }
        if [kCFMessagePortSendTimeout, kCFMessagePortReceiveTimeout].contains(status) { return .noAnswer }
        // Gone: looked up afresh next time.
        lock.withLock { if self.remote === port { self.remote = nil } }
        return .gone
    }

    /// The answer, or nil: the app is not running, or did not answer in time.
    public func request(_ message: FinderWire.Message, _ body: Data = Data(), timeout: TimeInterval = 2) -> Data? {
        if case let .answered(data) = ask(message, body, timeout: timeout) { return data }
        return nil
    }

    /// A mode of its own to wait for the answer in, so nothing else on the
    /// asking thread's run loop runs meanwhile.
    private static let replyMode = "io.onyxfs.finder.reply" as CFString
}

/// One Darwin notification (notify(3)): a name, no payload, cheap to post
/// and free to wait for. The app posts FinderWire's `changed` name; the
/// extension, sandboxed, may wait for any.
public final class FinderSignal: @unchecked Sendable {
    private var token: Int32 = NOTIFY_TOKEN_INVALID

    /// Calls `handler` on `queue` each time `name` is posted, until cancelled.
    public init?(name: String, queue: DispatchQueue, handler: @escaping @Sendable () -> Void) {
        let status = notify_register_dispatch(name, &token, queue) { _ in handler() }
        guard status == NOTIFY_STATUS_OK else { return nil }
    }

    public func cancel() {
        guard token != NOTIFY_TOKEN_INVALID else { return }
        notify_cancel(token)
        token = NOTIFY_TOKEN_INVALID
    }

    deinit { cancel() }

    public static func post(_ name: String) {
        notify_post(name)
    }
}
#endif
