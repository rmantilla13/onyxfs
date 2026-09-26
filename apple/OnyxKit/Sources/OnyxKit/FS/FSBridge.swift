import Foundation

/// The onyxfs routes on the bridge's listener (`/fs/v1/…`): the sessions,
/// and one FSResponder per drive mounted as a disk.
///
/// The socket layer (the Mac app's DAVServer) sends every request under
/// `/fs/v1/` here instead of to a WebDAV route. Only `POST /fs/v1/session`
/// is answered without a session — it is where a ticket is traded for one —
/// and everything else goes to the responder of the session's own drive, so
/// a session reaches nothing else. The WebDAV routes neither take a session
/// key nor are reachable here with rclone's token.
public final class FSBridge: @unchecked Sendable {
    public let sessions: FSSessions
    private let lock = NSLock()
    private var responders: [String: FSResponder] = [:]
    /// `changes` long-polls under way, by session, and in all.
    private var polls: [String: Int] = [:]
    private var pollCount = 0

    /// The resource URL's scheme. Not `onyxfs:`, which is the app's own
    /// sign-in hand-off scheme (CFBundleURLSchemes): a URL of that scheme
    /// opened anywhere would go to the app, not to FSKit.
    public static let resourceScheme = "onyxfs-drive"
    public static let prefix = "/fs/v1/"
    /// The ticket's body: a ticket is 43 characters; nothing more is waited
    /// for from a caller that has no session yet.
    public static let maxExchangeBody = 4 * 1024
    /// Anything else's body. The read side has none; this is room for the
    /// small JSON bodies of what comes next, not for a file's bytes.
    public static let maxRequestBody = 64 * 1024
    /// Long-polls hold a connection each while they wait, and the listener
    /// has a fixed number (DAVServer.maxConnections) shared with rclone. An
    /// extension keeps one going per disk; these leave most of the room to
    /// everything else whatever a caller with a session does.
    public static let maxPollsPerSession = 4
    public static let maxPolls = 32

    public init(sessions: FSSessions = FSSessions()) {
        self.sessions = sessions
    }

    // MARK: - Drives

    /// Answer for `responder.scope` from now on, in place of any responder
    /// it had. Its sessions carry on.
    public func register(_ responder: FSResponder) {
        lock.withLock { responders[responder.scope] = responder }
    }

    public func responder(for scope: String) -> FSResponder? {
        lock.withLock { responders[scope] }
    }

    /// The drive is unmounted, or gone: its sessions and tickets end, and
    /// nothing more is answered for it.
    public func end(scope: String) {
        sessions.end(scope: scope)
        lock.withLock { _ = responders.removeValue(forKey: scope) }
    }

    /// Signed out.
    public func endAll() {
        sessions.endAll()
        lock.withLock { responders = [:] }
    }

    /// Where FSKit mounts a drive from:
    /// `onyxfs-drive://127.0.0.1:<port>/<scope>?ticket=<t>&name=<name>&v=1`.
    ///
    /// `mount` shows this URL to every account on this Mac, so all it holds
    /// is a ticket good for one exchange, for two minutes (FSSessions). The
    /// name is there so FSKit's probe can name the volume without spending
    /// the ticket; it is the disk's name as `volume` gives it
    /// (FSResponder.volumeName). Everything in the URL is percent-encoded
    /// but RFC 3986's unreserved characters.
    public static func resourceURL(port: UInt16, scope: String, ticket: String, name: String) -> URL {
        let enc = DAVResponder.percentEncode
        let volume = enc(FSResponder.volumeName(name))
        let url = "\(resourceScheme)://127.0.0.1:\(port)/\(enc(scope))?ticket=\(enc(ticket))&name=\(volume)&v=1"
        // Only unreserved characters and %XX between fixed delimiters, which
        // always parses.
        return URL(string: url)!
    }

    // MARK: - The socket layer

    /// Whether a request-target is this bridge's to answer.
    public static func handles(_ target: String) -> Bool {
        let path = Self.path(of: target)
        return path == "/fs/v1" || path.hasPrefix(prefix)
    }

    public enum Admission: Equatable {
        /// Take the body, up to this many bytes, and answer (`respond`).
        case accept(maxBody: Int)
        /// No session: answer `unauthorized` and close, waiting for no body.
        case refuse
    }

    /// What the socket layer does once a request's headers are in: whoever
    /// has no session gets no body waited for or held. `respond` checks
    /// again, as for any caller.
    public func admit(method: String, target: String, authorization: String?) -> Admission {
        if method == "POST", Self.route(target) == "session" { return .accept(maxBody: Self.maxExchangeBody) }
        return sessions.session(for: authorization) == nil ? .refuse : .accept(maxBody: Self.maxRequestBody)
    }

