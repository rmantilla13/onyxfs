import Foundation
import os
import Testing
@testable import OnyxKit

/// The iPhone's Home: who it greets, what each place holds (asked of the
/// listing, as a member reads it), a tile's "20m ago", and each drive's
/// colour made legible.
@Suite struct OverviewTests {
    // MARK: - Who

    @Test func theGreetingUsesTheNameGivenFirst() {
        #expect(Identity(email: "r@x.test", name: "Ricky Mantilla").firstName == "Ricky")
        #expect(Identity(email: "r@x.test", name: "  Ana  ").firstName == "Ana")
    }

    @Test func withoutANameTheAddressSaysWhoItIs() {
        #expect(Identity(email: "ricky.mantilla@onyxfs.io").firstName == "Ricky")
        #expect(Identity(email: "jane_doe42@x.test").firstName == "Jane")
        #expect(Identity(email: "Mo-Li@x.test").firstName == "Mo")
    }

    @Test func anAddressThatNamesNoOneGetsNoName() {
        #expect(Identity(email: "hi@rickymantilla.com").firstName == nil)
        #expect(Identity(email: "appreview@onyxfs.io").firstName == nil)
        #expect(Identity(email: "x@y.test").firstName == nil, "one letter is not a name")
        #expect(Identity(email: "hi@rickymantilla.com", name: "").firstName == nil)
    }

