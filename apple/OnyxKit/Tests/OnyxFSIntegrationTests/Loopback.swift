import Foundation
@testable import OnyxKit

/// The app's side of the socket, in process. A request to 127.0.0.1:<port>
/// goes to that port's FSBridge the way DAVServer hands it one — admitted on
/// its headers, a file's body spooled to disk, never held — and a presigned
/// link to https://storage.test/ is answered from `objects`, ranges and all.
final class Loopback: URLProtocol, @unchecked Sendable {
    struct Host: Sendable {
        let bridge: FSBridge
        let spool: URL
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var hosts: [Int: Host] = [:]
    nonisolated(unsafe) private static var objects: [String: Data] = [:]
    nonisolated(unsafe) private static var nextPort = 30_000 + Int.random(in: 0..<20_000)

    /// A port of its own for this bridge.
    static func serve(_ bridge: FSBridge, spool: URL) -> Int {
        lock.withLock {
            nextPort += 1
            hosts[nextPort] = Host(bridge: bridge, spool: spool)
            return nextPort
        }
    }

    static func stop(_ port: Int) { lock.withLock { hosts[port] = nil } }

    /// Bytes in storage, at https://storage.test/<path>.
    static func store(_ path: String, _ data: Data) { lock.withLock { objects[path] = data } }
    static func stored(_ path: String) -> Data? { lock.withLock { objects[path] } }

    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Loopback.self]
        return configuration
    }

    // MARK: - URLProtocol

    private let finished = NSLock()
    private var done = false

    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        if url.host == "storage.test" { return true }
        return url.host == "127.0.0.1" && lock.withLock { hosts[url.port ?? 0] != nil }
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func stopLoading() { finished.withLock { done = true } }

    override func startLoading() {
        let request = self.request
        guard let url = request.url else { return fail() }
        if url.host == "storage.test" { return storage(request) }
        guard let host = Self.lock.withLock({ Self.hosts[url.port ?? 0] }) else { return fail() }
        Task {
            let answer = await Self.answer(request, host: host)
            self.send(answer)
        }
    }

    /// As DAVServer: the request-target raw, headers lowercased, the body
    /// admitted before it is read.
    static func answer(_ request: URLRequest, host: Host) async -> DAVResponse {
        let url = request.url!
        var target = url.path(percentEncoded: true)
        if let query = url.query(percentEncoded: true) { target += "?" + query }
        let method = request.httpMethod ?? "GET"
        let headers = Dictionary((request.allHTTPHeaderFields ?? [:]).map { ($0.key.lowercased(), $0.value) },
                                 uniquingKeysWith: { first, _ in first })
        let body = Self.body(of: request)
        switch host.bridge.admit(method: method, target: target, authorization: headers["authorization"]) {
        case .refuse:
            return FSBridge.unauthorized
        case let .accept(maxBody):
            guard body.count <= maxBody else { return DAVResponse(status: 413) }
            return await host.bridge.respond(to: DAVRequest(method: method, target: target, headers: headers, body: body))
        case .acceptFile:
            let file = host.spool.appendingPathComponent(UUID().uuidString)
            try? FileManager.default.createDirectory(at: host.spool, withIntermediateDirectories: true)
            try? body.write(to: file)
            return await host.bridge.respond(to: DAVRequest(method: method, target: target, headers: headers, bodyFile: file))
        }
    }

    private func storage(_ request: URLRequest) {
        guard let data = Self.stored(request.url!.path) else { return respond(404, [:], Data("<Code>NoSuchKey</Code>".utf8)) }
        guard let range = request.value(forHTTPHeaderField: "Range"), range.hasPrefix("bytes=") else {
            return respond(200, ["Content-Length": String(data.count)], data)
        }
        let parts = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2, let first = Int(parts[0]), first < data.count else {
            return respond(416, ["Content-Range": "bytes */\(data.count)"], Data())
        }
        let last = min(Int(parts[1]) ?? data.count - 1, data.count - 1)
        respond(206, ["Content-Range": "bytes \(first)-\(last)/\(data.count)"], data.subdata(in: first..<(last + 1)))
    }

    private func send(_ answer: DAVResponse) {
        var headers: [String: String] = [:]
        for (name, value) in answer.headers { headers[name] = value }
        let body: Data
        switch answer.body {
        case .empty:
            body = Data()
        case let .data(data):
            body = data
        case let .file(url, offset, length):
            let handle = try? FileHandle(forReadingFrom: url)
            try? handle?.seek(toOffset: UInt64(offset))
            body = (try? handle?.read(upToCount: Int(length))) ?? Data()
            try? handle?.close()
        }
        respond(answer.status, headers, body)
    }

    private func respond(_ status: Int, _ headers: [String: String], _ body: Data) {
        guard finished.withLock({ () -> Bool in defer { done = true }; return !done }) else { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !body.isEmpty { client?.urlProtocol(self, didLoad: body) }
        client?.urlProtocolDidFinishLoading(self)
    }

    private func fail() {
        guard finished.withLock({ () -> Bool in defer { done = true }; return !done }) else { return }
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
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
}
