import Foundation

/// Cursor-based enumeration against `/api/files/delta`.
///
/// Two rules, both of which are easy to get wrong and expensive to get wrong:
///
/// 1. THE CURSOR IS A `seq`, NEVER A TIMESTAMP. `seq` comes from a Postgres
///    sequence and is strictly monotonic per write. Two files written in the
///    same millisecond have distinct seqs but identical `updated_at`, so a
///    timestamp cursor can place the boundary between them and lose one
///    permanently — with no error and nothing to notice.
///
/// 2. PERSIST THE CURSOR ONLY AFTER THE PAGE IS APPLIED. Saving it first means
///    a crash mid-page skips that page forever. Re-applying a page is
///    harmless — the operations are idempotent by id — so the safe order is
///    apply, then commit.
public actor DeltaSync {
    public struct Page: Sendable {
        public let changed: [FileItem]
        public let deleted: [Tombstone]
        public let cursor: Int64
        public let done: Bool
    }

    let api: OnyxAPI
    public private(set) var cursor: Int64

    public init(api: OnyxAPI, cursor: Int64 = 0) {
        self.api = api
        self.cursor = cursor
    }

    /// Walk from the current cursor to the present, handing each page to
    /// `apply`. The cursor advances only after `apply` returns without
    /// throwing, so a failure leaves it where it was and the page is retried.
    ///
    /// `maxPages` bounds a single pass: a first sync of a large library should
    /// yield between pages rather than hold the extension busy until it is
    /// killed for it.
    @discardableResult
    public func drain(maxPages: Int = 50,
                      apply: @Sendable (Page) async throws -> Void) async throws -> Int64 {
        var pages = 0
        while pages < maxPages {
            let response = try await api.delta(cursor: cursor)
            let page = Page(changed: response.changed, deleted: response.deleted,
                            cursor: response.cursor, done: response.done)

            // An empty page that does not advance is the end. Without this the
            // loop spins against a server that keeps answering "nothing new".
            if page.changed.isEmpty && page.deleted.isEmpty && page.cursor <= cursor { return cursor }

            try await apply(page)

            // Never move backwards. A server that returns a lower cursor than
            // we hold would otherwise replay history indefinitely.
            cursor = max(cursor, page.cursor)
            pages += 1
            if page.done { break }
        }
        return cursor
    }

    /// Start from now, skipping history. For a device that should show what
    /// changes from here rather than replay a decade of uploads.
    public func fastForward() async throws {
        cursor = try await api.currentCursor()
    }

    public func reset() { cursor = 0 }
}

/// Where the cursor lives between launches.
///
/// In the shared app group, so the app and its File Provider extension agree:
/// two separate cursors would each re-enumerate the other's work and the
/// drive would never settle.
public struct CursorStore: Sendable {
    let defaults: UserDefaults?
    let key: String

    public init(suiteName: String = OnyxIdentifiers.appGroup, key: String = "delta.cursor") {
        self.defaults = UserDefaults(suiteName: suiteName)
        self.key = key
    }

    public func load() -> Int64 {
        // 0 is "never synced", which is also the correct starting cursor, so
        // a missing value needs no special case.
        Int64(defaults?.integer(forKey: key) ?? 0)
    }

    public func save(_ cursor: Int64) {
        defaults?.set(Int(cursor), forKey: key)
    }
}