    public static var unauthorized: DAVResponse {
        var r = FSResponder.error(401, "This session is not valid. Mount the drive again.")
        r.headers.append(("WWW-Authenticate", #"Bearer realm="onyxfs""#))
        return finished(r, method: "GET")
    }

    // MARK: - Answering

    /// The answer to one request under `/fs/v1/`, Content-Length set.
    public func respond(to request: DAVRequest) async -> DAVResponse {
        Self.finished(await answer(request), method: request.method)
    }

    /// Content-Length from the body a GET would carry, set once here, and
    /// HEAD given the headers alone — as DAVResponder does.
    static func finished(_ response: DAVResponse, method: String) -> DAVResponse {
        var r = response
        r.headers.removeAll { $0.0.lowercased() == "content-length" }
        r.headers.append(("Content-Length", String(r.body.length)))
        if method == "HEAD" { r.body = .empty }
        return r
    }

    private func answer(_ request: DAVRequest) async -> DAVResponse {
        let route = Self.route(request.target)
        if route == "session", request.method == "POST" { return await exchange(request.body) }

        guard let session = sessions.session(for: request.headers["authorization"]) else { return Self.unauthorized }
        guard let route, Self.readRoutes.contains(route) || route == "session" else {
            return FSResponder.error(404, "There is no such endpoint.")
        }
        if route == "session" { return Self.notAllowed("POST") }
        guard request.method == "GET" || request.method == "HEAD" else { return Self.notAllowed("GET, HEAD") }
        guard let query = Self.query(request.target) else { return FSResponder.error(400, "The query is not valid.") }
        // Registered before its first ticket was issued, and forgotten only
        // with its sessions: missing here means it went just now.
        guard let responder = responder(for: session.scope) else { return FSResponder.unavailable }

        switch route {
        case "list": return await responder.list(path: query["path"])
        case "stat": return await responder.stat(path: query["path"])
        case "source": return await responder.source(id: query["id"])
        case "data": return await responder.data(id: query["id"], range: request.headers["range"])
        case "volume": return await responder.volume()
        default: // "changes"
            guard beginPoll(session) else {
                var busy = FSResponder.error(503, "Too many waits for changes at once.")
                busy.headers.append(("Retry-After", "5"))
                return busy
            }
            defer { endPoll(session) }
            let answer = await responder.changes(since: query["since"], wait: query["wait"])
            // Unmounted, or signed out, while it waited: nothing more for it.
            return sessions.session(for: request.headers["authorization"]) == nil ? Self.unauthorized : answer
        }
    }

    static let readRoutes: Set<String> = ["list", "stat", "source", "data", "changes", "volume"]

    /// `POST /fs/v1/session`: `{ "ticket": "…" }` for a session on the
    /// ticket's drive.
    private func exchange(_ body: Data) async -> DAVResponse {
        guard body.count <= Self.maxExchangeBody,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let ticket = object["ticket"] as? String else {
            return FSResponder.error(400, #"The body must be {"ticket": "…"}."#)
        }
        guard let (key, scope) = sessions.exchange(ticket) else {
            return FSResponder.error(401, "This ticket is not valid: it is unknown, used or expired.")
        }
        guard let responder = responder(for: scope) else {
            // The drive went between the ticket and now.
            sessions.revoke(key)
            return FSResponder.error(401, "This drive is no longer mounted.")
        }
        return await responder.sessionAnswer(key: key)
    }

    private static func notAllowed(_ allow: String) -> DAVResponse {
        var r = FSResponder.error(405, "Method not allowed.")
        r.headers.append(("Allow", allow))
        return r
    }

    private func beginPoll(_ session: FSSessions.Session) -> Bool {
        lock.withLock {
            guard pollCount < Self.maxPolls, polls[session.id, default: 0] < Self.maxPollsPerSession else { return false }
            polls[session.id, default: 0] += 1
            pollCount += 1
            return true
        }
    }

    private func endPoll(_ session: FSSessions.Session) {
        lock.withLock {
            let left = (polls[session.id] ?? 1) - 1
            polls[session.id] = left > 0 ? left : nil
            pollCount -= 1
        }
    }

    /// Long-polls under way; for tests.
    var pollsUnderWay: Int { lock.withLock { pollCount } }

    // MARK: - Request-targets

    /// The path of a request-target, without its query: origin-form as
    /// clients send it, or absolute-form, which HTTP/1.1 servers must take.
    static func path(of target: String) -> Substring {
        var raw = Substring(target)
        if let q = raw.firstIndex(of: "?") { raw = raw[..<q] }
        if let scheme = raw.range(of: "://"), !raw[..<scheme.lowerBound].contains("/") {
            let rest = raw[scheme.upperBound...]
            raw = rest.firstIndex(of: "/").map { rest[$0...] } ?? "/"
        }
        return raw
    }

    /// "list" for `/fs/v1/list?…`; nil for anything not one segment under
    /// the prefix.
    static func route(_ target: String) -> String? {
        let path = Self.path(of: target)
        guard path.hasPrefix(prefix) else { return nil }
        let name = path.dropFirst(prefix.count)
        return name.isEmpty || name.contains("/") ? nil : String(name)
    }

    /// The query's parameters, each name and value decoded on its own; the
    /// first of a repeated name counts. Strict, as DAVResponder decodes a
    /// path: "+" is a plus, not a space — URLComponents leaves "+" in a
    /// value as it is, and a file may be called "a+b.mov" — and a stray "%"
    /// makes the whole query invalid (nil) rather than guessed at.
    static func query(_ target: String) -> [String: String]? {
        guard let q = target.firstIndex(of: "?") else { return [:] }
        var out: [String: String] = [:]
        for pair in target[target.index(after: q)...].split(separator: "&", omittingEmptySubsequences: true) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let name = DAVResponder.percentDecode(parts[0]),
                  let value = parts.count > 1 ? DAVResponder.percentDecode(parts[1]) : "" else { return nil }
            if out[name] == nil { out[name] = value }
        }
        return out
    }
}
