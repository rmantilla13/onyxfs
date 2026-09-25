import Testing
import Foundation
@testable import OnyxKit

/// The bridge rclone mounts each drive through. Its client is a program, not
/// a person: a wrong href drops a file from Finder without an error, a wrong
/// Content-Length hangs a read, a lax path check serves what it should not.
/// So each answer is pinned to the byte.
struct DAVResponderTests {
    static let token = "s3cret-token"
    static let modified = Date(timeIntervalSince1970: 1_790_000_000)
    static let modifiedHTTP = "Mon, 21 Sep 2026 14:13:20 GMT"
    static let streamURL = URL(string: "https://bucket.s3.example/k/Streamed.mov?X-Amz-Signature=abc")!

    /// A drive with a folder, awkward names, and one file of each content kind.
    struct Fixture {
        let dir: URL
        let pinned: URL
        let responder: DAVResponder

        init(prefix: String = "", root: Bool = true) throws {
            dir = FileManager.default.temporaryDirectory.appendingPathComponent("dav-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            pinned = dir.appendingPathComponent("pinned.bin")
            try Data((0..<100).map { UInt8($0) }).write(to: pinned)
            let empty = dir.appendingPathComponent("empty.bin")
            try Data().write(to: empty)

            func folder(_ path: String) -> MirrorEntry {
                MirrorEntry(kind: .folder, name: Replica.lastComponent(path), path: path, fileId: nil, size: 0,
                            modified: DAVResponderTests.modified, etag: nil, mime: nil)
            }
            func file(_ path: String, size: Int64 = 100, etag: String? = "abc123", mime: String? = "image/png") -> MirrorEntry {
                MirrorEntry(kind: .file, name: Replica.lastComponent(path), path: path, fileId: "id-\(path)", size: size,
                            modified: DAVResponderTests.modified, etag: etag, mime: mime)
            }
            var entries = [
                folder("Campaigns"),
                file("Campaigns/a b.png"),
                file("Campaigns/Café ☕.txt", mime: nil),
                file("Q&A <draft> v2.txt", mime: "text/plain"),
                file("Pinned.bin", mime: "application/x-thing"),
                file("Empty.bin", size: 0),
                file("Streamed.mov", mime: "video/quicktime"),
                file("Offline.doc"),
                file("Gone.bin"),
            ]
            if root {
                entries.append(MirrorEntry(kind: .folder, name: "Brand", path: "", fileId: nil, size: 0,
                                           modified: DAVResponderTests.modified, etag: nil, mime: nil))
            }
            let content: [String: DAVContent] = [
                "Pinned.bin": .local(pinned),
                "Empty.bin": .local(empty),
                "Campaigns/a b.png": .local(pinned),
                "Streamed.mov": .redirect(DAVResponderTests.streamURL),
                "Gone.bin": .local(dir.appendingPathComponent("missing.bin")),
            ]
            responder = DAVResponder(source: FakeSource(entries: entries, content: content),
                                     bearerToken: DAVResponderTests.token, hrefPrefix: prefix)
        }

        func remove() { try? FileManager.default.removeItem(at: dir) }
    }

    struct FakeSource: DAVSource {
        let byPath: [String: MirrorEntry]
        let content: [String: DAVContent]

        init(entries: [MirrorEntry], content: [String: DAVContent]) {
            byPath = Dictionary(uniqueKeysWithValues: entries.map { ($0.path, $0) })
            self.content = content
        }

        func entry(at path: String) async -> MirrorEntry? { byPath[path] }

        func children(of path: String) async -> [MirrorEntry]? {
            if !path.isEmpty, byPath[path]?.isFolder != true { return nil }
            return byPath.values.filter { !$0.path.isEmpty && Replica.parentPath($0.path) == path }
                .sorted { $0.path < $1.path }
        }

        func content(for entry: MirrorEntry) async -> DAVContent { content[entry.path] ?? .unavailable }
    }

    func send(_ responder: DAVResponder, _ method: String, _ target: String,
              _ headers: [String: String] = [:], auth: String? = "Bearer \(token)") async -> DAVResponse {
        var headers = headers
        if let auth { headers["authorization"] = auth }
        return await responder.respond(to: DAVRequest(method: method, target: target, headers: headers))
    }

