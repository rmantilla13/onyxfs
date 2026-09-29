import Foundation

/// What the thumbnail worker remembers of the files it has tried, so that
/// it neither retries one in a loop nor asks the server again and again
/// about one this account may not change. The browser keeps the same kind
/// of note (lib/preview-wanted.js), for a week.
///
/// Kept on disk per account (ThumbnailWorker), small: an entry says
/// nothing once its wait is over, and goes then.
public struct ThumbnailLedger: Codable, Sendable, Equatable {
    public enum Outcome: String, Codable, Sendable {
        /// Made and recorded. The feed brings the new thumbnail within
        /// seconds; until it has, this stops the file being made twice.
        case made
        /// It has a thumbnail new enough to keep: not one of the old small
        /// ones, only without siblings (a small picture has none).
        case kept
        /// The server says this account may not change it.
        case refused
        /// Nothing this Mac can make of it: a format it does not decode,
        /// every frame tried blank, not in the bucket, or a picture that
        /// may be transparent while this Mac can only write JPEG.
        case unusable
        /// It went wrong in a way that may pass: the network, the server,
        /// storage.
        case failed
    }

    public struct Entry: Codable, Sendable, Equatable {
        /// The file's version when this happened: a new one (new contents,
        /// a rename) is tried afresh. Nil for whatever version it is at —
        /// a refusal is about the account, not the file's bytes.
        public var version: Int?
        public var outcome: Outcome
        public var at: Date
        /// Failures in a row, at this version.
        public var failures: Int
    }

    public private(set) var entries: [String: Entry] = [:]

    public init() {}

    static let hour: TimeInterval = 3600
    static let day: TimeInterval = 24 * hour
    /// The browser's own wait for a file it could not make anything of.
    static let week: TimeInterval = 7 * day

    /// How long after `entry` the file is left alone. A failure waits an
    /// hour, then twice as long each time it fails again, up to a week.
    static func wait(after entry: Entry) -> TimeInterval {
        switch entry.outcome {
        case .made: return day
        case .kept: return 180 * day
        case .refused, .unusable: return week
        case .failed: return min(week, hour * pow(2, Double(max(0, entry.failures - 1))))
        }
    }

    /// When the file, at `version`, may be tried again; nil when it may now
    /// (or was never tried).
    public func notBefore(_ fileId: String, version: Int?) -> Date? {
        guard let entry = entries[fileId] else { return nil }
        if let noted = entry.version, let version, noted != version { return nil }
        return entry.at.addingTimeInterval(Self.wait(after: entry))
    }

    public func isDue(_ fileId: String, version: Int?, now: Date) -> Bool {
        guard let when = notBefore(fileId, version: version) else { return true }
        return when <= now
    }

    public mutating func record(_ outcome: Outcome, fileId: String, version: Int?, at now: Date) {
        var failures = 0
        if outcome == .failed {
            let before = entries[fileId]
            let same = before?.outcome == .failed && (before?.version == version || before?.version == nil || version == nil)
            failures = same ? (before?.failures ?? 0) + 1 : 1
        }
        entries[fileId] = Entry(version: outcome == .refused ? nil : version, outcome: outcome, at: now, failures: failures)
    }

    /// Forget the file: it has what it needs now, or is gone.
    public mutating func forget(_ fileId: String) {
        entries[fileId] = nil
    }

    /// Entries whose wait is over go, and past `limit` the oldest do too,
    /// so the note stays small whatever the drives hold. A failure's count
    /// goes with its entry only once it has waited a whole week, so a file
    /// that keeps failing keeps waiting longer.
    public mutating func prune(now: Date, limit: Int = 20_000) {
        entries = entries.filter { _, entry in
            let wait = entry.outcome == .failed ? Self.week : Self.wait(after: entry)
            return entry.at.addingTimeInterval(wait) > now
        }
        guard entries.count > limit else { return }
        let newest = entries.sorted { $0.value.at > $1.value.at }.prefix(limit)
        entries = Dictionary(uniqueKeysWithValues: newest.map { ($0.key, $0.value) })
    }
}
