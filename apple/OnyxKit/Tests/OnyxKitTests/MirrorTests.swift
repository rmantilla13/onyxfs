import Testing
import Foundation
@testable import OnyxKit

// MARK: - Fixtures

private func item(_ id: String, _ name: String, in folder: String = "", created: Int64? = nil,
                  updated: Int64? = nil, hash: String? = nil, version: Int = 1, size: Int64? = 10,
                  mime: String? = "image/png") -> FileItem {
    FileItem(id: id, name: name, folder: folder, kind: "image", mime: mime, size: size, url: nil,
             storageKey: nil, thumbnailUrl: nil, tags: [], notes: nil, caption: nil, visibility: "org",
             version: version, contentHash: hash, createdBy: nil,
             createdAt: created.map(EpochMillis.init), updatedAt: updated.map(EpochMillis.init),
             deletedAt: nil, seq: nil)
}

private func replica(_ items: [FileItem], folders: [String]? = nil) -> Replica {
    var r = Replica()
    r.apply(changed: items, deleted: [], folders: folders)
    return r
}

private func names(_ entries: [MirrorEntry]?) -> [String] { entries?.map(\.name) ?? [] }

// MARK: - MirrorIndex

/// The paths the mount hands to Finder. A name that is not a legal file name,
/// or two that Finder takes for one, loses a file from view without an error
/// anywhere — so each rule is pinned.
struct MirrorIndexTests {

    @Test func serverNamesBecomeFileNames() {
        let index = MirrorIndex(replica([
            item("1", "Q1/Q2 plan.pdf"),
            item("2", "bell\u{7}\u{0}tab\u{9}.txt"),
            item("3", ""),
            item("4", ".", created: 1),
            item("5", "..", created: 2),
            item("6", "\u{1}\u{1F}"),
            item("7", "👨‍👩‍👧 family.png"),
            item("8", "del\u{7F}\u{85}.png"),
        ]))
        let byID = { (id: String) in index.file(id: id)?.name }
        #expect(byID("1") == "Q1:Q2 plan.pdf")
        #expect(byID("2") == "belltab.txt")
        #expect(byID("7") == "👨‍👩‍👧 family.png", "a joiner is part of an emoji, not a control character")
        #expect(byID("8") == "del.png")
        // Four with no usable name: one keeps "Untitled", the rest are numbered.
        let untitled = ["3", "4", "5", "6"].compactMap(byID)
        #expect(Set(untitled) == ["Untitled", "Untitled (2)", "Untitled (3)", "Untitled (4)"])
        for entry in index.files(under: "") {
            #expect(!entry.name.contains("/"))
            #expect(!entry.name.unicodeScalars.contains { $0.properties.generalCategory == .control })
            #expect(!["", ".", ".."].contains(entry.name))
        }
    }

    @Test func folderSegmentsAreMadeSafeToo() throws {
        // Replica.clean keeps "." and ".." segments and control characters; the
        // mount must not hand either to a file system.
        let index = MirrorIndex(replica([item("a", "a.png", in: "../x/\u{7}Bell/.")]))
        let path = try #require(index.file(id: "a")?.path)
        #expect(path == "Untitled/x/Bell/Untitled/a.png")
        #expect(MirrorIndex.normalize(path) == path)
        #expect(index.entry(at: "Untitled/x/Bell")?.isFolder == true)
    }

    @Test func namesThatDifferOnlyInCaseAreNumberedOldestFirst() {
        let index = MirrorIndex(replica([
            item("b", "report.pdf", created: 200),
            item("a", "Report.pdf", created: 100),
            item("c", "REPORT.PDF", created: 300),
        ]))
        #expect(index.file(id: "a")?.name == "Report.pdf", "the oldest keeps its name")
        #expect(index.file(id: "b")?.name == "report (2).pdf")
        #expect(index.file(id: "c")?.name == "REPORT (3).PDF")
    }

