import Testing
import Foundation
import os
@testable import OnyxKit

/// Captions a person can read, and nothing the server would refuse: the
/// segmenter's promises, checked against words laid out the way the two
/// recognizers deliver them.
struct TranscriptSegmenterTests {
    /// Words spoken evenly from `from`, `pace` seconds apiece.
    func spoken(_ sentence: String, from: Double = 0, pace: Double = 0.3) -> [TranscriptSegmenter.Word] {
        sentence.split(separator: " ").enumerated().map { i, w in
            let start = from + Double(i) * pace
            return .init((i == 0 ? "" : " ") + w, start: start, end: start + pace * 0.8)
        }
    }

    @Test func aSentenceEndEndsTheCaption() {
        let words = spoken("Hello there. How are you? Fine!")
        let out = TranscriptSegmenter.segments(from: words)
        #expect(out.map(\.text) == ["Hello there.", "How are you?", "Fine!"])
        #expect(out[0].start == 0)
        #expect(out[1].start == 0.6)
    }

    @Test func aClosingQuoteDoesNotHideTheFullStop() {
        let out = TranscriptSegmenter.segments(from: spoken("He said \"stop.\" Then left."))
        #expect(out.map(\.text) == ["He said \"stop.\"", "Then left."])
    }

    @Test func aTitleIsNotASentenceEnd() {
        let out = TranscriptSegmenter.segments(from: spoken("Ask Dr. Smith today."))
        #expect(out.map(\.text) == ["Ask Dr. Smith today."])
    }

    @Test func noCaptionIsTooLongToRead() {
        // Two minutes of speech with no punctuation at all.
        let text = (0..<400).map { "word\($0 % 7 == 0 ? "ing" : "")" }.joined(separator: " ")
        let out = TranscriptSegmenter.segments(from: spoken(text))
        #expect(out.count > 10)
        for s in out {
            #expect(s.end - s.start <= 7.001)
            #expect(s.text.count <= 84)
        }
        // Every word is still there, once, in order.
        #expect(out.map(\.text).joined(separator: " ") == text)
    }

    @Test func slowSpeechIsCutByTimeNotLength() {
        let out = TranscriptSegmenter.segments(from: spoken("one two three four five six seven eight nine ten", pace: 1.2))
        #expect(out.allSatisfy { $0.end - $0.start <= 7 })
        #expect(out.count == 2)
    }

    @Test func aLongPauseEndsTheCaption() {
        let words = spoken("before the pause") + spoken("after it", from: 10)
        #expect(TranscriptSegmenter.segments(from: words).map(\.text) == ["before the pause", "after it"])
    }

    @Test func aCommaBreaksOnlyAFullCaption() {
        let short = TranscriptSegmenter.segments(from: spoken("Well, yes."))
        #expect(short.map(\.text) == ["Well, yes."])
        let long = TranscriptSegmenter.segments(from: spoken(
            "When the rain finally stopped over the hills near town, we walked home slowly."))
        #expect(long.map(\.text) == ["When the rain finally stopped over the hills near town,", "we walked home slowly."])
    }

    @Test func neverAnEmptyCaption() {
        #expect(TranscriptSegmenter.segments(from: []).isEmpty)
        let words: [TranscriptSegmenter.Word] = [
            .init("  ", start: 0, end: 1), .init("\n", start: 1, end: 2), .init(" hi", start: 2, end: 2.5),
            .init(" ", start: 3, end: 3.2), .init("there", start: .nan, end: 4),
        ]
        let out = TranscriptSegmenter.segments(from: words)
        #expect(out == [TranscriptSegment(start: 2, end: 2.5, text: "hi")])
    }

    @Test func punctuationAloneJoinsTheCaptionBefore() {
        let words: [TranscriptSegmenter.Word] = [
            .init("It", start: 0, end: 0.2), .init(" ended", start: 0.2, end: 0.5), .init(".", start: 0.5, end: 0.5),
            .init(" Then", start: 0.6, end: 0.8), .init(" more", start: 0.8, end: 1),
        ]
        #expect(TranscriptSegmenter.segments(from: words).map(\.text) == ["It ended.", "Then more"])
    }

