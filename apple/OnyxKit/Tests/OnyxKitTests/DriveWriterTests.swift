import Foundation
import os
import Testing
@testable import OnyxKit

/// The mirror, pretend: a map of paths, and a count of refreshes.
private actor FakeTree: DriveTree {
    var items: [String: DriveItem] = [:]
    var dates: [String: Date] = [:]
    /// Folders shown under a name of their own: shown path (no leading
    /// slash, as the writer asks) → the server's.
    var serverNames: [String: String] = [:]
    var refreshes = 0
    func item(at path: String) async -> DriveItem? { items[path] }
    func changed(at path: String) async -> Date? { dates[path] }
    func refresh() async { refreshes += 1 }
    func serverPath(at path: String) async -> String? { serverNames[path] }
    func set(_ path: String, _ item: DriveItem?, changed: Date? = nil) {
        items[path] = item
        dates[path] = changed
    }
    func show(_ path: String, as server: String) { serverNames[path] = server }
}

/// The server's write routes, pretend: what was called, and a refusal on command.
private actor FakeRoutes: DriveWriteAPI {
    var calls: [String] = []
    var refuse: [String: OnyxError] = [:]
    func log(_ call: String) throws {
        calls.append(call)
        if let error = refuse.removeValue(forKey: call) { throw error }
    }
    func setRefusal(_ call: String, _ error: OnyxError) { refuse[call] = error }
    func updateFile(id: String, name: String?, folder: String?, filespaceId: String?) async throws {
        try log("update \(id) name=\(name ?? "-") folder=\(folder ?? "-")")
    }
    func deleteFile(id: String) async throws { try log("delete \(id)") }
    func createFolder(path: String, filespaceId: String?) async throws { try log("mkdir \(path)") }
    func moveFolder(from: String, to: String, filespaceId: String?) async throws { try log("mvdir \(from) -> \(to)") }
    func deleteFolder(path: String, filespaceId: String?) async throws { try log("rmdir \(path)") }
}

private func writer(_ tree: FakeTree, _ routes: FakeRoutes, _ server: FakeServer, gate: Gate? = nil) throws -> (DriveWriter, UploadQueue) {
    let queue = try UploadQueue(directory: scratch(), transport: server, settle: 0, sleep: { _ in await gate?.wait() })
    return (DriveWriter(scope: "drive.d1", filespaceId: "d1", api: routes, tree: tree, uploads: queue), queue)
}