    @Test func tiesAreBrokenByDateThenId() {
        // No dates at all: the id decides. A dated file outranks an undated one.
        let undated = MirrorIndex(replica([item("z", "x.png"), item("m", "x.png")]))
        #expect(undated.file(id: "m")?.name == "x.png")
        #expect(undated.file(id: "z")?.name == "x (2).png")
        let mixed = MirrorIndex(replica([item("a", "x.png"), item("b", "x.png", created: 5)]))
        #expect(mixed.file(id: "b")?.name == "x.png")
        #expect(mixed.file(id: "a")?.name == "x (2).png")
        let sameDate = MirrorIndex(replica([item("q", "x.png", created: 5), item("p", "x.png", created: 5)]))
        #expect(sameDate.file(id: "p")?.name == "x.png")
    }

    @Test func aFolderKeepsItsNameAgainstAFile() {
        // Even an older file yields: renaming the folder would move every path
        // beneath it.
        let index = MirrorIndex(replica([
            item("f", "assets", created: 1),
            item("g", "Notes.txt", created: 1),
            item("in", "logo.png", in: "Assets", created: 9),
            item("n", "n.md", in: "notes.TXT"),
        ]))
        #expect(names(index.children(of: "")) == ["Assets", "notes.TXT", "assets (2)", "Notes (2).txt"])
        #expect(index.entry(at: "Assets/logo.png")?.fileId == "in")
        #expect(index.entry(at: "notes.TXT/n.md")?.fileId == "n")
        #expect(index.entry(at: "assets (2)")?.fileId == "f")
    }

    @Test func foldersThatDifferOnlyInCaseAreNumberedAndTheirFilesFollow() {
        let index = MirrorIndex(replica([
            item("a", "a.png", in: "Brand/Logos"),
            item("b", "b.png", in: "brand/logos"),
        ]))
        #expect(names(index.children(of: "")) == ["Brand", "brand (2)"])
        #expect(index.file(id: "a")?.path == "Brand/Logos/a.png")
        #expect(index.file(id: "b")?.path == "brand (2)/logos/b.png")
        #expect(index.folderCount == 4)
    }

    @Test func aSuffixNeverTakesARealName() {
        let index = MirrorIndex(replica([
            item("1", "a.png", created: 1),
            item("2", "A.png", created: 2),
            item("3", "a (2).png", created: 3),
            item("4", "a.png", created: 4),
            item("5", "A (3).PNG", created: 5),
        ]))
        #expect(index.file(id: "1")?.name == "a.png")
        #expect(index.file(id: "3")?.name == "a (2).png", "a real name is never displaced by a generated one")
        #expect(index.file(id: "5")?.name == "A (3).PNG")
        #expect(index.file(id: "2")?.name == "A (4).png")
        #expect(index.file(id: "4")?.name == "a (5).png")
        let folded = index.files(under: "").map { $0.name.lowercased() }
        #expect(Set(folded).count == folded.count)
    }

    @Test func sanitizedNamesThatMeetAreNumbered() {
        let index = MirrorIndex(replica([item("1", "a/b", created: 1), item("2", "a:b", created: 2)]))
        #expect(index.file(id: "1")?.name == "a:b")
        #expect(index.file(id: "2")?.name == "a:b (2)")
    }

    @Test func suffixesGoBeforeTheExtension() {
        #expect(MirrorIndex.suffixed("a.png", 2, isFolder: false) == "a (2).png")
        #expect(MirrorIndex.suffixed("archive.tar.gz", 3, isFolder: false) == "archive.tar (3).gz")
        #expect(MirrorIndex.suffixed("notes", 2, isFolder: false) == "notes (2)")
        #expect(MirrorIndex.suffixed(".env", 2, isFolder: false) == ".env (2)")
        #expect(MirrorIndex.suffixed("trailing.", 2, isFolder: false) == "trailing. (2)")
        #expect(MirrorIndex.suffixed("v1.2", 2, isFolder: true) == "v1.2 (2)", "a folder has no extension")
    }

    @Test func theSameReplicaAlwaysGivesTheSamePaths() {
        var items: [FileItem] = []
        for i in 0..<200 {
            // Plenty of collisions, several folders, some dates missing.
            items.append(item("id-\(i)", i % 3 == 0 ? "Clip.MOV" : "clip.mov", in: ["", "A", "a", "A/b"][i % 4],
                              created: i % 5 == 0 ? nil : Int64(1000 - i)))
        }
        let forward = MirrorIndex(replica(items))
        let backward = MirrorIndex(replica(items.reversed()))
        #expect(forward.files(under: "") == backward.files(under: ""))
        for path in ["", "A", "a (2)", "A/b"] {
            #expect(forward.children(of: path) == backward.children(of: path))
        }
        #expect(forward.fileCount == 200)
    }

