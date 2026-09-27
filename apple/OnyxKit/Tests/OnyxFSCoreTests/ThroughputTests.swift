import Foundation
import Testing
@testable import OnyxFSCore

/// How fast a master streams through FileReader over real HTTP on loopback:
/// the number that says whether scrubbing will feel right. Off by default
/// (it writes a 1 GiB file); run it in release:
///
///     ONYXFS_BENCH=1 swift test -c release --package-path OnyxKit --filter Throughput
///
/// The server can stand in for storage further away: a delay before each
/// answer and a cap on each connection's rate. `ONYXFS_BENCH_MIB` sets the
/// file's size.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["ONYXFS_BENCH"] != nil))
struct ThroughputTests {
    static let MiB = 1 << 20
    static let fileMiB = Int(ProcessInfo.processInfo.environment["ONYXFS_BENCH_MIB"] ?? "") ?? 1024

    @Test func sequentialAndScrubbing() async throws {
        let folder = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let master = folder.appendingPathComponent("master.mov")
        let size = Int64(Self.fileMiB * Self.MiB)
        FileManager.default.createFile(atPath: master.path, contents: nil)
        let handle = try FileHandle(forWritingTo: master)
        for block in 0..<Int64(Self.fileMiB / 8) {
            try handle.write(contentsOf: Pattern.bytes((block * 8 * Int64(Self.MiB))..<((block + 1) * 8 * Int64(Self.MiB)), seed: 1))
        }
        try handle.close()

        print("onyxfs throughput: \(Self.fileMiB) MiB file, 8 MiB chunks, 1 MiB reads")
        try await run("loopback, no limits", master: master, size: size, latency: 0, rate: nil)
        try await run("20 ms per request, 50 MB/s per connection", master: master, size: size, latency: 0.020,
                      rate: 50_000_000, scrubs: 40)
        var serial = FileReader.Tuning()
        serial.maxInFlight = 1
        try await run("same, one fetch at a time (for comparison)", master: master, size: size, latency: 0.020,
                      rate: 50_000_000, tuning: serial, warm: false, scrubs: 0)
    }

