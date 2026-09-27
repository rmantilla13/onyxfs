import Testing
import Foundation
@testable import OnyxKit

/// The onyxfs bridge, request by request, as the FSKit extension will make
/// them. Its client is a file system: a listing that drops an entry makes a
/// file vanish, a version that stands still serves stale bytes from the
/// extension's cache, a path matched loosely gives one file two identities,
/// and a link signed before the drive is checked leaks a file. So each rule
/// is pinned, over a fake source here and over a real mirror at the end.
struct FSBridgeTests {
    static let scope = "drive.d1"
    static let first: UInt64 = 1_000
    /// 2026-09-21, in milliseconds, as the server sends dates.
    static let t0: Int64 = 1_790_000_000_000

    static func item(_ id: String, _ name: String, in folder: String = "", size: Int64? = 100,
                     hash: String? = nil, version: Int = 1, updated: Int64 = t0) -> FileItem {
        FileItem(id: id, name: name, folder: folder, kind: "file", mime: nil, size: size, url: nil,
                 storageKey: nil, thumbnailUrl: nil, tags: [], notes: nil, caption: nil, visibility: nil,
                 version: version, contentHash: hash, createdBy: nil, createdAt: EpochMillis(updated - 1),
                 updatedAt: EpochMillis(updated), deletedAt: nil, seq: nil)
    }

    static func index(_ items: [FileItem], folders: [String] = []) -> MirrorIndex {
        var replica = Replica()
        replica.apply(changed: items, deleted: [], folders: folders)
        return MirrorIndex(replica)
    }

    /// A drive with a folder tree, a name in decomposed Unicode, the names
    /// macOS keeps to itself, a file kept offline and one that streams.
    static let drive: [FileItem] = [
        item("a", "a b.png", in: "Campaigns", hash: "h-a", updated: t0),
        item("cafe", "Cafe\u{301} ☕.txt", in: "Campaigns", size: 5, updated: t0 - 1_000),
        item("deep", "deep.mov", in: "Campaigns/Sub", size: 1_000, hash: "h-deep", updated: t0 - 2_000),
        item("readme", "Readme.md", size: 10, updated: t0 - 3_000),
        item("ds", ".DS_Store", size: 6),
        item("apple-double", "._Readme.md", size: 4),
        item("trash", "x.txt", in: ".Trashes/501", size: 1),
        item("pinned", "Pinned.bin", size: 100, hash: "h-pinned", updated: t0 - 4_000),
        item("stream", "Stream.mov", size: 5_000_000_000, hash: "h-stream", updated: t0 - 5_000),
    ]
    static let folders = ["Empty"]

    /// What the fake presigner hands out.
    static let expiry = Date(timeIntervalSince1970: 1_790_021_600.75)
    static func signed(_ id: String) -> URL { URL(string: "https://bucket.s3.example/k/\(id)?X-Amz-Signature=abc")! }

    // MARK: - A source

