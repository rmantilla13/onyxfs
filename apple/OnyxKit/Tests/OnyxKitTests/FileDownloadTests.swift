import Testing
import Foundation
@testable import OnyxKit

/// Offline copies are written where they are going, as they arrive. What
/// matters is that the file holds exactly the body, that an error page never
/// passes for the file, and that a stop really stops.
struct FileDownloadTests {
    func tempFolder() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("FileDownloadTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func theBodyIsWrittenWhereItIsTold() async throws {
        let stub = DownloadStub.serve(status: 200, chunks: ["first ", "second ", "third"])
        let destination = try tempFolder().appendingPathComponent("file")
        try Data("older and longer than the new body".utf8).write(to: destination)
        try await FileDownload.fetch(stub.url, to: destination, session: DownloadStub.session)
        #expect(try String(contentsOf: destination, encoding: .utf8) == "first second third")
    }

    @Test func anErrorPageIsNotTheFile() async throws {
        let stub = DownloadStub.serve(status: 403, chunks: ["<Error>AccessDenied</Error>"])
        let destination = try tempFolder().appendingPathComponent("file")
        do {
            try await FileDownload.fetch(stub.url, to: destination, session: DownloadStub.session)
            Issue.record("a 403 was taken for the file")
        } catch let OnyxError.http(status, _) {
            #expect(status == 403)
        }
        #expect(PinStore.fileSize(at: destination) ?? 0 == 0, "none of the error page written")
    }

    @Test func aMissingFolderFailsBeforeAnythingIsAsked() async throws {
        // The cache's disk unplugged: nothing is fetched only to be lost.
        let stub = DownloadStub.serve(status: 200, chunks: ["body"])
        let destination = try tempFolder().appendingPathComponent("gone/file")
        await #expect(throws: (any Error).self) {
            try await FileDownload.fetch(stub.url, to: destination, session: DownloadStub.session)
        }
        #expect(stub.requests == 0)
    }

    @Test func cancellingStopsTheTransfer() async throws {
        let stub = DownloadStub.serve(status: 200, chunks: ["the start"], hang: true)
        let destination = try tempFolder().appendingPathComponent("file")
        let fetch = Task { try await FileDownload.fetch(stub.url, to: destination, session: DownloadStub.session) }
        for _ in 0..<1000 where stub.requests == 0 { try await Task.sleep(nanoseconds: 2_000_000) }
        fetch.cancel()
        await #expect(throws: (any Error).self) { try await fetch.value }
    }
}

/// Canned answers at a host per test, so tests running in parallel never
/// see each other's.
private final class DownloadStub: URLProtocol, @unchecked Sendable {
    struct Answer {
        let status: Int
        let chunks: [String]
        let hang: Bool
    }

    final class Handle: @unchecked Sendable {
        let url: URL
        init(url: URL) { self.url = url }
        var requests: Int { DownloadStub.lock.withLock { DownloadStub.started[url.host ?? ""] ?? 0 } }
    }

    static let lock = NSLock()
    nonisolated(unsafe) static var answers: [String: Answer] = [:]
    nonisolated(unsafe) static var started: [String: Int] = [:]

    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DownloadStub.self]
        return URLSession(configuration: configuration)
    }()

    static func serve(status: Int, chunks: [String], hang: Bool = false) -> Handle {
        let host = "\(UUID().uuidString.lowercased()).download.test"
        lock.withLock { answers[host] = Answer(status: status, chunks: chunks, hang: hang) }
        return Handle(url: URL(string: "https://\(host)/file")!)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".download.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host else { return }
        let answer = Self.lock.withLock { () -> Answer? in
            Self.started[host, default: 0] += 1
            return Self.answers[host]
        }
        guard let answer else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in answer.chunks { client?.urlProtocol(self, didLoad: Data(chunk.utf8)) }
        if answer.hang { return }
        client?.urlProtocolDidFinishLoading(self)
    }
}
