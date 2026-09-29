import Testing
import Foundation
import os
@testable import OnyxKit

/// A server for one test, at a host of its own: what it was asked, and the
/// answers the test chose.
private final class ThumbStub: @unchecked Sendable {
    struct Request {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data?
        var json: [String: Any]? { body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }
    }

    let api: OnyxAPI
    let session: URLSession
    let host = "\(UUID().uuidString.lowercased()).thumbs.test"
    private let tokens = TokenStore(service: "io.onyxfs.tests.thumbs.\(UUID().uuidString)", accessGroup: nil)
    private let answer: (Request) -> (Int, String)
    private let lock = NSLock()
    private var received: [Request] = []

    var requests: [Request] { lock.withLock { received } }

    init(_ answer: @escaping (Request) -> (Int, String)) throws {
        self.answer = answer
        try tokens.set("test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ThumbStubProtocol.self]
        session = URLSession(configuration: configuration)
        api = OnyxAPI(config: OnyxConfig(baseURL: URL(string: "https://\(host)")!), tokens: tokens, session: session)
        Self.stubs.withLock { $0[host] = self }
    }

    func tearDown() {
        tokens.clear()
        Self.stubs.withLock { $0[host] = nil }
    }

    static let stubs = OSAllocatedUnfairLock<[String: ThumbStub]>(initialState: [:])

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
        let seen = Request(method: request.httpMethod ?? "GET",
                           path: URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path,
                           headers: request.allHTTPHeaderFields ?? [:], body: body)
        lock.withLock { received.append(seen) }
        let (status, text) = answer(seen)
        return (status, Data(text.utf8))
    }
}