    func run(_ name: String, master: URL, size: Int64, latency: Double, rate: Double?,
             tuning: FileReader.Tuning = FileReader.Tuning(), warm: Bool = true, scrubs: Int = 40) async throws {
        let server = try BenchServer(file: master, size: size, latency: latency, rate: rate)
        defer { server.stop() }
        let resource = try FSMountResource(url: URL(string: "onyxfs-drive://127.0.0.1:\(server.port)/library?ticket=t&v=1")!)
        let client = try await FSBridgeClient.connect(to: resource)
        let cache = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: cache) }
        let store = try ChunkStore(directory: cache, limitBytes: size * 2)
        print("\n\(name)")

        let cold = FileReader(fileId: "master", version: "v1", size: size, client: client, store: store, tuning: tuning)
        let coldSeconds = try await readAll(cold, size: size)
        let stats = await cold.stats()
        print(String(format: "  cold sequential: %7.0f MB/s  (%.2f s)", Double(size) / coldSeconds / 1e6, coldSeconds))
        print("    fetches \(stats.fetches), ahead of reads \(stats.readAheadFetches), window up to \(stats.peakWindow) chunks, "
              + "at most \(stats.peakInFlight) in flight, cache hits \(stats.cacheHits), storage requests \(server.requests)")

        if warm {
            let again = FileReader(fileId: "master", version: "v1", size: size, client: client, store: store, tuning: tuning)
            let warmSeconds = try await readAll(again, size: size)
            print(String(format: "  warm sequential: %7.0f MB/s  (%.2f s)", Double(size) / warmSeconds / 1e6, warmSeconds))
        }

        if scrubs > 0 {
            // Seeks to places not read yet: each one's first read waits for
            // its chunk; the reads that follow it in the same place do not.
            let fresh = try temporaryFolder()
            defer { try? FileManager.default.removeItem(at: fresh) }
            let scrubStore = try ChunkStore(directory: fresh, limitBytes: size * 2)
            let scrubber = FileReader(fileId: "master", version: "v1", size: size, client: client, store: scrubStore,
                                      tuning: tuning)
            var random = SplitMix(seed: 27)
            var firsts: [Double] = []
            var follows: [Double] = []
            for _ in 0..<scrubs {
                let offset = Int64(random.next() % UInt64(size - Int64(4 * Self.MiB)))
                let clock = ContinuousClock()
                var start = clock.now
                _ = try await scrubber.read(offset: offset, length: Self.MiB)
                firsts.append(seconds(clock.now - start))
                start = clock.now
                _ = try await scrubber.read(offset: offset + Int64(Self.MiB), length: Self.MiB)
                follows.append(seconds(clock.now - start))
            }
            print(String(format: "  scrub, cold: first read at a new place p50 %.0f ms, p95 %.0f ms; the next read p50 %.1f ms",
                         percentile(firsts, 0.5) * 1000, percentile(firsts, 0.95) * 1000, percentile(follows, 0.5) * 1000))
            var hot: [Double] = []
            let rescrubber = FileReader(fileId: "master", version: "v1", size: size, client: client, store: scrubStore,
                                        tuning: tuning)
            random = SplitMix(seed: 27)
            for _ in 0..<scrubs {
                let offset = Int64(random.next() % UInt64(size - Int64(4 * Self.MiB)))
                let clock = ContinuousClock()
                let start = clock.now
                _ = try await rescrubber.read(offset: offset, length: Self.MiB)
                hot.append(seconds(clock.now - start))
            }
            print(String(format: "  scrub, cached: p50 %.2f ms, p95 %.2f ms", percentile(hot, 0.5) * 1000,
                         percentile(hot, 0.95) * 1000))
        }
    }

    func readAll(_ reader: FileReader, size: Int64) async throws -> Double {
        let clock = ContinuousClock()
        let start = clock.now
        var offset: Int64 = 0
        while offset < size {
            let data = try await reader.read(offset: offset, length: Self.MiB)
            guard data.count == Self.MiB else { throw FSBridgeError.server("short read at \(offset)") }
            // A spot check per chunk: the bench is about speed, not bytes.
            if offset % (8 * Int64(Self.MiB)) == 0 {
                #expect(data.prefix(64) == Pattern.bytes(offset..<(offset + 64), seed: 1))
            }
            offset += Int64(data.count)
        }
        return seconds(clock.now - start)
    }

    func seconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
    }

    func percentile(_ values: [Double], _ p: Double) -> Double {
        let sorted = values.sorted()
        return sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * p + 0.5))]
    }
}

/// HTTP/1.1 on 127.0.0.1, a thread per connection, keep-alive: the three
/// requests FileReader makes (session, source, ranges of one file), the file
/// sent with sendfile, optionally late and slow.
final class BenchServer: @unchecked Sendable {
    let port: Int
    let size: Int64
    private let file: URL
    private let listener: Int32
    private let latency: Double
    private let rate: Double?
    private let lock = NSLock()
    private var count = 0

    var requests: Int { lock.withLock { count } }

