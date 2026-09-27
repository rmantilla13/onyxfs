import Foundation

/// The extension's side of bridge protocol v1: one mounted drive's session
/// with Onyx.app, over HTTP/1.1 on loopback, plus the range reads it makes
/// straight to storage.
///
/// A client exists only with a session: `connect` spends the mount's
/// one-time ticket, and the session key it gets back lives in this object and
/// nowhere else. Sessions do not survive the app, so there is no reconnect:
/// when the app comes back it mounts the drive again, with a new ticket.
///
/// Three URLSessions, all ephemeral (no cookies, no URL cache, no credential
/// store): the bridge's, with 30 s timeouts; the `changes` long-poll's, whose
/// timeout outlasts its wait and which keeps the poll off the connections
/// reads use; and storage's, for presigned range reads, which never carries
/// the session key.
public final class FSBridgeClient: Sendable {
    public let resource: FSMountResource
    /// What the ticket exchange answered: the starting generation, the
    /// volume, and the cache limit.
    public let session: FSSessionInfo

    public static let requestTimeout: TimeInterval = 30
    public static let changesTimeout: TimeInterval = 40
    public static let defaultChangesWait = 25

    private let key: String
    private let bridge: URLSession
    private let longPoll: URLSession
    let storage: URLSession

    /// Exchanges the resource's ticket for a session (POST /fs/v1/session).
    /// A ticket works once and for two minutes; a spent or unknown one is
    /// `.disconnected`, like every other 401. `configuration` is copied for
    /// each of the client's sessions; tests pass one with stub protocols.
    public static func connect(to resource: FSMountResource,
                               configuration: URLSessionConfiguration = .ephemeral) async throws -> FSBridgeClient {
        let sessions = Sessions(configuration)
        var request = URLRequest(url: Self.endpoint(resource.bridgeURL, "session", query: []))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(SessionRequest(ticket: resource.ticket))
        let (body, response) = try await Self.send(request, on: sessions.bridge)
        try Self.check(response, body)
        let reply = try Self.decode(SessionReply.self, body)
        let info = FSSessionInfo(generation: reply.generation, volume: reply.volume,
                                 cacheLimitBytes: reply.cacheLimitBytes ?? FSSessionInfo.defaultCacheLimitBytes)
        return FSBridgeClient(resource: resource, key: reply.session, session: info, sessions: sessions)
    }

    init(resource: FSMountResource, key: String, session: FSSessionInfo, sessions: Sessions) {
        self.resource = resource
        self.key = key
        self.session = session
        bridge = sessions.bridge
        longPoll = sessions.longPoll
        storage = sessions.storage
    }

    deinit {
        bridge.finishTasksAndInvalidate()
        longPoll.finishTasksAndInvalidate()
        storage.finishTasksAndInvalidate()
    }

    // MARK: - Reads

    /// GET /fs/v1/list. `.notFound` when there is no such folder.
    public func list(path: String) async throws -> FSListing {
        try await get("list", [("path", path)], as: FSListing.self)
    }

    /// GET /fs/v1/stat. "/" is the drive itself, named after it.
    public func stat(path: String) async throws -> FSStat {
        try await get("stat", [("path", path)], as: FSStat.self)
    }

    /// GET /fs/v1/source: a presigned URL to range-read, or word that the
    /// bytes are on this Mac (then read them with `data`).
    public func source(id: String) async throws -> FSSource {
        try await get("source", [("id", id)], as: FSSource.self)
    }