    /// A drive as a test sets it: its tree, what is kept offline, whether
    /// storage signs links.
    actor FakeSource: FSSource {
        private(set) var revision: UInt64 = 1
        private var index: MirrorIndex
        private var overlay = FSOverlay.none
        private var info: FSVolumeInfo
        private var kept: Set<String> = []
        private var copies: [String: URL] = [:]
        private var linkError: Error?
        private(set) var presigned: [String] = []

        init(_ index: MirrorIndex, info: FSVolumeInfo = FSVolumeInfo(name: "Client Deliverables", readOnly: false,
                                                                      cacheLimitBytes: 50 << 30)) {
            self.index = index
            self.info = info
        }

        func show(_ index: MirrorIndex, overlay: FSOverlay = .none) {
            self.index = index
            self.overlay = overlay
            revision += 1
        }

        /// The source moves on, showing nothing new.
        func touch() { revision += 1 }
        func keep(_ id: String, copy: URL?) {
            kept.insert(id)
            copies[id] = copy
        }
        func refuseLinks(_ error: Error?) { linkError = error }
        func setInfo(_ info: FSVolumeInfo) { self.info = info }

        func snapshot() -> FSSnapshot { FSSnapshot(revision: revision, index: index, overlay: overlay) }

        func waitForChange(after seen: UInt64, timeout: Duration) async {
            let deadline = ContinuousClock.now + timeout
            while revision <= seen, ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(2))
            }
        }

        func keptOffline(_ entries: [MirrorEntry]) -> Set<String> {
            Set(entries.compactMap(\.fileId)).intersection(kept)
        }

        func localCopy(of entry: MirrorEntry) -> URL? { entry.fileId.flatMap { copies[$0] } }

        func remoteLink(for entry: MirrorEntry) throws -> FSRemoteLink {
            presigned.append(entry.fileId ?? "")
            if let linkError { throw linkError }
            return FSRemoteLink(url: FSBridgeTests.signed(entry.fileId ?? ""), expiresAt: FSBridgeTests.expiry)
        }

        func volumeInfo() -> FSVolumeInfo { info }
    }

    /// A bridge answering for the fixture drive, and a session on it.
    struct Rig {
        let bridge: FSBridge
        let source: FakeSource
        let key: String
        let dir: URL
        /// 100 bytes, 0…99: the pinned file's copy on this Mac.
        let copy: URL

        func remove() { try? FileManager.default.removeItem(at: dir) }
    }

    func rig() async throws -> Rig {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fs-bridge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let copy = dir.appendingPathComponent("pinned-copy")
        try Data((0..<100).map { UInt8($0) }).write(to: copy)

        let bridge = FSBridge()
        let source = FakeSource(Self.index(Self.drive, folders: Self.folders))
        await source.keep("pinned", copy: copy)
        bridge.register(FSResponder(scope: Self.scope, source: source, firstGeneration: Self.first))
        let key = try await session(bridge, ticket: bridge.sessions.issueTicket(for: Self.scope))
        return Rig(bridge: bridge, source: source, key: key, dir: dir, copy: copy)
    }

    func session(_ bridge: FSBridge, ticket: String) async throws -> String {
        let r = await bridge.respond(to: exchange(ticket))
        try #require(r.status == 200)
        return try #require(try json(r)["session"] as? String)
    }

    func exchange(_ ticket: String) -> DAVRequest {
        DAVRequest(method: "POST", target: "/fs/v1/session", headers: ["content-type": "application/json"],
                   body: Data(#"{"ticket":"\#(ticket)"}"#.utf8))
    }

    /// A request-target the way the extension builds one, with URLComponents.
    static func target(_ endpoint: String, _ query: [String: String] = [:]) -> String {
        var c = URLComponents()
        c.path = "/fs/v1/" + endpoint
        if !query.isEmpty {
            c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return c.string!
    }

    func ask(_ rig: Rig, _ endpoint: String, _ query: [String: String] = [:], method: String = "GET",
             headers: [String: String] = [:]) async -> DAVResponse {
        await ask(rig.bridge, key: rig.key, endpoint, query, method: method, headers: headers)
    }

    func ask(_ bridge: FSBridge, key: String, _ endpoint: String, _ query: [String: String] = [:],
             method: String = "GET", headers: [String: String] = [:]) async -> DAVResponse {
        var headers = headers
        headers["authorization"] = "Bearer \(key)"
        return await bridge.respond(to: DAVRequest(method: method, target: Self.target(endpoint, query), headers: headers))
    }

    func text(_ r: DAVResponse) -> String {
        guard case let .data(data) = r.body else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    func json(_ r: DAVResponse) throws -> [String: Any] {
        guard case let .data(data) = r.body else { throw Unexpected.body }
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    enum Unexpected: Error { case body }

    /// Entries as the extension will decode them.
    struct Entry: Decodable, Equatable {
        let name: String
        let type: String
        let id: String?
        let size: Int64
        let mtime: Double
        let version: String
        let local: Bool
        let pending: Bool
    }

    struct Listing: Decodable {
        let path: String
        let generation: UInt64
        let entries: [Entry]
    }

    struct Stat: Decodable {
        let generation: UInt64
        let entry: Entry
    }

    struct Changes: Decodable, Equatable {
        let generation: UInt64
        let all: Bool
        let paths: [String]
    }

    func decode<T: Decodable>(_ type: T.Type, _ r: DAVResponse) throws -> T {
        guard case let .data(data) = r.body else { throw Unexpected.body }
        return try JSONDecoder().decode(type, from: data)
    }

    /// Every answer carries its true length, is JSON unless it is bytes, and
    /// never lets a presigned link be kept.
    func expectWellFormed(_ r: DAVResponse, sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(r.header("Content-Length") == String(r.body.length), sourceLocation: sourceLocation)
        if case .data = r.body {
            #expect(r.header("Content-Type") == "application/json", sourceLocation: sourceLocation)
        }
    }

    // MARK: - Sessions

    @Test func aTicketBuysOneSessionOnItsDrive() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let ticket = rig.bridge.sessions.issueTicket(for: Self.scope)
        let r = await rig.bridge.respond(to: exchange(ticket))
        #expect(r.status == 200)
        expectWellFormed(r)
        let body = try json(r)
        #expect((body["session"] as? String)?.count == 43)
        #expect((body["generation"] as? NSNumber)?.uint64Value == Self.first)
        #expect((body["cacheLimitBytes"] as? NSNumber)?.int64Value == 50 << 30)
        let volume = try #require(body["volume"] as? [String: Any])
        #expect(volume["scope"] as? String == Self.scope)
        #expect(volume["name"] as? String == "Client Deliverables")
        #expect(volume["readOnly"] as? Bool == false)
        #expect((volume["totalBytes"] as? NSNumber)?.int64Value == 0)
        #expect((volume["usedBytes"] as? NSNumber)?.int64Value == 5_000_001_226, "every file's size, added up")
        #expect((volume["fileCount"] as? NSNumber)?.intValue == 9)

        let again = await rig.bridge.respond(to: exchange(ticket))
        #expect(again.status == 401, "a ticket is spent by its first exchange")
        expectWellFormed(again)
        #expect(try json(again)["error"] is String)
        #expect(await rig.bridge.respond(to: exchange("made-up")).status == 401)

        for body in ["", "{}", "[]", #"{"ticket": 1}"#, "not json", String(repeating: "x", count: 5000)] {
            let r = await rig.bridge.respond(to: DAVRequest(method: "POST", target: "/fs/v1/session", body: Data(body.utf8)))
            #expect(r.status == 400, "\(body.prefix(20))")
        }
    }

    @Test func aTicketForADriveNoLongerAnsweredForBuysNothing() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let ticket = rig.bridge.sessions.issueTicket(for: "drive.elsewhere")
        #expect(await rig.bridge.respond(to: exchange(ticket)).status == 401)
        #expect(rig.bridge.sessions.sessionCount == 1, "only the rig's own session; none left for the ticket")
    }

    @Test func everythingElseNeedsTheSession() async throws {
        let rig = try await rig(); defer { rig.remove() }
        for endpoint in ["list", "stat", "source", "data", "changes", "volume", "nope"] {
            for auth in [nil, "Bearer wrong", "bearer \(rig.key)", "Bearer \(rig.key)x", rig.key, "Basic \(rig.key)"] {
                var headers: [String: String] = [:]
                if let auth { headers["authorization"] = auth }
                let r = await rig.bridge.respond(to: DAVRequest(method: "GET", target: Self.target(endpoint, ["path": "/"]),
                                                                headers: headers))
                #expect(r.status == 401, "\(endpoint) with \(auth ?? "no header")")
                #expect(r.header("WWW-Authenticate") == #"Bearer realm="onyxfs""#)
                expectWellFormed(r)
            }
        }
        #expect(rig.bridge.admit(method: "GET", target: "/fs/v1/list?path=/", authorization: nil) == .refuse)
        #expect(rig.bridge.admit(method: "GET", target: "/fs/v1/list?path=/", authorization: "Bearer \(rig.key)")
            == .accept(maxBody: FSBridge.maxRequestBody))
        #expect(rig.bridge.admit(method: "POST", target: "/fs/v1/session", authorization: nil)
            == .accept(maxBody: FSBridge.maxExchangeBody))
        #expect(rig.bridge.admit(method: "GET", target: "/fs/v1/session", authorization: nil) == .refuse)

        // With a session: what is not there, and what is not allowed.
        #expect(await ask(rig, "nope").status == 404)
        let post = await ask(rig, "list", ["path": "/"], method: "POST")
        #expect(post.status == 405 && post.header("Allow") == "GET, HEAD")
        let getSession = await ask(rig, "session")
        #expect(getSession.status == 405 && getSession.header("Allow") == "POST")
    }

    @Test func aSessionReachesItsOwnDriveOnly() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let other = FakeSource(Self.index([Self.item("theirs", "Secret.pdf")]))
        rig.bridge.register(FSResponder(scope: "drive.d2", source: other, firstGeneration: Self.first))
        let theirKey = try await session(rig.bridge, ticket: rig.bridge.sessions.issueTicket(for: "drive.d2"))

        #expect(await ask(rig, "source", ["id": "theirs"]).status == 404)
        #expect(await ask(rig, "data", ["id": "theirs"]).status == 404)
        #expect(await ask(rig, "stat", ["path": "/Secret.pdf"]).status == 404)
        #expect(await other.presigned.isEmpty, "nothing signed for a file of another drive")

        let theirs = Rig(bridge: rig.bridge, source: other, key: theirKey, dir: rig.dir, copy: rig.copy)
        let listing = try decode(Listing.self, await ask(theirs, "list", ["path": "/"]))
        #expect(listing.entries.map(\.name) == ["Secret.pdf"])

        // Unmounted: its sessions end, and the other drive's carry on.
        rig.bridge.end(scope: "drive.d2")
        #expect(await ask(theirs, "list", ["path": "/"]).status == 401)
        #expect(await ask(rig, "list", ["path": "/"]).status == 200)
    }

    // MARK: - Listings

    @Test func aListingIsFoldersFirstThenFilesWithoutWhatMacOSKeepsToItself() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let r = await ask(rig, "list", ["path": "/"])
        #expect(r.status == 200)
        expectWellFormed(r)
        #expect(r.header("Cache-Control") == "no-store")
        let root = try decode(Listing.self, r)
        #expect(root.path == "/")
        #expect(root.generation == Self.first)
        #expect(root.entries.map(\.name) == ["Campaigns", "Empty", "Pinned.bin", "Readme.md", "Stream.mov"])
        #expect(root.entries.map(\.type) == ["dir", "dir", "file", "file", "file"])

        let campaigns = try decode(Listing.self, await ask(rig, "list", ["path": "/Campaigns"]))
        #expect(campaigns.path == "/Campaigns")
        #expect(campaigns.entries.map(\.name) == ["Sub", "a b.png", "Caf\u{E9} ☕.txt"])
        #expect(campaigns.entries[2].name.unicodeScalars.count == "Café ☕.txt".precomposedStringWithCanonicalMapping
            .unicodeScalars.count, "names go out in NFC")

        #expect(try decode(Listing.self, await ask(rig, "list", ["path": "/Empty"])).entries.isEmpty)
        for missing in ["/Nope", "/Readme.md", "/.Trashes", "/.Trashes/501", "/campaigns"] {
            let r = await ask(rig, "list", ["path": missing])
            #expect(r.status == 404, "\(missing)")
            expectWellFormed(r)
        }
    }

    @Test func anEntryCarriesWhatTheExtensionNeeds() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let r = await ask(rig, "list", ["path": "/"])
        let entries = try decode(Listing.self, r).entries
        let campaigns = try #require(entries.first { $0.name == "Campaigns" })
        #expect(campaigns.id == nil && campaigns.size == 0 && !campaigns.local && !campaigns.pending)
        #expect(campaigns.mtime == Double(Self.t0) / 1000, "a folder is as new as the newest thing in it")
        let empty = try #require(entries.first { $0.name == "Empty" })
        #expect(empty.mtime == 0)
        #expect(text(r).contains(#""id":null"#), "a folder's id is written as null")

        let pinned = try #require(entries.first { $0.name == "Pinned.bin" })
        #expect(pinned.type == "file" && pinned.id == "pinned" && pinned.size == 100)
        #expect(pinned.local, "kept offline")
        #expect(pinned.mtime == Double(Self.t0 - 4_000) / 1000)
        #expect(pinned.version.count == 32 && pinned.version.allSatisfy { $0.isHexDigit })
        let stream = try #require(entries.first { $0.name == "Stream.mov" })
        #expect(!stream.local && !stream.pending && stream.size == 5_000_000_000)
        #expect(Set(entries.map(\.version)).count == entries.count)
    }

    @Test func pathsAreExactAndWellFormed() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let found = try decode(Stat.self, await ask(rig, "stat", ["path": "/Campaigns/a b.png"]))
        #expect(found.entry.id == "a")
        // Decomposed or composed, the same name.
        #expect(try decode(Stat.self, await ask(rig, "stat", ["path": "/Campaigns/Caf\u{E9} ☕.txt"])).entry.id == "cafe")
        #expect(try decode(Stat.self, await ask(rig, "stat", ["path": "/Campaigns/Cafe\u{301} ☕.txt"])).entry.id == "cafe")
        // Case is part of the name on this disk.
        for path in ["/campaigns/a b.png", "/Campaigns/A B.png", "/README.md"] {
            #expect(await ask(rig, "stat", ["path": path]).status == 404, "\(path)")
        }
        for bad in ["Campaigns", "", "/Campaigns/", "//Campaigns", "/Campaigns//a b.png", "/Campaigns/../Readme.md",
                    "/./Readme.md", "/Campaigns/.", "/a\u{0}b"] {
            let r = await ask(rig, "stat", ["path": bad])
            #expect(r.status == 400, "\(bad.debugDescription)")
            expectWellFormed(r)
        }
        #expect(await ask(rig, "stat").status == 400, "no path at all")
        #expect(await ask(rig, "list").status == 400)
        // "+" is a plus, as URLComponents leaves it; "%2B" is one too.
        rig.bridge.register(FSResponder(scope: Self.scope, source: FakeSource(Self.index([Self.item("plus", "a+b.mov")])),
                                        firstGeneration: Self.first))
        #expect(try decode(Stat.self, await ask(rig, "stat", ["path": "/a+b.mov"])).entry.id == "plus")
        let encoded = await rig.bridge.respond(to: DAVRequest(method: "GET", target: "/fs/v1/stat?path=%2Fa%2Bb.mov",
                                                              headers: ["authorization": "Bearer \(rig.key)"]))
        #expect(try decode(Stat.self, encoded).entry.id == "plus")
        let broken = await rig.bridge.respond(to: DAVRequest(method: "GET", target: "/fs/v1/stat?path=%2Fa%ZZ",
                                                             headers: ["authorization": "Bearer \(rig.key)"]))
        #expect(broken.status == 400)
    }

    @Test func namesMacOSKeepsToItselfAreNeverFound() async throws {
        let rig = try await rig(); defer { rig.remove() }
        for path in ["/.DS_Store", "/._Readme.md", "/.Trashes", "/.Trashes/501/x.txt"] {
            #expect(await ask(rig, "stat", ["path": path]).status == 404, "\(path)")
        }
        for id in ["ds", "apple-double", "trash"] {
            #expect(await ask(rig, "source", ["id": id]).status == 404, "\(id)")
            #expect(await ask(rig, "data", ["id": id]).status == 404, "\(id)")
        }
        #expect(await rig.source.presigned.isEmpty)
        for name in [".DS_Store", "._x", ".Trashes", ".Spotlight-V100", ".fseventsd", ".TemporaryItems", "Icon\r"] {
            #expect(FSNames.isLocalOnly(name), "\(name.debugDescription)")
        }
        for name in ["DS_Store", ".DS_Store2", "_x", ".x", "Icon", "icon\r"] {
            #expect(!FSNames.isLocalOnly(name), "\(name.debugDescription)")
        }
    }

    @Test func theRootIsTheDriveNamedAfterIt() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let r = await ask(rig, "stat", ["path": "/"])
        let root = try decode(Stat.self, r).entry
        #expect(root.name == "Client Deliverables" && root.type == "dir" && root.id == nil && root.size == 0)
        #expect(root.mtime == Double(Self.t0) / 1000)
        #expect(text(r).contains(#""id":null"#))
        // A name the server allows but a file system does not.
        await rig.source.setInfo(FSVolumeInfo(name: "Q1/Q2", readOnly: true, cacheLimitBytes: 0))
        #expect(try decode(Stat.self, await ask(rig, "stat", ["path": "/"])).entry.name == "Q1:Q2")
    }

    // MARK: - Versions

    @Test func aVersionMovesWithTheBytesAndNothingElse() {
        func entry(_ path: String, size: Int64 = 100, hash: String? = "h1", etag: String? = nil,
                   modified: Double = 1_000) -> FSNode {
            FSNode(MirrorEntry(kind: .file, name: Replica.lastComponent(path), path: path, fileId: "f", size: size,
                               modified: Date(timeIntervalSince1970: modified), etag: etag ?? hash ?? "v1", mime: nil,
                               contentHash: hash))
        }
        let original = entry("A/take.mov")
        // Renamed, moved, re-keyed: the row's version and times move, the bytes do not.
        #expect(entry("B/renamed.mov", etag: "h1", modified: 9_999).version == original.version)
        #expect(entry("A/take.mov", size: 101).version != original.version)
        #expect(entry("A/take.mov", hash: "h2").version != original.version)
        // With no hash to go by, any write may have brought new bytes.
        let unhashed = entry("A/take.mov", hash: nil, etag: "v3")
        #expect(entry("A/take.mov", hash: nil, etag: "v4").version != unhashed.version)
        #expect(entry("A/take.mov", hash: nil, etag: "v3", modified: 2_000).version != unhashed.version)
        #expect(entry("A/take.mov", hash: nil, etag: "v3").version == unhashed.version)

        func folder(_ path: String, modified: Double = 0) -> FSNode {
            FSNode(MirrorEntry(kind: .folder, name: Replica.lastComponent(path), path: path, fileId: nil, size: 0,
                               modified: Date(timeIntervalSince1970: modified), etag: nil, mime: nil))
        }
        #expect(folder("A/B").version == folder("A/B", modified: 5).version, "a folder's is its path's")
        #expect(folder("A/B").version != folder("A/C").version)
        #expect(folder("Cafe\u{301}").version == folder("Caf\u{E9}").version)
    }

    // MARK: - Bytes

    @Test func aSourceIsSignedOnlyForAFileOfThisDrive() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let remote = await ask(rig, "source", ["id": "stream"])
        #expect(remote.status == 200)
        expectWellFormed(remote)
        #expect(remote.header("Cache-Control") == "no-store")
        let body = try json(remote)
        #expect(body["kind"] as? String == "remote")
        #expect(body["url"] as? String == Self.signed("stream").absoluteString)
        #expect((body["expiresAt"] as? NSNumber)?.int64Value == 1_790_021_600, "whole seconds, never later than the link")
        #expect((body["size"] as? NSNumber)?.int64Value == 5_000_000_000)
        let listed = try decode(Listing.self, await ask(rig, "list", ["path": "/"])).entries
        #expect(body["version"] as? String == listed.first { $0.id == "stream" }?.version)

        let local = try json(await ask(rig, "source", ["id": "pinned"]))
        #expect(local["kind"] as? String == "local")
        #expect(local["url"] == nil && local["expiresAt"] == nil)
        #expect((local["size"] as? NSNumber)?.int64Value == 100)

        #expect(await ask(rig, "source", ["id": "no-such-file"]).status == 404)
        #expect(await ask(rig, "source").status == 400)
        #expect(await rig.source.presigned == ["stream"], "filtered before anything is signed")

        // What the server says when it will not sign.
        await rig.source.refuseLinks(OnyxError.http(status: 404, message: "File not found"))
        #expect(await ask(rig, "source", ["id": "stream"]).status == 404)
        await rig.source.refuseLinks(OnyxError.http(status: 409, message: "This file has no stored copy to download."))
        let conflict = await ask(rig, "source", ["id": "stream"])
        let said = try json(conflict)["error"] as? String
        #expect(conflict.status == 409 && said?.contains("no stored copy") == true)
        await rig.source.refuseLinks(URLError(.notConnectedToInternet))
        let offline = await ask(rig, "source", ["id": "stream"])
        #expect(offline.status == 503 && offline.header("Retry-After") != nil)
    }

    @Test func dataServesRangesOfAKeptCopyAndSendsTheRestToStorage() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let range = await ask(rig, "data", ["id": "pinned"], headers: ["range": "bytes=10-19"])
        #expect(range.status == 206)
        #expect(range.header("Content-Range") == "bytes 10-19/100")
        #expect(range.header("Accept-Ranges") == "bytes")
        #expect(range.body == .file(rig.copy, offset: 10, length: 10))
        expectWellFormed(range)

        let whole = await ask(rig, "data", ["id": "pinned"])
        #expect(whole.status == 200 && whole.body == .file(rig.copy, offset: 0, length: 100))
        let tail = await ask(rig, "data", ["id": "pinned"], headers: ["range": "bytes=90-"])
        #expect(tail.header("Content-Range") == "bytes 90-99/100")
        let beyond = await ask(rig, "data", ["id": "pinned"], headers: ["range": "bytes=100-"])
        #expect(beyond.status == 416 && beyond.header("Content-Range") == "bytes */100")
        expectWellFormed(beyond)
        let head = await ask(rig, "data", ["id": "pinned"], method: "HEAD", headers: ["range": "bytes=0-9"])
        #expect(head.status == 206 && head.body == .empty && head.header("Content-Length") == "10")

        let remote = await ask(rig, "data", ["id": "stream"], headers: ["range": "bytes=0-99"])
        #expect(remote.status == 307)
        #expect(remote.header("Location") == Self.signed("stream").absoluteString)
        #expect(remote.header("Cache-Control") == "no-store")
        expectWellFormed(remote)

        // A copy that went (deleted by hand, its disk unplugged) streams instead.
        try FileManager.default.removeItem(at: rig.copy)
        #expect(await ask(rig, "data", ["id": "pinned"]).status == 307)
        #expect(await ask(rig, "data", ["id": "nope"]).status == 404)
    }

    // MARK: - Changes

    /// The fixture with one file added deep in it, newer than anything else.
    static var withNewTake: MirrorIndex {
        index(drive + [item("new", "take 2.mov", in: "Campaigns/Sub", hash: "h-new", updated: t0 + 60_000)],
              folders: folders)
    }

    @Test func changesNameTheFoldersWhoseListingChanged() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let none = try decode(Changes.self, await ask(rig, "changes", ["since": String(Self.first), "wait": "0"]))
        #expect(none == Changes(generation: Self.first, all: false, paths: []))

        await rig.source.show(Self.withNewTake)
        let one = try decode(Changes.self, await ask(rig, "changes", ["since": String(Self.first)]))
        // Its folder has a new entry; each folder above it has an entry
        // whose time moved.
        #expect(one == Changes(generation: Self.first + 1, all: false, paths: ["/", "/Campaigns", "/Campaigns/Sub"]))
        // Every answer after says the same generation.
        #expect(try decode(Listing.self, await ask(rig, "list", ["path": "/"])).generation == Self.first + 1)

        // A rename on the web: gone from one folder, into another.
        var moved = Self.drive
        moved.removeAll { $0.id == "readme" }
        moved.append(Self.item("readme", "Readme.md", in: "Empty", size: 10, updated: Self.t0 - 3_000))
        moved.append(Self.item("new", "take 2.mov", in: "Campaigns/Sub", hash: "h-new", updated: Self.t0 + 60_000))
        await rig.source.show(Self.index(moved, folders: Self.folders))
        let two = try decode(Changes.self, await ask(rig, "changes", ["since": String(Self.first + 1)]))
        #expect(two == Changes(generation: Self.first + 2, all: false, paths: ["/", "/Empty"]))
        let both = try decode(Changes.self, await ask(rig, "changes", ["since": String(Self.first)]))
        #expect(both == Changes(generation: Self.first + 2, all: false, paths: ["/", "/Campaigns", "/Campaigns/Sub", "/Empty"]))
    }

    @Test func aGenerationFromBeforeOrElsewhereDropsEverything() async throws {
        let rig = try await rig(); defer { rig.remove() }
        for since in [Self.first - 1, 0, Self.first + 7] {
            let r = try decode(Changes.self, await ask(rig, "changes", ["since": String(since)]))
            #expect(r == Changes(generation: Self.first, all: true, paths: []), "\(since)")
        }
        for bad in ["", "-1", "x", "1.5"] {
            #expect(await ask(rig, "changes", ["since": bad]).status == 400, "\(bad)")
        }
        #expect(await ask(rig, "changes").status == 400)
        #expect(await ask(rig, "changes", ["since": String(Self.first), "wait": "soon"]).status == 400)
        #expect(await ask(rig, "changes", ["since": String(Self.first), "wait": "-1"]).status == 400)
    }

    @Test func aLongPollAnswersAsSoonAsTheDriveChanges() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let started = ContinuousClock.now
        let poll = Task { await ask(rig, "changes", ["since": String(Self.first), "wait": "25"]) }
        try await Task.sleep(for: .milliseconds(150))
        await rig.source.show(Self.withNewTake)
        let answer = try decode(Changes.self, await poll.value)
        let took = ContinuousClock.now - started
        #expect(answer.generation == Self.first + 1 && answer.paths.contains("/Campaigns/Sub"))
        #expect(took < .seconds(5), "answered in \(took), not after the whole wait")
        #expect(rig.bridge.pollsUnderWay == 0)
    }

    @Test func aLongPollWithNothingNewAnswersWhenItsWaitIsUp() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let started = ContinuousClock.now
        let poll = Task { await ask(rig, "changes", ["since": String(Self.first), "wait": "0.4"]) }
        try await Task.sleep(for: .milliseconds(100))
        // The source moves, but nothing any listing shows changes.
        await rig.source.touch()
        let answer = try decode(Changes.self, await poll.value)
        let took = ContinuousClock.now - started
        #expect(answer == Changes(generation: Self.first, all: false, paths: []))
        #expect(took >= .milliseconds(400), "a change nobody can see wakes nobody (\(took))")
        #expect(took < .seconds(5))
    }

    @Test func aLongPollWhoseDriveIsUnmountedMeanwhileGetsNothing() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let poll = Task { await ask(rig, "changes", ["since": String(Self.first), "wait": "0.3"]) }
        try await Task.sleep(for: .milliseconds(100))
        rig.bridge.end(scope: Self.scope)
        let answer = await poll.value
        #expect(answer.status == 401 && answer.header("WWW-Authenticate") != nil)
    }

    @Test func longPollsAreCappedPerSession() async throws {
        let rig = try await rig(); defer { rig.remove() }
        var polls: [Task<DAVResponse, Never>] = []
        for _ in 0..<FSBridge.maxPollsPerSession {
            polls.append(Task { await ask(rig, "changes", ["since": String(Self.first), "wait": "10"]) })
        }
        for _ in 0..<500 where rig.bridge.pollsUnderWay < FSBridge.maxPollsPerSession {
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(rig.bridge.pollsUnderWay == FSBridge.maxPollsPerSession)
        let refused = await ask(rig, "changes", ["since": String(Self.first), "wait": "10"])
        #expect(refused.status == 503 && refused.header("Retry-After") != nil)
        // Another session has room of its own.
        let other = try await session(rig.bridge, ticket: rig.bridge.sessions.issueTicket(for: Self.scope))
        let second = Rig(bridge: rig.bridge, source: rig.source, key: other, dir: rig.dir, copy: rig.copy)
        #expect(await ask(second, "changes", ["since": String(Self.first), "wait": "0"]).status == 200)

        await rig.source.show(Self.withNewTake)
        for poll in polls { #expect(await poll.value.status == 200) }
        #expect(rig.bridge.pollsUnderWay == 0)
        #expect(await ask(rig, "changes", ["since": String(Self.first), "wait": "0"]).status == 200)
    }

    // MARK: - The volume

    @Test func theVolumeIsAnsweredFresh() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let before = try json(await ask(rig, "volume"))
        #expect(before["readOnly"] as? Bool == false)
        #expect(before["name"] as? String == "Client Deliverables")
        await rig.source.setInfo(FSVolumeInfo(name: "Renamed/2", readOnly: true, totalBytes: 1 << 40, cacheLimitBytes: 0))
        await rig.source.show(Self.index([Self.item("x", "x.bin", size: 7)]))
        let after = try json(await ask(rig, "volume"))
        #expect(after["readOnly"] as? Bool == true)
        #expect(after["name"] as? String == "Renamed:2", "as the root's stat names it")
        #expect((after["totalBytes"] as? NSNumber)?.int64Value == 1 << 40)
        #expect((after["usedBytes"] as? NSNumber)?.int64Value == 7)
        #expect((after["fileCount"] as? NSNumber)?.intValue == 1)
        #expect(after["scope"] as? String == Self.scope)
    }

    @Test func aDriveMayBeWrittenToByItsEditorsAndOwners() {
        func drive(_ role: String?) -> Filespace { Filespace(id: "d", name: "D", role: role) }
        #expect(drive("owner").mayAddFiles && drive("editor").mayAddFiles)
        #expect(!drive("viewer").mayAddFiles && !drive(nil).mayAddFiles && !drive("Owner").mayAddFiles)
    }

    // MARK: - The resource URL

    @Test func theResourceURLCarriesATicketAndTheNameOnly() throws {
        let url = FSBridge.resourceURL(port: 54321, scope: "drive.0f2c-9a", ticket: "abc_DEF-123",
                                       name: "Q&A = plans + ideas #1 / Cafe\u{301}")
        #expect(url.scheme == "onyxfs-drive")
        #expect(url.host == "127.0.0.1" && url.port == 54321)
        #expect(url.path == "/drive.0f2c-9a")
        let items = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        #expect(items.map(\.name) == ["ticket", "name", "v"])
        #expect(items[0].value == "abc_DEF-123")
        #expect(items[1].value == "Q&A = plans + ideas #1 : Caf\u{E9}", "every reserved character escaped")
        #expect(items[1].value?.unicodeScalars.last == "\u{E9}", "the disk's name, as `volume` gives it: NFC, no slash")
        #expect(items[2].value == "1")
        #expect(!url.absoluteString.contains(" ") && !url.absoluteString.contains("+"))
    }

    // MARK: - The overlay

    @Test func whatThisMacWroteSitsOverTheMirror() async throws {
        let rig = try await rig(); defer { rig.remove() }
        let staged = rig.dir.appendingPathComponent("staged")
        try Data("new bytes".utf8).write(to: staged)
        let upload = FSNode(path: "Campaigns/Upload.mov", name: "Upload.mov", isFolder: false, fileId: "up-1", size: 9,
                            modified: Date(timeIntervalSince1970: 1_790_000_100), content: "pending:1", pending: true,
                            staged: staged)
        let replacement = FSNode(path: "Readme.md", name: "Readme.md", isFolder: false, fileId: "readme", size: 9,
                                 modified: Date(timeIntervalSince1970: 1_790_000_200), content: "pending:2",
                                 pending: true, staged: staged)
        let made = FSNode(path: "Campaigns/New Folder", name: "New Folder", isFolder: true, fileId: nil, size: 0,
                          modified: Date(timeIntervalSince1970: 0), content: "")
        let overlay = FSOverlay(nodes: [upload, replacement, made], hidden: ["Campaigns/Sub", "Pinned.bin"])
        await rig.source.show(Self.index(Self.drive, folders: Self.folders), overlay: overlay)

        let campaigns = try decode(Listing.self, await ask(rig, "list", ["path": "/Campaigns"])).entries
        #expect(campaigns.map(\.name) == ["New Folder", "a b.png", "Caf\u{E9} ☕.txt", "Upload.mov"])
        let up = try #require(campaigns.last)
        #expect(up.pending && up.local && up.id == "up-1" && up.size == 9)
        #expect(await ask(rig, "stat", ["path": "/Campaigns/Sub"]).status == 404)
        #expect(await ask(rig, "stat", ["path": "/Campaigns/Sub/deep.mov"]).status == 404)
        #expect(await ask(rig, "source", ["id": "deep"]).status == 404, "hidden with the folder it was in")
        #expect(try decode(Listing.self, await ask(rig, "list", ["path": "/Campaigns/New Folder"])).entries.isEmpty)

        let root = try decode(Listing.self, await ask(rig, "list", ["path": "/"])).entries
        #expect(!root.contains { $0.name == "Pinned.bin" })
        let readme = try #require(root.first { $0.name == "Readme.md" })
        #expect(readme.pending && readme.size == 9, "the replacement, not the mirror's")

        // Its bytes come from where they were staged, not from storage.
        let data = await ask(rig, "data", ["id": "readme"], headers: ["range": "bytes=0-2"])
        #expect(data.status == 206 && data.body == .file(staged, offset: 0, length: 3))
        #expect(try json(await ask(rig, "source", ["id": "up-1"]))["kind"] as? String == "local")
        #expect(await rig.source.presigned.isEmpty)

        let changes = try decode(Changes.self, await ask(rig, "changes", ["since": String(Self.first)]))
        #expect(changes.paths == ["/", "/Campaigns", "/Campaigns/New Folder", "/Campaigns/Sub"])
    }

    @Test func aChangeAmongAHundredThousandFilesIsFoundQuickly() {
        var items: [FileItem] = []
        items.reserveCapacity(100_000)
        for i in 0..<100_000 {
            items.append(Self.item("id-\(i)", "frame \(i).exr", in: "Projects \(i % 50)/Shot \(i % 2_000)",
                                   hash: "h\(i)", updated: Self.t0 - Int64(i)))
        }
        let before = FSView(index: Self.index(items))
        items[5] = Self.item("id-5", "frame 5.exr", in: "Projects 5/Shot 5", size: 999, hash: "h5-new",
                             updated: Self.t0 - 5)
        let after = FSView(index: Self.index(items))
        let started = ContinuousClock.now
        let changed = FSView.changedFolders(from: before, to: after)
        let took = ContinuousClock.now - started
        #expect(changed == ["Projects 5/Shot 5"], "its size changed; its date did not, so nothing above it did")
        // Debug build; generous, to catch a quadratic step rather than to time it.
        #expect(took < .seconds(20), "compared in \(took)")
    }

    // MARK: - Over a real mirror

    /// The app's own source: a mirror as it is kept on disk, a pin store
    /// holding one file, and a presigner that records what it signs.
    @Test func theMirrorSourceAnswersFromTheMirrorAndThePinStore() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fs-mirror-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let server = URL(string: "https://www.onyxfs.io")!
        let mirrors = dir.appendingPathComponent("Mirrors")
        try FileManager.default.createDirectory(at: mirrors, withIntermediateDirectories: true)
        var replica = Replica()
        replica.apply(changed: Self.drive, deleted: [], folders: Self.folders, cursor: 10)
        let stored = DriveMirror.Stored(identity: .init(server: server.absoluteString, account: "me@example.com"),
                                        replica: replica, complete: true, generation: "g1")
        try JSONEncoder().encode(stored).write(to: mirrors.appendingPathComponent("\(Self.scope).json"))
        let mirror = DriveMirror(scope: .drive(id: "d1"), directory: mirrors, server: server,
                                 account: "me@example.com", api: { OnyxAPI() })
        #expect(await mirror.index.fileCount == Self.drive.count)

        let store = try PinStore(directory: dir.appendingPathComponent("Pinned"))
        await store.pin(PinRule(scope: Self.scope, target: .file(id: "pinned")))
        let report = await store.reconcile(scope: Self.scope, index: await mirror.index) { _, destination in
            try Data((0..<100).map { UInt8($0) }).write(to: destination)
        }
        #expect(report.downloaded == 1)

        actor Signed { var ids: [String] = []; func add(_ id: String) { ids.append(id) } }
        let signed = Signed()
        let source = MirrorFSSource(scope: Self.scope, mirror: mirror, pins: { store }, presign: { entry in
            await signed.add(entry.fileId ?? "")
            return FSRemoteLink(url: Self.signed(entry.fileId ?? ""), expiresAt: Self.expiry)
        }, volume: { FSVolumeInfo(name: "Client Deliverables", readOnly: false, cacheLimitBytes: 50 << 30) })
        let bridge = FSBridge()
        bridge.register(FSResponder(scope: Self.scope, source: source, firstGeneration: Self.first))
        let key = try await session(bridge, ticket: bridge.sessions.issueTicket(for: Self.scope))

        let root = try decode(Listing.self, await ask(bridge, key: key, "list", ["path": "/"])).entries
        #expect(root.map(\.name) == ["Campaigns", "Empty", "Pinned.bin", "Readme.md", "Stream.mov"])
        #expect(root.filter(\.local).map(\.name) == ["Pinned.bin"])

        let local = try json(await ask(bridge, key: key, "source", ["id": "pinned"]))
        #expect(local["kind"] as? String == "local")
        let copy = try #require(await store.localCopy(scope: Self.scope, fileId: "pinned", etag: "h-pinned"))
        let range = await ask(bridge, key: key, "data", ["id": "pinned"], headers: ["range": "bytes=10-19"])
        #expect(range.status == 206 && range.body == .file(copy, offset: 10, length: 10))

        let remote = try json(await ask(bridge, key: key, "source", ["id": "stream"]))
        #expect(remote["kind"] as? String == "remote" && remote["url"] as? String == Self.signed("stream").absoluteString)
        #expect(await ask(bridge, key: key, "data", ["id": "stream"]).status == 307)
        #expect(await signed.ids == ["stream", "stream"])

        // A long-poll, woken by the mirror itself.
        let started = ContinuousClock.now
        let poll = Task { await ask(bridge, key: key, "changes", ["since": String(Self.first), "wait": "25"]) }
        try await Task.sleep(for: .milliseconds(150))
        await mirror.applyForTesting(changed: [Self.item("new", "take 2.mov", in: "Campaigns/Sub", hash: "h-new",
                                                         updated: Self.t0 + 60_000)])
        let changes = try decode(Changes.self, await poll.value)
        #expect(changes == Changes(generation: Self.first + 1, all: false, paths: ["/", "/Campaigns", "/Campaigns/Sub"]))
        #expect(ContinuousClock.now - started < .seconds(10))
        let sub = try decode(Listing.self, await ask(bridge, key: key, "list", ["path": "/Campaigns/Sub"]))
        #expect(sub.generation == Self.first + 1 && sub.entries.map(\.name) == ["deep.mov", "take 2.mov"])
    }

    @Test func aFolderMovedAwayTakesItsListingWithIt() {
        let base = FSView(index: Self.index(Self.drive, folders: Self.folders))
        let hidden = FSView(index: base.index, overlay: FSOverlay(hidden: ["Campaigns"]))
        #expect(hidden.children(of: "Campaigns") == nil)
        #expect(hidden.children(of: "Campaigns/Sub") == nil)
        #expect(hidden.file(id: "deep") == nil)
        #expect(!hidden.folderPaths().contains("Campaigns/Sub"))
        #expect(FSView.changedFolders(from: base, to: hidden) == ["", "Campaigns", "Campaigns/Sub"])
        #expect(FSView.changedFolders(from: base, to: base).isEmpty)
    }
}
