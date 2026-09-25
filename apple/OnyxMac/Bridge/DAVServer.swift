import Foundation
import Network
import OnyxKit

/// The local WebDAV endpoint that rclone mounts: HTTP on 127.0.0.1, one route
/// per mounted drive (`/<segment>/…`), each answered by a DAVResponder.
///
/// Only the wire lives here — parsing requests, writing responses, streaming
/// a pinned file's bytes. What to answer is DAVResponder's (OnyxKit), which is
/// tested on its own. Bound to loopback with a random port, and every request
/// must carry the bearer token rclone was started with, so nothing else on
/// the network — or another account on this Mac — can read through it.
final class DAVServer: @unchecked Sendable {
    let token: String
    private let queue = DispatchQueue(label: "io.onyxfs.dav", qos: .userInitiated)
    private var listener: NWListener?
    private var routes: [String: DAVResponder] = [:]
    private let lock = NSLock()
    private(set) var port: UInt16 = 0

    init() {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Start listening; returns the port. Idempotent.
    func start() async throws -> UInt16 {
        if port != 0 { return port }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: params)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            listener.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    resumed = true
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error):
                    resumed = true
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
        self.port = port
        return port
    }

    func stop() {
        listener?.cancel()
        listener = nil
        port = 0
    }

    /// Route `/<segment>/…` to `responder` (nil removes it).
    func setRoute(_ segment: String, _ responder: DAVResponder?) {
        lock.lock(); defer { lock.unlock() }
        routes[segment] = responder
    }

    func baseURL(for segment: String) -> URL? {
        port == 0 ? nil : URL(string: "http://127.0.0.1:\(port)/\(segment)")
    }

    private func responder(for segment: String) -> DAVResponder? {
        lock.lock(); defer { lock.unlock() }
        return routes[segment]
    }

    // MARK: - Connections

    private func accept(_ connection: NWConnection) {
        let session = Session(connection: connection, server: self)
        connection.start(queue: queue)
        session.readNext()
    }

    /// One keep-alive connection: read a request, answer it, read the next.
    private final class Session: @unchecked Sendable {
        let connection: NWConnection
        weak var server: DAVServer?
        var buffer = Data()

        static let maxHeader = 64 * 1024
        static let maxBody = 1024 * 1024

        init(connection: NWConnection, server: DAVServer) {
            self.connection = connection
            self.server = server
        }

        func readNext() {
            switch parse() {
            case let .request(request, keepAlive):
                handle((request, keepAlive))
                return
            case .failed:
                return // answered, and closing
            case .needMore:
                break
            }
            if buffer.count > Self.maxHeader + Self.maxBody {
                fail(413); return
            }
            connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [self] data, _, complete, error in
                if let data, !data.isEmpty { buffer.append(data) }
                if error != nil || (complete && (data?.isEmpty ?? true)) {
                    connection.cancel(); return
                }
                readNext()
            }
        }

        enum Parsed {
            case request(DAVRequest, keepAlive: Bool)
            case needMore
            case failed
        }

        /// A complete request from the buffer, removing it. A request this
        /// server cannot take (chunked bodies, oversized, garbled) is answered
        /// and the connection closed.
        private func parse() -> Parsed {
            guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if buffer.count > Self.maxHeader { fail(413); return .failed }
                return .needMore
            }
            guard let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else {
                fail(400); return .failed
            }
            var lines = head.components(separatedBy: "\r\n")
            let parts = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
            guard parts.count == 3 else { fail(400); return .failed }
            var headers: [String: String] = [:]
            for line in lines {
                guard let colon = line.firstIndex(of: ":") else { continue }
                let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                headers[name] = headers[name].map { "\($0), \(value)" } ?? value
            }
            if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
                // The mount is read-only: nothing it sends has a chunked body
                // worth reading. Refuse, and close rather than guess where the
                // body ends.
                fail(403); return .failed
            }
            let length = Int(headers["content-length"] ?? "0") ?? 0
            guard length >= 0, length <= Self.maxBody else { fail(413); return .failed }
            let bodyStart = end.upperBound
            guard buffer.endIndex - bodyStart >= length else { return .needMore }
            let body = buffer[bodyStart..<(bodyStart + length)]
            buffer = Data(buffer[(bodyStart + length)...])
            let keepAlive = headers["connection"]?.lowercased() != "close" && parts[2] == "HTTP/1.1"
            let request = DAVRequest(method: String(parts[0]), target: String(parts[1]),
                                     headers: headers, body: Data(body))
            return .request(request, keepAlive: keepAlive)
        }

        private func handle(_ parsed: (DAVRequest, keepAlive: Bool)) {
            var (request, keepAlive) = parsed
            // Route by the first segment, and hand the responder the rest.
            let target = request.target
            let pathEnd = target.firstIndex(of: "?") ?? target.endIndex
            let trimmed = target[..<pathEnd].drop(while: { $0 == "/" })
            let segment = trimmed.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
            let rest = trimmed.dropFirst(segment.count)
            request.target = (rest.isEmpty ? "/" : String(rest)) + target[pathEnd...]

            guard let server, let responder = server.responder(for: segment) else {
                send(DAVResponse(status: 404, headers: [("Content-Length", "0")], body: .empty), keepAlive: keepAlive)
                return
            }
            Task {
                let response = await responder.respond(to: request)
                send(response, keepAlive: keepAlive)
            }
        }

        private func send(_ response: DAVResponse, keepAlive: Bool) {
            var head = "HTTP/1.1 \(response.status) \(Self.reason(response.status))\r\n"
            var hasLength = false
            for (name, value) in response.headers {
                if name.lowercased() == "content-length" { hasLength = true }
                head += "\(name): \(value)\r\n"
            }
            if !hasLength {
                let length: Int64
                switch response.body {
                case .empty: length = 0
                case let .data(d): length = Int64(d.count)
                case let .file(_, _, n): length = n
                }
                head += "Content-Length: \(length)\r\n"
            }
            head += keepAlive ? "Connection: keep-alive\r\n\r\n" : "Connection: close\r\n\r\n"

            let finish: @Sendable (NWError?) -> Void = { [self] error in
                if error != nil || !keepAlive { connection.cancel(); return }
                readNext()
            }
            switch response.body {
            case .empty:
                connection.send(content: Data(head.utf8), completion: .contentProcessed(finish))
            case let .data(body):
                connection.send(content: Data(head.utf8) + body, completion: .contentProcessed(finish))
            case let .file(url, offset, length):
                connection.send(content: Data(head.utf8), completion: .contentProcessed { [self] error in
                    if let error { finish(error); return }
                    streamFile(url, offset: offset, remaining: length, finish: finish)
                })
            }
        }

        /// A pinned file's bytes, a quarter megabyte at a time, each piece sent
        /// only once the one before it has gone — so a multi-gigabyte file never
        /// sits in memory.
        private func streamFile(_ url: URL, offset: Int64, remaining: Int64,
                                finish: @escaping @Sendable (NWError?) -> Void) {
            guard remaining > 0 else { finish(nil); return }
            guard let handle = try? FileHandle(forReadingFrom: url) else { connection.cancel(); return }
            defer { try? handle.close() }
            do {
                try handle.seek(toOffset: UInt64(offset))
                let chunk = try handle.read(upToCount: Int(min(remaining, 256 * 1024))) ?? Data()
                guard !chunk.isEmpty else { connection.cancel(); return }
                connection.send(content: chunk, completion: .contentProcessed { [self] error in
                    if let error { finish(error); return }
                    streamFile(url, offset: offset + Int64(chunk.count), remaining: remaining - Int64(chunk.count), finish: finish)
                })
            } catch {
                connection.cancel()
            }
        }

        /// Answer with an error and close: after a request that could not be
        /// read, where the next one starts is unknowable.
        private func fail(_ status: Int) {
            buffer.removeAll()
            send(DAVResponse(status: status, headers: [("Content-Length", "0")], body: .empty), keepAlive: false)
        }

        static func reason(_ status: Int) -> String {
            switch status {
            case 200: return "OK"
            case 206: return "Partial Content"
            case 207: return "Multi-Status"
            case 302: return "Found"
            case 400: return "Bad Request"
            case 401: return "Unauthorized"
            case 403: return "Forbidden"
            case 404: return "Not Found"
            case 405: return "Method Not Allowed"
            case 413: return "Payload Too Large"
            case 416: return "Range Not Satisfiable"
            case 503: return "Service Unavailable"
            default: return "Status"
            }
        }
    }
}