    func text(_ r: DAVResponse) -> String {
        guard case let .data(data) = r.body else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Content-Length must always match what is sent, or the connection hangs
    /// or truncates.
    func expectLengthMatchesBody(_ r: DAVResponse, sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(r.header("Content-Length") == String(r.body.length), sourceLocation: sourceLocation)
        #expect(r.headers.filter { $0.0.lowercased() == "content-length" }.count == 1, sourceLocation: sourceLocation)
    }

    // MARK: - Auth

    @Test func everyMethodNeedsTheExactBearerToken() async throws {
        let f = try Fixture(); defer { f.remove() }
        for method in ["OPTIONS", "PROPFIND", "GET", "HEAD", "PUT", "TRACE"] {
            for auth in [nil, "Bearer wrong", "bearer \(Self.token)", "Bearer \(Self.token)x",
                         "Bearer \(Self.token.dropLast())", "Basic \(Self.token)", Self.token, "Bearer "] {
                let r = await send(f.responder, method, "/", ["depth": "0"], auth: auth)
                #expect(r.status == 401, "\(method) with \(auth ?? "no header")")
                #expect(r.header("WWW-Authenticate") == #"Bearer realm="onyx""#)
                if method != "HEAD" { expectLengthMatchesBody(r) }
            }
        }
        #expect(await send(f.responder, "OPTIONS", "/").status == 200)
        // Header names are case-insensitive on the wire; the request lowercases them.
        let mixed = DAVRequest(method: "OPTIONS", target: "/", headers: ["Authorization": "Bearer \(Self.token)"])
        #expect(await f.responder.respond(to: mixed).status == 200)
    }

    @Test func anEmptyTokenLetsNobodyIn() async {
        let r = DAVResponder(source: FakeSource(entries: [], content: [:]), bearerToken: "")
        #expect(await r.respond(to: DAVRequest(method: "OPTIONS", target: "/", headers: ["authorization": "Bearer "])).status == 401)
        #expect(await r.respond(to: DAVRequest(method: "OPTIONS", target: "/", headers: ["authorization": "Bearer"])).status == 401)
    }

    @Test func constantTimeComparisonStillCompares() {
        let a = Array("Bearer abc".utf8)
        #expect(DAVResponder.constantTimeEquals(a, a))
        #expect(!DAVResponder.constantTimeEquals(Array("Bearer abd".utf8), a))
        #expect(!DAVResponder.constantTimeEquals(Array("Bearer ab".utf8), a))
        #expect(!DAVResponder.constantTimeEquals(Array("Bearer abcd".utf8), a))
        #expect(!DAVResponder.constantTimeEquals([], a))
    }

    // MARK: - OPTIONS

    @Test func optionsAdvertisesAReadOnlyClass1Server() async throws {
        let f = try Fixture(); defer { f.remove() }
        for target in ["/", "/Campaigns/", "*", "/does-not-exist"] {
            let r = await send(f.responder, "OPTIONS", target)
            #expect(r.status == 200)
            #expect(r.header("DAV") == "1")
            #expect(r.header("Allow") == "OPTIONS, PROPFIND, GET, HEAD")
            #expect(r.header("Accept-Ranges") == "bytes")
            #expect(r.header("Content-Length") == "0")
            #expect(r.body == .empty)
        }
    }

    // MARK: - PROPFIND

    @Test func depthZeroOnTheRootIsOneCollection() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "PROPFIND", "/", ["depth": "0"])
        #expect(r.status == 207)
        #expect(r.header("Content-Type") == "application/xml; charset=utf-8")
        expectLengthMatchesBody(r)
        let xml = text(r)
        #expect(xml.hasPrefix(#"<?xml version="1.0" encoding="utf-8"?>"#))
        let responses = try #require(Multistatus.parse(r))
        #expect(responses.count == 1)
        #expect(responses[0].href == "/")
        #expect(responses[0].collection)
        #expect(responses[0].props["displayname"] == "Brand")
        #expect(responses[0].props["getlastmodified"] == Self.modifiedHTTP)
        #expect(responses[0].props["getcontentlength"] == nil, "folders carry no length")
        #expect(responses[0].props["getetag"] == nil)
        #expect(responses[0].status == "HTTP/1.1 200 OK")
    }

