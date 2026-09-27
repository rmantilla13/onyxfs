import Foundation
@testable import OnyxFSCore

/// Onyx.app's bridge and storage, played by one object per test, reached
/// through `StubProtocol`: the bridge at 127.0.0.1 on a port of its own,
/// storage at a host of its own, so tests running in parallel never see each
/// other's requests.
///
/// File bytes are a pattern computed from the offset (`Pattern`), so a 100
/// MiB file costs nothing to hold and any byte out of place is caught.
final class Stub: @unchecked Sendable {
    struct File {
        var size: Int64
        var seed: UInt64
        var version: String
        var local = false
    }

    struct Seen: Sendable {
        let method: String
        let path: String
        /// Decoded.
        let query: [String: String]
        /// As sent, still percent-encoded.
        let rawQuery: String?
        let headers: [String: String]
        let body: Data
    }

    struct StorageRequest: Sendable {
        let fileId: String
        let signature: Int
        let range: String?
        let authorization: String?
    }

    let port: Int
    let storageHost: String
    private let lock = NSLock()

    // Bridge state.
    private var tickets: Set<String> = []
    private var keys: Set<String> = []
    private var generation: UInt64 = 42
    private var changes: [(generation: UInt64, paths: [String])] = []
    private var polls: [(since: UInt64, request: StubProtocol)] = []
    var volume = FSVolumeInfo(scope: "drive.abc", name: "Client Deliverables", readOnly: false,
                              totalBytes: 0, usedBytes: 123_456, fileCount: 3)
    private var folders: [String: [FSEntry]] = ["/": []]
    private var files: [String: File] = [:]
    private var seen: [Seen] = []
    private var uploads: [String: Data] = [:]
    /// /fs/v1/data answers with a redirect to storage.
    var redirectData = false
    /// Every write is refused with this status, as the app refuses one the
    /// server would not make.
    var writeRefusal: Int?

    // Storage state.
    private var signature = 0
    private var refused: Set<Int> = []
    private var refuseAll = false
    var linkLifetime: Double = 900
    private var storageLog: [StorageRequest] = []
    private var failures: [URLError.Code] = []
    private var statuses: [Int] = []
    /// Storage requests whose range starts in here wait for `release`.
    private var holdRange: Range<Int64>?
    private var held: [StubProtocol] = []

    init() {
        port = Stub.lock.withLock {
            Stub.nextPort += 1
            return Stub.nextPort
        }
        storageHost = "\(UUID().uuidString.lowercased()).storage.test"
        Stub.lock.withLock {
            Stub.byPort[port] = self
            Stub.byHost[storageHost] = self
        }
    }

    deinit {
        Stub.lock.withLock {
            Stub.byPort[port] = nil
            Stub.byHost[storageHost] = nil
        }
    }

    // MARK: - Setting up