    @Test func theServerSaysNullWhenThereIsNoName() throws {
        let identity = try JSONDecoder().decode(Identity.self, from: Data(#"{"email":"a@b.test","isAdmin":false,"name":null}"#.utf8))
        #expect(identity.name == nil && identity.isAdmin == false)
        let older = try JSONDecoder().decode(Identity.self, from: Data(#"{"email":"a@b.test","isAdmin":true}"#.utf8))
        #expect(older.name == nil, "a server from before")
    }

    // MARK: - When

    @Test func aTileSaysHowLongAgoInAFewLetters() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        #expect(RelativeTime.short(now.addingTimeInterval(-30), now: now) == "now")
        #expect(RelativeTime.short(now.addingTimeInterval(-20 * 60), now: now) == "20m ago")
        #expect(RelativeTime.short(now.addingTimeInterval(-3 * 3600 - 59), now: now) == "3h ago")
        #expect(RelativeTime.short(now.addingTimeInterval(-2 * 86_400), now: now) == "2d ago")
        // A week on, the date itself.
        let older = RelativeTime.short(now.addingTimeInterval(-30 * 86_400), now: now)
        #expect(!older.contains("ago") && !older.isEmpty)
        // A clock a little ahead of the server's is not "in the future".
        #expect(RelativeTime.short(now.addingTimeInterval(90), now: now) == "now")
    }

    // MARK: - Colour

    @Test func everyBrandHueCarriesWhiteWordsOnItsCard() throws {
        // The palette's hues and the mixes lib/drive-color.js makes of them.
        for hex in ["#E040FB", "#22D3EE", "#C2410C", "#3D5AFE", "#7FC08A", "#FFFFFF", "#FFE45C"] {
            let tint = try #require(DriveTint(hex: hex), "\(hex)")
            #expect(try #require(DriveTint.whiteContrast(on: tint.cardTop)) >= 4.5, "\(hex) top")
            #expect(try #require(DriveTint.whiteContrast(on: tint.cardBottom)) >= 4.5, "\(hex) bottom")
            #expect(try #require(DriveTint.pageContrast(of: tint.accent)) >= 3, "\(hex) on the page")
        }
    }

    @Test func aHueAlreadyDeepEnoughKeepsItself() throws {
        let tint = try #require(DriveTint(hex: "#3D5AFE"))
        #expect(tint.cardTop == "#3D5AFE", "the web's --aura-a-deep is the accent itself")
    }

    @Test func aColourTooDarkForThePageIsLifted() throws {
        let tint = try #require(DriveTint(hex: "#101828"))
        #expect(tint.accent != "#101828")
        #expect(try #require(DriveTint.pageContrast(of: tint.accent)) >= 3)
    }

    @Test func anythingElseIsNoColour() {
        #expect(DriveTint(hex: nil) == nil)
        #expect(DriveTint(hex: "red") == nil)
        #expect(DriveTint(hex: "#12345") == nil)
    }

    // MARK: - What a place holds

    @Test func aPlaceIsCountedByTheListingItself() async throws {
        let stub = try OverviewStub { _ in (200, #"{"files":[],"cursor":null,"total":42,"totalBytes":"5368709120"}"#) }
        defer { stub.tearDown() }
        let usage = try await stub.api.usage(of: .drive(id: "d1"))
        #expect(usage == PlaceUsage(files: 42, bytes: 5_368_709_120))

        let asked = try #require(stub.requests.first)
        #expect(asked.path == "/api/files")
        #expect(asked.query["filespace"] == "d1")
        #expect(asked.query["withTotal"] == "1")
        #expect(asked.query["limit"] == "1")
        #expect(asked.query["folders"] == "0")
        // Every folder of the drive: no folder asked for.
        #expect(asked.query["folder"] == nil && asked.query["folderPrefix"] == nil)
    }

    @Test func aServerThatOnlyCountsGivesNoWeight() async throws {
        let stub = try OverviewStub { _ in (200, #"{"files":[],"cursor":null,"total":7}"#) }
        defer { stub.tearDown() }
        #expect(try await stub.api.usage(of: .library) == PlaceUsage(files: 7, bytes: nil))
        #expect(stub.requests.first?.query["filespace"] == nil, "All Files is the whole library")
    }

    @Test func recentFilesComeFromEveryFolderNewestFirst() async throws {
        let stub = try OverviewStub { _ in (200, #"{"files":[],"cursor":"c2"}"#) }
        defer { stub.tearDown() }
        let page = try await stub.api.recentFiles(limit: 5, cursor: "c1")
        #expect(page.cursor == "c2")
        let asked = try #require(stub.requests.first)
        #expect(asked.query["sort"] == "new")
        #expect(asked.query["limit"] == "5")
        #expect(asked.query["cursor"] == "c1")
        #expect(asked.query["folder"] == nil)
    }

    @Test func theGreetingIsAskedOfTheTokensOwnRoute() async throws {
        let stub = try OverviewStub { _ in (200, #"{"email":"ricky.mantilla@x.test","isAdmin":false,"name":"Ricky M"}"#) }
        defer { stub.tearDown() }
        let identity = try await stub.api.identity()
        #expect(identity.firstName == "Ricky")
        #expect(stub.requests.first?.path == "/api/desktop/me")
        #expect(stub.requests.first?.authorization == "Bearer test-token")
    }
}

/// An OnyxAPI whose requests are answered here, and remembered.
private final class OverviewStub: @unchecked Sendable {
    struct Request {
        let path: String
        let query: [String: String]
        let authorization: String?
    }

    let api: OnyxAPI
    private let host = "\(UUID().uuidString.lowercased()).overview.test"
    private let tokens = TokenStore(service: "io.onyxfs.tests.overview.\(UUID().uuidString)", accessGroup: nil)
    private let answer: (Request) -> (Int, String)
    private let lock = NSLock()
    private var received: [Request] = []

    var requests: [Request] { lock.withLock { received } }

    init(_ answer: @escaping (Request) -> (Int, String)) throws {
        self.answer = answer
        try tokens.set("test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OverviewStubProtocol.self]
        api = OnyxAPI(config: OnyxConfig(baseURL: URL(string: "https://\(host)")!), tokens: tokens,
                      session: URLSession(configuration: configuration))
        Self.stubs.withLock { $0[host] = self }
    }

    func tearDown() {
        tokens.clear()
        Self.stubs.withLock { $0[host] = nil }
    }

    static let stubs = OSAllocatedUnfairLock<[String: OverviewStub]>(initialState: [:])

    func respond(to request: URLRequest) -> (Int, Data) {
        let url = request.url!
        var query: [String: String] = [:]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let seen = Request(path: url.path, query: query, authorization: request.value(forHTTPHeaderField: "Authorization"))
        lock.withLock { received.append(seen) }
        let (status, text) = answer(seen)
        return (status, Data(text.utf8))
    }
}

private final class OverviewStubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".overview.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host,
              let stub = OverviewStub.stubs.withLock({ $0[host] }) else {
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