    @Test func lookupsForgiveSlashesAndCaseButNotDots() throws {
        let index = MirrorIndex(replica([item("a", "Plan.pdf", in: "Campaigns/2026")]))
        #expect(index.entry(at: "Campaigns/2026/Plan.pdf")?.fileId == "a")
        #expect(index.entry(at: "/Campaigns//2026/Plan.pdf/")?.fileId == "a")
        #expect(index.entry(at: "campaigns/2026/PLAN.PDF")?.path == "Campaigns/2026/Plan.pdf",
                "a case-insensitive hit answers with the real path")
        #expect(index.entry(at: "Campaigns/2026/../2026/Plan.pdf") == nil)
        #expect(index.entry(at: "./Campaigns") == nil)
        #expect(index.entry(at: "..") == nil)
        #expect(index.entry(at: "Campaigns/2027") == nil)
        #expect(index.entry(at: "Campaigns/2026/Plan.pdf/more") == nil)
        let folder = try #require(index.entry(at: "CAMPAIGNS/"))
        #expect(folder.isFolder && folder.path == "Campaigns" && folder.name == "Campaigns")
        #expect(folder.fileId == nil && folder.etag == nil && folder.size == 0 && folder.mime == nil)
        // Unicode normalization does not matter either: "é" composed or not.
        let accented = MirrorIndex(replica([item("e", "caf\u{E9}.txt")]))
        #expect(accented.entry(at: "cafe\u{301}.txt")?.fileId == "e")
    }

    @Test func normalizeCleansOrRefuses() {
        #expect(MirrorIndex.normalize("") == "")
        #expect(MirrorIndex.normalize("/") == "")
        #expect(MirrorIndex.normalize("//a///b//") == "a/b")
        #expect(MirrorIndex.normalize("a/./b") == nil)
        #expect(MirrorIndex.normalize("a/../b") == nil)
        #expect(MirrorIndex.normalize("a/..b/c.") == "a/..b/c.", "only whole segments are dots")
    }

    @Test func theRootIsTheDriveItself() throws {
        let empty = MirrorIndex(Replica(), emptyFolderDate: Date(timeIntervalSince1970: 42))
        for path in ["", "/", "//"] {
            let root = try #require(empty.entry(at: path))
            #expect(root.kind == .folder && root.name == "" && root.path == "")
            #expect(root.modified == Date(timeIntervalSince1970: 42))
        }
        #expect(empty.children(of: "") == [])
        #expect(empty.files(under: "").isEmpty)
        #expect(empty.fileCount == 0 && empty.folderCount == 0)
    }

    @Test func childrenListFoldersFirstInFindersOrder() {
        let index = MirrorIndex(replica([
            item("1", "file10.png"), item("2", "file2.png"), item("3", "File1.png"),
            item("4", "x.png", in: "beta"), item("5", "x.png", in: "Alpha"), item("6", "x.png", in: "gamma 10"),
            item("7", "x.png", in: "gamma 9"), item("8", "x.png", in: "Alpha/inner"),
        ]))
        #expect(names(index.children(of: "")) == ["Alpha", "beta", "gamma 9", "gamma 10",
                                                   "File1.png", "file2.png", "file10.png"])
        #expect(names(index.children(of: "alpha")) == ["inner", "x.png"])
        #expect(index.children(of: "Alpha")?.first?.path == "Alpha/inner")
        #expect(index.children(of: "file2.png") == nil, "a file has no children")
        #expect(index.children(of: "missing") == nil)
        #expect(index.children(of: "../x") == nil)
    }

    @Test func filesUnderAFolderReachEveryDepth() {
        let index = MirrorIndex(replica([
            item("root", "r.png"),
            item("a", "a.png", in: "A"),
            item("ab", "ab.png", in: "A/B"),
            item("abc", "abc.png", in: "A/B/C"),
            item("other", "o.png", in: "AA"),
        ], folders: ["A/Empty"]))
        #expect(Set(index.files(under: "").compactMap(\.fileId)) == ["root", "a", "ab", "abc", "other"])
        #expect(index.files(under: "A").compactMap(\.fileId) == ["a", "ab", "abc"],
                "a folder's own files, then its subfolders'")
        #expect(index.files(under: "/a/b/").compactMap(\.fileId) == ["ab", "abc"])
        #expect(index.files(under: "A/Empty").isEmpty)
        #expect(index.files(under: "A/a.png").isEmpty, "a file is not a folder")
        #expect(index.files(under: "nowhere").isEmpty)
        #expect(index.files(under: "A/../AA").isEmpty)
        let pinnable: any PinnableIndex = index
        #expect(pinnable.files(under: "AA").map(\.path) == ["AA/o.png"])
        #expect(pinnable.file(id: "abc")?.path == "A/B/C/abc.png")
        #expect(pinnable.file(id: "nope") == nil)
    }

    @Test func datesComeFromTheFilesBeneath() throws {
        let fallback = Date(timeIntervalSince1970: 7)
        let index = MirrorIndex(replica([
            item("old", "old.png", in: "A", created: 1_000, updated: 5_000),
            item("new", "new.png", in: "A/B/C", created: 9_000),
            item("none", "none.png", in: "D"),
        ], folders: ["Empty"]), emptyFolderDate: fallback)
        let ms = { (v: Int64) in EpochMillis(v).date }
        #expect(index.file(id: "old")?.modified == ms(5_000), "updatedAt wins over createdAt")
        #expect(index.file(id: "new")?.modified == ms(9_000), "createdAt when never updated")
        #expect(index.file(id: "none")?.modified == fallback)
        #expect(index.entry(at: "A")?.modified == ms(9_000), "the newest file at any depth")
        #expect(index.entry(at: "A/B")?.modified == ms(9_000))
        #expect(index.entry(at: "Empty")?.modified == fallback)
        #expect(index.entry(at: "D")?.modified == fallback)
        #expect(index.entry(at: "")?.modified == ms(9_000))
    }

    @Test func etagsSizesAndTypesComeFromTheFile() throws {
        let index = MirrorIndex(replica([
            item("h", "h.png", hash: "sha256:abc", version: 4),
            item("v", "v.png", hash: nil, version: 3, size: nil, mime: nil),
            item("e", "e.png", hash: "", version: 2, size: 1_234_567_890_123),
        ]))
        let h = try #require(index.file(id: "h"))
        #expect(h.etag == "sha256:abc" && h.kind == .file && h.fileId == "h" && h.mime == "image/png")
        let v = try #require(index.file(id: "v"))
        #expect(v.etag == "v3" && v.size == 0 && v.mime == nil)
        let e = try #require(index.file(id: "e"))
        #expect(e.etag == "v2", "an empty hash is no hash")
        #expect(e.size == 1_234_567_890_123)
        #expect(index.file(id: "missing") == nil)
    }

    @Test func countsAndPathsHoldTogether() {
        let index = MirrorIndex(replica([
            item("1", "a.png", in: "X/Y"), item("2", "b.png", in: "X"), item("3", "c.png"),
        ], folders: ["Z"]))
        #expect(index.fileCount == 3)
        #expect(index.folderCount == 3)
        for file in index.files(under: "") {
            #expect(!file.path.hasPrefix("/") && !file.path.hasSuffix("/"))
            #expect(index.entry(at: file.path) == file)
            #expect(Replica.lastComponent(file.path) == file.name)
        }
    }

    @Test func aDeepDriveBuildsOnAConcurrencyThread() async {
        // DriveMirror builds off its actor, on a thread with a small stack; a
        // walk that recursed per level would overflow it here.
        let deep = (0..<1_500).map { "level \($0)" }.joined(separator: "/")
        let r = replica([item("bottom", "b.png", in: deep, created: 3_000), item("top", "t.png", created: 1_000)])
        let index = await Task.detached { MirrorIndex(r) }.value
        #expect(index.folderCount == 1_500)
        #expect(index.file(id: "bottom")?.path == deep + "/b.png")
        #expect(index.entry(at: "level 0")?.modified == EpochMillis(3_000).date)
        #expect(index.files(under: "").compactMap(\.fileId) == ["top", "bottom"])
        #expect(index.files(under: "level 0/level 1").compactMap(\.fileId) == ["bottom"])
    }

    @Test func aHundredThousandFilesBuildQuickly() {
        var items: [FileItem] = []
        items.reserveCapacity(100_000)
        for i in 0..<100_000 {
            // Hundreds of folders two deep, and a crowd of clashing names in the root.
            let folder = i % 10 == 0 ? "" : "Projects \(i % 50)/Shot \(i % 1_000)"
            items.append(item("id-\(i)", "frame \(i % 5_000).exr", in: folder, created: Int64(i)))
        }
        let r = replica(items)
        let started = Date()
        let index = MirrorIndex(r)
        let took = Date().timeIntervalSince(started)
        #expect(index.fileCount == 100_000)
        #expect(index.folderCount == r.folders.count)
        let top = r.children(of: "")
        #expect(index.children(of: "")?.count == top.folders.count + top.files.count)
        #expect(index.entry(at: "projects 1/shot 1/FRAME 1.EXR")?.fileId == "id-1")
        // Debug build; generous, to catch a quadratic step rather than to time it.
        #expect(took < 20, "built in \(took)s")
    }
}