@Suite struct DriveWriterTests {
    @Test func aCopiedFileIsListedAtOnceAndLeavesPendingOnceTheMirrorHasIt() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet)) // hold it pending a moment
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        let seen = await queue
        await seen.observe { job in Task { await drive.uploadChanged(job) } }

        let entry = try await drive.putFile(path: "/Footage/Take 1.mov", from: try source(Data("frames".utf8)))
        #expect(entry.size == 6)
        #expect(await drive.pending(at: "/Footage/Take 1.mov") != nil)

        await gate.open()
        await settle(queue)
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(await server.calls.last == "record /Footage/Take 1.mov")
        // Uploaded, but not yet in the mirror: still listed.
        #expect(await drive.pending(at: "/Footage/Take 1.mov") != nil)
        await tree.set("/Footage/Take 1.mov", .file(id: "file-Take 1.mov"))
        await drive.mirrorChanged()
        #expect(await drive.pending(at: "/Footage/Take 1.mov") == nil)
    }

    /// Saved over: the same file, new bytes — its id, and so its comments,
    /// tags and links on the web, stay. Listed as pending until the mirror
    /// shows the change itself, not merely the file (which it always did).
    @Test func savingOverAFileGivesItNewContents() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/notes.txt", .file(id: "notes"), changed: Date(timeIntervalSince1970: 1))
        let (drive, queue) = try writer(tree, routes, server)
        await queue.observe { job in Task { await drive.uploadChanged(job) } }
        try await drive.putFile(path: "/notes.txt", from: try source(Data("v2".utf8)))
        await settle(queue)
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(await server.calls == ["presign for notes", "put notes.txt", "swap notes <- drive/notes-new"])
        #expect(await routes.calls.isEmpty)
        // The mirror still has the old bytes (changed at 1 s; the swap was at 2 s).
        await drive.mirrorChanged()
        #expect(await drive.pending(at: "/notes.txt") != nil)
        await tree.set("/notes.txt", .file(id: "notes"), changed: Date(timeIntervalSince1970: 2))
        await drive.mirrorChanged()
        #expect(await drive.pending(at: "/notes.txt") == nil)
    }

    /// How apps save: a new copy under a temporary name, moved over the
    /// document. The move comes before anything is sent, so the copy goes
    /// up once — as the document's new contents.
    @Test func anAppsSaveBecomesTheDocumentsNewContents() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/Script.fdx", .file(id: "script"))
        let gate = Gate()
        let queue = try UploadQueue(directory: scratch(), transport: server, settle: 1, sleep: { _ in await gate.wait() })
        let drive = DriveWriter(scope: "drive.d1", filespaceId: "d1", api: routes, tree: tree, uploads: queue)
        try await drive.putFile(path: "/.Script.fdx.sb-1a2b", from: try source(Data("draft 2".utf8)))
        try await drive.rename(from: "/.Script.fdx.sb-1a2b", to: "/Script.fdx", replace: true)
        #expect(await drive.pending(at: "/Script.fdx")?.replaceOf == "script")
        await gate.open()
        await settle(queue)
        #expect(await server.calls == ["presign for script", "put Script.fdx", "swap script <- drive/script-new"])
        #expect(await routes.calls.isEmpty) // nothing deleted, nothing renamed
    }

    /// Moved over the document after its bytes had started up as a new
    /// file: it starts again as the document's contents — the key a new
    /// file was given cannot be swapped into another.
    @Test func aSaveMovedOverTheDocumentLateStartsAgainAsItsContents() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/Script.fdx", .file(id: "script"))
        await server.setFailure("record /.tmp-save", URLError(.networkConnectionLost), times: 50)
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        try await drive.putFile(path: "/.tmp-save", from: try source(Data("draft 2".utf8)))
        var tries = 0
        while await !server.calls.contains("record /.tmp-save"), tries < 500 {
            tries += 1
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        try await drive.rename(from: "/.tmp-save", to: "/Script.fdx", replace: true)
        await gate.open()
        await settle(queue)
        let calls = await server.calls
        #expect(calls.suffix(3) == ["presign for script", "put Script.fdx", "swap script <- drive/script-new"])
        #expect(await routes.calls.isEmpty)
    }

    /// Deleted in Finder while its new contents were on their way: the file
    /// goes on the server too, or its old contents would come back.
    @Test func deletingAFileMidSaveDeletesIt() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/notes.txt", .file(id: "notes"))
        await server.setFailure("presign for notes", URLError(.notConnectedToInternet))
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        try await drive.putFile(path: "/notes.txt", from: try source(Data("v2".utf8)))
        try await drive.delete(path: "/notes.txt")
        await gate.open()
        await settle(queue)
        #expect(await routes.calls == ["delete notes"])
        #expect(await server.calls.filter { $0.hasPrefix("swap") }.isEmpty)
    }

    @Test func renamedOrDeletedWhileUploadingNeverReachesTheServerAsItWas() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet), times: 2)
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        try await drive.putFile(path: "/untitled.txt", from: try source(Data([1])))
        try await drive.putFile(path: "/scratch.txt", from: try source(Data([2])))
        try await drive.rename(from: "/untitled.txt", to: "/Notes/ideas.txt", replace: false)
        try await drive.delete(path: "/scratch.txt")
        #expect(await drive.pending(at: "/Notes/ideas.txt") != nil)
        #expect(await drive.pending(at: "/untitled.txt") == nil)
        await gate.open()
        await settle(queue)
        let calls = await server.calls
        #expect(calls.contains("record /Notes/ideas.txt"))
        #expect(!calls.contains { $0.contains("scratch") })
        #expect(await routes.calls.isEmpty)
    }

    /// A folder renamed while files in it are still on their way — what
    /// Archive Utility does with what it unpacks, before removing the folder
    /// it unpacked into — takes them along: they land where it went, not in
    /// its old place, where the next step would remove them.
    @Test func filesStillUploadingGoWhereTheirFolderWent() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet), times: 2)
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        await tree.set("/Scratch/Sample", .folder)
        try await drive.putFile(path: "/Scratch/Sample/a.txt", from: try source(Data([1])))
        try await drive.putFile(path: "/Scratch/Sample/Day 2/b.txt", from: try source(Data([2])))
        try await drive.putFile(path: "/Scratch/Samples.txt", from: try source(Data([3])))
        try await drive.rename(from: "/Scratch/Sample", to: "/Sample", replace: false)
        #expect(await routes.calls == ["mvdir Scratch/Sample -> Sample"])
        #expect(await drive.pending(at: "/Sample/a.txt") != nil)
        #expect(await drive.pending(at: "/Sample/Day 2/b.txt") != nil)
        #expect(await drive.pending(at: "/Scratch/Sample/a.txt") == nil)
        #expect(await drive.pending(at: "/Scratch/Samples.txt") != nil, "a name that only starts the same stays")
        await gate.open()
        await settle(queue)
        let calls = await server.calls
        #expect(calls.contains("record /Sample/a.txt"))
        #expect(calls.contains("record /Sample/Day 2/b.txt"))
        #expect(!calls.contains { $0.hasPrefix("record /Scratch/Sample/") })
    }

    @Test func renamesAndMovesAreTheServersOwn() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/a.mov", .file(id: "f1"))
        await tree.set("/Old", .folder)
        let (drive, _) = try writer(tree, routes, server)
        try await drive.rename(from: "/a.mov", to: "/b.mov", replace: false)
        try await drive.rename(from: "/a.mov", to: "/Cuts/a.mov", replace: false)
        try await drive.rename(from: "/a.mov", to: "/Cuts/final.mov", replace: false)
        try await drive.rename(from: "/Old", to: "/New", replace: false)
        #expect(await routes.calls == [
            "update f1 name=b.mov folder=-",
            "update f1 name=- folder=Cuts",
            "update f1 name=- folder=Cuts", "update f1 name=final.mov folder=-",
            "mvdir Old -> New",
        ])
        #expect(await tree.refreshes == 4)
    }

    @Test func moveOverAnExistingFileOnlyWhenAskedTo() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/draft.doc", .file(id: "new"))
        await tree.set("/final.doc", .file(id: "old"))
        let (drive, _) = try writer(tree, routes, server)
        await #expect(throws: DriveWriter.Failure.posix(EEXIST, nil)) {
            try await drive.rename(from: "/draft.doc", to: "/final.doc", replace: false)
        }
        try await drive.rename(from: "/draft.doc", to: "/final.doc", replace: true)
        #expect(await routes.calls == ["delete old", "update new name=final.doc folder=-"])
    }

    @Test func theServersRefusalIsFindersPermissionError() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/a.mov", .file(id: "f1"))
        await routes.setRefusal("delete f1", OnyxError.http(status: 403, message: "Your role can view files but not delete them."))
        let (drive, _) = try writer(tree, routes, server)
        await #expect(throws: DriveWriter.Failure.posix(EACCES, "Your role can view files but not delete them.")) {
            try await drive.delete(path: "/a.mov")
        }
    }

    @Test func foldersAreMadeOnceAndGoWhole() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        let (drive, _) = try writer(tree, routes, server)
        try await drive.mkdir(path: "/Footage/Day 1")
        // The mirror is brought up to date before the bridge reads the new
        // folder's entry back from it.
        #expect(await tree.refreshes == 1)
        await tree.set("/Footage/Day 1", .folder)
        try await drive.mkdir(path: "/Footage/Day 1") // already there: nothing to do
        #expect(await tree.refreshes == 1)
        try await drive.delete(path: "/Footage/Day 1")
        #expect(await routes.calls == ["mkdir Footage/Day 1", "rmdir Footage/Day 1"])
        await tree.set("/a.txt", .file(id: "x"))
        await #expect(throws: DriveWriter.Failure.posix(EEXIST, nil)) { try await drive.mkdir(path: "/a.txt") }
    }

    /// A folder the mirror shows under a name of its own — "photos (2)"
    /// beside "Photos", which the server keeps apart — is changed by the
    /// server's name for it, and so is what is made or moved into it.
    @Test func aFolderShownUnderANameOfItsOwnIsChangedByTheServersName() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/photos (2)", .folder)
        await tree.show("photos (2)", as: "photos")
        await tree.set("/x.jpg", .file(id: "x"))
        let (drive, _) = try writer(tree, routes, server)
        try await drive.mkdir(path: "/photos (2)/New")
        try await drive.rename(from: "/x.jpg", to: "/photos (2)/x.jpg", replace: false)
        try await drive.rename(from: "/photos (2)", to: "/Old", replace: false)
        try await drive.delete(path: "/photos (2)")
        #expect(await routes.calls == [
            "mkdir photos/New", "update x name=- folder=photos", "mvdir photos -> Old", "rmdir photos",
        ])
    }

    /// The server refuses to delete a folder holding files this account
    /// cannot see, and deletes nothing: Finder is told it is not empty.
    @Test func aFolderWithFilesNotShownHereIsNotEmpty() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/Shared", .folder)
        await routes.setRefusal("rmdir Shared", OnyxError.http(status: 409, message: "“Shared” holds 1 file you cannot see."))
        let (drive, _) = try writer(tree, routes, server)
        await #expect(throws: DriveWriter.Failure.posix(ENOTEMPTY, "“Shared” holds 1 file you cannot see.")) {
            try await drive.delete(path: "/Shared")
        }
    }

    @Test func pathsAreCheckedBeforeAnythingHappens() throws {
        #expect(throws: DriveWriter.Failure.posix(EINVAL, nil)) { try DriveWriter.split("/a/../b") }
        #expect(throws: DriveWriter.Failure.posix(EINVAL, nil)) { try DriveWriter.split("/") }
        let split = try DriveWriter.split("/Footage/Day 1/Take.mov")
        #expect(split.folder == "Footage/Day 1" && split.name == "Take.mov")
        #expect(DriveWriter.relative("/Footage/Day 1/") == "Footage/Day 1")
    }
}

