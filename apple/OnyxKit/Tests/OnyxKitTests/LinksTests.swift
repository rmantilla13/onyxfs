import Foundation
import os
import Testing
@testable import OnyxKit

/// Links as the iPhone's Share Link sheet makes them: what it asks the
/// web's link routes (app/api/files/[id]/shares, app/api/files/folders/shares)
/// and sends them, and what it reads back — shaped as lib/share-guard.js
/// presentShare, presentFileShare and linkChoices send them.
@Suite struct LinksTests {
    static let fileList = #"""
    {
      "shares": [
        { "token": "Zk3_q9Lx0aB7cD2eF4gH6i", "path": "/s/Zk3_q9Lx0aB7cD2eF4gH6i", "kind": "password", "review": "comment",
          "expiresAt": 1790500000000, "viewCount": 12, "createdAt": 1790000000000, "createdBy": "ricky@x.test",
          "levels": ["view", "comment", "approve"] },
        { "token": "0123456789ab", "path": "/s/0123456789ab", "kind": "private", "review": null,
          "expiresAt": null, "viewCount": "3", "createdAt": 1789000000000, "createdBy": null, "levels": ["view"] }
      ],
      "can": { "kinds": ["public", "password", "private"], "review": ["comment", "approve"],
               "expires": ["never", "1", "7", "30"], "maxExpiryDays": null, "passwordMin": 6 }
    }
    """#

    @Test func aFilesLinksAreListedWithWhatMayBeMade() async throws {
        let stub = try LinksStub { _ in (200, Self.fileList) }
        defer { stub.tearDown() }
        let list = try await stub.api.links(to: .file(id: "f1"))

        let asked = try #require(stub.requests.first)
        #expect(asked.method == "GET")
        #expect(asked.path == "/api/files/f1/shares")
        #expect(asked.authorization == "Bearer test-token", "the device token, which the route now takes")

        #expect(list.shares.count == 2)
        let first = list.shares[0]
        #expect(first.kind == .password && first.level == .comment)
        #expect(first.expiresAt == EpochMillis(1_790_500_000_000))
        #expect(first.viewCount == 12 && first.createdBy == "ricky@x.test")
        #expect(first.levels == [.view, .comment, .approve])
        let second = list.shares[1]
        #expect(second.kind == .private && second.review == nil && second.level == .view)
        #expect(second.expiresAt == nil, "never expires")
        #expect(second.viewCount == 3, "a count that arrives as a string")
        #expect(list.choices == LinkChoices(kinds: [.public, .password, .private], review: [.comment, .approve]))
    }

    @Test func aFoldersLinksAreAskedForByItsPathAndItsDrive() async throws {
        let stub = try LinksStub { _ in (200, #"{"shares":[],"can":{"kinds":["public","password"],"review":[],"expires":["1","7"],"maxExpiryDays":7,"passwordMin":6}}"#) }
        defer { stub.tearDown() }
        let list = try await stub.api.links(to: .folder(path: "Footage/Day 1", scope: .drive(id: "d1")))
        let asked = try #require(stub.requests.first)
        #expect(asked.path == "/api/files/folders/shares")
        #expect(asked.query["folder"] == "Footage/Day 1")
        #expect(asked.query["filespace"] == "d1")
        #expect(list.choices.kinds == [.public, .password] && list.choices.review.isEmpty)
        #expect(list.choices.expires == [.day, .week] && list.choices.maxExpiryDays == 7)

        _ = try await stub.api.links(to: .folder(path: "Brand", scope: .library))
        #expect(stub.requests.last?.query["filespace"] == nil, "the library's folder: no drive")
        #expect(stub.requests.last?.query["folder"] == "Brand")
    }

    @Test func aFileLinkIsMadeAsTheWebMakesOne() async throws {
        let made = #"{"share":{"token":"Zk3_q9Lx0aB7cD2eF4gH6i","path":"/s/Zk3_q9Lx0aB7cD2eF4gH6i","kind":"public","review":"approve","expiresAt":null,"viewCount":0,"createdAt":1790000000000,"createdBy":"ricky@x.test","levels":["view","comment","approve"]}}"#
        let stub = try LinksStub { _ in (200, made) }
        defer { stub.tearDown() }

        let link = try await stub.api.makeLink(to: .file(id: "f1"), LinkRequest(kind: .public, expires: .never, review: .approve))
        #expect(link.token == "Zk3_q9Lx0aB7cD2eF4gH6i" && link.level == .approve)
        var asked = try #require(stub.requests.last)
        #expect(asked.method == "POST" && asked.path == "/api/files/f1/shares")
        #expect(asked.json as NSDictionary? == ["kind": "public", "expires": "never", "review": "approve"])

        // A password only for a password link; comments never on a private one.
        _ = try await stub.api.makeLink(to: .file(id: "f1"), LinkRequest(kind: .password, password: "hunter22", expires: .week))
        asked = try #require(stub.requests.last)
        #expect(asked.json as NSDictionary? == ["kind": "password", "expires": "7", "password": "hunter22"])
        _ = try await stub.api.makeLink(to: .file(id: "f1"), LinkRequest(kind: .private, password: "left over", expires: .day, review: .comment))
        asked = try #require(stub.requests.last)
        #expect(asked.json as NSDictionary? == ["kind": "private", "expires": "1"])
        _ = try await stub.api.makeLink(to: .file(id: "f1"), LinkRequest(kind: .public, expires: .month, review: .view))
        #expect(stub.requests.last?.json?["review"] == nil, "view is what no review means")
    }

    @Test func aFolderLinkNamesTheFolderAndItsDriveAndTakesNoComments() async throws {
        let stub = try LinksStub { _ in (200, #"{"share":{"token":"t0k3n0000000","path":"/s/t0k3n0000000","kind":"public","review":null,"expiresAt":null,"viewCount":0,"createdAt":1,"createdBy":"a@b.test"}}"#) }
        defer { stub.tearDown() }
        let link = try await stub.api.makeLink(to: .folder(path: "Footage", scope: .drive(id: "d1")),
                                               LinkRequest(kind: .public, expires: .never, review: .comment))
        #expect(link.levels == nil, "a folder's link has no levels to change")
        let asked = try #require(stub.requests.last)
        #expect(asked.method == "POST" && asked.path == "/api/files/folders/shares")
        #expect(asked.json as NSDictionary? == ["kind": "public", "expires": "never", "folder": "Footage", "filespaceId": "d1"])

        _ = try await stub.api.makeLink(to: .folder(path: "Brand", scope: .library), LinkRequest(kind: .password, password: "hunter22"))
        #expect(stub.requests.last?.json as NSDictionary? == ["kind": "password", "expires": "never", "password": "hunter22", "folder": "Brand"])
    }

    @Test func aLinksLevelIsChangedAndALinkRevokedWhereItLives() async throws {
        let stub = try LinksStub { req in
            req.method == "PATCH"
                ? (200, #"{"share":{"token":"Zk3_q9Lx0aB7cD2eF4gH6i","kind":"public","review":null,"expiresAt":null,"viewCount":1,"createdAt":1,"createdBy":"a@b.test","levels":["view","comment"]}}"#)
                : (200, #"{"ok":true}"#)
        }
        defer { stub.tearDown() }
        let changed = try await stub.api.setLinkReview(.view, token: "Zk3_q9Lx0aB7cD2eF4gH6i", fileId: "f1")
        #expect(changed?.level == .view && changed?.levels == [.view, .comment])
        var asked = try #require(stub.requests.last)
        #expect(asked.method == "PATCH" && asked.path == "/api/files/f1/shares/Zk3_q9Lx0aB7cD2eF4gH6i")
        #expect(asked.json as NSDictionary? == ["review": "view"])

        try await stub.api.revokeLink(token: "Zk3_q9Lx0aB7cD2eF4gH6i", of: .file(id: "f1"))
        asked = try #require(stub.requests.last)
        #expect(asked.method == "DELETE" && asked.path == "/api/files/f1/shares/Zk3_q9Lx0aB7cD2eF4gH6i")

        try await stub.api.revokeLink(token: "t0k3n0000000", of: .folder(path: "Footage", scope: .drive(id: "d1")))
        asked = try #require(stub.requests.last)
        #expect(asked.method == "DELETE" && asked.path == "/api/files/folders/shares/t0k3n0000000",
                "a folder's link is revoked by its token alone")
        #expect(asked.query.isEmpty)
    }

    @Test func anIdOrATokenIsOnePathComponentWhateverItHolds() async throws {
        let stub = try LinksStub { _ in (200, #"{"ok":true}"#) }
        defer { stub.tearDown() }
        try await stub.api.revokeLink(token: "a/b", of: .file(id: "x y/z"))
        #expect(stub.requests.last?.path == "/api/files/x%20y%2Fz/shares/a%2Fb")
    }

    @Test func whatTheServerRefusesIsSaidInItsOwnWords() async throws {
        let stub = try LinksStub { req in
            req.path.hasSuffix("/f2/shares") ? (401, #"{"error":"Not authenticated"}"#)
                : (403, #"{"error":"You can view this file but not share it."}"#)
        }
        defer { stub.tearDown() }
        do {
            _ = try await stub.api.links(to: .file(id: "f1"))
            Issue.record("a 403 is an error")
        } catch let OnyxError.http(status, message) {
            #expect(status == 403 && message == "You can view this file but not share it.")
        }
        await #expect(throws: OnyxError.self) {
            _ = try await stub.api.makeLink(to: .file(id: "f1"), LinkRequest(kind: .public))
        }
        do {
            _ = try await stub.api.links(to: .file(id: "f2"))
            Issue.record("a 401 is an error")
        } catch OnyxError.notAuthenticated {
            // The token no longer counts: the app signs out, as everywhere.
        }
    }

    // MARK: - What is offered

    @Test func choicesAreReadLeniently() throws {
        let odd = #"{"kinds":["public","telepathy"],"review":["view","comment"],"expires":["never","365","7"],"maxExpiryDays":"30"}"#
        let c = try JSONDecoder().decode(LinkChoices.self, from: Data(odd.utf8))
        #expect(c.kinds == [.public], "a kind this build does not know is not offered")
        #expect(c.review == [.comment], "view is not a review level to offer")
        #expect(c.expires == [.never, .week])
        #expect(c.maxExpiryDays == 30 && c.passwordMin == 6 && c.reason == nil)

        let refused = #"{"kinds":[],"review":[],"expires":[],"maxExpiryDays":null,"passwordMin":6,"reason":"Links are turned off for this drive."}"#
        let none = try JSONDecoder().decode(LinkChoices.self, from: Data(refused.utf8))
        #expect(!none.canMake && none.reason == "Links are turned off for this drive.")

        let older = try JSONDecoder().decode(LinkList.self, from: Data(#"{"shares":[]}"#.utf8))
        #expect(older.choices == .none && !older.choices.canMake, "a server that does not say: nothing is offered")
    }

    @Test func aNewLinkStartsAtNeverWhenItMayElseTheLongestItMay() {
        #expect(LinkChoices(kinds: [.public]).defaultExpiry == .never)
        #expect(LinkChoices(kinds: [.private], expires: [.day, .week, .month], maxExpiryDays: 30).defaultExpiry == .month)
        #expect(LinkChoices(kinds: [.public], expires: [.day]).defaultExpiry == .day)
        #expect(LinkChoices.none.defaultExpiry == nil)
    }

    @Test func commentsAreOfferedForAPublicOrPasswordLinkWhereTheServerSaysSo() {
        let reviewable = LinkChoices(kinds: [.public, .password, .private], review: [.comment, .approve])
        #expect(reviewable.offersReview(for: .public) && reviewable.offersReview(for: .password))
        #expect(!reviewable.offersReview(for: .private), "a private link's people comment on the file itself")
        #expect(!LinkChoices(kinds: [.public]).offersReview(for: .public))
    }

    @Test func aLinksLevelIsOfferedOnlyWithAChoiceAndBeforeItExpires() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let soon = EpochMillis(Int64((now.timeIntervalSince1970 + 3600) * 1000))
        let gone = EpochMillis(Int64((now.timeIntervalSince1970 - 1) * 1000))
        #expect(SharedLink(token: "t", kind: .public, levels: [.view, .comment]).offersLevels(now: now))
        #expect(SharedLink(token: "t", kind: .public, expiresAt: soon, levels: [.view, .comment]).offersLevels(now: now))
        #expect(!SharedLink(token: "t", kind: .public, expiresAt: gone, levels: [.view, .comment]).offersLevels(now: now),
                "an expired link is there to be revoked")
        #expect(!SharedLink(token: "t", kind: .private, levels: [.view]).offersLevels(now: now), "nothing to choose")
        #expect(!SharedLink(token: "t", kind: .public, levels: nil).offersLevels(now: now), "a folder's")
        #expect(SharedLink(token: "t", kind: .public, expiresAt: gone).isExpired(now: now))
        #expect(!SharedLink(token: "t", kind: .public).isExpired(now: now), "never")
    }

    // MARK: - Where it opens, and how it reads

    @Test func aLinkOpensOnTheServerTheAppTalksTo() {
        let server = URL(string: "https://onyx.example.com")!
        #expect(SharedLink(token: "abc", path: "/s/abc", kind: .public).url(on: server).absoluteString == "https://onyx.example.com/s/abc")
        #expect(SharedLink(token: "abc", kind: .public).url(on: server).absoluteString == "https://onyx.example.com/s/abc",
                "a path the server did not send is the one it serves")
        let local = URL(string: "http://127.0.0.1:3000")!
        #expect(SharedLink(token: "abc", path: "/s/abc", kind: .public).url(on: local).absoluteString == "http://127.0.0.1:3000/s/abc")
    }

    /// lib/share-kinds.js expiryLabel, the same arithmetic: hours under a
    /// day, then days, each rounded up.
    @Test func anExpiryReadsAsTheWebSaysIt() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        func at(_ seconds: Double) -> EpochMillis { EpochMillis(Int64((now.timeIntervalSince1970 + seconds) * 1000)) }
        #expect(LinkWords.expires(nil, now: now) == nil)
        #expect(LinkWords.expires(at(0), now: now) == "Expired")
        #expect(LinkWords.expires(at(-60), now: now) == "Expired")
        #expect(LinkWords.expires(at(60), now: now) == "Expires in 1 hour")
        #expect(LinkWords.expires(at(3600 * 5 - 1), now: now) == "Expires in 5 hours")
        #expect(LinkWords.expires(at(3600 * 22.5), now: now) == "Expires in 23 hours")
        #expect(LinkWords.expires(at(3600 * 23.5), now: now) == "Expires in 1 day", "24 hours is not under a day")
        #expect(LinkWords.expires(at(86_400), now: now) == "Expires in 1 day")
        #expect(LinkWords.expires(at(86_400 * 2.5), now: now) == "Expires in 3 days")
        #expect(LinkWords.expires(at(86_400 * 30), now: now) == "Expires in 30 days")
    }

    @Test func theWordsAreTheWebDialogs() {
        #expect(LinkKind.allCases.map(LinkWords.title) == ["Public", "Password", "Private"])
        #expect(LinkWords.detail(.public) == "Anyone with the link can view and download.")
        #expect(LinkWords.detail(.public, folder: true) == "Anyone with the link can open the folder and download what is in it.")
        #expect(LinkExpiry.allCases.map(LinkWords.expiry) == ["Never", "In 1 day", "In 7 days", "In 30 days"])
        #expect(LinkReview.allCases.map(LinkWords.level) == ["View only", "Can comment", "Can approve"])
        #expect(LinkWords.views(1) == "1 view" && LinkWords.views(12) == "12 views")
        #expect(LinkWords.maxExpiry(nil) == nil)
        #expect(LinkWords.maxExpiry(1) == "Links you make must expire within 1 day.")
        #expect(LinkWords.folderNote(inDrive: true).hasSuffix("stay out of it."))
        #expect(LinkWords.folderNote(inDrive: false).hasSuffix("share those from their drive."))
        #expect(LinkExpiry.allCases.map(\.days) == [nil, 1, 7, 30])
        #expect(LinkReview.view < .comment && LinkReview.comment < .approve)
    }

    // MARK: - Where Share Link… is offered

    @Test func aFolderSaysWhetherItsLinksAreThisAccounts() throws {
        struct Tree: Decodable { let folders: [FolderNode] }
        let json = #"{"folders":[{"folder":"A","name":"A","parent":"","depth":1,"count":2,"share":true},{"folder":"B","name":"B","parent":"","depth":1,"count":0}]}"#
        let tree = try JSONDecoder().decode(Tree.self, from: Data(json.utf8))
        #expect(tree.folders.map(\.share) == [true, nil], "unmarked, or an older server: no")
    }

    @Test func theAccountSaysWhetherItMayShareAtAll() async throws {
        let bodies = [
            #"{"filespaces":[],"library":{"can":{"upload":true}},"email":"a@b.test","isAdmin":false,"shares":true}"#,
            #"{"filespaces":[],"library":{"can":{"upload":true}},"email":"a@b.test","isAdmin":false,"shares":false}"#,
            #"{"filespaces":[],"email":"a@b.test","isAdmin":false}"#,
        ]
        for (body, expected) in zip(bodies, [true, false, false]) {
            let stub = try LinksStub { _ in (200, body) }
            defer { stub.tearDown() }
            #expect(try await stub.api.drives().shares == expected, "\(body)")
        }
    }
}

/// An OnyxAPI whose requests are answered here, and remembered.
private final class LinksStub: @unchecked Sendable {
    struct Request {
        let method: String
        let path: String
        let query: [String: String]
        let authorization: String?
        let body: Data?
        var json: [String: Any]? { body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }
    }

    let api: OnyxAPI
    private let host = "\(UUID().uuidString.lowercased()).links.test"
    private let tokens = TokenStore(service: "io.onyxfs.tests.links.\(UUID().uuidString)", accessGroup: nil)
    private let answer: (Request) -> (Int, String)
    private let lock = NSLock()
    private var received: [Request] = []

    var requests: [Request] { lock.withLock { received } }

    init(_ answer: @escaping (Request) -> (Int, String)) throws {
        self.answer = answer
        try tokens.set("test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LinksStubProtocol.self]
        api = OnyxAPI(config: OnyxConfig(baseURL: URL(string: "https://\(host)")!), tokens: tokens,
                      session: URLSession(configuration: configuration))
        Self.stubs.withLock { $0[host] = self }
    }

    func tearDown() {
        tokens.clear()
        Self.stubs.withLock { $0[host] = nil }
    }

    static let stubs = OSAllocatedUnfairLock<[String: LinksStub]>(initialState: [:])

    func respond(to request: URLRequest) -> (Int, Data) {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            body = data
        }
        let url = request.url!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let seen = Request(method: request.httpMethod ?? "GET", path: components?.percentEncodedPath ?? url.path, query: query,
                           authorization: request.value(forHTTPHeaderField: "Authorization"), body: body)
        lock.withLock { received.append(seen) }
        let (status, text) = answer(seen)
        return (status, Data(text.utf8))
    }
}

private final class LinksStubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".links.test") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host, let stub = LinksStub.stubs.withLock({ $0[host] }) else {
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
