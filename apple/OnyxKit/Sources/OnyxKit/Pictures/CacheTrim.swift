import Foundation

/// A cache on disk held under a cap: past `limit`, what was used least
/// recently goes first, until no more than `trimTo` is left — a margin under
/// the cap, so the next few things kept do not each start another trim.
///
/// Planning only: the app counts what is in its folder, and deletes what the
/// plan names.
public struct CacheTrim: Equatable, Sendable {
    public var limit: Int64
    public var trimTo: Int64

    public init(limit: Int64, trimTo: Int64) {
        self.limit = limit
        self.trimTo = min(trimTo, limit)
    }

    /// One thing kept — a file, or a folder of them — with its size on disk
    /// and when it was last used.
    public struct Entry<ID: Hashable & Sendable>: Equatable, Sendable {
        public var id: ID
        public var bytes: Int64
        public var lastUse: Date

        public init(id: ID, bytes: Int64, lastUse: Date) {
            self.id = id
            self.bytes = bytes
            self.lastUse = lastUse
        }
    }

    public struct Plan<ID: Hashable & Sendable>: Equatable, Sendable {
        /// To delete, least recently used first.
        public var delete: [ID]
        /// What is left once they are.
        public var left: Int64
    }

    /// Nothing while the whole is within `limit`; past it, the least recently
    /// used until no more than `trimTo` is left — of two last used at the
    /// same moment the bigger first, so fewer go. What is `held` (a document
    /// open on screen) stays however long ago it was used, so a big one held
    /// may leave more than `trimTo`.
    public func plan<ID>(_ entries: [Entry<ID>], held: Set<ID> = []) -> Plan<ID> {
        var left = entries.reduce(Int64(0)) { $0 + max(0, $1.bytes) }
        guard left > limit else { return Plan(delete: [], left: left) }
        let oldestFirst = entries
            .filter { !held.contains($0.id) }
            .sorted { $0.lastUse != $1.lastUse ? $0.lastUse < $1.lastUse : $0.bytes > $1.bytes }
        var delete: [ID] = []
        for entry in oldestFirst where left > trimTo {
            delete.append(entry.id)
            left -= max(0, entry.bytes)
        }
        return Plan(delete: delete, left: left)
    }
}

/// What a cache on disk holds between counts, so that trimming it lists its
/// folder only when it may be past its cap: the total when it was last
/// counted, and what has been written since. Whatever is deleted meanwhile
/// — by a trim, or by the system clearing caches — only makes it less, so
/// the tally is never under what is there.
public struct CacheTally: Equatable, Sendable {
    /// The total when last counted; nil before the first count, when
    /// anything may be there.
    public private(set) var counted: Int64?
    /// Written since the last count began.
    public private(set) var written: Int64 = 0
    /// A count is under way: another would only list the folder twice.
    public private(set) var counting = false

    public init() {}

    public mutating func wrote(_ bytes: Int64) {
        written += max(0, bytes)
    }

    /// Whether the folder may be past `limit`.
    public func mayExceed(_ limit: Int64) -> Bool {
        guard let counted else { return true }
        return counted + written > limit
    }

    /// Whether to count now: yes when the folder may be past `limit` and no
    /// count is under way, and the count begins. What was written before now
    /// is in it; what is written while it goes on is tallied again after
    /// it — counted twice, perhaps, never missed.
    public mutating func beginCount(over limit: Int64) -> Bool {
        guard !counting, mayExceed(limit) else { return false }
        counting = true
        written = 0
        return true
    }

    /// The count is done, and `left` is what the trim left — or nil when
    /// the folder could not be read, and the next asking counts again.
    public mutating func endCount(left: Int64?) {
        counting = false
        counted = left
    }

    /// Everything in it deleted (Clear Pictures, signing out).
    public mutating func emptied() {
        counted = 0
        written = 0
    }
}