@Suite struct DriveWriterRaceTests {
    /// Finder deletes (or renames) a file the instant it finished uploading,
    /// before anything told the writer: the change reaches the file it became.
    @Test func aChangeRightAfterTheUploadFinishedReachesTheFile() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        let (drive, queue) = try writer(tree, routes, server)
        try await drive.putFile(path: "/a.txt", from: try source(Data([1])))
        try await drive.putFile(path: "/b.txt", from: try source(Data([2])))
        await settle(queue)
        try await drive.delete(path: "/a.txt")
        try await drive.rename(from: "/b.txt", to: "/c.txt", replace: false)
        #expect(await routes.calls == ["delete file-a.txt", "update file-b.txt name=c.txt folder=-"])
        #expect(await drive.pending(at: "/c.txt") == nil)
    }
}

/// The writer's folder routes through the real API, to a server that reads a
/// query as the web's routes do (URLSearchParams): "+" is a space there.
@Suite struct DriveWriterQueryTests {
    /// Foundation's safe-save folder, made beside a file and removed at once,
    /// in a folder whose name has a "+" in it. The delete asked for
    /// "A B/…", was told there is no such folder, and the folder stayed on
    /// the server (made by JSON, it had arrived as named) — while Finder,
    /// never told, took it for gone.
    @Test func aFolderMadeAndRemovedUnderAPlusLeavesNothingBehind() async throws {
        let server = try FolderServer()
        defer { server.tearDown() }
        let tree = FakeTree()
        let queue = try UploadQueue(directory: scratch(), transport: FakeServer(), settle: 0)
        let drive = DriveWriter(scope: "drive.d1", filespaceId: "d1", api: server.api, tree: tree, uploads: queue)
        let path = "/Disclaimers+Trademarks/Footage/(A Document Being Saved By repl)"

        try await drive.mkdir(path: path)
        #expect(server.folders == ["Disclaimers+Trademarks/Footage/(A Document Being Saved By repl)"])
        await tree.set(path, .folder)
        try await drive.delete(path: path)
        #expect(server.folders.isEmpty)
    }

