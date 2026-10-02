import Foundation

/// One drive's collections, for its disk's read-only Collections folder
/// (FSCollections): which collections the drive has, and the files each
/// gathers, fetched from the server and found in the mirrors.
///
/// Nothing here polls. Finder listing the drive's top asks for the
/// collections (`listed`); listing a collection asks for its files. The first
/// time, the listing waits for the answer, so a folder does not open empty;
/// after that it is answered from what is held at once, and refreshed behind
/// it once what is held is older than `stale`. A drive that is mounted but
/// not looked at costs nothing.
///
/// Membership has no change feed — a tag set on the web moves no file row
/// the mirror would see — so what Finder shows is at most `stale` behind,
/// while it is being looked at.
public actor CollectionsFolder {
    /// Finds files by id in this Mac's other mirrors: an All Files
    /// collection gathers files from drives the library's mirror does not
    /// hold. Answers only for the ids it has.
    public typealias Elsewhere = @Sendable ([String]) async -> [String: MirrorEntry]

    let scope: SyncDomain
    let api: @Sendable () -> OnyxAPI
    let elsewhere: Elsewhere?
    /// How old what is held may be before a listing refreshes it.
    let stale: TimeInterval
    /// The most files shown for one collection: the listing's pages, up to here.
    let cap: Int

    private var collections: [FileCollection] = []
    private var listedAt: Date?
    private var files: [String: [String]] = [:]
    private var filesAt: [String: Date] = [:]
    private var inFlight: [String: Task<Void, Never>] = [:]
    /// Moves whenever what is held changes.
    public private(set) var revision: UInt64 = 0
    private var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var waitersSoFar = 0

    private var built: (mirror: UInt64, revision: UInt64, value: FSCollections)?

    public init(scope: SyncDomain, api: @escaping @Sendable () -> OnyxAPI, elsewhere: Elsewhere? = nil,
                stale: TimeInterval = 30, cap: Int = 10_000) {
        self.scope = scope
        self.api = api
        self.elsewhere = elsewhere
        self.stale = stale
        self.cap = cap
    }

    // MARK: - Asked for by the bridge

    /// Finder is listing `path` (mounted, "" for the drive): the top asks for
    /// the collections, a collection's folder for its files.
    public func listed(_ path: String, rootName: String) async {
        if path.isEmpty || path == rootName {
            await refresh("", waitFirst: listedAt == nil)
            return
        }
        guard path.hasPrefix(rootName + "/") else { return }
        let name = String(path.dropFirst(rootName.count + 1))
        guard !name.contains("/"), let id = shown?.first(where: { $0.name == name })?.id else { return }
        await refresh(id, waitFirst: filesAt[id] == nil)
    }

    /// The folders as they stand, with the mirror's `index` (revision
    /// `mirrorRevision`) to find the files in. Built again only when either
    /// has moved since.
    public func folders(index: MirrorIndex, mirrorRevision: UInt64) async -> FSCollections {
        if let built, built.mirror == mirrorRevision, built.revision == revision { return built.value }
        let mine = collections
        guard !mine.isEmpty else {
            built = (mirrorRevision, revision, .none)
            return .none
        }
        let wanted = mine.flatMap { files[$0.id] ?? [] }
        var found: [String: MirrorEntry] = [:]
        var missing: [String] = []
        for id in Set(wanted) {
            if let entry = index.file(id: id) { found[id] = entry } else { missing.append(id) }
        }
        if !missing.isEmpty, let elsewhere {
            for (id, entry) in await elsewhere(missing) where found[id] == nil { found[id] = entry }
        }
        let held = revision
        let root = FSCollections.rootName { name in index.entry(at: name) != nil }
        let folders = mine.map { c in
            FSCollections.Folder(id: c.id, name: c.name, entries: (files[c.id] ?? []).compactMap { found[$0] })
        }
        let value = FSCollections(folders, rootName: root)
        // Kept for the mirror and the files it was made from; anything that
        // moved meanwhile builds it again next time.
        built = (mirrorRevision, held, value)
        return value
    }

    /// The name the top folder would have now: before anything is built, the
    /// usual one.
    public var rootName: String { built?.value.rootName ?? FSCollections.folderName }

    /// Returns once `revision` is past `after`, or `timeout` has gone by, or
    /// the task is cancelled — as DriveMirror's own wait, which it is raced
    /// against (MirrorFSSource): a waiter is released either way, so the
    /// extension's long-polls never pile up here.
    public func waitForChange(after: UInt64, timeout: Duration) async {
        guard revision <= after, timeout > .zero, !Task.isCancelled else { return }
        waitersSoFar += 1
        let id = waitersSoFar
        let timer = Task { [weak self] in
            try? await Task.sleep(for: timeout, tolerance: .milliseconds(100))
            await self?.release(id)
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { waiters[id] = $0 }
        } onCancel: {
            Task { [weak self] in await self?.release(id) }
        }
        timer.cancel()
    }

    private func release(_ waiter: Int) {
        waiters.removeValue(forKey: waiter)?.resume()
    }

    // MARK: - Fetching

    /// The collections shown on this drive, as last fetched.
    private var shown: [FileCollection]? { listedAt == nil ? nil : collections }

    /// "" for the list of collections, else a collection's id.
    private func refresh(_ key: String, waitFirst: Bool) async {
        let at = key.isEmpty ? listedAt : filesAt[key]
        if let at, Date().timeIntervalSince(at) < stale { return }
        let task = inFlight[key] ?? Task { await self.fetch(key) }
        inFlight[key] = task
        if waitFirst {
            // Not forever: a slow server shows the folder empty, then fills it.
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await task.value }
                group.addTask { try? await Task.sleep(for: .seconds(4)) }
                await group.next()
                group.cancelAll()
            }
        }
    }

    private func fetch(_ key: String) async {
        defer { inFlight[key] = nil }
        let api = api()
        do {
            if key.isEmpty {
                let all = try await api.collections()
                let mine = all.filter { $0.scope == scope }
                listedAt = Date()
                if mine != collections {
                    collections = mine
                    // A collection no longer here takes its files with it.
                    let ids = Set(mine.map(\.id))
                    files = files.filter { ids.contains($0.key) }
                    filesAt = filesAt.filter { ids.contains($0.key) }
                    changed()
                }
            } else {
                var ids: [String] = []
                var cursor: String?
                repeat {
                    let page = try await api.listFiles(in: scope, folder: "", sort: .name, cursor: cursor, limit: 500,
                                                       collection: key)
                    ids += page.files.map(\.id)
                    cursor = page.cursor
                } while cursor != nil && ids.count < cap
                filesAt[key] = Date()
                if Array(ids.prefix(cap)) != files[key] {
                    files[key] = Array(ids.prefix(cap))
                    changed()
                }
            }
        } catch {
            // What was held stays; the next listing tries again. A collection
            // that is gone (404) empties when the list is fetched again.
            if key.isEmpty { listedAt = listedAt ?? Date.distantPast } else { filesAt[key] = filesAt[key] ?? Date.distantPast }
        }
    }

    private func changed() {
        revision &+= 1
        let woken = waiters
        waiters = [:]
        for w in woken.values { w.resume() }
    }

    // MARK: - Tests

    /// Collections and their files as if fetched, for tests.
    public func setForTesting(_ list: [FileCollection], files byCollection: [String: [String]]) {
        collections = list.filter { $0.scope == scope }
        files = byCollection
        listedAt = Date()
        for key in byCollection.keys { filesAt[key] = Date() }
        changed()
    }
}
