import Foundation

/// One drive as the Finder mount serves it: a replica kept current from the
/// server's access-checked feed, kept on disk between launches, and the index
/// the WebDAV bridge answers from.
///
/// The bridge never lists anything the feed did not send, so the mount shows
/// what the web shows. It never keeps bytes either: a read is redirected to a
/// presigned link, fetched here per file and reused only while it has time
/// left to run and the file has not moved since.
public actor DriveMirror {
    public nonisolated let scope: SyncDomain
    private let files: Files
    private let identity: Identity
    private let api: @Sendable () -> OnyxAPI
    private let linkLimit: Int

    /// What `index` is built from.
    private var replica: Replica
    /// `replica` has been fetched to the end under its scope, so a file it
    /// lacks is gone rather than not fetched yet. Kept on disk with it.
    private var complete: Bool
    /// The drive fetched again from the start after the access changed, kept
    /// out of sight until it is whole; `replica` answers meanwhile.
    private var staged: Replica?
    /// Names the replica on disk. The cursor file extends that one only.
    private var generation: String?
    public private(set) var index: MirrorIndex
    public private(set) var lastSynced: Date?
    public private(set) var lastError: String?
    /// The server said this account may no longer open the drive, and the
    /// mirror has forgotten it (see OnyxError.driveGone). Until a sync gets
    /// a page again.
    public private(set) var isGone = false

    private var syncing: Task<Replica.Diff, Error>?
    /// Changes applied by a pass that then failed. The index already shows
    /// them, so they are owed to the next caller whose sync succeeds.
    private var unreported = Replica.Diff()
    private var links: [String: Link] = [:]
    private var fetching: [String: Fetch] = [:]
    private var fetches = 0

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
        /// Nil in a file written before this was kept: not known to be
        /// whole, so taken as not until a pass reaches the end.
        var complete: Bool? = nil
        var generation: String? = nil
    }

    /// The cursor alone, for a pass that moved it and changed nothing else.
    /// That is most passes on a busy server: the feed carries every drive's
    /// changes, other drives' as bare ids, and rewriting a hundred thousand
    /// files' worth of replica for each would wear the disk for nothing.
    struct Progress: Codable, Sendable {
        let generation: String
        let cursor: Int64
    }

    /// Where a drive's mirror is kept.
    struct Files: Sendable {
        let store: URL
        let progress: URL

        init(directory: URL, scope: SyncDomain) {
            store = directory.appendingPathComponent(scope.identifier + ".json")
            progress = directory.appendingPathComponent(scope.identifier + ".cursor.json")
        }
    }

    struct Loaded: Sendable {
        let replica: Replica
        let complete: Bool
        let generation: String?
        let index: MirrorIndex
    }

    private struct Link {
        let url: URL
        let freshUntil: Date
        /// The file's version when the link was signed. A rename or a move
        /// moves the object to a new key and bumps the version, so a link
        /// signed before the version the replica has now points at a key
        /// that may be gone — or, reused by a later upload, hold other bytes.
        let version: Int
    }

    private struct Fetch {
        let id: Int
        let task: Task<URL, Error>
    }

    /// The mirror as it was left, read and indexed off the caller's thread:
    /// at a hundred thousand files that is most of a second, and the app
    /// opens mirrors from the main thread.
    public static func open(scope: SyncDomain, directory: URL, server: URL, account: String,
                            api: @escaping @Sendable () -> OnyxAPI) async -> DriveMirror {
        let identity = Identity(server: server.absoluteString, account: account.lowercased())
        let files = Files(directory: directory, scope: scope)
        let loaded = await Task.detached(priority: .userInitiated) {
            Self.load(files, directory: directory, identity: identity)
        }.value
        return DriveMirror(scope: scope, files: files, identity: identity, api: api, loaded: loaded, linkLimit: 1024)
    }

    /// Reads the disk on the caller's thread, which suits a test; the app
    /// uses `open`.
    init(scope: SyncDomain, directory: URL, server: URL, account: String,
         api: @escaping @Sendable () -> OnyxAPI, linkLimit: Int = 1024) {
        let identity = Identity(server: server.absoluteString, account: account.lowercased())
        let files = Files(directory: directory, scope: scope)
        self.init(scope: scope, files: files, identity: identity, api: api,
                  loaded: Self.load(files, directory: directory, identity: identity), linkLimit: linkLimit)
    }

    private init(scope: SyncDomain, files: Files, identity: Identity, api: @escaping @Sendable () -> OnyxAPI,
                 loaded: Loaded, linkLimit: Int) {
        self.scope = scope
        self.files = files
        self.identity = identity
        self.api = api
        self.linkLimit = linkLimit
        replica = loaded.replica
        complete = loaded.complete
        generation = loaded.generation
        index = loaded.index
    }

    static func load(_ files: Files, directory: URL, identity: Identity) -> Loaded {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let saved = (try? Data(contentsOf: files.store)).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) }
        guard let saved, saved.identity == identity else {
            return Loaded(replica: Replica(), complete: false, generation: nil,
                          index: MirrorIndex(Replica(), authoritative: false))
        }
        var replica = saved.replica
        if let generation = saved.generation,
           let data = try? Data(contentsOf: files.progress),
           let progress = try? JSONDecoder().decode(Progress.self, from: data),
           progress.generation == generation {
            replica.cursor = max(replica.cursor, progress.cursor)
        }
        let complete = saved.complete ?? false
        return Loaded(replica: replica, complete: complete, generation: saved.generation,
                      index: MirrorIndex(replica, authoritative: complete))
    }

    /// Forget what is kept on disk for a drive: for one the account has lost
    /// or turned off for good. A mirror open on it should be dropped too.
    public static func removeStore(for scope: SyncDomain, in directory: URL) {
        let files = Files(directory: directory, scope: scope)
        try? FileManager.default.removeItem(at: files.store)
        try? FileManager.default.removeItem(at: files.progress)
    }

    /// Whether a file the index lacks is really gone (MirrorIndex): false
    /// until the drive has been fetched to the end, and again while it is
    /// fetched afresh after the access changed. Offline copies are deleted
    /// only against an index that is.
    public var isAuthoritative: Bool { index.isAuthoritative }

    // MARK: - Sync

    /// Bring the drive up to the present and say what changed, in Replica's
    /// item identifiers ("folder:<server path>" for folders).
    ///
    /// Calls that overlap share one pass: two drains at once would each
    /// apply pages the other already had and race to save. A pass that fails
    /// keeps what it applied, and the next one to succeed reports it.
    ///
    /// Throws OnyxError.driveGone when the server says this account may no
    /// longer open the drive. The mirror has then forgotten it — tree, links
    /// and what was on disk — and the app should unmount it and remove its
    /// offline copies.
    public func sync() async throws -> Replica.Diff {
        if let syncing { return try await syncing.value }
        let task = Task { try await self.drain() }
        syncing = task
        return try await task.value
    }

    private enum Unsaved: Int, Comparable {
        case nothing, cursor, everything
        static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
    }

    private func drain() async throws -> Replica.Diff {
        defer { syncing = nil }
        var pages = 0
        var restarted = false
        var unsaved = Unsaved.nothing
        var reindex = false
        var saveError: String?

        do {
            while pages < Self.maxPages {
                let page = try await api().delta(cursor: staged?.cursor ?? replica.cursor, domain: scope, folders: true)
                pages += 1
                isGone = false

                if let scope = page.scope {
                    let held = staged?.scope ?? replica.scope
                    if let held, held != scope {
                        // Who may see what has changed, with no file row to
                        // say so. Nothing fetched under the old access may
                        // outlast a fetch under the new, so fetch the drive
                        // again from the start — once. If it moves again
                        // mid-pass, stop there; the next pass starts over
                        // under whatever is current. No link from before is
                        // used again either way.
                        forgetLinks()
                        if complete {
                            // Beside the whole drive, which goes on answering
                            // until the new fetch is whole too. Shown half
                            // done, it would look like most of the drive had
                            // gone, and the pins would delete to match.
                            var fresh = Replica()
                            fresh.reset(scope: scope)
                            staged = fresh
                            index = index.authoritative(false)
                        } else {
                            // Nothing whole to go on showing.
                            unreported.deleted += Self.ids(in: replica)
                            replica.reset(scope: scope)
                            unsaved = .everything
                            reindex = true
                        }
                        if restarted { break }
                        restarted = true
                        continue
                    }
                    if held == nil { replica.scope = scope; unsaved = .everything }
                }

                if staged != nil {
                    // Applied in place: a copy would cost the whole replica.
                    let cursor = staged!.cursor
                    staged!.apply(changed: page.changed, deleted: page.deleted.map(\.id),
                                  folders: page.folders, cursor: page.cursor)
                    guard Self.isLast(page, from: cursor, to: staged!.cursor) else { continue }
                    promoteStaged()
                    unsaved = .everything
                    reindex = true
                    break
                }

                let cursor = replica.cursor
                let listed = replica.listedFolders
                let diff = replica.apply(changed: page.changed, deleted: page.deleted.map(\.id),
                                         folders: page.folders, cursor: page.cursor)
                unreported.updated += diff.updated
                unreported.deleted += diff.deleted
                forgetLinks(for: diff)
                if !diff.isEmpty { reindex = true }
                if !diff.isEmpty || replica.listedFolders != listed {
                    unsaved = .everything
                } else if replica.cursor != cursor {
                    unsaved = max(unsaved, .cursor)
                }

                if Self.isLast(page, from: cursor, to: replica.cursor) {
                    if !complete { complete = true; unsaved = .everything }
                    break
                }
                if pages % Self.checkpointPages == 0 && unsaved != .nothing {
                    saveError = await save(unsaved)
                    if saveError == nil { unsaved = .nothing }
                }
            }
        } catch {
            if Self.meansGone(error, scope: scope) {
                forgetDrive()
                lastError = OnyxError.driveGone.localizedDescription
                throw OnyxError.driveGone
            }
            // What was applied is kept, and the next pass resumes from it: a
            // whole replica stays correct as of its cursor, and a fetch from
            // the start (shown or staged) carries on where it stopped.
            await publish(rebuilding: reindex)
            if unsaved != .nothing { _ = await save(unsaved) }
            lastError = error.localizedDescription
            throw error
        }

        await publish(rebuilding: reindex)
        if unsaved != .nothing { saveError = await save(unsaved) }
        lastSynced = Date()
        lastError = saveError
        return settle()
    }

    /// The end of the feed: the server says so, or a page with nothing in it
    /// that does not move the cursor — asking again would spin.
    private static func isLast(_ page: DeltaPage, from before: Int64, to after: Int64) -> Bool {
        page.done || (page.changed.isEmpty && page.deleted.isEmpty && after <= before)
    }

    /// The fetch under the new access is whole: it replaces what was shown,
    /// and every file in it is reported, since any may now be seen
    /// differently.
    private func promoteStaged() {
        guard var fresh = staged else { return }
        fresh.keepFolderStamps(from: replica)
        unreported.deleted += Self.ids(in: replica)
        unreported.updated += Self.ids(in: fresh)
        replica = fresh
        staged = nil
        complete = true
        forgetLinks()
    }

    private func publish(rebuilding: Bool) async {
        let whole = complete && staged == nil
        if rebuilding {
            index = await Self.build(replica, authoritative: whole)
        } else {
            index = index.authoritative(whole)
        }
    }

    /// A 404 from the feed, for a drive, is the server saying this account
    /// may not open it (app/api/files/delta). Only with the route's own JSON
    /// error: a proxy's or an old server's missing page is not taken for it.
    static func meansGone(_ error: Error, scope: SyncDomain) -> Bool {
        guard case .drive = scope, case let OnyxError.http(status, message) = error else { return false }
        return status == 404 && message != nil
    }

    /// Nothing the account may no longer open is listed or served from here,
    /// or kept on disk as a listing. The offline copies are the app's to
    /// remove (PinStore.removeAll): it holds the store.
    private func forgetDrive() {
        unreported.deleted += Self.ids(in: replica)
        replica = Replica()
        staged = nil
        complete = false
        generation = nil
        forgetLinks()
        index = MirrorIndex(replica, authoritative: false)
        isGone = true
        try? FileManager.default.removeItem(at: files.store)
        try? FileManager.default.removeItem(at: files.progress)
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
    private static func build(_ replica: Replica, authoritative: Bool) async -> MirrorIndex {
        MirrorIndex(replica, authoritative: authoritative)
    }

    /// Nil, or why the replica could not be written. Not fatal: the mount
    /// works from memory, and the next save tries again.
    ///
    /// A cursor that moved alone goes in the small cursor file, which names
    /// the replica on disk it extends; anything else rewrites the replica,
    /// under a new name, so an older cursor file no longer applies to it.
    private func save(_ what: Unsaved) async -> String? {
        do {
            if what == .cursor, let generation {
                try await Self.write(Progress(generation: generation, cursor: replica.cursor), to: files.progress)
            } else {
                let next = UUID().uuidString
                try await Self.write(Stored(identity: identity, replica: replica, complete: complete, generation: next),
                                     to: files.store)
                generation = next
                try? FileManager.default.removeItem(at: files.progress)
            }
            return nil
        } catch {
            return "Could not save \(scope.identifier): \(error.localizedDescription)"
        }
    }

    /// Off the actor, like `build`. Atomic, so a crash mid-write leaves the
    /// previous file rather than half of this one.
    private static func write<T: Encodable & Sendable>(_ value: T, to url: URL) async throws {
        let data = try JSONEncoder().encode(value)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    // MARK: - Bytes

    /// Where to read a file's bytes from now: a presigned storage link, which
    /// serves ranges, so the bridge can redirect to it.
    ///
    /// Reused until ten minutes before it expires (fifty minutes when the
    /// server gives no expiry) and while the file is at the version it was
    /// signed for: a player seeking through a video asks for many ranges, and
    /// each should not cost a round trip to the server, but a file renamed
    /// or moved on the web is at a new key, and the old link reads nothing —
    /// or whatever was uploaded to that key since. Requests for one file at
    /// once share a single fetch.
    public func contentURL(fileId: String) async throws -> URL {
        let version = replica.file(id: fileId)?.version
        if let link = links[fileId], link.freshUntil > Date(), let version, link.version >= version {
            return link.url
        }
        if let pending = fetching[fileId] { return try await pending.task.value }
        fetches += 1
        let id = fetches
        let task = Task { try await self.fetchLink(fileId, fetch: id, asOf: version) }
        fetching[fileId] = Fetch(id: id, task: task)
        return try await task.value
    }

    /// Drop a link, e.g. after storage refused it, so the next read fetches
    /// a fresh one.
    public func forgetContentURL(fileId: String) {
        links[fileId] = nil
    }

    /// How many links are kept; for tests.
    var linkCount: Int { links.count }

    private func fetchLink(_ fileId: String, fetch: Int, asOf version: Int?) async throws -> URL {
        defer { if fetching[fileId]?.id == fetch { fetching[fileId] = nil } }
        let asked = Date()
        let link = try await api().contentLink(fileId: fileId)
        let freshUntil = link.expiresAt.map { $0.date.addingTimeInterval(-10 * 60) }
            ?? asked.addingTimeInterval(50 * 60)
        // Kept only if the file did not move while this was in flight: a
        // sync that changed it dropped this fetch (forgetLinks), and a link
        // signed before the version the replica has now is not reused. The
        // server says which version it signed; one that does not is taken
        // to have signed the version asked for.
        if fetching[fileId]?.id == fetch, let signed = link.version ?? version,
           let current = replica.file(id: fileId)?.version, signed >= current {
            keep(Link(url: link.url, freshUntil: freshUntil, version: signed), for: fileId)
        }
        return link.url
    }

    /// Bounded: browsing a big drive touches thousands of files. At the
    /// limit the expired go, and if that is not enough, all but the half
    /// with the most time left — so a prune comes once per half-limit of new
    /// links, not with every one.
    private func keep(_ link: Link, for fileId: String) {
        if links[fileId] == nil, links.count >= linkLimit {
            let now = Date()
            links = links.filter { $0.value.freshUntil > now }
            if links.count > linkLimit / 2 {
                let kept = links.sorted { $0.value.freshUntil > $1.value.freshUntil }.prefix(linkLimit / 2)
                links = Dictionary(uniqueKeysWithValues: kept.map { ($0.key, $0.value) })
            }
        }
        links[fileId] = link
    }

    /// After the access changed: no link fetched under the old one is used
    /// again, and no fetch under way is kept.
    private func forgetLinks() {
        links = [:]
        fetching = [:]
    }

    /// The files a page changed: renamed, moved, replaced or gone, their
    /// links may name a key that no longer holds them.
    private func forgetLinks(for diff: Replica.Diff) {
        for id in diff.updated + diff.deleted where Replica.folderPath(ofID: id) == nil {
            links[id] = nil
            fetching[id] = nil
        }
    }
}
