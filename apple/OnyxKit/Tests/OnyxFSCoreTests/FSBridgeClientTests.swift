import Foundation
import Testing
@testable import OnyxFSCore

/// The client against a stand-in for the app. What matters: the ticket buys
/// exactly one session, a dead app reads as `.disconnected` and nothing else,
/// every name reaches the app as itself, and the session key never leaves for
/// storage.
struct FSBridgeClientTests {
    // MARK: - Sessions

    @Test func theTicketBuysOneSession() async throws {
        let stub = Stub()
        let resource = stub.resource()
        let client = try await FSBridgeClient.connect(to: resource, configuration: Stub.configuration)
        #expect(client.session.generation == 42)
        #expect(client.session.volume.name == "Client Deliverables")
        #expect(client.session.cacheLimitBytes == 53_687_091_200)

        let exchange = try #require(stub.requests("/fs/v1/session").first)
        #expect(exchange.method == "POST")
        #expect(exchange.headers["Authorization"] == nil, "the ticket is the credential; there is no session yet")
        #expect(try JSONDecoder().decode(SessionRequest.self, from: exchange.body).ticket == resource.ticket)

        // Every later request carries the session key.
        _ = try await client.volume()
        #expect(stub.requests("/fs/v1/volume").first?.headers["Authorization"]?.hasPrefix("Bearer ") == true)

        // The ticket is spent.
        await #expect(throws: FSBridgeError.disconnected) {
            try await FSBridgeClient.connect(to: resource, configuration: Stub.configuration)
        }
    }

    @Test func aSessionTheAppForgotIsDisconnected() async throws {
        let stub = Stub()
        let client = try await stub.connect()
        _ = try await client.list(path: "/")
        stub.forgetSessions()   // the app restarted
        await #expect(throws: FSBridgeError.disconnected) { try await client.list(path: "/") }
        await #expect(throws: FSBridgeError.disconnected) { try await client.source(id: "x") }
    }

    @Test func nothingListeningIsDisconnected() async throws {
        // A port nothing listens on: bound once, then let go.
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) }
        }
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        let port = Int(UInt16(bigEndian: address.sin_port))
        close(fd)

        let resource = try FSMountResource(url: URL(string: "onyxfs-drive://127.0.0.1:\(port)/library?ticket=t&v=1")!)
        await #expect(throws: FSBridgeError.disconnected) {
            try await FSBridgeClient.connect(to: resource)
        }
    }

    @Test func theDrivesIconOrNone() async throws {
        let stub = Stub()
        let client = try await stub.connect()
        #expect(try await client.volumeIcon() == nil, "an app with none, or from before icons: 404")

        let body = Data("0123456789".utf8)
        var icns = Data("icns".utf8)
        withUnsafeBytes(of: UInt32(8 + body.count).bigEndian) { icns.append(contentsOf: $0) }
        icns.append(body)
        stub.icon = icns
        #expect(try await client.volumeIcon() == icns)
        #expect(stub.requests("/fs/v1/icon").last?.headers["Authorization"]?.hasPrefix("Bearer ") == true)

        // Anything that is not one is none.
        stub.icon = Data("<html>".utf8)
        #expect(try await client.volumeIcon() == nil)
        stub.icon = icns.dropLast()
        #expect(try await client.volumeIcon() == nil, "cut short")

        stub.forgetSessions()
        await #expect(throws: FSBridgeError.disconnected) { try await client.volumeIcon() }
    }

    // MARK: - Reading the tree

    @Test func listStatAndVolume() async throws {
        let stub = Stub()
        stub.addFolder("/Shots")
        let take = stub.addFile("/Shots/Take 1.mov", size: 1234)
        stub.addFile("/Shots/Take 2.mov", size: 5)
        let client = try await stub.connect()

        let root = try await client.list(path: "/")
        #expect(root.path == "/" && root.generation == 42)
        #expect(root.entries.map(\.name) == ["Shots"])

        let shots = try await client.list(path: "/Shots")
        #expect(shots.entries.map(\.name) == ["Take 1.mov", "Take 2.mov"])
        #expect(shots.entries.first == take)

        #expect(try await client.stat(path: "/Shots/Take 1.mov").entry == take)
        #expect(try await client.stat(path: "/").entry.name == "Client Deliverables")
        #expect(try await client.volume() == stub.volume)

        await #expect(throws: FSBridgeError.notFound) { try await client.list(path: "/Nope") }
        await #expect(throws: FSBridgeError.notFound) { try await client.stat(path: "/Shots/Take 3.mov") }
        await #expect(throws: FSBridgeError.notFound) { try await client.source(id: "missing") }
    }

    @Test(arguments: [
        "/Q&A #1?/draft+final = 100% ☕.mov",
        "/a b/c%20d/e+f",
        "/Café/Ünïcödé 日本語 🎬",
        "/semi;colon/comma,/colon:/at@/dollar$/quote'\"/brackets[]{}()",
        "/tab\tand\\backslash",
    ])
    func everyNameReachesTheAppAsItself(_ path: String) async throws {
        let stub = Stub()
        let client = try await stub.connect()
        _ = try? await client.list(path: path)
        _ = try? await client.stat(path: path)
        _ = try? await client.delete(path: path)
        for seen in stub.requests.filter({ $0.path != "/fs/v1/session" }) {
            #expect(seen.query["path"] == path)
            let raw = try #require(seen.rawQuery)
            #expect(raw.hasPrefix("path=") && !raw.dropFirst(5).contains { " #?&+=;\t\"'".contains($0) },
                    "\(raw) must escape everything but unreserved characters and /")
        }
    }

    @Test func aDecomposedNameIsSentComposed() async throws {
        let stub = Stub()
        let client = try await stub.connect()
        let decomposed = "/Cafe\u{301}"          // what the kernel may hand over
        _ = try? await client.list(path: decomposed)
        let sent = try #require(stub.requests("/fs/v1/list").first?.query["path"])
        #expect(Array(sent.unicodeScalars) == Array("/Caf\u{E9}".unicodeScalars))
    }

    @Test func changesWaitsForTheDriveToMove() async throws {
        let stub = Stub()
        let client = try await stub.connect()
        let poll = Task { try await client.changes(since: 42, wait: 25) }
        try await eventually { !stub.requests("/fs/v1/changes").isEmpty }
        stub.post(paths: ["/Shots", "/"])
        let changes = try await poll.value
        #expect(changes.generation == 43 && !changes.all)
        #expect(Set(changes.paths) == ["/Shots", "/"])
        #expect(stub.requests("/fs/v1/changes").first?.query == ["since": "42", "wait": "25"])

        // Behind already: the answer is immediate.
        #expect(try await client.changes(since: 42).paths.sorted() == ["/", "/Shots"])
    }

    @Test func aStoppedPollIsCancelled() async throws {
        let stub = Stub()
        let client = try await stub.connect()
        let poll = Task { try await client.changes(since: 42) }
        try await eventually { !stub.requests("/fs/v1/changes").isEmpty }
        poll.cancel()
        await #expect(throws: CancellationError.self) { try await poll.value }
    }

    // MARK: - Bytes on this Mac

    @Test func dataReadsARangeOfALocalFile() async throws {
        let stub = Stub()
        let file = stub.addFile("/Kept.mov", size: 10_000, local: true)
        let client = try await stub.connect()
        let bytes = try await client.data(id: file.id!, range: 1000..<3000)
        #expect(bytes == Pattern.bytes(1000..<3000, seed: 7))
        #expect(stub.requests("/fs/v1/data").first?.headers["Range"] == "bytes=1000-2999")
        // At the end, what exists; past it, nothing.
        #expect(try await client.data(id: file.id!, range: 9000..<12_000) == Pattern.bytes(9000..<10_000, seed: 7))
        #expect(try await client.data(id: file.id!, range: 10_000..<10_001).isEmpty)
    }

    @Test func aRedirectToStorageIsFollowedWithoutTheSessionKey() async throws {
        let stub = Stub()
        let file = stub.addFile("/Unpinned.mov", size: 10_000)
        stub.redirectData = true
        let client = try await stub.connect()
        let bytes = try await client.data(id: file.id!, range: 0..<4096)
        #expect(bytes == Pattern.bytes(0..<4096, seed: 7))
        let fetched = try #require(stub.storageRequests.first)
        #expect(fetched.range == "bytes=0-4095")
        #expect(fetched.authorization == nil, "the session key must never reach storage")
    }

    // MARK: - Writes

    @Test func putFileStreamsTheFileAndAnswersWithThePendingEntry() async throws {
        let stub = Stub()
        let folder = try temporaryFolder()
        defer { removeFolder(folder) }
        let upload = folder.appendingPathComponent("upload.bin")
        let content = Pattern.bytes(0..<(3 << 20) + 17, seed: 99)
        try content.write(to: upload)
        let client = try await stub.connect()

        let entry = try await client.putFile(path: "/Shots/New Take #1.mov", from: upload,
                                             mtime: Date(timeIntervalSince1970: 1_790_460_000.25))
        #expect(entry.name == "New Take #1.mov" && entry.pending && entry.local)
        #expect(entry.size == Int64(content.count))
        #expect(stub.upload(at: "/Shots/New Take #1.mov") == content)
        let put = try #require(stub.requests("/fs/v1/file").first)
        #expect(put.method == "PUT")
        #expect(put.headers["X-Onyx-Mtime"] == "1790460000.25")
        #expect(put.headers["Authorization"]?.hasPrefix("Bearer ") == true)

        // Again at the same path: a replacement, the same file id.
        let again = try await client.putFile(path: "/Shots/New Take #1.mov", from: upload)
        #expect(again.id == entry.id)
        #expect(stub.requests("/fs/v1/file").last?.headers["X-Onyx-Mtime"] == nil)
    }

    @Test func mkdirRenameAndDelete() async throws {
        let stub = Stub()
        stub.addFolder("/Shots")
        stub.addFile("/Shots/Take 1.mov", size: 10)
        stub.addFile("/Shots/Take 2.mov", size: 20)
        let client = try await stub.connect()

        let made = try await client.mkdir(path: "/Shots/Selects")
        #expect(made.name == "Selects" && made.isDirectory)
        #expect(try JSONDecoder().decode(PathRequest.self, from: stub.requests("/fs/v1/mkdir")[0].body).path
                == "/Shots/Selects")
        _ = try await client.mkdir(path: "/Shots/Selects")   // a folder already there is fine
        await #expect(throws: FSBridgeError.conflict("A file is in the way.")) {
            try await client.mkdir(path: "/Shots/Take 1.mov")
        }

        let moved = try await client.rename(from: "/Shots/Take 1.mov", to: "/Shots/Selects/Hero.mov")
        #expect(moved.name == "Hero.mov" && moved.size == 10)
        let sent = try JSONDecoder().decode(RenameRequest.self, from: stub.requests("/fs/v1/rename")[0].body)
        #expect(sent.from == "/Shots/Take 1.mov" && sent.to == "/Shots/Selects/Hero.mov" && !sent.replace)

        stub.addFile("/Shots/Selects/Take 2.mov", size: 1)
        await #expect(throws: FSBridgeError.self) {
            try await client.rename(from: "/Shots/Take 2.mov", to: "/Shots/Selects/Take 2.mov")
        }
        let replaced = try await client.rename(from: "/Shots/Take 2.mov", to: "/Shots/Selects/Take 2.mov", replace: true)
        #expect(replaced.size == 20)

        try await client.delete(path: "/Shots/Selects/Hero.mov")
        #expect(stub.requests("/fs/v1/item").first?.method == "DELETE")
        await #expect(throws: FSBridgeError.notFound) { try await client.delete(path: "/Shots/Selects/Hero.mov") }
    }

    @Test(arguments: [
        (400, FSBridgeError.invalid("Refused with 400.")),
        (404, FSBridgeError.notFound),
        (409, FSBridgeError.conflict("Refused with 409.")),
        (413, FSBridgeError.quotaExceeded("Refused with 413.")),
        (500, FSBridgeError.server("Refused with 500.")),
        (503, FSBridgeError.server("Refused with 503.")),
    ])
    func aRefusedWriteSaysWhy(status: Int, expected: FSBridgeError) async throws {
        let stub = Stub()
        let client = try await stub.connect()
        stub.writeRefusal = status
        let folder = try temporaryFolder()
        defer { removeFolder(folder) }
        let file = folder.appendingPathComponent("f")
        try Data("x".utf8).write(to: file)
        await #expect(throws: expected) { try await client.putFile(path: "/f", from: file) }
        await #expect(throws: expected) { try await client.mkdir(path: "/New") }
        await #expect(throws: expected) { try await client.rename(from: "/a", to: "/b") }
        await #expect(throws: expected) { try await client.delete(path: "/a") }
    }

    @Test func aReadOnlyDriveRefusesWrites() async throws {
        let stub = Stub()
        stub.volume.readOnly = true
        let client = try await stub.connect()
        #expect(client.session.volume.readOnly)
        let expected = FSBridgeError.forbidden("This drive is read-only for you.")
        await #expect(throws: expected) { try await client.mkdir(path: "/New") }
        await #expect(throws: expected) { try await client.rename(from: "/a", to: "/b") }
        await #expect(throws: expected) { try await client.delete(path: "/a") }
        let folder = try temporaryFolder()
        defer { removeFolder(folder) }
        let file = folder.appendingPathComponent("f")
        try Data("x".utf8).write(to: file)
        await #expect(throws: expected) { try await client.putFile(path: "/f", from: file) }
    }
}