private final class ThumbStubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".thumbs.test") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host, let stub = ThumbStub.stubs.withLock({ $0[host] }) else {
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

private let fileJSON = """
{"id":"f1","name":"GX010042.MP4","folder":"Day 1","kind":"video","mime":"video/mp4","size":752678765,
 "url":"https://s3.test/team/GX010042.MP4?X-Amz-Signature=x","storage":"s3","storageKey":"team/Day 1/GX010042.MP4",
 "tags":[],"notes":null,"visibility":"org","caption":null,"thumbnailUrl":null,"thumbnailKey":null,"posterKey":null,
 "thumbSizes":[],"version":3,"contentHash":"abc","metadata":{"width":3840,"height":2160,"duration":60},
 "createdBy":"me@example.com","createdAt":1790460000000,"updatedAt":1790460000000,"deletedAt":null,"seq":42}
"""

/// The requests the worker makes of the server, as the web's routes take
/// them (app/api/files/[id]/thumbnail, app/api/files/presign).
struct ThumbnailAPITests {
    @Test func mayItOnlyA204IsYes() async throws {
        let answers = OSAllocatedUnfairLock(initialState: [(204, ""), (403, #"{"error":"No access"}"#),
                                                           (404, #"{"error":"Not found"}"#), (200, "<!DOCTYPE html>"),
                                                           (401, #"{"error":"Invalid or expired token"}"#)])
        let stub = try ThumbStub { _ in answers.withLock { $0.removeFirst() } }
        defer { stub.tearDown() }
        #expect(try await stub.api.mayRecordThumbnail(fileId: "f1") == true)
        #expect(try await stub.api.mayRecordThumbnail(fileId: "f1") == false)
        #expect(try await stub.api.mayRecordThumbnail(fileId: "f1") == false)
        do {
            _ = try await stub.api.mayRecordThumbnail(fileId: "f1")
            Issue.record("a sign-in page is not a yes")
        } catch let OnyxError.http(status, _) {
            #expect(status == 501)
        }
        await #expect(throws: OnyxError.self) { try await stub.api.mayRecordThumbnail(fileId: "f1") }
        let asked = stub.requests[0]
        #expect(asked.method == "GET" && asked.path == "/api/files/f1/thumbnail")
        #expect(asked.headers["Authorization"] == "Bearer test-token")
    }

    @Test func aFilesDetailSaysWhereItIsAndWhetherItMayChange() async throws {
        let stub = try ThumbStub { _ in (200, #"{"file":\#(fileJSON),"canWrite":true}"#) }
        defer { stub.tearDown() }
        let detail = try await stub.api.fileDetail(id: "f1")
        #expect(detail.storage == "s3" && detail.canWrite == true)
        #expect(detail.file.version == 3 && detail.file.size == 752_678_765)
        #expect(detail.file.metadata == FileMetadata(width: 3840, height: 2160, duration: 60))
        #expect(stub.requests.map(\.path) == ["/api/files/f1"])
        // An id is one path component, whatever it holds.
        _ = try? await stub.api.fileDetail(id: "a b/c")
        #expect(stub.requests.last?.path == "/api/files/a%20b%2Fc")
    }

    @Test func thePresignRouteIsAskedForPreviewsNeverAFile() async throws {
        let stub = try ThumbStub { request in
            if request.json?["poster"] as? Bool == true {
                return (200, #"{"putUrl":"https://s3.test/p?sig","key":"_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.poster.jpg","cacheControl":"private, max-age=31536000, immutable"}"#)
            }
            return (200, #"""
            {"putUrl":"https://s3.test/g?sig","publicUrl":"https://s3.test/g","name":"x.jpg",
             "key":"_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg","cacheControl":"private, max-age=31536000, immutable",
             "siblings":{"sm":{"putUrl":"https://s3.test/sm?sig","key":"_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.sm.jpg"},
                         "xs":{"putUrl":"https://s3.test/xs?sig","key":"_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.xs.jpg"}}}
            """#)
        }
        defer { stub.tearDown() }
        let grid = try await stub.api.presignThumbnail(contentType: "image/jpeg", sizes: ["sm", "xs"])
        #expect(grid.key == "_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg")
        #expect(grid.siblings?["xs"]?.key == "_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.xs.jpg")
        #expect(grid.cacheControl == "private, max-age=31536000, immutable")
        let poster = try await stub.api.presignPoster(contentType: "image/jpeg")
        #expect(poster.key.hasSuffix(".poster.jpg") && poster.siblings == nil)
        let asked = stub.requests.compactMap(\.json)
        #expect(stub.requests.allSatisfy { $0.method == "POST" && $0.path == "/api/files/presign" })
        #expect(asked[0]["thumb"] as? Bool == true && asked[0]["sizes"] as? [String] == ["sm", "xs"])
        #expect(asked[0]["contentType"] as? String == "image/jpeg")
        #expect(asked[1]["poster"] as? Bool == true && asked[1]["thumb"] == nil)
        #expect(asked.allSatisfy { $0["filename"] == nil && $0["size"] == nil }, "never a file")
    }

    @Test func theKeysAreRecordedWithTheMediaFactsAndThePlaceholder() async throws {
        let stub = try ThumbStub { _ in (200, #"{"file":\#(fileJSON)}"#) }
        defer { stub.tearDown() }
        let placeholder = try #require(Placeholder(dataURL: "data:image/jpeg;base64,/9j/4AAQSkZJRg=="))
        let file = try await stub.api.recordThumbnail(fileId: "f1", thumbnailKey: "_thumbs/a.jpg", posterKey: "_thumbs/a.poster.jpg",
                                                      thumbSizes: ["sm", "xs"],
                                                      media: MediaFacts(width: 3840, height: 2160, duration: 60.02),
                                                      placeholder: placeholder)
        #expect(file.id == "f1")
        let asked = try #require(stub.requests.first)
        #expect(asked.method == "PUT" && asked.path == "/api/files/f1/thumbnail")
        let body = try #require(asked.json)
        #expect(body["thumbnailKey"] as? String == "_thumbs/a.jpg" && body["posterKey"] as? String == "_thumbs/a.poster.jpg")
        #expect(body["thumbSizes"] as? [String] == ["sm", "xs"])
        let media = try #require(body["media"] as? [String: Any])
        #expect(media["width"] as? Int == 3840 && media["height"] as? Int == 2160 && media["duration"] as? Double == 60.02)
        // The placeholder as the route reads it (body.placeholder): the data URL.
        #expect(body["placeholder"] as? String == "data:image/jpeg;base64,/9j/4AAQSkZJRg==")
        // No poster and no placeholder: the keys are left out, not sent as null.
        _ = try await stub.api.recordThumbnail(fileId: "f1", thumbnailKey: "_thumbs/b.jpg", posterKey: nil, thumbSizes: [],
                                               media: MediaFacts(width: 640, height: 360, duration: nil))
        let second = try #require(stub.requests.last?.json)
        #expect(second["posterKey"] == nil && (second["media"] as? [String: Any])?["duration"] == nil)
        #expect(second["placeholder"] == nil)
    }

    @Test func picturesGoToStorageWithTheHeadersItKeeps() async throws {
        let status = OSAllocatedUnfairLock(initialState: 200)
        let stub = try ThumbStub { _ in (status.withLock { $0 }, "") }
        defer { stub.tearDown() }
        let server = APIThumbnailServer(api: stub.api, session: stub.session)
        let target = URL(string: "https://\(stub.host)/_thumbs/g.jpg?X-Amz-Signature=x")!
        try await server.put(Data(repeating: 1, count: 300), to: target, contentType: "image/jpeg",
                             cacheControl: "private, max-age=31536000, immutable")
        let put = try #require(stub.requests.first)
        #expect(put.method == "PUT" && put.path == "/_thumbs/g.jpg")
        #expect(put.headers["Content-Type"] == "image/jpeg")
        #expect(put.headers["Cache-Control"] == "private, max-age=31536000, immutable")
        #expect(put.headers["Authorization"] == nil, "the device's token never goes to storage")
        #expect(put.body?.count == 300)
        // An expired link: storage's 403 is a failure to try again, not a refusal.
        status.withLock { $0 = 403 }
        do {
            try await server.put(Data([1]), to: target, contentType: "image/jpeg", cacheControl: nil)
            Issue.record("storage refused it")
        } catch let OnyxError.http(code, _) {
            #expect(code == 503)
        }
    }
}
