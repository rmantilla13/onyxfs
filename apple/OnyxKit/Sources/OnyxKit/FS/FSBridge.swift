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
    /// Where each drive's writes go (the app's DriveWriter), for drives this
    /// account may change.
    private var writers: [String: any FSWriteTarget] = [:]
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
    /// Anything else's body: the small JSON of a mkdir or a rename. A
    /// file's bytes (`PUT /fs/v1/file`) are not held but written to disk as
    /// they arrive (Admission.acceptFile).
    public static let maxRequestBody = 64 * 1024
    /// The largest file a drive takes: storage's own limit for one object.
    public static let maxFileBody: Int64 = 5 << 40
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

    /// Where `scope`'s writes go from now on (nil: nowhere — read-only).
    public func setWriter(_ writer: (any FSWriteTarget)?, for scope: String) {
        lock.withLock { writers[scope] = writer }
    }

    func writer(for scope: String) -> (any FSWriteTarget)? {
        lock.withLock { writers[scope] }
    }

    /// The drive is unmounted, or gone: its sessions and tickets end, and
    /// nothing more is answered for it.
    public func end(scope: String) {
        sessions.end(scope: scope)
        lock.withLock {
            _ = responders.removeValue(forKey: scope)
            _ = writers.removeValue(forKey: scope)
        }
    }

    /// Signed out.
    public func endAll() {
        sessions.endAll()
        lock.withLock {
            responders = [:]
            writers = [:]
        }
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
        /// A file's bytes: written to a file as they arrive, never held, up
        /// to this many; the request then carries it as `bodyFile`.
        case acceptFile(maxBytes: Int64)
        /// No session: answer `unauthorized` and close, waiting for no body.
        case refuse
    }

    /// What the socket layer does once a request's headers are in: whoever
    /// has no session gets no body waited for or held. `respond` checks
    /// again, as for any caller.
    public func admit(method: String, target: String, authorization: String?) -> Admission {
        if method == "POST", Self.route(target) == "session" { return .accept(maxBody: Self.maxExchangeBody) }
        guard sessions.session(for: authorization) != nil else { return .refuse }
        if method == "PUT", Self.route(target) == "file" { return .acceptFile(maxBytes: Self.maxFileBody) }
        return .accept(maxBody: Self.maxRequestBody)
    }

    public static var unauthorized: DAVResponse {
        var r = FSResponder.error(401, "This session is not valid. Mount the drive again.")
        r.headers.append(("WWW-Authenticate", #"Bearer realm="onyxfs""#))
        return finished(r, method: "GET")
    }

    // MARK: - Answering

    /// The answer to one request under `/fs/v1/`, Content-Length set.
    public func respond(to request: DAVRequest) async -> DAVResponse {
        let response = await answer(request)
        // An upload's body the writer did not take (refused, failed): gone.
        if let file = request.bodyFile { try? FileManager.default.removeItem(at: file) }
        return Self.finished(response, method: request.method)
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
        guard let route, Self.readRoutes.contains(route) || Self.writeRoutes.contains(route) || route == "session" else {
            return FSResponder.error(404, "There is no such endpoint.")
        }
        if route == "session" { return Self.notAllowed("POST") }
        if Self.writeRoutes.contains(route) { return await write(route, request, session: session) }
        guard request.method == "GET" || request.method == "HEAD" else { return Self.notAllowed("GET, HEAD") }
        guard let query = Self.query(request.target) else { return FSResponder.error(400, "The query is not valid.") }
        // Registered before its first ticket was issued, and forgotten only
        // with its sessions: missing here means it went just now.
        guard let responder = responder(for: session.scope) else { return gone(request) }

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
    static let writeRoutes: Set<String> = ["file", "mkdir", "rename", "item"]

    /// The write side (ONYXFS.md, "Writes"): Finder's changes, made on the
    /// server by the drive's writer, then answered with the entry as a
    /// listing would show it now.
    ///
    ///     PUT    /fs/v1/file?path=     the body is the whole file (new, or
    ///                                  new bytes for the one there)
    ///     POST   /fs/v1/mkdir          { "path": "/a/new" }
    ///     POST   /fs/v1/rename         { "from": …, "to": …, "replace": false }
    ///     DELETE /fs/v1/item?path=     to the web's trash (its flag decides)
    ///
    /// A drive this account may only view answers 403 before anything is
    /// tried; the server checks each change again whatever the app thinks.
    private func write(_ route: String, _ request: DAVRequest, session: FSSessions.Session) async -> DAVResponse {
        guard let responder = responder(for: session.scope) else { return gone(request) }
        let allowed: String = switch route {
        case "file": "PUT"
        case "item": "DELETE"
        default: "POST"
        }
        guard request.method == allowed else { return Self.notAllowed(allowed) }
        guard let writer = writer(for: session.scope), await !responder.source.volumeInfo().readOnly else {
            return FSResponder.error(403, "You can view this drive but not change it. Ask one of its owners for editor access.")
        }
        guard let query = Self.query(request.target) else { return FSResponder.error(400, "The query is not valid.") }
        let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
        do {
            switch route {
            case "file":
                guard let path = query["path"], let file = request.bodyFile else {
                    return FSResponder.error(400, "PUT /fs/v1/file needs ?path= and the file as its body.")
                }
                let modified = request.headers["x-onyx-mtime"].flatMap(Double.init).map { Date(timeIntervalSince1970: $0) }
                let created = request.headers["x-onyx-btime"].flatMap(Double.init).map { Date(timeIntervalSince1970: $0) }
                try await writer.write(path: path, from: file, modified: modified, created: created)
                return await responder.stat(path: path)
            case "mkdir":
                guard let path = body["path"] as? String else { return FSResponder.error(400, #"The body must be {"path": "…"}."#) }
                try await writer.makeFolder(path: path)
                return await responder.stat(path: path)
            case "rename":
                guard let from = body["from"] as? String, let to = body["to"] as? String else {
                    return FSResponder.error(400, #"The body must be {"from": "…", "to": "…"}."#)
                }
                try await writer.move(from: from, to: to, replace: body["replace"] as? Bool ?? false)
                return await responder.stat(path: to)
            default: // "item"
                guard let path = query["path"] else { return FSResponder.error(400, "DELETE /fs/v1/item needs ?path=.") }
                try await writer.remove(path: path)
                return FSResponder.json(200, ["ok": true])
            }
        } catch let DriveWriter.Failure.posix(code, message) {
            let (status, fallback): (Int, String) = switch code {
            case EACCES, EPERM: (403, "Onyx did not allow this change.")
            case ENOENT: (404, "There is no such file or folder.")
            case EEXIST: (409, "Something by that name is already there.")
            case EDQUOT: (413, "There is no room for this in the drive.")
            case EISDIR, EINVAL: (400, "That is not a name a file can have here.")
            default: (500, "The change could not be made.")
            }
            return FSResponder.error(status, message ?? fallback)
        } catch {
            return FSResponder.error(500, error.localizedDescription)
        }
    }

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

    /// A drive unmounted between this request's session check and now: its
    /// sessions went with it, so the answer is the one that says so (401,
    /// mount again), not a 503 to be retried.
    private func gone(_ request: DAVRequest) -> DAVResponse {
        sessions.session(for: request.headers["authorization"]) == nil ? Self.unauthorized : FSResponder.unavailable
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

/// Where a drive's writes go: the app's DriveWriter, which makes each change
/// on the server with the device token (and so under the web's own rules).
/// Paths are the drive's ("/Footage/Take 1.mov"). Throws DriveWriter.Failure.
public protocol FSWriteTarget: Sendable {
    /// `file` is taken (moved away) by the writer when it succeeds.
    /// `modified` and `created`: the dates the file had where it was
    /// written (X-Onyx-Mtime, X-Onyx-Btime), kept on the server.
    func write(path: String, from file: URL, modified: Date?, created: Date?) async throws
    func makeFolder(path: String) async throws
    func move(from: String, to: String, replace: Bool) async throws
    func remove(path: String) async throws
}