    /// A folder holding files this account was never shown: the server
    /// deletes nothing (409), and Finder is told the folder is not empty —
    /// not that it is gone.
    @Test func aDeleteTheServerRefusesIsNotTakenForDone() async throws {
        let server = try FolderServer()
        defer { server.tearDown() }
        server.add("Shared", refusing: (409, "“Shared” holds 1 file you cannot see, so it was not deleted."))
        let tree = FakeTree()
        await tree.set("/Shared", .folder)
        // Shown by the mirror, gone from the server since.
        await tree.set("/Elsewhere", .folder)
        let queue = try UploadQueue(directory: scratch(), transport: FakeServer(), settle: 0)
        let drive = DriveWriter(scope: "drive.d1", filespaceId: "d1", api: server.api, tree: tree, uploads: queue)

        await #expect(throws: DriveWriter.Failure.posix(ENOTEMPTY, "“Shared” holds 1 file you cannot see, so it was not deleted.")) {
            try await drive.delete(path: "/Shared")
        }
        await #expect(throws: DriveWriter.Failure.posix(ENOENT, "There is no folder here.")) {
            try await drive.delete(path: "/Elsewhere")
        }
        #expect(server.folders == ["Shared"])
    }

    /// Every query value the app sends reads back as itself on the server.
    @Test func aQueryValueReadsBackAsItselfOnTheServer() throws {
        let value = "C++ & Co/a=b #1 50% (été)"
        let url = OnyxConfig(baseURL: URL(string: "https://onyx.test")!).url("api/files", query: [.init(name: "q", value: value)])
        #expect(FolderServer.formValue("q", in: url) == value)
    }
}