    /// GET /fs/v1/data with a Range: bytes of a file kept on this Mac.
    ///
    /// When the file is not local after all, the bridge redirects to storage.
    /// That redirect is followed here, by hand, with a request of our own:
    /// following it automatically would carry the session key to storage.
    /// Returns fewer bytes than asked at the end of the file, none past it.
    public func data(id: String, range: Range<Int64>) async throws -> Data {
        guard !range.isEmpty else { return Data() }
        var request = self.request("GET", "data", query: [("id", id)])
        request.setValue(Self.rangeHeader(range), forHTTPHeaderField: "Range")
        let (body, response) = try await Self.send(request, on: bridge, delegate: RefuseRedirects.shared)
        switch response.statusCode {
        case 206:
            return body
        case 200:
            return Self.slice(body, range)
        case 301, 302, 303, 307, 308:
            guard let location = response.value(forHTTPHeaderField: "Location"),
                  let target = URL(string: location, relativeTo: request.url)?.absoluteURL else {
                throw FSBridgeError.server("The Onyx app redirected a read nowhere.")
            }
            let status: Int, data: Data
            do {
                (status, data, _) = try await storageGET(target, range: range)
            } catch let error as URLError {
                throw error.code == .cancelled ? CancellationError() : FSBridgeError.network(error.code)
            }
            switch status {
            case 206: return data
            case 200: return Self.slice(data, range)
            case 416: return Data()
            default: throw FSBridgeError.storage(status: status)
            }
        case 416:
            return Data()
        default:
            try Self.check(response, body)
            throw FSBridgeError.server("The Onyx app answered a read with \(response.statusCode).")
        }
    }

    /// GET /fs/v1/changes: waits up to `wait` seconds for the drive to move
    /// past `generation`, and names the folders whose listings changed.
    public func changes(since generation: UInt64, wait: Int = FSBridgeClient.defaultChangesWait) async throws -> FSChanges {
        var request = self.request("GET", "changes", query: [("since", String(generation)), ("wait", String(wait))])
        request.timeoutInterval = max(Self.changesTimeout, TimeInterval(wait) + 15)
        let (body, response) = try await Self.send(request, on: longPoll)
        try Self.check(response, body)
        return try Self.decode(FSChanges.self, body)
    }

    /// GET /fs/v1/volume: the volume as it is now (sizes move).
    public func volume() async throws -> FSVolumeInfo {
        try await get("volume", [], as: FSVolumeInfo.self)
    }

    /// GET /fs/v1/icon: the drive's disk icon, an .icns. Nil when the app has
    /// none to give (404 — an app from before icons says the same), or sent
    /// something that is not one.
    public func volumeIcon() async throws -> Data? {
        var request = self.request("GET", "icon", query: [])
        request.setValue("image/icns", forHTTPHeaderField: "Accept")
        let (body, response) = try await Self.send(request, on: bridge)
        if response.statusCode == 404 { return nil }
        try Self.check(response, body)
        return Self.isIcns(body) ? body : nil
    }

    /// "icns", then the length of the whole.
    static func isIcns(_ data: Data) -> Bool {
        guard data.count > 8, data.prefix(4) == Data("icns".utf8) else { return false }
        let length = data.dropFirst(4).prefix(4).reduce(0) { $0 << 8 | Int($1) }
        return length == data.count
    }

    // MARK: - Writes

    /// PUT /fs/v1/file: uploads the file at `fileURL` to `path`, streamed
    /// from disk (a file may be tens of gigabytes; it is never held in
    /// memory). The app keeps the bytes and answers at once with the entry,
    /// `pending` until its upload to storage finishes. A file already at
    /// `path` is replaced in place: same id, new bytes.
    public func putFile(path: String, from fileURL: URL, mtime: Date? = nil, btime: Date? = nil) async throws -> FSEntry {
        var request = self.request("PUT", "file", query: [("path", path)])
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        if let mtime {
            request.setValue(Self.seconds(mtime.timeIntervalSince1970), forHTTPHeaderField: "X-Onyx-Mtime")
        }
        if let btime {
            request.setValue(Self.seconds(btime.timeIntervalSince1970), forHTTPHeaderField: "X-Onyx-Btime")
        }
        let body: Data
        let response: HTTPURLResponse
        do {
            let (data, answer) = try await bridge.upload(for: request, fromFile: fileURL)
            guard let http = answer as? HTTPURLResponse else {
                throw FSBridgeError.server("The Onyx app gave an answer that is not HTTP.")
            }
            (body, response) = (data, http)
        } catch let error as URLError {
            throw Self.bridgeError(error)
        }
        try Self.check(response, body)
        return try Self.decode(EntryReply.self, body).entry
    }