    @Test func depthOneListsTheFolderAndItsChildrenWithEncodedHrefs() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "PROPFIND", "/Campaigns", ["depth": "1"])
        #expect(r.status == 207)
        expectLengthMatchesBody(r)
        let responses = try #require(Multistatus.parse(r))
        #expect(responses.map(\.href) == ["/Campaigns/", "/Campaigns/Caf%C3%A9%20%E2%98%95.txt", "/Campaigns/a%20b.png"])
        #expect(responses.map(\.collection) == [true, false, false])
        #expect(responses.allSatisfy { $0.status == "HTTP/1.1 200 OK" })

        let unicode = responses[1], png = responses[2]
        #expect(unicode.props["displayname"] == "Café ☕.txt")
        #expect(unicode.props["getcontenttype"] == "application/octet-stream", "no mime falls back")
        #expect(png.props["displayname"] == "a b.png")
        #expect(png.props["getcontentlength"] == "100")
        #expect(png.props["getetag"] == #""abc123""#)
        #expect(png.props["getcontenttype"] == "image/png")
        #expect(png.props["getlastmodified"] == Self.modifiedHTTP)

        let xml = text(r)
        #expect(xml.contains(#"<D:multistatus xmlns:D="DAV:">"#))
        #expect(xml.contains(#"<D:getetag>"abc123"</D:getetag>"#))
        #expect(xml.contains("<D:resourcetype><D:collection/></D:resourcetype>"))
        #expect(xml.contains("<D:resourcetype/>"))
    }

    @Test func depthOneOnTheRootListsTopLevelOnly() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "PROPFIND", "/", ["depth": "1"])
        let hrefs = try #require(Multistatus.parse(r)).map(\.href)
        #expect(hrefs.first == "/")
        #expect(hrefs.contains("/Campaigns/"))
        #expect(hrefs.contains("/Pinned.bin"))
        #expect(!hrefs.contains { $0.hasPrefix("/Campaigns/") && $0 != "/Campaigns/" })
    }

    @Test func namesAreEscapedInXMLAndEncodedInHrefs() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "PROPFIND", "/Q%26A%20%3Cdraft%3E%20v2.txt", ["depth": "0"])
        #expect(r.status == 207)
        let xml = text(r)
        #expect(xml.contains("<D:displayname>Q&amp;A &lt;draft&gt; v2.txt</D:displayname>"))
        #expect(xml.contains("<D:href>/Q%26A%20%3Cdraft%3E%20v2.txt</D:href>"))
        let parsed = try #require(Multistatus.parse(r))
        #expect(parsed.first?.props["displayname"] == "Q&A <draft> v2.txt")
    }

    @Test func depthOneOnAFileIsJustTheFile() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "PROPFIND", "/Pinned.bin", ["depth": "1"])
        #expect(try #require(Multistatus.parse(r)).map(\.href) == ["/Pinned.bin"])
    }

    @Test func infiniteDepthIsRefusedAndOddDepthIsBad() async throws {
        let f = try Fixture(); defer { f.remove() }
        for depth in [nil, "infinity", "Infinity"] {
            let r = await send(f.responder, "PROPFIND", "/", depth.map { ["depth": $0] } ?? [:])
            #expect(r.status == 403)
            #expect(r.header("Content-Type") == "application/xml; charset=utf-8")
            #expect(text(r).contains(#"<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>"#))
            expectLengthMatchesBody(r)
        }
        #expect(await send(f.responder, "PROPFIND", "/", ["depth": "2"]).status == 400)
    }

    @Test func propfindOnNothingIs404() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "PROPFIND", "/Nope/", ["depth": "1"])
        #expect(r.status == 404)
        expectLengthMatchesBody(r)
        #expect(await send(f.responder, "PROPFIND", "/Campaigns/nope.png", ["depth": "0"]).status == 404)
    }

    @Test func theRootExistsEvenWhenTheSourceHasNoEntryForIt() async throws {
        let f = try Fixture(root: false); defer { f.remove() }
        let r = await send(f.responder, "PROPFIND", "/", ["depth": "1"])
        #expect(r.status == 207)
        let parsed = try #require(Multistatus.parse(r))
        #expect(parsed.first?.href == "/" && parsed.first?.collection == true)
        #expect(parsed.contains { $0.href == "/Campaigns/" })
    }

    @Test func aFolderWithNoListingIsRetryableNotEmpty() async {
        struct Vanishing: DAVSource {
            func entry(at path: String) async -> MirrorEntry? {
                MirrorEntry(kind: .folder, name: "F", path: path, fileId: nil, size: 0, modified: Date(), etag: nil, mime: nil)
            }
            func children(of path: String) async -> [MirrorEntry]? { nil }
            func content(for entry: MirrorEntry) async -> DAVContent { .unavailable }
        }
        let responder = DAVResponder(source: Vanishing(), bearerToken: Self.token)
        let r = await send(responder, "PROPFIND", "/F/", ["depth": "1"])
        #expect(r.status == 503)
        #expect(r.header("Retry-After") == "30")
    }

    // MARK: - GET / HEAD

    @Test func aStreamedFileRedirectsToStorage() async throws {
        let f = try Fixture(); defer { f.remove() }
        for method in ["GET", "HEAD"] {
            let r = await send(f.responder, method, "/Streamed.mov", ["range": "bytes=0-99"])
            #expect(r.status == 302)
            #expect(r.header("Location") == Self.streamURL.absoluteString)
            #expect(r.header("Cache-Control") == "no-store")
            #expect(r.header("Content-Length") == "0")
            #expect(r.body == .empty)
        }
    }

    @Test func aPinnedFileIsServedWholeFromDisk() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "GET", "/Pinned.bin")
        #expect(r.status == 200)
        #expect(r.body == .file(f.pinned, offset: 0, length: 100))
        #expect(r.header("Content-Length") == "100")
        #expect(r.header("Accept-Ranges") == "bytes")
        #expect(r.header("ETag") == #""abc123""#)
        #expect(r.header("Last-Modified") == Self.modifiedHTTP)
        #expect(r.header("Content-Type") == "application/x-thing")
        #expect(r.header("Content-Range") == nil)
    }

    @Test func everyRangeForm() async throws {
        let f = try Fixture(); defer { f.remove() }
        // (Range header, status, Content-Range, offset, length)
        let cases: [(String, Int, String?, Int64, Int64)] = [
            ("bytes=10-19", 206, "bytes 10-19/100", 10, 10),
            ("bytes=0-0", 206, "bytes 0-0/100", 0, 1),
            ("Bytes = 5-5", 206, "bytes 5-5/100", 5, 1),
            ("bytes=90-", 206, "bytes 90-99/100", 90, 10),
            ("bytes=95-200", 206, "bytes 95-99/100", 95, 5),
            ("bytes=0-99999999999999999999999", 206, "bytes 0-99/100", 0, 100),
            ("bytes=-5", 206, "bytes 95-99/100", 95, 5),
            ("bytes=-100", 206, "bytes 0-99/100", 0, 100),
            ("bytes=-500", 206, "bytes 0-99/100", 0, 100),
            // Unsatisfiable: starts at or past the end, or asks for no bytes.
            ("bytes=100-", 416, "bytes */100", 0, 0),
            ("bytes=100-150", 416, "bytes */100", 0, 0),
            ("bytes=99999999999999999999999-", 416, "bytes */100", 0, 0),
            ("bytes=-0", 416, "bytes */100", 0, 0),
            // Several, or unparseable: ignored, the whole file.
            ("bytes=0-1,5-6", 200, nil, 0, 100),
            ("bytes=0-1, 5-", 200, nil, 0, 100),
            ("bytes=5-2", 200, nil, 0, 100),
            ("bytes=abc", 200, nil, 0, 100),
            ("bytes=a-b", 200, nil, 0, 100),
            ("bytes=", 200, nil, 0, 100),
            ("bytes=-", 200, nil, 0, 100),
            ("bytes=1-2-3", 200, nil, 0, 100),
            ("bytes=+1-2", 200, nil, 0, 100),
            ("items=0-1", 200, nil, 0, 100),
            ("0-1", 200, nil, 0, 100),
        ]
        for (range, status, contentRange, offset, length) in cases {
            let r = await send(f.responder, "GET", "/Pinned.bin", ["range": range])
            #expect(r.status == status, "\(range)")
            #expect(r.header("Content-Range") == contentRange, "\(range)")
            #expect(r.header("Accept-Ranges") == "bytes")
            #expect(r.header("ETag") == #""abc123""#)
            if status == 416 {
                #expect(r.body == .empty, "\(range)")
            } else {
                #expect(r.body == .file(f.pinned, offset: offset, length: length), "\(range)")
            }
            expectLengthMatchesBody(r)
        }
    }

    @Test func anEmptyPinnedFileHasNoSatisfiableRange() async throws {
        let f = try Fixture(); defer { f.remove() }
        let whole = await send(f.responder, "GET", "/Empty.bin")
        #expect(whole.status == 200 && whole.header("Content-Length") == "0")
        for range in ["bytes=0-", "bytes=-5", "bytes=0-0"] {
            let r = await send(f.responder, "GET", "/Empty.bin", ["range": range])
            #expect(r.status == 416, "\(range)")
            #expect(r.header("Content-Range") == "bytes */0")
        }
    }

    @Test func headSendsGetsHeadersAndLengthButNoBody() async throws {
        let f = try Fixture(); defer { f.remove() }
        let whole = await send(f.responder, "HEAD", "/Pinned.bin")
        #expect(whole.status == 200)
        #expect(whole.body == .empty)
        #expect(whole.header("Content-Length") == "100")
        #expect(whole.header("ETag") == #""abc123""#)
        #expect(whole.header("Last-Modified") == Self.modifiedHTTP)

        let part = await send(f.responder, "HEAD", "/Pinned.bin", ["range": "bytes=-5"])
        #expect(part.status == 206)
        #expect(part.body == .empty)
        #expect(part.header("Content-Length") == "5")
        #expect(part.header("Content-Range") == "bytes 95-99/100")

        let missing = await send(f.responder, "HEAD", "/nope")
        #expect(missing.status == 404 && missing.body == .empty)
        #expect(missing.header("Content-Length") == String((await send(f.responder, "GET", "/nope")).body.length))
    }

    @Test func thePinnedSizeComesFromDiskNotTheIndex() async throws {
        let f = try Fixture(); defer { f.remove() }
        // The index says 100; the copy on disk is what gets served.
        try Data(repeating: 7, count: 40).write(to: f.pinned)
        let r = await send(f.responder, "GET", "/Campaigns/a%20b.png", ["range": "bytes=30-"])
        #expect(r.status == 206)
        #expect(r.header("Content-Range") == "bytes 30-39/40")
        #expect(r.body == .file(f.pinned, offset: 30, length: 10))
    }

    @Test func aPinnedCopyMissingFromDiskIs503() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "GET", "/Gone.bin")
        #expect(r.status == 503)
        expectLengthMatchesBody(r)
    }

    @Test func unavailableContentIsRetryable503() async throws {
        let f = try Fixture(); defer { f.remove() }
        for method in ["GET", "HEAD"] {
            let r = await send(f.responder, method, "/Offline.doc")
            #expect(r.status == 503)
            #expect(r.header("Retry-After") == "30")
        }
    }

    @Test func foldersCannotBeReadAndMissingFilesAre404() async throws {
        let f = try Fixture(); defer { f.remove() }
        for target in ["/", "/Campaigns", "/Campaigns/"] {
            for method in ["GET", "HEAD"] {
                let r = await send(f.responder, method, target)
                #expect(r.status == 405, "\(method) \(target)")
                #expect(r.header("Allow") == "OPTIONS, PROPFIND, GET, HEAD")
            }
        }
        let r = await send(f.responder, "GET", "/Campaigns/missing.png")
        #expect(r.status == 404)
        expectLengthMatchesBody(r)
    }

    // MARK: - Methods

    @Test func writesAreRefusedWhileTheMountIsReadOnly() async throws {
        let f = try Fixture(); defer { f.remove() }
        for method in ["PUT", "DELETE", "MKCOL", "MOVE", "COPY", "PROPPATCH", "LOCK", "UNLOCK", "POST", "PATCH"] {
            let r = await send(f.responder, method, "/Pinned.bin")
            #expect(r.status == 403, "\(method)")
            #expect(r.header("Content-Type") == "text/plain; charset=utf-8")
            #expect(!text(r).isEmpty)
            expectLengthMatchesBody(r)
        }
    }

    @Test func unknownMethodsAre405WithAllow() async throws {
        let f = try Fixture(); defer { f.remove() }
        for method in ["TRACE", "SEARCH", "CONNECT", "get", "BREW"] {
            let r = await send(f.responder, method, "/Pinned.bin")
            #expect(r.status == 405, "\(method)")
            #expect(r.header("Allow") == "OPTIONS, PROPFIND, GET, HEAD")
            expectLengthMatchesBody(r)
        }
    }

    // MARK: - Paths

    @Test func pathsThatClimbOrSmuggleAreRefused() async throws {
        let f = try Fixture(); defer { f.remove() }
        let bad = [
            "/../etc/passwd", "/Campaigns/..", "/Campaigns/../Pinned.bin", "/./Pinned.bin", "/Campaigns/.",
            "/%2e%2e/x", "/%2E%2E", "/%2e", "/a%2Fb", "/Campaigns%2Fa%20b.png", "/a%00b", "/%00",
            "/%zz", "/%4", "/abc%", "/%C3%28", "Pinned.bin", "", "../Pinned.bin",
        ]
        for target in bad {
            for method in ["GET", "PROPFIND"] {
                let r = await send(f.responder, method, target, ["depth": "0"])
                #expect(r.status == 400, "\(method) \(target)")
                expectLengthMatchesBody(r)
            }
        }
    }

    @Test func theQueryIsIgnoredAndSlashesAreForgiven() async throws {
        let f = try Fixture(); defer { f.remove() }
        let r = await send(f.responder, "GET", "/Streamed.mov?download=1&x=%2F..")
        #expect(r.status == 302)
        let listing = await send(f.responder, "PROPFIND", "/Campaigns/?foo=bar", ["depth": "1"])
        #expect(listing.status == 207)
        #expect(try #require(Multistatus.parse(listing)).count == 3)
        #expect(await send(f.responder, "GET", "//Campaigns//a%20b.png").status == 200)
        #expect(await send(f.responder, "GET", "/Campaigns/a b.png").status == 200, "a raw space still decodes")
        #expect(await send(f.responder, "GET", "http://127.0.0.1:8080/Pinned.bin?q").status == 200)
    }

    @Test func resolveDecodesEachSegment() {
        #expect(DAVResponder.resolve("/", under: []) == .path(""))
        #expect(DAVResponder.resolve("/Caf%C3%A9/a+b%20c", under: []) == .path("Café/a+b c"))
        #expect(DAVResponder.resolve("/d/x/y", under: ["d"]) == .path("x/y"))
        #expect(DAVResponder.resolve("/d", under: ["d"]) == .path(""))
        #expect(DAVResponder.resolve("/e/x", under: ["d"]) == .outside)
        #expect(DAVResponder.resolve("/", under: ["d"]) == .outside)
        #expect(DAVResponder.resolve("/d/%2F", under: ["d"]) == .invalid)
    }

    @Test func hrefPrefixIsAppliedToHrefsAndRequired() async throws {
        let f = try Fixture(prefix: "/drive.abc/"); defer { f.remove() }
        let r = await send(f.responder, "PROPFIND", "/drive.abc/Campaigns/", ["depth": "1"])
        #expect(r.status == 207)
        #expect(try #require(Multistatus.parse(r)).map(\.href) ==
                ["/drive.abc/Campaigns/", "/drive.abc/Campaigns/Caf%C3%A9%20%E2%98%95.txt", "/drive.abc/Campaigns/a%20b.png"])

        let root = await send(f.responder, "PROPFIND", "/drive.abc", ["depth": "0"])
        #expect(try #require(Multistatus.parse(root)).map(\.href) == ["/drive.abc/"])

        #expect(await send(f.responder, "GET", "/drive.abc/Streamed.mov").status == 302)
        #expect(await send(f.responder, "GET", "/drive%2Eabc/Streamed.mov").status == 302, "the prefix is compared decoded")
        #expect(await send(f.responder, "GET", "/Streamed.mov").status == 404, "outside the prefix")
        #expect(await send(f.responder, "PROPFIND", "/drive.xyz/", ["depth": "0"]).status == 404)
    }

    @Test func hrefEncodingKeepsOnlyUnreservedCharacters() {
        #expect(DAVResponder.percentEncode("aZ09-._~") == "aZ09-._~")
        #expect(DAVResponder.percentEncode("a b&c/d?e#f%g+h") == "a%20b%26c%2Fd%3Fe%23f%25g%2Bh")
        #expect(DAVResponder.percentEncode("é") == "%C3%A9")
        #expect(DAVResponder.percentEncode("☕") == "%E2%98%95")
        for name in ["a b.png", "Café ☕.txt", "Q&A <draft>.txt", "100%.txt", "日本語"] {
            #expect(DAVResponder.percentDecode(DAVResponder.percentEncode(name)) == name)
        }
    }

    // MARK: - Shapes

    @Test func httpDatesAreRFC1123InGMT() {
        #expect(DAVResponder.httpDate(Date(timeIntervalSince1970: 784_111_777)) == "Sun, 06 Nov 1994 08:49:37 GMT")
        #expect(DAVResponder.httpDate(Date(timeIntervalSince1970: 0)) == "Thu, 01 Jan 1970 00:00:00 GMT")
        #expect(DAVResponder.httpDate(Date(timeIntervalSince1970: 0.999)) == "Thu, 01 Jan 1970 00:00:00 GMT")
        #expect(DAVResponder.httpDate(Date(timeIntervalSince1970: -0.5)) == "Wed, 31 Dec 1969 23:59:59 GMT")
        #expect(DAVResponder.httpDate(Date(timeIntervalSince1970: 951_782_400)) == "Tue, 29 Feb 2000 00:00:00 GMT")
        #expect(DAVResponder.httpDate(Self.modified) == Self.modifiedHTTP)

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        for t in stride(from: -2_000_000_000, through: 4_000_000_000, by: 7_777_777) {
            let date = Date(timeIntervalSince1970: TimeInterval(t))
            #expect(DAVResponder.httpDate(date) == formatter.string(from: date))
        }
    }

    @Test func etagsAreQuotedAndCannotBreakOut() {
        #expect(DAVResponder.quotedETag("abc123") == #""abc123""#)
        #expect(DAVResponder.quotedETag("v7") == #""v7""#)
        #expect(DAVResponder.quotedETag(#"a"b c"#) == #""abc""#)
        #expect(DAVResponder.quotedETag("\"\"") == nil)
        #expect(DAVResponder.quotedETag(nil) == nil)
    }

    @Test func xmlEscapingDropsWhatXMLCannotCarry() {
        #expect(DAVResponder.xmlEscape("a & b < c > d \"e\" 'f'") == "a &amp; b &lt; c &gt; d \"e\" 'f'")
        #expect(DAVResponder.xmlEscape("bell\u{7}tab\t") == "belltab\t")
    }

    @Test func reasonPhrasesCoverWhatTheResponderSends() {
        for status in [200, 206, 207, 302, 400, 401, 403, 404, 405, 416, 503] {
            #expect(!DAVResponse.reasonPhrase(for: status).hasPrefix("Status"))
        }
    }
}