/// /api/files/folders, pretend: the folders made (POST, a JSON body) and
/// removed (DELETE ?name=, read as URLSearchParams reads it — "+" is a space).
private final class FolderServer: @unchecked Sendable {
    let api: OnyxAPI
    private let host = "\(UUID().uuidString.lowercased()).folders.test"
    private let tokens = TokenStore(service: "io.onyxfs.tests.folders.\(UUID().uuidString)", accessGroup: nil)
    private let made = OSAllocatedUnfairLock<Set<String>>(initialState: [])
    /// Deletes answered with a refusal, by folder, and nothing deleted.
    private let refusals = OSAllocatedUnfairLock<[String: (Int, String)]>(initialState: [:])

    var folders: Set<String> { made.withLock { $0 } }

    func add(_ name: String, refusing refusal: (Int, String)? = nil) {
        made.withLock { _ = $0.insert(name) }
        refusals.withLock { $0[name] = refusal }
    }

    init() throws {
        try tokens.set("test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FolderServerProtocol.self]
        api = OnyxAPI(config: OnyxConfig(baseURL: URL(string: "https://\(host)")!), tokens: tokens,
                      session: URLSession(configuration: configuration))
        Self.servers.withLock { $0[host] = self }
    }

    func tearDown() {
        tokens.clear()
        Self.servers.withLock { $0[host] = nil }
    }

    static let servers = OSAllocatedUnfairLock<[String: FolderServer]>(initialState: [:])

    /// A query value as the server reads it: "+" a space, then %-decoded.
    static func formValue(_ name: String, in url: URL) -> String? {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery ?? ""
        for pair in query.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map { $0.replacingOccurrences(of: "+", with: " ").removingPercentEncoding }
            if parts.first == name { return parts.count > 1 ? parts[1] : "" }
        }
        return nil
    }

    func respond(to request: URLRequest, body: Data) -> (Int, String) {
        guard let url = request.url, url.path == "/api/files/folders" else { return (404, #"{"error":"Not found."}"#) }
        switch request.httpMethod {
        case "POST":
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            guard let name = json?["name"] as? String else { return (400, #"{"error":"Folder required."}"#) }
            made.withLock { _ = $0.insert(name) }
            return (200, "{}")
        case "DELETE":
            guard let name = Self.formValue("name", in: url), folders.contains(name) else {
                return (404, #"{"error":"There is no folder here."}"#)
            }
            if let (status, message) = refusals.withLock({ $0[name] }) {
                let body = try! JSONSerialization.data(withJSONObject: ["error": message])
                return (status, String(decoding: body, as: UTF8.self))
            }
            made.withLock { _ = $0.remove(name) }
            return (200, #"{"deleted":0,"failed":0,"more":false}"#)
        default:
            return (405, #"{"error":"Not allowed."}"#)
        }
    }
}

private final class FolderServerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".folders.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host,
              let server = FolderServer.servers.withLock({ $0[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let (status, text) = server.respond(to: request, body: request.httpBody ?? Self.read(request.httpBodyStream))
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    /// A body URLSession hands over as a stream.
    private static func read(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}