    /// POST /fs/v1/mkdir. A folder already there is fine; a file there is
    /// `.conflict`.
    public func mkdir(path: String) async throws -> FSEntry {
        try await post("mkdir", PathRequest(path: path), as: EntryReply.self).entry
    }

    /// POST /fs/v1/rename: files and folders, across folders too. With
    /// `replace`, a file at `to` goes to the web's trash first; without it,
    /// one there is `.conflict`.
    public func rename(from: String, to: String, replace: Bool = false) async throws -> FSEntry {
        try await post("rename", RenameRequest(from: from, to: to, replace: replace), as: EntryReply.self).entry
    }

    /// DELETE /fs/v1/item: a file goes to the web's trash (the server's trash
    /// setting decides); a folder goes with its contents.
    public func delete(path: String) async throws {
        let request = self.request("DELETE", "item", query: [("path", path)])
        let (body, response) = try await Self.send(request, on: bridge)
        try Self.check(response, body)
    }

    // MARK: - Storage

    /// A range read of a presigned URL: the status, the body, and its
    /// Content-Range. Throws URLError for network failures, untouched, so the
    /// caller can decide what is worth retrying.
    func storageGET(_ url: URL, range: Range<Int64>) async throws -> (status: Int, body: Data, contentRange: String?) {
        var request = URLRequest(url: url)
        request.setValue(Self.rangeHeader(range), forHTTPHeaderField: "Range")
        // A stored Content-Encoding would otherwise be undone on a slice of
        // the encoded bytes.
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.httpShouldHandleCookies = false
        let (data, response) = try await storage.data(for: request)
        guard let http = response as? HTTPURLResponse else { return (0, data, nil) }
        return (http.statusCode, data, http.value(forHTTPHeaderField: "Content-Range"))
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(_ endpoint: String, _ query: [(String, String)], as type: T.Type) async throws -> T {
        let (body, response) = try await Self.send(request("GET", endpoint, query: query), on: bridge)
        try Self.check(response, body)
        return try Self.decode(type, body)
    }

    private func post<B: Encodable, T: Decodable>(_ endpoint: String, _ payload: B, as type: T.Type) async throws -> T {
        var request = self.request("POST", endpoint, query: [])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(payload)
        let (body, response) = try await Self.send(request, on: bridge)
        try Self.check(response, body)
        return try Self.decode(type, body)
    }

    private func request(_ method: String, _ endpoint: String, query: [(String, String)]) -> URLRequest {
        var request = URLRequest(url: Self.endpoint(resource.bridgeURL, endpoint, query: query))
        request.httpMethod = method
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    /// Query values are encoded to the letter: everything but RFC 3986's
    /// unreserved characters and "/" is %-escaped, so a name with a space,
    /// "#", "?", "&", "+", "=" or "%" reaches the app as itself, and "+" is
    /// never taken for a space. Paths are NFC first, as the protocol wants:
    /// the kernel may hand over a name decomposed.
    static let queryValueAllowed: CharacterSet = {
        var allowed = CharacterSet()
        allowed.insert(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~/")
        return allowed
    }()

    static func encodeQueryValue(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping.addingPercentEncoding(withAllowedCharacters: queryValueAllowed) ?? ""
    }

    static func endpoint(_ base: URL, _ endpoint: String, query: [(String, String)]) -> URL {
        var string = base.absoluteString
        while string.hasSuffix("/") { string.removeLast() }
        string += "/fs/v1/" + endpoint
        if !query.isEmpty {
            string += "?" + query.map { "\($0.0)=\(encodeQueryValue($0.1))" }.joined(separator: "&")
        }
        return URL(string: string)!
    }

    static func rangeHeader(_ range: Range<Int64>) -> String {
        "bytes=\(range.lowerBound)-\(range.upperBound - 1)"
    }

    /// Seconds since 1970 as the header wants them: whole when whole, else
    /// to the microsecond.
    static func seconds(_ time: TimeInterval) -> String {
        if time == time.rounded() { return String(format: "%.0f", time) }
        var text = String(format: "%.6f", time)
        while text.hasSuffix("0") { text.removeLast() }
        return text
    }

    /// The part of a whole body that `range` covers: for a server that
    /// ignored the Range header and sent everything.
    static func slice(_ body: Data, _ range: Range<Int64>) -> Data {
        let lower = Int(clamping: max(0, range.lowerBound))
        let upper = Int(clamping: min(Int64(body.count), range.upperBound))
        guard lower < upper else { return Data() }
        return body.subdata(in: (body.startIndex + lower)..<(body.startIndex + upper))
    }

    static func send(_ request: URLRequest, on session: URLSession,
                     delegate: (any URLSessionTaskDelegate)? = nil) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request, delegate: delegate)
            guard let http = response as? HTTPURLResponse else {
                throw FSBridgeError.server("The Onyx app gave an answer that is not HTTP.")
            }
            return (data, http)
        } catch let error as URLError {
            throw bridgeError(error)
        }
    }