/// Reads a 207 body back the way a WebDAV client would: namespace-aware, with
/// entities decoded.
final class Multistatus: NSObject, XMLParserDelegate {
    struct Response {
        var href = ""
        var collection = false
        var status = ""
        var props: [String: String] = [:]
    }

    private var responses: [Response] = []
    private var current: Response?
    private var text = ""
    private var foreignNamespace = false

    static func parse(_ r: DAVResponse) -> [Response]? {
        guard case let .data(data) = r.body else { return nil }
        let delegate = Multistatus()
        let parser = XMLParser(data: data)
        parser.shouldProcessNamespaces = true
        parser.delegate = delegate
        guard parser.parse(), !delegate.foreignNamespace else { return nil }
        return delegate.responses
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
                qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        if namespaceURI != "DAV:" { foreignNamespace = true }
        text = ""
        switch elementName {
        case "response": current = Response()
        case "collection": current?.collection = true
        default: break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?,
                qualifiedName qName: String?) {
        switch elementName {
        case "response":
            if let current { responses.append(current) }
            current = nil
        case "href": current?.href = text
        case "status": current?.status = text
        case "displayname", "getlastmodified", "getcontentlength", "getetag", "getcontenttype":
            current?.props[elementName] = text
        default: break
        }
        text = ""
    }
}