// MARK: - A stub server

/// Canned answers for one test, at a host of its own, so tests running in
/// parallel never see each other's requests.
private final class MirrorStubServer: @unchecked Sendable {
    let host = "\(UUID().uuidString.lowercased()).mirror.test"
    private let lock = NSLock()
    private var pages: [Int64: DeltaPage] = [:]
    private var links: [String: String] = [:]
    private var delay: TimeInterval = 0
    private var log: [URL] = []

    private static let lock = NSLock()
    nonisolated(unsafe) private static var servers: [String: MirrorStubServer] = [:]

    init() { Self.lock.withLock { Self.servers[host] = self } }
    deinit { Self.lock.withLock { _ = Self.servers.removeValue(forKey: host) } }

    static func server(for url: URL?) -> MirrorStubServer? {
        guard let host = url?.host else { return nil }
        return lock.withLock { servers[host] }
    }

    func page(at cursor: Int64, _ page: DeltaPage) { lock.withLock { pages[cursor] = page } }
    func link(_ id: String, json: String) { lock.withLock { links[id] = json } }
    func slow(_ seconds: TimeInterval) { lock.withLock { delay = seconds } }
    var requests: [URL] { lock.withLock { log } }
    func requests(to path: String) -> [URL] { requests.filter { $0.path == path } }