    /// Nothing listening, or the connection dropped: on loopback that means
    /// the app is gone. A timeout means only that it is slow.
    static func bridgeError(_ error: URLError) -> Error {
        switch error.code {
        case .cancelled:
            return CancellationError()
        case .cannotConnectToHost, .networkConnectionLost, .cannotFindHost, .dnsLookupFailed,
             .notConnectedToInternet, .resourceUnavailable:
            return FSBridgeError.disconnected
        case .timedOut:
            return FSBridgeError.server("The Onyx app did not answer in time.")
        default:
            return FSBridgeError.server(error.localizedDescription)
        }
    }

    static func check(_ response: HTTPURLResponse, _ body: Data) throws {
        let status = response.statusCode
        if (200..<300).contains(status) { return }
        let message = (try? JSONDecoder().decode(ErrorReply.self, from: body).error)
            ?? "The Onyx app answered \(status)."
        switch status {
        case 400: throw FSBridgeError.invalid(message)
        case 401: throw FSBridgeError.disconnected
        case 403: throw FSBridgeError.forbidden(message)
        case 404: throw FSBridgeError.notFound
        case 409: throw FSBridgeError.conflict(message)
        case 413: throw FSBridgeError.quotaExceeded(message)
        default: throw FSBridgeError.server(message)
        }
    }

    static func decode<T: Decodable>(_ type: T.Type, _ body: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: body)
        } catch {
            throw FSBridgeError.server("The Onyx app's answer could not be read (\(T.self)).")
        }
    }
}

/// The client's URLSessions, made from one configuration.
struct Sessions {
    let bridge: URLSession
    let longPoll: URLSession
    let storage: URLSession

    init(_ configuration: URLSessionConfiguration) {
        func make(_ timeout: TimeInterval, connections: Int) -> URLSession {
            let copy = configuration.copy() as! URLSessionConfiguration
            copy.timeoutIntervalForRequest = timeout
            copy.httpMaximumConnectionsPerHost = connections
            copy.httpCookieStorage = nil
            copy.httpShouldSetCookies = false
            copy.httpCookieAcceptPolicy = .never
            copy.urlCache = nil
            copy.urlCredentialStorage = nil
            copy.requestCachePolicy = .reloadIgnoringLocalCacheData
            copy.waitsForConnectivity = false
            return URLSession(configuration: copy)
        }
        bridge = make(FSBridgeClient.requestTimeout, connections: 8)
        longPoll = make(FSBridgeClient.changesTimeout, connections: 2)
        // Up to four chunk fetches per open file, and several files open.
        storage = make(FSBridgeClient.requestTimeout, connections: 16)
    }
}

/// Keeps a bridge redirect as the answer, so the caller follows it with a
/// request that does not carry the session key.
final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = RefuseRedirects()

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}
