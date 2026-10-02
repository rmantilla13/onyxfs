import Foundation
import os
import Testing
@testable import OnyxKit

/// Browsing as the iOS app does it: what it asks the listing for, and what
/// it reads back from rows shaped as lib/db.js shapeFile and the listing's
/// presigning (lib/storage.js presignFileUrls) send them.
@Suite struct ListingTests {
    static let row = #"""
    {
      "id": "f1", "name": "Take 1.mov", "folder": "Footage/Day 1", "kind": "video", "mime": "video/quicktime",
      "size": 4096, "url": "https://bucket.test/k?sig=1", "storage": "s3", "storageKey": "drives/a/Footage/Day 1/Take 1.mov",
      "tags": ["hero"], "notes": null, "visibility": "org", "caption": null,
      "thumbnailUrl": "https://bucket.test/t?sig=2", "thumbnailKey": "thumbs/f1.webp",
      "smUrl": "https://bucket.test/t-sm?sig=3", "xsUrl": "https://bucket.test/t-xs?sig=4", "thumbSizes": ["sm", "xs"],
      "posterKey": "thumbs/f1-poster.webp", "posterUrl": "https://bucket.test/p?sig=5",
      "filmstripKey": null, "deletedAt": null, "trashKey": null, "deletedBy": null,
      "version": 3, "contentHash": "abc", "reviewStatus": "approved", "openComments": 2,
      "metadata": { "width": 3840, "height": "2160", "duration": 12.5, "client": "Acme", "fps": "junk" },
      "createdBy": "a@b.test", "createdAt": 1790481854124, "updatedAt": 1790482561565, "seq": 5,
      "can": { "edit": true, "delete": false, "share": true }
    }
    """#

    @Test func aDriveFolderIsListedAsTheWebListsIt() async throws {
        let stub = try ListingStub { _ in (200, #"{ "files": [\#(Self.row)], "cursor": "next-page" }"#) }
        defer { stub.tearDown() }
        let page = try await stub.api.listFiles(in: .drive(id: "d1"), folder: "Footage/Day 1", sort: .modified, limit: 50)

        let asked = try #require(stub.requests.first)
        #expect(asked.path == "/api/files")
        #expect(asked.query["filespace"] == "d1")
        #expect(asked.query["folder"] == "Footage/Day 1")
        #expect(asked.query["sort"] == "modified")
        #expect(asked.query["limit"] == "50")
        // The tree is asked for once, by folders(in:), not with every page.
        #expect(asked.query["folders"] == "0")
        #expect(asked.query["q"] == nil && asked.query["cursor"] == nil)
        #expect(asked.authorization == "Bearer test-token")

        #expect(page.cursor == "next-page")
        let file = try #require(page.files.first)
        #expect(file.name == "Take 1.mov" && file.version == 3)
        #expect(file.thumbnailKey == "thumbs/f1.webp")
        #expect(file.smUrl == "https://bucket.test/t-sm?sig=3" && file.xsUrl == "https://bucket.test/t-xs?sig=4")
        #expect(file.posterUrl == "https://bucket.test/p?sig=5" && file.posterKey == "thumbs/f1-poster.webp")
        #expect(file.metadata == FileMetadata(width: 3840, height: 2160, duration: 12.5))
        #expect(file.can == FilePermissions(edit: true, delete: false, share: true))
        #expect(file.reviewStatus == "approved" && file.openComments == 2)
    }

    @Test func theNextPageCarriesTheCursorBack() async throws {
        let stub = try ListingStub { _ in (200, #"{ "files": [], "cursor": null }"#) }
        defer { stub.tearDown() }
        let page = try await stub.api.listFiles(in: .drive(id: "d1"), folder: "", cursor: "opaque==")
        #expect(stub.requests.first?.query["cursor"] == "opaque==")
        // The top of a drive is folder "", said outright: no folder at all
        // would list every file in it.
        #expect(stub.requests.first?.query["folder"] == "")
        #expect(page.files.isEmpty && page.cursor == nil)
    }

    @Test func aSearchLooksBeneathTheFolderNotJustInIt() async throws {
        let stub = try ListingStub { _ in (200, #"{ "files": [], "cursor": null }"#) }
        defer { stub.tearDown() }
        _ = try await stub.api.listFiles(in: .drive(id: "d1"), folder: "Footage", query: "  take  ")
        let asked = try #require(stub.requests.first)
        #expect(asked.query["q"] == "take")
        #expect(asked.query["folderPrefix"] == "Footage")
        #expect(asked.query["folder"] == nil)

        _ = try await stub.api.listFiles(in: .drive(id: "d1"), folder: "", query: "take")
        #expect(stub.requests.last?.query["folderPrefix"] == nil)
    }

    @Test func theLibraryNamesNoDrive() async throws {
        let stub = try ListingStub { request in
            request.path.hasSuffix("/folders")
                ? (200, #"{ "folders": [{ "folder": "Brand", "name": "Brand", "parent": "", "depth": 1, "count": 4 }] }"#)
                : (200, #"{ "files": [], "cursor": null }"#)
        }
        defer { stub.tearDown() }
        _ = try await stub.api.listFiles(in: .library, folder: "")
        let folders = try await stub.api.folders(in: .library)
        #expect(stub.requests.allSatisfy { $0.query["filespace"] == nil })
        #expect(folders == [FolderNode(folder: "Brand", name: "Brand", parent: "", depth: 1, count: 4)])
    }

    @Test func aDrivesFoldersComeWithTheirCounts() async throws {
        let stub = try ListingStub { _ in
            (200, #"{ "folders": [{ "folder": "Footage", "name": "Footage", "parent": "", "depth": 1, "count": 0 },"#
                + #"{ "folder": "Footage/Day 1", "name": "Day 1", "parent": "Footage", "depth": 2, "count": 12 }] }"#)
        }
        defer { stub.tearDown() }
        let folders = try await stub.api.folders(in: .drive(id: "d1"))
        #expect(stub.requests.first?.path == "/api/files/folders")
        #expect(stub.requests.first?.query["filespace"] == "d1")
        #expect(folders.map(\.folder) == ["Footage", "Footage/Day 1"])
        #expect(folders.last?.count == 12 && folders.last?.parent == "Footage")
    }

    @Test func aRefusalIsTheServersOwnSentence() async throws {
        let stub = try ListingStub { _ in (403, #"{ "error": "No access to that filespace." }"#) }
        defer { stub.tearDown() }
        await #expect(throws: OnyxError.self) { try await stub.api.listFiles(in: .drive(id: "d2"), folder: "") }
        do {
            _ = try await stub.api.listFiles(in: .drive(id: "d2"), folder: "")
        } catch let OnyxError.http(status, message) {
            #expect(status == 403 && message == "No access to that filespace.")
        }
    }

    @Test func measurementsAreReadLeniently() throws {
        let decode = { (json: String) in try JSONDecoder().decode(FileMetadata.self, from: Data(json.utf8)) }
        #expect(try decode(#"{}"#) == FileMetadata())
        #expect(try decode(#"{ "width": "1920", "height": 1080 }"#) == FileMetadata(width: 1920, height: 1080))
        // Nothing to show is nothing, not a zero-by-zero picture.
        #expect(try decode(#"{ "width": 0, "duration": "n/a" }"#) == FileMetadata())
        // A drive's own fields share the object and are not this client's.
        #expect(try decode(#"{ "duration": 61.2, "client": { "name": "Acme" } }"#) == FileMetadata(duration: 61.2))
    }

    @Test func aChangeFeedRowStillDecodes() throws {
        // The delta's rows lack what only a listing adds; they must decode
        // as they did, with the additions nil.
        let json = #"""
        { "id": "f2", "name": "a.png", "folder": "", "kind": "image", "mime": "image/png", "size": 1, "url": null,
          "storageKey": null, "thumbnailUrl": null, "tags": [], "notes": null, "caption": null, "visibility": null,
          "version": 1, "contentHash": null, "createdBy": null, "createdAt": 1, "updatedAt": 2, "deletedAt": null, "seq": 9 }
        """#
        let file = try JSONDecoder().decode(FileItem.self, from: Data(json.utf8))
        #expect(file.id == "f2" && file.seq == 9)
        #expect(file.smUrl == nil && file.metadata == nil && file.can == nil && file.openComments == nil)
    }
}

/// Collections, as GET /api/collections sends them, and their files as the
/// listing sends them (GET /api/files?collection=).
@Suite struct CollectionsTests {
    @Test func collectionsComeBackWithTheirScopeAndRules() async throws {
        let stub = try ListingStub { _ in
            (200, #"{ "collections": [{ "id": "c1", "driveId": "d1", "name": "Spring", "match": "all", "rules": [{ "field": "tag", "op": "any", "values": ["spring"] }], "updatedAt": 1, "canEdit": true }] }"#)
        }
        defer { stub.tearDown() }
        let list = try await stub.api.collections()
        #expect(stub.requests.first?.path == "/api/collections")
        let c = try #require(list.first)
        #expect(c.scope == .drive(id: "d1") && c.name == "Spring" && c.match == "all")
        #expect(c.rules == [FileCollection.Rule(field: "tag", op: "any", values: ["spring"])])
        #expect(c.canEdit == true)
    }

    @Test func aCollectionsFilesAreAskedForByItsIdNotAFolder() async throws {
        let stub = try ListingStub { _ in (200, #"{ "files": [], "cursor": null }"#) }
        defer { stub.tearDown() }
        _ = try await stub.api.listFiles(in: .drive(id: "d1"), folder: "", query: " hero ", collection: "c1")
        let asked = try #require(stub.requests.first)
        #expect(asked.path == "/api/files")
        #expect(asked.query["collection"] == "c1")
        #expect(asked.query["folder"] == nil && asked.query["folderPrefix"] == nil, "a collection lists its whole drive")
        #expect(asked.query["q"] == "hero")
        #expect(asked.query["filespace"] == "d1")
    }
}

/// Starred folders, as GET and PUT /api/stars (app/api/stars/route.js) send them.
@Suite struct StarsTests {
    @Test func starsComeBackWithTheirScope() async throws {
        let stub = try ListingStub { _ in
            (200, #"{ "stars": [{ "driveId": "", "folder": "Campaigns" }, { "driveId": "d1", "folder": "Footage/Day 1" }] }"#)
        }
        defer { stub.tearDown() }
        let stars = try await stub.api.stars()

        let asked = try #require(stub.requests.first)
        #expect(asked.method == "GET" && asked.path == "/api/stars")
        #expect(asked.authorization == "Bearer test-token")
        #expect(stars.map(\.scope) == [.library, .drive(id: "d1")])
        #expect(stars.map(\.name) == ["Campaigns", "Day 1"])
        #expect(stars[0].id != FolderStar(scope: .drive(id: "d1"), folder: "Campaigns").id,
                "the same path in another drive is another star")
    }

    @Test func starringPutsAndReadsTheListBack() async throws {
        let stub = try ListingStub { _ in (200, #"{ "stars": [{ "driveId": "d1", "folder": "Cuts" }] }"#) }
        defer { stub.tearDown() }
        let star = FolderStar(scope: .drive(id: "d1"), folder: "Cuts")
        #expect(star.driveId == "d1")
        let now = try await stub.api.setStar(star, starred: true)
        #expect(stub.requests.first?.method == "PUT" && stub.requests.first?.path == "/api/stars")
        #expect(now == [star])
    }

    @Test func aRefusalSaysWhy() async throws {
        let stub = try ListingStub { _ in (409, #"{ "error": "You have 200 starred folders." }"#) }
        defer { stub.tearDown() }
        do {
            try await stub.api.setStar(FolderStar(scope: .library, folder: "A"), starred: true)
            Issue.record("a 409 should throw")
        } catch let OnyxError.http(status, message) {
            #expect(status == 409 && message == "You have 200 starred folders.")
        }
    }
}

private final class ListingStub: @unchecked Sendable {
    struct Request {
        let method: String
        let path: String
        let query: [String: String]
        let authorization: String?
    }

    let api: OnyxAPI
    private let host = "\(UUID().uuidString.lowercased()).listing.test"
    private let tokens = TokenStore(service: "io.onyxfs.tests.listing.\(UUID().uuidString)", accessGroup: nil)
    private let answer: (Request) -> (Int, String)
    private let lock = NSLock()
    private var received: [Request] = []

    var requests: [Request] { lock.withLock { received } }

    init(_ answer: @escaping (Request) -> (Int, String)) throws {
        self.answer = answer
        try tokens.set("test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ListingStubProtocol.self]
        api = OnyxAPI(config: OnyxConfig(baseURL: URL(string: "https://\(host)")!), tokens: tokens,
                      session: URLSession(configuration: configuration))
        Self.stubs.withLock { $0[host] = self }
    }

    func tearDown() {
        tokens.clear()
        Self.stubs.withLock { $0[host] = nil }
    }

    static let stubs = OSAllocatedUnfairLock<[String: ListingStub]>(initialState: [:])

    func respond(to request: URLRequest) -> (Int, Data) {
        let url = request.url!
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var query: [String: String] = [:]
        for item in parts?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let seen = Request(method: request.httpMethod ?? "GET", path: url.path, query: query,
                           authorization: request.value(forHTTPHeaderField: "Authorization"))
        lock.withLock { received.append(seen) }
        let (status, text) = answer(seen)
        return (status, Data(text.utf8))
    }
}

private final class ListingStubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".listing.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host,
              let stub = ListingStub.stubs.withLock({ $0[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let (status, body) = stub.respond(to: request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
