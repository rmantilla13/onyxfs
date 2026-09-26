import Foundation

/// One drive as the Finder mount serves it: a replica kept current from the
/// server's access-checked feed, kept on disk between launches, and the index
/// the WebDAV bridge answers from.
///
/// The bridge never lists anything the feed did not send, so the mount shows
/// what the web shows. It never keeps bytes either: a read is redirected to a
/// presigned link, fetched here per file and reused only while it has time
/// left to run.
public actor DriveMirror {
    public nonisolated let scope: SyncDomain
    private let store: URL
    private let identity: Identity
    private let api: @Sendable () -> OnyxAPI

    private var replica: Replica
    public private(set) var index: MirrorIndex
    public private(set) var lastSynced: Date?
    public private(set) var lastError: String?

    private var syncing: Task<Replica.Diff, Error>?
    /// Changes applied by a pass that then failed. The index already shows
    /// them, so they are owed to the next caller whose sync succeeds.
    private var unreported = Replica.Diff()
    private var links: [String: Link] = [:]
    private var fetching: [String: Task<URL, Error>] = [:]

    /// A pass stops here even if the server is not done; the next continues.
    static let maxPages = 2000
    /// A long first sync is written down this often, so a quit or a crash
    /// resumes near where it stopped instead of at the start.
    static let checkpointPages = 50

    /// Whose replica this is. A replica is only good for the account and
    /// server it was fetched as: another account may see other files, and
    /// another server's cursor means nothing here.
    struct Identity: Codable, Equatable, Sendable {
        let server: String
        let account: String
    }

    struct Stored: Codable, Sendable {
        let identity: Identity
        let replica: Replica
    }

    private struct Link {
        let url: URL
        let freshUntil: Date
    }

    public init(scope: SyncDomain, directory: URL, server: URL, account: String,
                api: @escaping @Sendable () -> OnyxAPI) {
        let identity = Identity(server: server.absoluteString, account: account.lowercased())
        let store = directory.appendingPathComponent(scope.identifier + ".json")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let saved = (try? Data(contentsOf: store)).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) }
        let replica = saved.flatMap { $0.identity == identity ? $0.replica : nil } ?? Replica()
        self.scope = scope
        self.api = api
        self.identity = identity
        self.store = store
        self.replica = replica
        index = MirrorIndex(replica)
    }

    // MARK: - Sync

    /// Bring the drive up to the present and say what changed, in Replica's
    /// item identifiers ("folder:<server path>" for folders).
    ///
    /// Calls that overlap share one pass: two drains at once would each
    /// apply pages the other already had and race to save. A pass that fails
    /// keeps what it applied, and the next one to succeed reports it.
    public func sync() async throws -> Replica.Diff {
        if let syncing { return try await syncing.value }
        let task = Task { try await self.drain() }
        syncing = task
        return try await task.value
    }

    private func drain() async throws -> Replica.Diff {
        defer { syncing = nil }
        var pages = 0
        var restarted = false
        var unsaved = false
        var reindex = false
        var saveError: String?

        do {
            while pages < Self.maxPages {
                let page = try await api().delta(cursor: replica.cursor, domain: scope, folders: true)
                pages += 1

                if let scope = page.scope {
                    if let held = replica.scope, held != scope {
                        // Who may see what has changed, with no file row to
                        // say so. Nothing fetched under the old access may
                        // stay, so start again from the beginning — once. If
                        // it moves again mid-pass, stop there, empty; the
                        // next pass starts over under whatever is current.
                        unreported.deleted += Self.ids(in: replica)
                        replica.reset(scope: scope)
                        unsaved = true
                        reindex = true
                        if restarted { break }
                        restarted = true
                        continue
                    }
                    if replica.scope == nil { replica.scope = scope; unsaved = true }
                }

                let cursor = replica.cursor
                let diff = replica.apply(changed: page.changed, deleted: page.deleted.map(\.id),
                                         folders: page.folders, cursor: page.cursor)
                unreported.updated += diff.updated
                unreported.deleted += diff.deleted
                if !diff.isEmpty { reindex = true }
                if !diff.isEmpty || replica.cursor != cursor { unsaved = true }

                if page.done { break }
                // A page with nothing in it that does not move the cursor is
                // the end, whatever `done` says; asking again would spin.
                if page.changed.isEmpty && page.deleted.isEmpty && replica.cursor <= cursor { break }
                if pages % Self.checkpointPages == 0 && unsaved {
                    saveError = await save()
                    unsaved = saveError != nil
                }
            }
        } catch {
            // What was applied is sound — each page leaves a replica that is
            // correct as of its cursor — so keep it, and resume from there.
            if reindex { index = await Self.build(replica) }
            if unsaved { _ = await save() }
            lastError = error.localizedDescription
            throw error
        }

        if reindex { index = await Self.build(replica) }
        if unsaved { saveError = await save() }
        lastSynced = Date()
        lastError = saveError
        return settle()
    }

    /// The owed changes, net: each id once, as what it is now.
    private func settle() -> Replica.Diff {
        guard !unreported.isEmpty else { return unreported }
        let files = replica.files
        let folders = replica.folders
        func present(_ id: String) -> Bool {
            if let path = Replica.folderPath(ofID: id) { return folders.contains(path) }
            return files[id] != nil
        }
        let diff = Replica.Diff(updated: Replica.unique(unreported.updated.filter(present)),
                                deleted: Replica.unique(unreported.deleted.filter { !present($0) }))
        unreported = Replica.Diff()
        return diff
    }

    static func ids(in replica: Replica) -> [String] {
        replica.files.keys.sorted() + replica.folders.sorted().map(Replica.folderID)
    }

    /// Off the actor: at a hundred thousand files this is long enough to hold
    /// up the reads the bridge is waiting on.
    private static func build(_ replica: Replica) async -> MirrorIndex {
        MirrorIndex(replica)
    }

    /// Nil, or why the replica could not be written. Not fatal: the mount
    /// works from memory, and the next save tries again.
    private func save() async -> String? {
        do {
            try await Self.write(Stored(identity: identity, replica: replica), to: store)
            return nil
        } catch {
            return "Could not save \(scope.identifier): \(error.localizedDescription)"
        }
    }

    /// Off the actor, like `build`. Atomic, so a crash mid-write leaves the
    /// previous replica rather than half of this one.
    private static func write(_ stored: Stored, to url: URL) async throws {
        let data = try JSONEncoder().encode(stored)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    // MARK: - Bytes

    /// Where to read a file's bytes from now: a presigned storage link, which
    /// serves ranges, so the bridge can redirect to it.
    ///
    /// Reused until ten minutes before it expires (fifty minutes when the
    /// server gives no expiry): a player seeking through a video asks for
    /// many ranges, and each should not cost a round trip to the server.
    /// Requests for one file at once share a single fetch.
    public func contentURL(fileId: String) async throws -> URL {
        if let link = links[fileId], link.freshUntil > Date() { return link.url }
        if let pending = fetching[fileId] { return try await pending.value }
        let task = Task { try await self.fetchLink(fileId) }
        fetching[fileId] = task
        return try await task.value
    }

    /// Drop a link, e.g. after storage refused it, so the next read fetches
    /// a fresh one.
    public func forgetContentURL(fileId: String) {
        links[fileId] = nil
    }

    private func fetchLink(_ fileId: String) async throws -> URL {
        defer { fetching[fileId] = nil }
        let asked = Date()
        let link = try await api().contentLink(fileId: fileId)
        let freshUntil = link.expiresAt.map { $0.date.addingTimeInterval(-10 * 60) }
            ?? asked.addingTimeInterval(50 * 60)
        if links.count >= 1024 {
            // Browsing a big drive touches thousands of files; keep only
            // links that are still worth reusing.
            let now = Date()
            links = links.filter { $0.value.freshUntil > now }
        }
        links[fileId] = Link(url: link.url, freshUntil: freshUntil)
        return link.url
    }
}