    func respond(to url: URL) -> (status: Int, body: Data, delay: TimeInterval) {
        lock.withLock {
            log.append(url)
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if url.path == "/api/files/delta" {
                let cursor = query.first { $0.name == "cursor" }.flatMap { Int64($0.value ?? "") } ?? -1
                guard let page = pages[cursor] else { return (500, Data(#"{"error":"no page"}"#.utf8), delay) }
                return (200, try! JSONEncoder().encode(page), delay)
            }
            let prefix = "/api/space/files/"
            if url.path.hasPrefix(prefix), let json = links[String(url.path.dropFirst(prefix.count))] {
                return (200, Data(json.utf8), delay)
            }
            return (404, Data(#"{"error":"Not found"}"#.utf8), delay)
        }
    }
}

private final class MirrorStubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".mirror.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let server = MirrorStubServer.server(for: url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let (status, body, delay) = server.respond(to: url)
        if delay > 0 { Thread.sleep(forTimeInterval: delay) }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

/// An OnyxAPI pointed at a stub, signed in with a throwaway token under a
/// keychain service of its own, removed again when the test ends.
private struct MirrorStubbedAPI {
    let server = MirrorStubServer()
    let api: OnyxAPI
    private let tokens: TokenStore

    init() throws {
        tokens = TokenStore(service: "io.onyxfs.tests.mirror.\(UUID().uuidString)", accessGroup: nil)
        try tokens.set("test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MirrorStubProtocol.self]
        api = OnyxAPI(config: OnyxConfig(baseURL: URL(string: "https://\(server.host)")!), tokens: tokens,
                      session: URLSession(configuration: configuration))
    }

    func tearDown() { tokens.clear() }
}

private func page(_ changed: [FileItem], deleted: [String] = [], cursor: Int64, done: Bool = true,
                  scope: String? = "s1", folders: [String]? = []) -> DeltaPage {
    DeltaPage(changed: changed, deleted: deleted.map { Tombstone(id: $0, seq: cursor) }, cursor: cursor,
              done: done, scope: scope, folders: folders)
}

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("onyxkit-mirror-\(UUID().uuidString)")
}

// MARK: - DriveMirror

/// A drive's replica, synced, kept, and read through. Against a stub server:
/// a scope change and a page boundary are hard to produce on demand from a
/// real one, and costly to get wrong.
struct DriveMirrorTests {
    let server = URL(string: "https://www.onyxfs.io")!

    @Test func aReplicaIsKeptForTheSameAccountOnly() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory().appendingPathComponent("nested/mirrors")
        defer { try? FileManager.default.removeItem(at: dir.deletingLastPathComponent().deletingLastPathComponent()) }
        stub.server.page(at: 0, page([item("a", "a.png", in: "X")], cursor: 7, folders: ["Empty"]))

        let mirror = DriveMirror(scope: .drive(id: "d1"), directory: dir, server: server,
                                 account: "Me@Example.com", api: { stub.api })
        #expect(await mirror.index.fileCount == 0)
        _ = try await mirror.sync()
        let file = dir.appendingPathComponent("drive.d1.json")
        #expect(FileManager.default.fileExists(atPath: file.path))

        // The same account, however it is capitalised, picks up where it was.
        let again = DriveMirror(scope: .drive(id: "d1"), directory: dir, server: server,
                                account: "me@example.com", api: { stub.api })
        #expect(await again.index.entry(at: "X/a.png")?.fileId == "a")
        #expect(await again.index.entry(at: "Empty")?.isFolder == true)

        let stored = try JSONDecoder().decode(DriveMirror.Stored.self, from: Data(contentsOf: file))
        #expect(stored.identity == DriveMirror.Identity(server: "https://www.onyxfs.io", account: "me@example.com"))
        #expect(stored.replica.cursor == 7 && stored.replica.scope == "s1")

        // Another account, or another server, starts empty.
        let other = DriveMirror(scope: .drive(id: "d1"), directory: dir, server: server,
                                account: "someone@example.com", api: { stub.api })
        #expect(await other.index.fileCount == 0)
        let elsewhere = DriveMirror(scope: .drive(id: "d1"), directory: dir,
                                    server: URL(string: "http://localhost:3000")!,
                                    account: "me@example.com", api: { stub.api })
        #expect(await elsewhere.index.fileCount == 0)
        // Another drive has a file of its own.
        let library = DriveMirror(scope: .library, directory: dir, server: server,
                                  account: "me@example.com", api: { stub.api })
        #expect(await library.index.fileCount == 0)
    }

    @Test func aDamagedFileStartsEmpty() async throws {
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: dir.appendingPathComponent("library.json"))
        let mirror = DriveMirror(scope: .library, directory: dir, server: server, account: "a@b.c",
                                 api: { OnyxAPI() })
        #expect(await mirror.index.fileCount == 0)
        #expect(await mirror.lastSynced == nil)
    }

    @Test func syncPagesToTheEndAndReportsWhatChanged() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        stub.server.page(at: 0, page([item("a", "a.png"), item("b", "b.png", in: "X")], cursor: 10, done: false))
        stub.server.page(at: 10, page([item("c", "c.png", in: "X/Y")], deleted: ["a"], cursor: 20))

        let mirror = DriveMirror(scope: .drive(id: "d1"), directory: dir, server: server,
                                 account: "me@example.com", api: { stub.api })
        let diff = try await mirror.sync()
        #expect(Set(diff.updated) == ["b", "c", "folder:X", "folder:X/Y"])
        #expect(diff.deleted == ["a"], "created and deleted within the pass is reported gone")

        let asked = stub.server.requests(to: "/api/files/delta")
        #expect(asked.count == 2)
        for url in asked {
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            #expect(query.contains(URLQueryItem(name: "drive", value: "d1")))
            #expect(query.contains(URLQueryItem(name: "folders", value: "1")))
        }
        let index = await mirror.index
        #expect(index.fileCount == 2)
        #expect(index.entry(at: "X/Y/c.png")?.fileId == "c")
        #expect(await mirror.lastSynced != nil)
        #expect(await mirror.lastError == nil)

        // Nothing new: one request, nothing reported.
        stub.server.page(at: 20, page([], cursor: 20))
        #expect(try await mirror.sync().isEmpty)
        #expect(stub.server.requests(to: "/api/files/delta").count == 3)
    }

    @Test func aScopeChangeStartsOverAndReportsTheNetChange() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        stub.server.page(at: 0, page([item("a", "a.png", in: "Gone"), item("b", "b.png", in: "Kept")],
                                     cursor: 20, scope: "s1"))
        let mirror = DriveMirror(scope: .drive(id: "d1"), directory: dir, server: server,
                                 account: "me@example.com", api: { stub.api })
        _ = try await mirror.sync()

        // Membership changed: the page after 20 carries a new scope, and the
        // whole drive is fetched again from 0 under it.
        stub.server.page(at: 20, page([], cursor: 21, scope: "s2"))
        stub.server.page(at: 0, page([item("b", "b.png", in: "Kept"), item("c", "c.png", in: "New")],
                                     cursor: 25, done: false, scope: "s2"))
        stub.server.page(at: 25, page([item("d", "d.png")], cursor: 30, scope: "s2"))
        let diff = try await mirror.sync()

        #expect(Set(diff.deleted) == ["a", "folder:Gone"])
        #expect(Set(diff.updated) == ["b", "c", "d", "folder:Kept", "folder:New"],
                "everything is new after a restart, including what was there before")
        #expect(Set(diff.updated).isDisjoint(with: diff.deleted))
        let cursors = stub.server.requests(to: "/api/files/delta").map {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
        }
        #expect(cursors == ["0", "20", "0", "25"])
        let index = await mirror.index
        #expect(Set(index.files(under: "").compactMap(\.fileId)) == ["b", "c", "d"])
        #expect(index.entry(at: "Gone") == nil)

        let stored = try JSONDecoder().decode(DriveMirror.Stored.self,
                                              from: Data(contentsOf: dir.appendingPathComponent("drive.d1.json")))
        #expect(stored.replica.scope == "s2" && stored.replica.cursor == 30)
    }

