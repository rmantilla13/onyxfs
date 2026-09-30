import Foundation

/// Links to play a file from, kept while they still work: the original's,
/// and its streamable copy's.
///
/// Each video page of the iPhone's preview asked the server for a link as it
/// came on screen, and played nothing until the answer came. But a link is
/// good for six hours from when it was signed (lib/storage.js
/// ORIGINAL_URL_TTL, the content route's CONTENT_URL_TTL), and says so
/// itself: X-Amz-Date and X-Amz-Expires are in it (`expiry(of:)`). So a
/// link is kept for its file at its version (`link`), the pages either side
/// of the one on screen have theirs fetched while it plays (`prefetch`), two
/// asking for one file at once share one request, and a page plays at once
/// from one kept (`kept`) — or, for a file with no streamable copy to
/// prefer, from the listing's own (`listed`). One that storage refuses
/// anyway is let go of (`forget`), and the page asks afresh.
///
/// A link is only used while it has `needed` seconds left: enough to play
/// the file through, with time to pause (`needed(toPlay:)`). A large video's
/// link that has no streamable copy is kept only a few minutes: one may be
/// on its way (the page asks for it), and once it is there it is what
/// should play. Kept in memory only, and forgotten at sign-out.
public actor ContentLinks {
    public struct Link: Sendable, Equatable {
        public let url: URL
        public let proxyUrl: URL?
        /// When the first of the two stops working.
        public let expires: Date

        public init(url: URL, proxyUrl: URL? = nil, expires: Date) {
            self.url = url
            self.proxyUrl = proxyUrl
            self.expires = expires
        }

        /// What a player plays: the streamable copy when there is one.
        public var playable: URL { proxyUrl ?? url }
    }

    /// How long a link with no streamable copy is kept for a file that may
    /// get one.
    public static let withoutCopy: TimeInterval = 300
    /// Kept at most; the oldest go first.
    static let capacity = 256

    private struct Entry {
        let link: Link
        /// Used no later than this: its expiry, or sooner (`withoutCopy`).
        let until: Date
        let fetchedAt: Date
    }

    private struct Fetch {
        let token: UInt64
        let task: Task<Link, Error>
    }

    private var entries: [String: Entry] = [:]
    private var fetching: [String: Fetch] = [:]
    private var nextToken: UInt64 = 0
    /// Moved on by `removeAll`: a fetch begun before keeps nothing.
    private var generation: UInt64 = 0
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
    }

    /// The link kept for `fileId` at `version`, if it has `needed` seconds
    /// left.
    public func kept(_ fileId: String, version: Int, needed: TimeInterval) -> Link? {
        guard let entry = entries[Self.key(fileId, version)] else { return nil }
        let at = now()
        guard at < entry.until, at.addingTimeInterval(needed) <= entry.link.expires else { return nil }
        return entry.link
    }

    /// A link to `fileId` at `version` with `needed` seconds left: the one
    /// kept, else the one on its way, else one `fetch`ed now and kept.
    /// `copyExpected`: a streamable copy may be made of the file, so a link
    /// without one is kept only `withoutCopy`.
    public func link(_ fileId: String, version: Int, needed: TimeInterval, copyExpected: Bool,
                     fetch: @escaping @Sendable () async throws -> ContentLink) async throws -> Link {
        if let link = kept(fileId, version: version, needed: needed) { return link }
        let key = Self.key(fileId, version)
        let task = fetching[key]?.task ?? start(key, copyExpected: copyExpected, fetch: fetch)
        return try await task.value
    }

    /// As `link`, without waiting: for the pages beside the one on screen.
    public func prefetch(_ fileId: String, version: Int, needed: TimeInterval, copyExpected: Bool,
                         fetch: @escaping @Sendable () async throws -> ContentLink) {
        let key = Self.key(fileId, version)
        guard kept(fileId, version: version, needed: needed) == nil, fetching[key] == nil else { return }
        _ = start(key, copyExpected: copyExpected, fetch: fetch)
    }

    /// Storage refused what was kept for `fileId`: it goes, every version.
    public func forget(_ fileId: String) {
        let prefix = fileId + "\n"
        for key in entries.keys where key.hasPrefix(prefix) { entries[key] = nil }
    }

    /// Sign-out: nothing of the account's is kept. What is on its way is
    /// stopped, and returns only once it has ended, keeping nothing.
    public func removeAll() async {
        generation += 1
        entries = [:]
        let running = fetching.values.map(\.task)
        fetching = [:]
        for task in running { task.cancel() }
        for task in running { _ = try? await task.value }
    }

    /// Links kept now, and fetches on their way: for tests.
    var counts: (kept: Int, fetching: Int) { (entries.count, fetching.count) }

    private func start(_ key: String, copyExpected: Bool,
                       fetch: @escaping @Sendable () async throws -> ContentLink) -> Task<Link, Error> {
        nextToken += 1
        let token = nextToken, generation = self.generation
        let task = Task {
            try await self.fetched(key, token: token, generation: generation, copyExpected: copyExpected, fetch: fetch)
        }
        fetching[key] = Fetch(token: token, task: task)
        return task
    }

    private func fetched(_ key: String, token: UInt64, generation: UInt64, copyExpected: Bool,
                         fetch: @Sendable () async throws -> ContentLink) async throws -> Link {
        defer { if fetching[key]?.token == token { fetching[key] = nil } }
        let answer = try await fetch()
        let at = now()
        let link = Self.link(from: answer, now: at)
        guard generation == self.generation else { return link }
        let until = copyExpected && link.proxyUrl == nil ? min(link.expires, at.addingTimeInterval(Self.withoutCopy))
                                                         : link.expires
        entries[key] = Entry(link: link, until: until, fetchedAt: at)
        if entries.count > Self.capacity { trim(at) }
        return link
    }

    /// What no longer works goes first, then the longest kept.
    private func trim(_ at: Date) {
        for (key, entry) in entries where entry.until <= at { entries[key] = nil }
        let excess = entries.count - Self.capacity
        guard excess > 0 else { return }
        for (key, _) in entries.sorted(by: { $0.value.fetchedAt < $1.value.fetchedAt }).prefix(excess) {
            entries[key] = nil
        }
    }

    private static func key(_ fileId: String, _ version: Int) -> String { "\(fileId)\n\(version)" }

    // MARK: - Reading a link

    /// The server's answer as a link, working until the first of its URLs
    /// stops, or the time it gave, whichever is sooner.
    static func link(from answer: ContentLink, now: Date) -> Link {
        let ends = [expiry(of: answer.url), answer.proxyUrl.flatMap(expiry(of:)), answer.expiresAt?.date].compactMap { $0 }
        return Link(url: answer.url, proxyUrl: answer.proxyUrl, expires: ends.min() ?? .distantFuture)
    }

    /// The listing's own link to a file's original, if it has `needed`
    /// seconds left. A listing's links are signed as the content route's are,
    /// for six hours, so one listed a while ago may well still play: its own
    /// expiry says whether it will.
    public nonisolated static func listed(_ url: String?, needed: TimeInterval, now: Date = Date()) -> Link? {
        guard let url, let parsed = URL(string: url), parsed.scheme == "https" || parsed.scheme == "http" else {
            return nil
        }
        let expires = expiry(of: parsed) ?? .distantFuture
        guard now.addingTimeInterval(needed) <= expires else { return nil }
        return Link(url: parsed, expires: expires)
    }

    /// When a presigned URL stops working, from what it says itself:
    /// X-Amz-Date, when it was signed, and X-Amz-Expires, for how many
    /// seconds (SigV4's query form, which is how the server signs). Nil for a
    /// URL that is not presigned, which does not expire. One that is, but
    /// says when unreadably, is taken to have expired already.
    public nonisolated static func expiry(of url: URL) -> Date? {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> String? {
            items.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.value
        }
        let signed = value("X-Amz-Date"), lifetime = value("X-Amz-Expires")
        guard signed != nil || lifetime != nil || value("X-Amz-Signature") != nil else { return nil }
        guard let signed, let date = amzDate(signed), let lifetime, let seconds = Int(lifetime), seconds >= 0 else {
            return .distantPast
        }
        return date.addingTimeInterval(TimeInterval(seconds))
    }

    /// Seconds a link must still work to play something `duration` long
    /// through, with half an hour to spare for pauses and seeking back; half
    /// an hour when the length is not known.
    public nonisolated static func needed(toPlay duration: Double?) -> TimeInterval {
        let length = duration.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0
        return length + 30 * 60
    }

    /// "20260929T101500Z": SigV4's date and time, in UTC.
    static func amzDate(_ text: String) -> Date? {
        let bytes = Array(text.utf8)
        guard bytes.count == 16, bytes[8] == UInt8(ascii: "T"), bytes[15] == UInt8(ascii: "Z") else { return nil }
        func number(_ range: Range<Int>) -> Int? {
            let digits = bytes[range]
            guard digits.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }) else { return nil }
            return digits.reduce(0) { $0 * 10 + Int($1 - UInt8(ascii: "0")) }
        }
        guard let year = number(0..<4), let month = number(4..<6), let day = number(6..<8),
              let hour = number(9..<11), let minute = number(11..<13), let second = number(13..<15) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = DateComponents(calendar: calendar, timeZone: calendar.timeZone, year: year, month: month, day: day,
                                   hour: hour, minute: minute, second: second)
        guard parts.isValidDate else { return nil }
        return parts.date
    }
}
