import Foundation

/// Newest files across several drives, a page at a time, as one list: for a
/// workspace with no All Files (`drivesOnly`), where the server lists one
/// drive at a time and Home's Recent and Search still mean "everywhere I
/// can look".
///
/// Each page asks every drive not yet finished for a page of `limit` from
/// where it stands, and merges them newest first the way the server orders a
/// drive (by when the file was added). What a drive gave beyond the page is
/// asked again next time — by its cursor and how many of that page were used
/// — rather than kept, so the cursor is all there is to carry: one opaque
/// string, like the server's own. Every ask is the same size, so none grows
/// past what the server hands out at once.
///
/// The merge stops where a drive's page runs out while the drive has more:
/// its next file, not yet seen, could be newer than anything left. A page
/// can so be shorter than `limit`, never empty while there is more.
public enum AcrossDrives {
    struct Mark: Codable, Equatable {
        /// The drive's cursor this page was asked from (nil: its first).
        var cursor: String?
        /// How many of that page were shown already.
        var skip: Int
        var done: Bool
    }

    /// One merged page of `limit`, from `cursor` (nil for the first).
    /// `fetch` asks one drive for one page: `(scope, cursor, limit)`.
    public static func page(
        _ scopes: [SyncDomain], limit: Int, cursor: String?,
        fetch: @escaping @Sendable (SyncDomain, String?, Int) async throws -> FilePage
    ) async throws -> FilePage {
        var marks = decode(cursor) ?? [:]
        let open = scopes.filter { !(marks[$0.identifier]?.done ?? false) }
        if open.isEmpty { return FilePage(files: [], cursor: nil) }

        // Each drive's page, in the order the server gave it, minus what was
        // shown of it already.
        var pages: [(scope: SyncDomain, files: [FileItem], next: String?)] = []
        try await withThrowingTaskGroup(of: (Int, FilePage).self) { group in
            for (i, scope) in open.enumerated() {
                let mark = marks[scope.identifier] ?? Mark(cursor: nil, skip: 0, done: false)
                group.addTask { (i, try await fetch(scope, mark.cursor, limit)) }
            }
            var got: [(Int, FilePage)] = []
            for try await one in group { got.append(one) }
            for (i, page) in got.sorted(by: { $0.0 < $1.0 }) {
                let skip = marks[open[i].identifier]?.skip ?? 0
                pages.append((open[i], Array(page.files.dropFirst(skip)), page.cursor))
            }
        }

        // A k-way merge, so what is taken of each drive is always the front
        // of its page: the next page starts where this one stopped.
        var heads = Array(repeating: 0, count: pages.count)
        var out: [FileItem] = []
        var seen = Set<String>()
        merging: while out.count < limit {
            var best: Int?
            for (i, p) in pages.enumerated() {
                if heads[i] >= p.files.count {
                    // Out of this page, with more to come: stop here.
                    if p.next != nil { break merging }
                    continue
                }
                guard let b = best else { best = i; continue }
                if newer(p.files[heads[i]], than: pages[b].files[heads[b]]) { best = i }
            }
            guard let i = best else { break }
            let file = pages[i].files[heads[i]]
            heads[i] += 1
            // A file in a drive inside another is listed by both.
            if seen.insert(file.id).inserted { out.append(file) }
        }

        for (i, p) in pages.enumerated() {
            let key = p.scope.identifier
            let before = marks[key] ?? Mark(cursor: nil, skip: 0, done: false)
            if heads[i] < p.files.count {
                // Some of this page is still to show: ask for it again.
                marks[key] = Mark(cursor: before.cursor, skip: before.skip + heads[i], done: false)
            } else if let next = p.next {
                marks[key] = Mark(cursor: next, skip: 0, done: false)
            } else {
                marks[key] = Mark(cursor: nil, skip: 0, done: true)
            }
        }
        let more = scopes.contains { !(marks[$0.identifier]?.done ?? false) }
        return FilePage(files: out, cursor: more ? encode(marks) : nil)
    }

    static func newer(_ a: FileItem, than b: FileItem) -> Bool {
        let x = a.createdAt?.raw ?? 0, y = b.createdAt?.raw ?? 0
        return x != y ? x > y : a.id > b.id
    }

    static func encode(_ marks: [String: Mark]) -> String {
        let data = (try? JSONEncoder().encode(marks)) ?? Data()
        return "x." + data.base64EncodedString()
    }

    static func decode(_ cursor: String?) -> [String: Mark]? {
        guard let cursor, cursor.hasPrefix("x."), let data = Data(base64Encoded: String(cursor.dropFirst(2))) else { return nil }
        return try? JSONDecoder().decode([String: Mark].self, from: data)
    }
}

extension OnyxAPI {
    /// The newest files across `scopes` (AcrossDrives), as `findFiles`
    /// finds them in one.
    public func findFiles(across scopes: [SyncDomain], query: String? = nil, kinds: [String] = [],
                          limit: Int = 30, cursor: String? = nil) async throws -> FilePage {
        try await AcrossDrives.page(scopes, limit: limit, cursor: cursor) { scope, after, count in
            try await self.findFiles(in: scope, query: query, kinds: kinds, sort: .newest, limit: count, cursor: after)
        }
    }
}