    static let configuration: URLSessionConfiguration = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return configuration
    }()

    /// A fresh mount URL with a ticket good for one exchange.
    func resource(scope: String = "drive.abc", name: String = "Client Deliverables") -> FSMountResource {
        let ticket = UUID().uuidString
        lock.withLock { _ = tickets.insert(ticket) }
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let url = URL(string: "onyxfs-drive://127.0.0.1:\(port)/\(scope)?ticket=\(ticket)&name=\(encoded)&v=1")!
        return try! FSMountResource(url: url)
    }

    func connect() async throws -> FSBridgeClient {
        try await FSBridgeClient.connect(to: resource(), configuration: Stub.configuration)
    }

    func addFolder(_ path: String) {
        lock.withLock {
            folders[path] = folders[path] ?? []
            let parent = Stub.parent(of: path)
            folders[parent, default: []].removeAll { $0.name == Stub.name(of: path) }
            folders[parent, default: []].append(FSEntry(name: Stub.name(of: path), type: .dir, id: nil, size: 0,
                                                        mtime: 0, version: "dir:\(path)"))
        }
    }

    @discardableResult
    func addFile(_ path: String, size: Int64, seed: UInt64 = 7, version: String = "v1", local: Bool = false) -> FSEntry {
        let id = "id-\(UUID().uuidString.prefix(8))"
        let entry = FSEntry(name: Stub.name(of: path), type: .file, id: id, size: size, mtime: 1_790_460_000.5,
                            version: version, local: local)
        lock.withLock {
            files[id] = File(size: size, seed: seed, version: version, local: local)
            let parent = Stub.parent(of: path)
            folders[parent, default: []].removeAll { $0.name == entry.name }
            folders[parent, default: []].append(entry)
        }
        return entry
    }

    func setVersion(of id: String, to version: String, seed: UInt64) {
        lock.withLock {
            files[id]?.version = version
            files[id]?.seed = seed
        }
    }

    /// Forgets every session: the app restarted.
    func forgetSessions() { lock.withLock { keys.removeAll() } }

    /// The drive changed: long-polls waiting past the old generation answer.
    func post(paths: [String]) {
        let (generation, answer, waiting): (UInt64, FSChanges, [StubProtocol]) = lock.withLock {
            self.generation += 1
            changes.append((self.generation, paths))
            let ready = polls.filter { $0.since < self.generation }.map(\.request)
            polls.removeAll { $0.since < self.generation }
            return (self.generation, FSChanges(generation: self.generation, all: false, paths: paths), ready)
        }
        _ = generation
        for request in waiting { request.respond(json: answer) }
    }

    func refuseSignatures(through serial: Int) {
        lock.withLock { refused.formUnion(0...serial) }
    }

    func refuseEverySignature(_ refuse: Bool = true) { lock.withLock { refuseAll = refuse } }

    func failStorage(_ codes: [URLError.Code]) { lock.withLock { failures += codes } }

    func answerStorage(_ statuses: [Int]) { lock.withLock { self.statuses += statuses } }

    func hold(_ range: Range<Int64>?) { lock.withLock { holdRange = range } }

    var heldCount: Int { lock.withLock { held.count } }

    func release() {
        let waiting: [StubProtocol] = lock.withLock {
            holdRange = nil
            defer { held.removeAll() }
            return held
        }
        for request in waiting { serveStorage(request) }
    }

    // MARK: - What was asked

    var requests: [Seen] { lock.withLock { seen } }
    var storageRequests: [StorageRequest] { lock.withLock { storageLog } }
    func upload(at path: String) -> Data? { lock.withLock { uploads[path] } }
    func entries(in folder: String) -> [FSEntry]? { lock.withLock { folders[folder] } }

    func requests(_ path: String) -> [Seen] { requests.filter { $0.path == path } }

    // MARK: - Answering

    fileprivate func handle(_ request: StubProtocol) {
        guard let url = request.request.url else { return }
        if url.host == storageHost {
            storage(request)
            return
        }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let method = request.request.httpMethod ?? "GET"
        let body = Stub.body(of: request.request)
        let headers = request.request.allHTTPHeaderFields ?? [:]
        let seen = Seen(method: method, path: url.path, query: query, rawQuery: components?.percentEncodedQuery,
                        headers: headers, body: body)
        lock.withLock { self.seen.append(seen) }

        if url.path == "/fs/v1/session" {
            session(request, body)
            return
        }
        let key = headers["Authorization"].map { String($0.dropFirst("Bearer ".count)) } ?? ""
        guard lock.withLock({ keys.contains(key) }) else {
            request.respond(401, json: ErrorReply(error: "Unauthorized."))
            return
        }
        switch (method, url.path) {
        case ("GET", "/fs/v1/list"):
            let path = query["path"] ?? ""
            let answer: FSListing? = lock.withLock {
                folders[path].map { entries in
                    FSListing(path: path, generation: generation,
                              entries: entries.sorted { ($0.type == .dir ? 0 : 1, $0.name) < ($1.type == .dir ? 0 : 1, $1.name) })
                }
            }
            if let answer { request.respond(json: answer) } else { request.notFound() }
        case ("GET", "/fs/v1/stat"):
            let path = query["path"] ?? ""
            let answer: FSStat? = lock.withLock {
                if path == "/" {
                    return FSStat(generation: generation, entry: FSEntry(name: volume.name, type: .dir, version: "root"))
                }
                return folders[Stub.parent(of: path)]?.first { $0.name == Stub.name(of: path) }
                    .map { FSStat(generation: generation, entry: $0) }
            }
            if let answer { request.respond(json: answer) } else { request.notFound() }
        case ("GET", "/fs/v1/source"):
            let answer: FSSource? = lock.withLock {
                guard let id = query["id"], let file = files[id] else { return nil }
                if file.local { return FSSource(kind: .local, size: file.size, version: file.version) }
                signature += 1
                return FSSource(kind: .remote, url: storageURL(id, signature),
                                expiresAt: Date().timeIntervalSince1970 + linkLifetime,
                                size: file.size, version: file.version)
            }
            if let answer { request.respond(json: answer) } else { request.notFound() }
        case ("GET", "/fs/v1/data"):
            let found: (File, URL)? = lock.withLock {
                guard let id = query["id"], let file = files[id] else { return nil }
                signature += 1
                return (file, storageURL(id, signature))
            }
            guard let (file, link) = found else { request.notFound(); return }
            if redirectData {
                request.respond(307, headers: ["Location": link.absoluteString])
            } else {
                request.respondRange(headers["Range"], size: file.size, seed: file.seed)
            }
        case ("GET", "/fs/v1/changes"):
            let since = UInt64(query["since"] ?? "") ?? 0
            let ready: FSChanges? = lock.withLock {
                let newer = changes.filter { $0.generation > since }
                guard !newer.isEmpty else {
                    polls.append((since, request))
                    return nil
                }
                return FSChanges(generation: generation, all: false,
                                 paths: Array(Set(newer.flatMap(\.paths))).sorted())
            }
            if let ready { request.respond(json: ready) }
        case ("GET", "/fs/v1/volume"):
            request.respond(json: lock.withLock { volume })
        case ("PUT", "/fs/v1/file"):
            guard writable(request) else { return }
            let path = query["path"] ?? ""
            let entry: FSEntry = lock.withLock {
                uploads[path] = body
                let parent = Stub.parent(of: path)
                let existing = folders[parent]?.first { $0.name == Stub.name(of: path) }
                let id = existing?.id ?? "id-\(UUID().uuidString.prefix(8))"
                let entry = FSEntry(name: Stub.name(of: path), type: .file, id: id, size: Int64(body.count),
                                    mtime: Double(headers["X-Onyx-Mtime"] ?? "") ?? 0, version: "up-\(body.count)",
                                    local: true, pending: true)
                folders[parent, default: []].removeAll { $0.name == entry.name }
                folders[parent, default: []].append(entry)
                generation += 1
                return entry
            }
            request.respond(json: EntryReply(entry: entry, generation: lock.withLock { generation }))
        case ("POST", "/fs/v1/mkdir"):
            guard writable(request), let asked = try? JSONDecoder().decode(PathRequest.self, from: body) else { return }
            let clash = lock.withLock {
                folders[Stub.parent(of: asked.path)]?.contains { $0.name == Stub.name(of: asked.path) && $0.type == .file } ?? false
            }
            if clash {
                request.respond(409, json: ErrorReply(error: "A file is in the way."))
                return
            }
            addFolder(asked.path)
            request.respond(json: EntryReply(entry: FSEntry(name: Stub.name(of: asked.path), type: .dir,
                                                            version: "dir:\(asked.path)"), generation: nil))
        case ("POST", "/fs/v1/rename"):
            guard writable(request), let asked = try? JSONDecoder().decode(RenameRequest.self, from: body) else { return }
            let outcome: Int = lock.withLock {
                let fromParent = Stub.parent(of: asked.from), toParent = Stub.parent(of: asked.to)
                guard var entry = folders[fromParent]?.first(where: { $0.name == Stub.name(of: asked.from) }) else { return 404 }
                if folders[toParent]?.contains(where: { $0.name == Stub.name(of: asked.to) }) == true && !asked.replace {
                    return 409
                }
                folders[fromParent]?.removeAll { $0.name == entry.name }
                entry.name = Stub.name(of: asked.to)
                folders[toParent, default: []].removeAll { $0.name == entry.name }
                folders[toParent, default: []].append(entry)
                return 200
            }
            switch outcome {
            case 404: request.notFound()
            case 409: request.respond(409, json: ErrorReply(error: "Something is already called that."))
            default:
                let entry = entries(in: Stub.parent(of: asked.to))?.first { $0.name == Stub.name(of: asked.to) }
                request.respond(json: EntryReply(entry: entry!, generation: nil))
            }
        case ("DELETE", "/fs/v1/item"):
            guard writable(request) else { return }
            let path = query["path"] ?? ""
            let removed: Bool = lock.withLock {
                let parent = Stub.parent(of: path)
                guard folders[parent]?.contains(where: { $0.name == Stub.name(of: path) }) == true else { return false }
                folders[parent]?.removeAll { $0.name == Stub.name(of: path) }
                return true
            }
            if removed { request.respond(json: ["ok": true]) } else { request.notFound() }
        default:
            request.respond(400, json: ErrorReply(error: "No such endpoint."))
        }
    }

    private func session(_ request: StubProtocol, _ body: Data) {
        guard let asked = try? JSONDecoder().decode(SessionRequest.self, from: body),
              lock.withLock({ tickets.remove(asked.ticket) != nil }) else {
            request.respond(401, json: ErrorReply(error: "That ticket is unknown, used or expired."))
            return
        }
        let key = UUID().uuidString
        lock.withLock { _ = keys.insert(key) }
        let reply = SessionReply(session: key, generation: lock.withLock { generation }, volume: volume,
                                 cacheLimitBytes: 53_687_091_200)
        request.respond(json: reply)
    }

    private func writable(_ request: StubProtocol) -> Bool {
        if let status = lock.withLock({ writeRefusal }) {
            request.respond(status, json: ErrorReply(error: "Refused with \(status)."))
            return false
        }
        guard lock.withLock({ volume.readOnly }) else { return true }
        request.respond(403, json: ErrorReply(error: "This drive is read-only for you."))
        return false
    }

    private func storageURL(_ id: String, _ signature: Int) -> URL {
        URL(string: "https://\(storageHost)/bucket/\(id)?X-Amz-Signature=\(signature)")!
    }

    private func storage(_ request: StubProtocol) {
        let url = request.request.url!
        let id = url.lastPathComponent
        let signature = Int(URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "X-Amz-Signature" }?.value ?? "") ?? -1
        let range = request.request.value(forHTTPHeaderField: "Range")
        let hold: Bool = lock.withLock {
            storageLog.append(StorageRequest(fileId: id, signature: signature, range: range,
                                             authorization: request.request.value(forHTTPHeaderField: "Authorization")))
            guard let holdRange, let start = Stub.parseRange(range)?.lowerBound, holdRange.contains(start) else {
                return false
            }
            held.append(request)
            return true
        }
        if !hold { serveStorage(request) }
    }

    private func serveStorage(_ request: StubProtocol) {
        let url = request.request.url!
        let id = url.lastPathComponent
        let signature = Int(URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "X-Amz-Signature" }?.value ?? "") ?? -1
        enum Answer { case fail(URLError.Code), status(Int), refused, missing, file(File) }
        let answer: Answer = lock.withLock {
            if !failures.isEmpty { return .fail(failures.removeFirst()) }
            if !statuses.isEmpty { return .status(statuses.removeFirst()) }
            if refuseAll || refused.contains(signature) { return .refused }
            guard let file = files[id] else { return .missing }
            return .file(file)
        }
        switch answer {
        case let .fail(code): request.fail(code)
        case let .status(status): request.respond(status, body: Data("<Error/>".utf8))
        case .refused: request.respond(403, body: Data("<Error><Code>AccessDenied</Code></Error>".utf8))
        case .missing: request.respond(404, body: Data("<Error><Code>NoSuchKey</Code></Error>".utf8))
        case let .file(file):
            request.respondRange(request.request.value(forHTTPHeaderField: "Range"), size: file.size, seed: file.seed)
        }
    }

    fileprivate func stopped(_ request: StubProtocol) {
        lock.withLock {
            polls.removeAll { $0.request === request }
            held.removeAll { $0 === request }
        }
    }

    // MARK: - Helpers

    static func parent(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/"), slash != path.startIndex else { return "/" }
        return String(path[..<slash])
    }

    static func name(of path: String) -> String {
        String(path[path.index(after: path.lastIndex(of: "/")!)...])
    }

    static func parseRange(_ header: String?) -> ClosedRange<Int64>? {
        guard let header, header.hasPrefix("bytes=") else { return nil }
        let parts = header.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2, let first = Int64(parts[0]), let last = Int64(parts[1]) else { return nil }
        return first...last
    }

    static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        while true {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    // MARK: - Registry

    private static let lock = NSLock()
    nonisolated(unsafe) private static var nextPort = 20_000 + Int.random(in: 0..<20_000)
    nonisolated(unsafe) private static var byPort: [Int: Stub] = [:]
    nonisolated(unsafe) private static var byHost: [String: Stub] = [:]

    fileprivate static func find(_ url: URL?) -> Stub? {
        guard let url, let host = url.host else { return nil }
        return lock.withLock {
            if host == "127.0.0.1", let port = url.port { return byPort[port] }
            return byHost[host]
        }
    }
}