    @Test func aScopeThatMovesTwiceInOnePassStopsEmpty() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        stub.server.page(at: 0, page([item("a", "a.png")], cursor: 5, scope: "s1"))
        let mirror = DriveMirror(scope: .library, directory: dir, server: server,
                                 account: "me@example.com", api: { stub.api })
        _ = try await mirror.sync()

        stub.server.page(at: 5, page([], cursor: 6, scope: "s2"))
        stub.server.page(at: 0, page([item("a", "a.png")], cursor: 9, scope: "s3"))
        let diff = try await mirror.sync()
        #expect(diff.deleted == ["a"] && diff.updated.isEmpty)
        #expect(await mirror.index.fileCount == 0, "nothing fetched under a superseded scope is kept")
        #expect(stub.server.requests(to: "/api/files/delta").count == 3)

        // The next pass starts over under the current scope.
        stub.server.page(at: 0, page([item("a", "a.png")], cursor: 9, scope: "s3"))
        #expect(try await mirror.sync().updated == ["a"])
    }

    @Test func overlappingSyncsShareOnePass() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        stub.server.page(at: 0, page([item("a", "a.png")], cursor: 5))
        stub.server.slow(0.3)
        let mirror = DriveMirror(scope: .library, directory: dir, server: server,
                                 account: "me@example.com", api: { stub.api })
        async let first = mirror.sync()
        async let second = mirror.sync()
        let (one, two) = try await (first, second)
        #expect(one == two && one.updated == ["a"])
        #expect(stub.server.requests(to: "/api/files/delta").count == 1)
    }

    @Test func aFailedPassKeepsItsProgressAndReportsItLater() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        // Page two is missing: the stub answers 500.
        stub.server.page(at: 0, page([item("a", "a.png")], cursor: 10, done: false))
        let mirror = DriveMirror(scope: .library, directory: dir, server: server,
                                 account: "me@example.com", api: { stub.api })
        await #expect(throws: OnyxError.self) { try await mirror.sync() }
        #expect(await mirror.lastError == "no page")
        #expect(await mirror.lastSynced == nil)
        #expect(await mirror.index.entry(at: "a.png") != nil, "what was applied is shown")

        stub.server.page(at: 10, page([item("b", "b.png")], cursor: 20))
        let diff = try await mirror.sync()
        #expect(Set(diff.updated) == ["a", "b"], "the failed pass's changes are still owed")
        #expect(await mirror.lastError == nil)
        let cursors = stub.server.requests(to: "/api/files/delta").map {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
        }
        #expect(cursors == ["0", "10", "10"], "it resumes where it stopped")
    }

    @Test func aPageThatGoesNowhereEndsThePass() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        stub.server.page(at: 0, page([], cursor: 0, done: false))
        let mirror = DriveMirror(scope: .library, directory: dir, server: server,
                                 account: "me@example.com", api: { stub.api })
        #expect(try await mirror.sync().isEmpty)
        #expect(stub.server.requests(to: "/api/files/delta").count == 1)
    }

    @Test func contentLinksAreReusedUntilCloseToExpiry() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let inAnHour = Int64(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000)
        let inFiveMinutes = Int64(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)
        stub.server.link("f1", json: #"{"id":"f1","url":"https://bucket.test/f1?sig=1","expiresAt":\#(inAnHour)}"#)
        stub.server.link("f2", json: #"{"id":"f2","url":"https://bucket.test/f2?sig=2","expiresAt":\#(inFiveMinutes)}"#)
        stub.server.link("f3", json: #"{"id":"f3","url":"https://bucket.test/f3?sig=3","expiresAt":null}"#)
        let mirror = DriveMirror(scope: .library, directory: dir, server: server,
                                 account: "me@example.com", api: { stub.api })
        let count = { (id: String) in stub.server.requests(to: "/api/space/files/\(id)").count }

        #expect(try await mirror.contentURL(fileId: "f1").absoluteString == "https://bucket.test/f1?sig=1")
        _ = try await mirror.contentURL(fileId: "f1")
        #expect(count("f1") == 1, "an hour left: reused")

        await mirror.forgetContentURL(fileId: "f1")
        _ = try await mirror.contentURL(fileId: "f1")
        #expect(count("f1") == 2, "forgotten: fetched again")

        _ = try await mirror.contentURL(fileId: "f2")
        _ = try await mirror.contentURL(fileId: "f2")
        #expect(count("f2") == 2, "under ten minutes left: used once, never reused")

        _ = try await mirror.contentURL(fileId: "f3")
        _ = try await mirror.contentURL(fileId: "f3")
        #expect(count("f3") == 1, "no expiry given: reused")

        await #expect(throws: OnyxError.self) { try await mirror.contentURL(fileId: "missing") }
        await #expect(throws: OnyxError.self) { try await mirror.contentURL(fileId: "missing") }
        #expect(count("missing") == 2, "a failure is not kept")
    }

    @Test func concurrentReadsOfOneFileShareOneFetch() async throws {
        let stub = try MirrorStubbedAPI()
        defer { stub.tearDown() }
        let dir = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        stub.server.link("f1", json: #"{"id":"f1","url":"https://bucket.test/f1","expiresAt":null}"#)
        stub.server.slow(0.3)
        let mirror = DriveMirror(scope: .library, directory: dir, server: server,
                                 account: "me@example.com", api: { stub.api })
        async let a = mirror.contentURL(fileId: "f1")
        async let b = mirror.contentURL(fileId: "f1")
        async let c = mirror.contentURL(fileId: "f1")
        let urls = try await [a, b, c]
        #expect(Set(urls).count == 1)
        #expect(stub.server.requests(to: "/api/space/files/f1").count == 1)
    }
}