    @Test func timesAreThreeDecimalsAndNeverGoBack() {
        // Recognizers overlap words a little, and occasionally step back.
        let words: [TranscriptSegmenter.Word] = [
            .init("First.", start: 0.12345, end: 1.00049),
            .init(" Second.", start: 0.9, end: 0.95),
            .init(" Third", start: -1, end: 2.3333333),
        ]
        let out = TranscriptSegmenter.segments(from: words)
        #expect(out.map(\.text) == ["First.", "Second.", "Third"])
        #expect(out[0].start == 0.123 && out[0].end == 1)
        for (a, b) in zip(out, out.dropFirst()) { #expect(b.start >= a.end) }
        for s in out {
            #expect(s.end >= s.start && s.start >= 0)
            #expect((s.start * 1000).rounded() / 1000 == s.start)
            #expect((s.end * 1000).rounded() / 1000 == s.end)
        }
    }

    @Test func languagesWithoutSpacesStayWithout() {
        let words: [TranscriptSegmenter.Word] = [
            .init("今日は", start: 0, end: 0.5), .init("晴れ", start: 0.5, end: 0.9), .init("です。", start: 0.9, end: 1.2),
        ]
        #expect(TranscriptSegmenter.segments(from: words).map(\.text) == ["今日は晴れです。"])
    }

    @Test func runsBecomeWordsWithTheirSpacesAndPunctuation() {
        // SpeechAnalyzer's shape: timed words, untimed spaces and marks.
        let runs: [TranscriptSegmenter.Run] = [
            .init("Hello", start: 0, end: 0.4), .init(", "), .init("world", start: 0.5, end: 0.9), .init(". "),
            .init("Again", start: 1, end: 1.3), .init("!"),
        ]
        let words = TranscriptSegmenter.words(from: runs)
        #expect(words.map(\.text) == ["Hello,", " world.", " Again!"])
        #expect(words.map(\.start) == [0, 0.5, 1])
        #expect(TranscriptSegmenter.segments(from: words).map(\.text) == ["Hello, world.", "Again!"])
    }

    @Test func runsThatCarryTheirOwnSpace() {
        let runs: [TranscriptSegmenter.Run] = [
            .init(" Leading", start: 0, end: 0.4), .init(" and", start: 0.4, end: 0.6), .init(" timed.", start: 0.6, end: 1),
        ]
        #expect(TranscriptSegmenter.segments(from: TranscriptSegmenter.words(from: runs)).map(\.text) == ["Leading and timed."])
    }
}

struct SpeechLocaleTests {
    let supported = ["en-AU", "en-GB", "en-US", "de-AT", "de-CH", "de-DE", "fr-CA", "fr-FR", "pt-BR", "pt-PT", "zh-CN", "zh-TW", "es-419", "es-ES"]

    @Test func theSameTagWhateverItsSpelling() {
        #expect(SpeechLocale.match("en-GB", among: supported) == "en-GB")
        #expect(SpeechLocale.match("pt_pt", among: supported) == "pt-PT")
        #expect(SpeechLocale.match("zh-Hant-TW", among: supported) == "zh-TW")
        #expect(SpeechLocale.match("es-419", among: supported) == "es-419")
        #expect(SpeechLocale.match("en_GB@rg=uszzzz", among: supported) == "en-GB")
    }

    @Test func aLanguageAloneGoesToItsHomeRegion() {
        #expect(SpeechLocale.match("en", among: supported) == "en-US")
        #expect(SpeechLocale.match("de", among: supported) == "de-DE")
        #expect(SpeechLocale.match("fr", among: supported) == "fr-FR")
        #expect(SpeechLocale.match("pt", among: supported) == "pt-BR")
    }

    @Test func theMacsRegionComesBeforeTheHomeRegion() {
        #expect(SpeechLocale.match("en", among: supported, preferredRegion: "au") == "en-AU")
        #expect(SpeechLocale.match("de", among: supported, preferredRegion: "CH") == "de-CH")
    }

    @Test func aRegionWithNoRecognizerStillGetsTheLanguage() {
        // English, set in Spain.
        #expect(SpeechLocale.match("en-ES", among: supported, preferredRegion: "ES") == "en-US")
        #expect(SpeechLocale.match("de-u-rg-gbzzzz", among: supported) == "de-DE")
    }

    @Test func anotherLanguageIsNoMatch() {
        #expect(SpeechLocale.match("nl-NL", among: supported) == nil)
        #expect(SpeechLocale.match("", among: supported) == nil)
    }
}

struct TranscriptWireTests {
    @Test func segmentsAreShortOnTheWire() throws {
        let data = try JSONEncoder().encode(TranscriptSegment(start: 12.48, end: 15.9, text: "And that's the whole point."))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(object.keys) == ["s", "e", "t"])
        #expect(object["s"] as? Double == 12.48)
        let back = try JSONDecoder().decode(TranscriptSegment.self, from: data)
        #expect(back.text == "And that's the whole point.")
    }