/// Hands each request to the Stub that owns its port or host.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    override class func canInit(with request: URLRequest) -> Bool { Stub.find(request.url) != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let stub = Stub.find(request.url) else {
            fail(.cannotConnectToHost)
            return
        }
        stub.handle(self)
    }

    override func stopLoading() {
        lock.withLock { done = true }
        Stub.find(request.url)?.stopped(self)
    }

    /// Once per request: an answer after stopLoading is dropped.
    private func finish(_ body: () -> Void) {
        let first = lock.withLock { () -> Bool in
            defer { done = true }
            return !done
        }
        if first { body() }
    }

    func respond(_ status: Int = 200, headers: [String: String] = [:], body: Data = Data()) {
        finish {
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !body.isEmpty { client?.urlProtocol(self, didLoad: body) }
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    func respond<T: Encodable>(_ status: Int = 200, json: T) {
        respond(status, headers: ["Content-Type": "application/json"], body: try! JSONEncoder().encode(json))
    }

    func notFound() { respond(404, json: ErrorReply(error: "No such file or folder.")) }

    func fail(_ code: URLError.Code) {
        finish { client?.urlProtocol(self, didFailWithError: URLError(code)) }
    }

    /// 206 with the pattern's bytes for a Range header, 200 with all of them
    /// without one, 416 past the end.
    func respondRange(_ header: String?, size: Int64, seed: UInt64) {
        guard let asked = Stub.parseRange(header) else {
            respond(200, body: Pattern.bytes(0..<size, seed: seed))
            return
        }
        guard asked.lowerBound < size else {
            respond(416, headers: ["Content-Range": "bytes */\(size)"])
            return
        }
        let upper = min(asked.upperBound + 1, size)
        respond(206, headers: ["Content-Range": "bytes \(asked.lowerBound)-\(upper - 1)/\(size)"],
                body: Pattern.bytes(asked.lowerBound..<upper, seed: seed))
    }
}

/// Bytes that are a function of their offset: each 8-byte word holds its own
/// index, scrambled with a seed, so a byte moved anywhere is caught.
enum Pattern {
    static func bytes(_ range: Range<Int64>, seed: UInt64) -> Data {
        guard !range.isEmpty else { return Data() }
        let firstWord = range.lowerBound / 8
        let words = Int((range.upperBound + 7) / 8 - firstWord)
        var buffer = [UInt64](repeating: 0, count: words)
        buffer.withUnsafeMutableBufferPointer { out in
            for k in 0..<words {
                out[k] = ((UInt64(firstWord) &+ UInt64(k)) &* 0x9E37_79B9_7F4A_7C15 ^ seed).littleEndian
            }
        }
        let skip = Int(range.lowerBound - firstWord * 8)
        return buffer.withUnsafeBytes { Data(bytes: $0.baseAddress! + skip, count: Int(range.count)) }
    }
}

/// Polls until `condition` holds, for up to five seconds.
func eventually(_ condition: () async -> Bool) async throws {
    for _ in 0..<2500 {
        if await condition() { return }
        try await Task.sleep(nanoseconds: 2_000_000)
    }
    struct TimedOut: Error {}
    throw TimedOut()
}

/// A folder of its own under the temporary directory.
func temporaryFolder(_ name: String = #function) throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("OnyxFSCoreTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
