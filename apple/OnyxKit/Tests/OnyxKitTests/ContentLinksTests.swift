import Foundation
import Testing
@testable import OnyxKit

/// Links to play from, kept while they work (ContentLinks): what a link says
/// of its own expiry, when one kept is used and when it is asked for again,
/// and that one request serves every page that wants it.
@Suite struct ContentLinksTests {
    /// 2026-09-29 10:00:00 UTC.
    static let signed = Date(timeIntervalSince1970: 1_790_676_000)

    /// A link signed at `at` for `seconds`, as lib/storage.js signs one.
    static func presigned(_ key: String, at: Date = signed, seconds: Int = 25_200) -> URL {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(identifier: "UTC")
        format.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return URL(string: "https://bucket.s3.us-east-2.amazonaws.com/\(key)?X-Amz-Algorithm=AWS4-HMAC-SHA256"
                   + "&X-Amz-Credential=AKIA%2F20260929%2Fus-east-2%2Fs3%2Faws4_request&X-Amz-Date=\(format.string(from: at))"
                   + "&X-Amz-Expires=\(seconds)&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123")!
    }

    static func answer(_ id: String, proxy: Bool = false, at: Date = signed) -> ContentLink {
        ContentLink(id: id, url: presigned("files/\(id).mov", at: at), expiresAt: nil, version: 1, contentHash: nil,
                    proxyUrl: proxy ? presigned("_proxies/\(id).mp4", at: at) : nil)
    }

    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var time: Date
        init(_ start: Date) { time = start }
        var now: Date {
            get { lock.withLock { time } }
            set { lock.withLock { time = newValue } }
        }
    }

    /// Counts the server's answers, and can hold them until let go.
    actor Server {
        private(set) var asked = 0
        private var held = false
        private var waiting: [CheckedContinuation<Void, Never>] = []
        var failure: Error?

        func hold() { held = true }
        func release() {
            held = false
            waiting.forEach { $0.resume() }
            waiting = []
        }
        var holding: Int { waiting.count }
        func fail(with error: Error?) { failure = error }

        func contentLink(_ id: String, proxy: Bool = false, at: Date) async throws -> ContentLink {
            asked += 1
            if held { await withCheckedContinuation { waiting.append($0) } }
            if let failure { throw failure }
            return ContentLinksTests.answer(id, proxy: proxy, at: at)
        }
    }

    // MARK: - What a link says

    @Test func aPresignedLinkSaysWhenItStopsWorking() {
        #expect(ContentLinks.expiry(of: Self.presigned("a.mov")) == Self.signed.addingTimeInterval(25_200))
        #expect(ContentLinks.amzDate("20260929T100000Z") == Self.signed)
        // Not presigned (a public bucket behind a CDN): it does not expire.
        #expect(ContentLinks.expiry(of: URL(string: "https://cdn.example.com/files/a.mov")!) == nil)
        // Presigned, but saying when unreadably: taken to have expired.
        let odd = URL(string: "https://s3.test/a.mov?X-Amz-Date=yesterday&X-Amz-Expires=3600&X-Amz-Signature=x")!
        #expect(ContentLinks.expiry(of: odd) == .distantPast)
        #expect(ContentLinks.amzDate("20261329T100000Z") == nil, "no thirteenth month")
        #expect(ContentLinks.amzDate("2026-09-29T10:00:00Z") == nil)
    }

    @Test func theServersAnswerWorksUntilItsFirstLinkStops() {
        let proxy = Self.presigned("_proxies/a.mp4", at: Self.signed.addingTimeInterval(-3600))
        let answer = ContentLink(id: "a", url: Self.presigned("files/a.mov"), expiresAt: nil, version: 1, contentHash: nil,
                                 proxyUrl: proxy)
        let link = ContentLinks.link(from: answer, now: Self.signed)
        #expect(link.expires == Self.signed.addingTimeInterval(25_200 - 3600), "the copy's, signed an hour before")
        #expect(link.playable == proxy, "the streamable copy is what plays")
        let said = ContentLink(id: "a", url: URL(string: "https://cdn.example.com/a.mov")!,
                               expiresAt: EpochMillis(Int64(Self.signed.timeIntervalSince1970 * 1000) + 60_000),
                               version: 1, contentHash: nil, proxyUrl: nil)
        #expect(ContentLinks.link(from: said, now: Self.signed).expires == Self.signed.addingTimeInterval(60))
    }

    @Test func theListingsOwnLinkPlaysWhileItHasTimeEnough() {
        let listed = Self.presigned("files/song.m4a").absoluteString
        let late = Self.signed.addingTimeInterval(6 * 3600)          // an hour left
        let needed = ContentLinks.needed(toPlay: 240)                 // four minutes, and half an hour
        #expect(ContentLinks.listed(listed, needed: needed, now: late)?.url.absoluteString == listed)
        #expect(ContentLinks.listed(listed, needed: ContentLinks.needed(toPlay: 3 * 3600), now: late) == nil,
                "not enough left to play three hours through")
        #expect(ContentLinks.listed(nil, needed: needed) == nil)
        #expect(ContentLinks.listed("files/song.m4a", needed: needed) == nil, "a key, not a link")
        #expect(ContentLinks.listed("https://cdn.example.com/song.m4a", needed: needed)?.expires == .distantFuture)
    }

    @Test func aLinkMustLastThePlayThroughAndHalfAnHourMore() {
        #expect(ContentLinks.needed(toPlay: nil) == 1800)
        #expect(ContentLinks.needed(toPlay: 600) == 2400)
        #expect(ContentLinks.needed(toPlay: .nan) == 1800)
        #expect(ContentLinks.needed(toPlay: -5) == 1800)
    }

    // MARK: - Keeping them

    @Test func aLinkIsKeptForItsFileAtItsVersionWhileItHasTimeLeft() async throws {
        let clock = Clock(Self.signed)
        let links = ContentLinks(now: { clock.now })
        let server = Server()
        let needed = ContentLinks.needed(toPlay: 60)
        func play(_ id: String, version: Int = 1) async throws -> ContentLinks.Link {
            try await links.link(id, version: version, needed: needed, copyExpected: false) {
                try await server.contentLink(id, at: clock.now)
            }
        }
        let first = try await play("a")
        #expect(try await play("a") == first)
        #expect(await server.asked == 1, "asked once")
        #expect(await links.kept("a", version: 1, needed: needed) == first)

        // Another version of the file (new contents), or another file: asked.
        _ = try await play("a", version: 2)
        _ = try await play("b")
        #expect(await server.asked == 3)

        // Hours later, with less left than playing it needs: asked again.
        clock.now = Self.signed.addingTimeInterval(25_200 - needed + 1)
        #expect(await links.kept("a", version: 1, needed: needed) == nil)
        _ = try await play("a")
        #expect(await server.asked == 4)

        // Refused by storage: forgotten, every version, and asked again.
        await links.forget("a")
        #expect(await links.kept("a", version: 1, needed: needed) == nil)
        #expect(await links.kept("a", version: 2, needed: 60) == nil)
        #expect(await links.kept("b", version: 1, needed: 60) != nil, "another file's stays")
        _ = try await play("a")
        #expect(await server.asked == 5)
    }

    @Test func aLargeVideosLinkWithNoStreamableCopyIsKeptMinutes() async throws {
        // A copy may be on its way (the page asks for one): once it is there,
        // it is what should play, so the server is asked again soon.
        let clock = Clock(Self.signed)
        let links = ContentLinks(now: { clock.now })
        let server = Server()
        let needed = ContentLinks.needed(toPlay: 60)
        func play(_ id: String, proxy: Bool) async throws -> ContentLinks.Link {
            try await links.link(id, version: 1, needed: needed, copyExpected: true) {
                try await server.contentLink(id, proxy: proxy, at: clock.now)
            }
        }
        #expect(try await play("master", proxy: false).proxyUrl == nil)
        #expect(try await play("streamable", proxy: true).proxyUrl != nil)
        clock.now = Self.signed.addingTimeInterval(ContentLinks.withoutCopy - 1)
        #expect(await links.kept("master", version: 1, needed: needed) != nil)
        clock.now = Self.signed.addingTimeInterval(ContentLinks.withoutCopy)
        #expect(await links.kept("master", version: 1, needed: needed) == nil)
        #expect(await links.kept("streamable", version: 1, needed: needed) != nil, "kept for its hours")
    }

    @Test(.timeLimit(.minutes(1)))
    func pagesAskingAtOnceShareOneRequest() async throws {
        let clock = Clock(Self.signed)
        let links = ContentLinks(now: { clock.now })
        let server = Server()
        await server.hold()
        let needed = ContentLinks.needed(toPlay: nil)
        let fetch: @Sendable () async throws -> ContentLink = { try await server.contentLink("a", at: clock.now) }

        // The page beside the one on screen: fetched ahead, not waited for.
        await links.prefetch("a", version: 1, needed: needed, copyExpected: false, fetch: fetch)
        try await eventuallyTrue { await server.holding == 1 }
        #expect(await links.counts.fetching == 1)
        // Swiped to while it is on its way: the page waits on the same request.
        let page = Task { try await links.link("a", version: 1, needed: needed, copyExpected: false, fetch: fetch) }
        let second = Task { try await links.link("a", version: 1, needed: needed, copyExpected: false, fetch: fetch) }
        await links.prefetch("a", version: 1, needed: needed, copyExpected: false, fetch: fetch)
        await server.release()
        let link = try await page.value
        #expect(try await second.value == link)
        #expect(await server.asked == 1)
        #expect(await links.counts == (kept: 1, fetching: 0))
    }

    @Test func aFailedRequestKeepsNothingAndIsAskedAgain() async throws {
        let clock = Clock(Self.signed)
        let links = ContentLinks(now: { clock.now })
        let server = Server()
        let fetch: @Sendable () async throws -> ContentLink = { try await server.contentLink("a", at: clock.now) }
        await server.fail(with: URLError(.notConnectedToInternet))
        await #expect(throws: URLError.self) {
            try await links.link("a", version: 1, needed: 60, copyExpected: false, fetch: fetch)
        }
        #expect(await links.counts == (kept: 0, fetching: 0))
        await server.fail(with: nil)
        _ = try await links.link("a", version: 1, needed: 60, copyExpected: false, fetch: fetch)
        #expect(await server.asked == 2)
    }

    @Test(.timeLimit(.minutes(1)))
    func aLinkOnItsWayAtSignOutIsNotKept() async throws {
        let clock = Clock(Self.signed)
        let links = ContentLinks(now: { clock.now })
        let server = Server()
        await server.hold()
        await links.prefetch("a", version: 1, needed: 60, copyExpected: false) {
            try await server.contentLink("a", at: clock.now)
        }
        try await eventuallyTrue { await server.holding == 1 }
        // Signed out while the server has not answered: the answer comes
        // anyway (this one pays no heed to being stopped), and is dropped.
        let signingOut = Task { await links.removeAll() }
        try await eventuallyTrue { await links.counts.fetching == 0 }
        await server.release()
        await signingOut.value
        #expect(await server.asked == 1)
        #expect(await links.kept("a", version: 1, needed: 60) == nil, "another account's, by then")
    }

    @Test func aFewHundredLinksAreKeptAtMost() async throws {
        let clock = Clock(Self.signed)
        let links = ContentLinks(now: { clock.now })
        for index in 0..<(ContentLinks.capacity + 10) {
            clock.now = Self.signed.addingTimeInterval(Double(index))
            _ = try await links.link("f\(index)", version: 1, needed: 60, copyExpected: false) {
                ContentLinksTests.answer("f\(index)", at: Self.signed)
            }
        }
        #expect(await links.counts.kept == ContentLinks.capacity)
        #expect(await links.kept("f0", version: 1, needed: 60) == nil, "the longest kept went first")
        #expect(await links.kept("f\(ContentLinks.capacity + 9)", version: 1, needed: 60) != nil)
    }
}

/// Polls until `condition` holds, for up to five seconds.
private func eventuallyTrue(_ condition: () async -> Bool) async throws {
    for _ in 0..<2500 {
        if await condition() { return }
        try await Task.sleep(nanoseconds: 2_000_000)
    }
    struct TimedOut: Error {}
    throw TimedOut()
}