    @Test func aClaimAsTheContractShowsIt() throws {
        let json = """
        { "fileId": "f1", "name": "Interview.mov", "mime": "video/quicktime", "size": 123, "language": null,
          "sourceKey": "drive/Interview.mov", "downloadUrl": "https://s3.example.com/b/Interview.mov?X-Amz-Signature=abc",
          "leaseSeconds": 600 }
        """
        let claim = try JSONDecoder().decode(TranscriptionClaim.self, from: Data(json.utf8))
        #expect(claim.fileId == "f1" && claim.size == 123 && claim.language == nil && claim.leaseSeconds == 600)
        #expect(claim.downloadUrl.host == "s3.example.com")
    }

    @Test func aQueueWhoseSizesArriveAsStrings() throws {
        // A Postgres BIGINT the route did not convert.
        let json = #"{ "jobs": [ { "fileId": "a", "name": "A.mp4", "mime": null, "size": "9876543210", "language": "en-US", "requestedAt": "2026-09-26T10:00:00Z" } ] }"#
        struct Wrapper: Decodable { let jobs: [TranscriptionJob] }
        let jobs = try JSONDecoder().decode(Wrapper.self, from: Data(json.utf8)).jobs
        #expect(jobs.first?.size == 9_876_543_210)
        #expect(jobs.first?.language == "en-US")
    }