    init(file: URL, size: Int64, latency: Double, rate: Double?) throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) }
        }
        guard bound == 0, listen(fd, 64) == 0 else {
            close(fd)
            throw FSBridgeError.server("bench server: bind")
        }
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        self.file = file
        self.size = size
        self.latency = latency
        self.rate = rate
        listener = fd
        port = Int(UInt16(bigEndian: address.sin_port))
        Thread.detachNewThread { [self] in accept() }
    }

    func stop() {
        shutdown(listener, SHUT_RDWR)
        close(listener)
    }

    private func accept() {
        while true {
            let connection = Darwin.accept(listener, nil, nil)
            if connection < 0 {
                if errno == EINTR { continue }
                return
            }
            var one: Int32 = 1
            setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(connection, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
            Thread.detachNewThread { [self] in serve(connection) }
        }
    }

    private func serve(_ connection: Int32) {
        defer { close(connection) }
        let fd = open(file.path, O_RDONLY)
        defer { close(fd) }
        var pending = Data()
        while true {
            guard let head = readHead(connection, &pending) else { return }
            let lines = head.components(separatedBy: "\r\n")
            let parts = lines[0].split(separator: " ")
            guard parts.count >= 2 else { return }
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { continue }
                headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            let bodyLength = Int(headers["content-length"] ?? "0") ?? 0
            while pending.count < bodyLength {
                guard receive(connection, &pending) else { return }
            }
            pending.removeFirst(bodyLength)
            let target = String(parts[1])
            if target.hasPrefix("/fs/v1/session") {
                json(connection, """
                    {"session":"bench","generation":1,"volume":{"scope":"library","name":"Bench","readOnly":true,\
                    "totalBytes":0,"usedBytes":\(size),"fileCount":1},"cacheLimitBytes":\(size * 2)}
                    """)
            } else if target.hasPrefix("/fs/v1/source") {
                json(connection, """
                    {"kind":"remote","url":"http://127.0.0.1:\(port)/blob?X-Amz-Signature=1",\
                    "expiresAt":\(Int(Date().timeIntervalSince1970) + 3600),"size":\(size),"version":"v1"}
                    """)
            } else if target.hasPrefix("/blob") {
                lock.withLock { count += 1 }
                guard blob(connection, fd, range: headers["range"]) else { return }
            } else {
                write(connection, Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".utf8))
            }
        }
    }

    private func blob(_ connection: Int32, _ fd: Int32, range: String?) -> Bool {
        if latency > 0 { Thread.sleep(forTimeInterval: latency) }
        var first: Int64 = 0, last = size - 1
        if let range, range.hasPrefix("bytes=") {
            let ends = range.dropFirst(6).split(separator: "-")
            first = Int64(ends.first ?? "") ?? 0
            last = min(size - 1, Int64(ends.count > 1 ? ends[1] : "") ?? size - 1)
        }
        let length = last - first + 1
        let status = range == nil ? "200 OK" : "206 Partial Content"
        let head = "HTTP/1.1 \(status)\r\nContent-Length: \(length)\r\nContent-Range: bytes \(first)-\(last)/\(size)\r\n"
            + "Content-Type: application/octet-stream\r\n\r\n"
        guard write(connection, Data(head.utf8)) else { return false }
        let started = Date()
        var offset = first
        var remaining = length
        while remaining > 0 {
            var slice: off_t = rate == nil ? remaining : min(remaining, 256 * 1024)
            let result = sendfile(fd, connection, offset, &slice, nil, 0)
            if result != 0 && errno != EAGAIN && errno != EINTR && slice == 0 { return false }
            offset += slice
            remaining -= slice
            if let rate {
                let due = Double(offset - first) / rate - Date().timeIntervalSince(started)
                if due > 0 { Thread.sleep(forTimeInterval: due) }
            }
        }
        return true
    }

    private func json(_ connection: Int32, _ body: String) {
        let data = Data(body.utf8)
        write(connection, Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(data.count)\r\n\r\n".utf8) + data)
    }

    @discardableResult
    private func write(_ connection: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Bool in
            var done = 0
            while done < buffer.count {
                let n = send(connection, buffer.baseAddress! + done, buffer.count - done, 0)
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { return false }
                done += n
            }
            return true
        }
    }

    private func receive(_ connection: Int32, _ pending: inout Data) -> Bool {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        let n = recv(connection, &buffer, buffer.count, 0)
        guard n > 0 else { return false }
        pending.append(buffer, count: n)
        return true
    }

    private func readHead(_ connection: Int32, _ pending: inout Data) -> String? {
        let end = Data("\r\n\r\n".utf8)
        while true {
            if let found = pending.range(of: end) {
                let head = String(decoding: pending[pending.startIndex..<found.lowerBound], as: UTF8.self)
                pending.removeSubrange(pending.startIndex..<found.upperBound)
                return head
            }
            guard receive(connection, &pending) else { return nil }
        }
    }
}