    @Test func conflictsAreToldApartByCode() {
        func body(_ code: String) -> Data { Data(#"{ "error": "No.", "code": "\#(code)" }"#.utf8) }
        #expect(TranscriptionConflict.from(status: 409, data: body("lost")) == .lost)
        #expect(TranscriptionConflict.from(status: 409, data: body("taken")) == .taken)
        #expect(TranscriptionConflict.from(status: 409, data: body("other")) == nil)
        #expect(TranscriptionConflict.from(status: 403, data: body("lost")) == nil)
        #expect(TranscriptionConflict.from(status: 409, data: Data("<html>".utf8)) == nil)
    }

    @Test func theSubmissionBody() throws {
        let body = TranscriptSubmission(segments: [.init(start: 0, end: 2.1, text: "Hi.")], resultLanguage: "en-US",
                                        engine: "apple-speechanalyzer", sourceKey: "k")
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(Set(object.keys) == ["segments", "resultLanguage", "engine", "sourceKey"])
    }
}

/// The transcript calls as the server sees them: method, path, body, and how
/// its answers come back — above all, which 409 is which.
@Suite(.serialized)
struct TranscriptAPITests {
    @Test func theQueueAndAClaim() async throws {
        let stub = try TranscriptStub { request in
            switch (request.method, request.path) {
            case ("GET", "/api/transcripts/queue"):
                return (200, #"{ "jobs": [ { "fileId": "f 1", "name": "A.mov", "mime": "video/quicktime", "size": 10, "language": null, "requestedAt": "2026-09-26T10:00:00Z" } ] }"#)
            case ("POST", "/api/files/f%201/transcript/claim"):
                return (200, #"{ "fileId": "f 1", "name": "A.mov", "mime": "video/quicktime", "size": 10, "language": null, "sourceKey": "k", "downloadUrl": "https://s3.test/A.mov", "leaseSeconds": 600 }"#)
            default:
                return (404, #"{ "error": "Not found" }"#)
            }
        }
        defer { stub.tearDown() }
        let jobs = try await stub.api.transcriptionQueue()
        #expect(jobs.map(\.fileId) == ["f 1"])
        let claim = try await stub.api.claimTranscription(fileId: "f 1", device: String(repeating: "M", count: 120))
        #expect(claim.sourceKey == "k" && claim.downloadUrl.absoluteString == "https://s3.test/A.mov")
        let sent = try #require(stub.requests.last)
        #expect(sent.authorization == "Bearer test-token")
        #expect((sent.json?["device"] as? String)?.count == 80)
        // An id is one path component, escaped once.
        try? await stub.api.reportTranscriptionProgress(fileId: "a/b", progress: 0)
        #expect(stub.requests.last?.path == "/api/files/a%2Fb/transcript")
    }

    @Test func takenAndLostAreTheirOwnErrors() async throws {
        let stub = try TranscriptStub { request in
            request.method == "POST"
                ? (409, #"{ "error": "Another Mac has it.", "code": "taken" }"#)
                : (409, #"{ "error": "Not yours.", "code": "lost" }"#)
        }
        defer { stub.tearDown() }
        await #expect(throws: TranscriptionConflict.taken) {
            _ = try await stub.api.claimTranscription(fileId: "f", device: "Mac")
        }
        await #expect(throws: TranscriptionConflict.lost) {
            try await stub.api.reportTranscriptionProgress(fileId: "f", progress: 0.5)
        }
        await #expect(throws: TranscriptionConflict.lost) {
            try await stub.api.submitTranscript(fileId: "f", .init(segments: [], resultLanguage: "en-US", engine: "apple-sfspeech", sourceKey: nil))
        }
    }

    @Test func anyOtherRefusalIsAnHTTPError() async throws {
        let stub = try TranscriptStub { _ in (404, #"{ "error": "No such job." }"#) }
        defer { stub.tearDown() }
        do {
            _ = try await stub.api.claimTranscription(fileId: "f", device: "Mac")
            Issue.record("a 404 was taken for a claim")
        } catch let OnyxError.http(status, message) {
            #expect(status == 404 && message == "No such job.")
        }
    }

    @Test func progressFailureAndResultBodies() async throws {
        let stub = try TranscriptStub { _ in (200, #"{ "transcript": null, "canRequest": true, "canDelete": true }"#) }
        defer { stub.tearDown() }
        try await stub.api.reportTranscriptionProgress(fileId: "f", progress: 0.123456)
        try await stub.api.reportTranscriptionProgress(fileId: "f", progress: 7)
        try await stub.api.reportTranscriptionFailure(fileId: "f", message: String(repeating: "x", count: 900))
        try await stub.api.submitTranscript(fileId: "f", .init(segments: [.init(start: 0, end: 1.5, text: "Hi.")],
                                                               resultLanguage: "en-US", engine: "apple-speechanalyzer", sourceKey: "k"))
        let r = stub.requests
        #expect(r.map(\.method) == ["PATCH", "PATCH", "PATCH", "PUT"])
        #expect(r.allSatisfy { $0.path == "/api/files/f/transcript" })
        #expect(r[0].json?["progress"] as? Double == 0.123)
        #expect(r[1].json?["progress"] as? Double == 1)
        #expect(r[2].json?["status"] as? String == "failed")
        #expect((r[2].json?["error"] as? String)?.count == 500)
        let segments = r[3].json?["segments"] as? [[String: Any]]
        #expect(segments?.first?["t"] as? String == "Hi.")
        #expect(r[3].json?["sourceKey"] as? String == "k")
    }
}

/// A server for one test, at a host of its own, answering from a closure and
/// keeping what it was sent. Signed in with a throwaway token under a
/// keychain service of its own, removed again when the test ends.
private final class TranscriptStub: @unchecked Sendable {
    struct Request {
        let method: String
        let path: String
        let authorization: String?
        let json: [String: Any]?
    }

    let api: OnyxAPI
    private let host = "\(UUID().uuidString.lowercased()).transcripts.test"
    private let tokens = TokenStore(service: "io.onyxfs.tests.transcripts.\(UUID().uuidString)", accessGroup: nil)
    private let answer: (Request) -> (Int, String)
    private let lock = NSLock()
    private var received: [Request] = []

    var requests: [Request] { lock.withLock { received } }

    init(_ answer: @escaping (Request) -> (Int, String)) throws {
        self.answer = answer
        try tokens.set("test-token")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TranscriptStubProtocol.self]
        api = OnyxAPI(config: OnyxConfig(baseURL: URL(string: "https://\(host)")!), tokens: tokens,
                      session: URLSession(configuration: configuration))
        Self.stubs.withLock { $0[host] = self }
    }

    func tearDown() {
        tokens.clear()
        Self.stubs.withLock { $0[host] = nil }
    }

    static let stubs = OSAllocatedUnfairLock<[String: TranscriptStub]>(initialState: [:])

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
                           authorization: request.value(forHTTPHeaderField: "Authorization"),
                           json: body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        lock.withLock { received.append(seen) }
        let (status, text) = answer(seen)
        return (status, Data(text.utf8))
    }
}

private final class TranscriptStubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".transcripts.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host,
              let stub = TranscriptStub.stubs.withLock({ $0[host] }) else {
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
