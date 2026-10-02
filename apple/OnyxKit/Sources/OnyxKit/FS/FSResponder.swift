import Foundation

// The onyxfs half of the bridge: what the app answers when the FSKit
// extension asks about one drive mounted as a disk (bridge protocol v1, the
// read side).
//
// Pure, like DAVResponder — no sockets. FSBridge checks the session and hands
// each request to the responder for the session's own drive, so a session
// only ever reaches that drive. What a drive holds is what its mirror holds:
// the server's access-checked feed. A file is found there before anything is
// signed for it — authorize, filter, presign — and bytes come either from the
// copy kept on this Mac or, by a presigned link, straight from storage.

/// What the onyxfs bridge answers one drive from: its tree and its bytes.
/// MirrorFSSource is the app's — the drive's mirror, the pin store and
/// presigned links.
public protocol FSSource: Sendable {
    /// The drive now, read together: the mirror's index, this Mac's overlay,
    /// and a revision that moves whenever either may show something new, and
    /// never goes back.
    func snapshot() async -> FSSnapshot
    /// Returns once the revision is past `revision`, or `timeout` has gone
    /// by, whichever is first.
    func waitForChange(after revision: UInt64, timeout: Duration) async
    /// Which of `entries` are kept offline at their current version, from
    /// the records alone: a listing asks about thousands at once.
    func keptOffline(_ entries: [MirrorEntry]) async -> Set<String>
    /// The file's offline copy, checked on disk; nil to stream it instead.
    func localCopy(of entry: MirrorEntry) async -> URL?
    /// A presigned link to the file's bytes in storage, with a quarter of an
    /// hour left at least. Throws what the server said when it gives none.
    func remoteLink(for entry: MirrorEntry) async throws -> FSRemoteLink
    /// The drive's name and what this account may do in it, as the app
    /// knows them now.
    func volumeInfo() async -> FSVolumeInfo
    /// The drive's disk icon, an .icns (DriveIcon); nil for none.
    func volumeIcon() async -> Data?
    /// Finder is about to list `path` (mounted, "" for the drive): what is
    /// fetched only when looked at — the Collections folder — is fetched now.
    func listed(_ path: String) async
}

extension FSSource {
    public func volumeIcon() async -> Data? { nil }
    public func listed(_ path: String) async {}
}

public struct FSSnapshot: Sendable {
    public var revision: UInt64
    public var index: MirrorIndex
    public var overlay: FSOverlay
    /// The drive's collections as read-only folders (FSCollections).
    public var collections: FSCollections

    public init(revision: UInt64, index: MirrorIndex, overlay: FSOverlay = .none, collections: FSCollections = .none) {
        self.revision = revision; self.index = index; self.overlay = overlay; self.collections = collections
    }
}

public struct FSRemoteLink: Sendable, Equatable {
    public var url: URL
    public var expiresAt: Date

    public init(url: URL, expiresAt: Date) {
        self.url = url; self.expiresAt = expiresAt
    }
}

public struct FSVolumeInfo: Sendable, Equatable {
    /// What the disk is called: the drive's name.
    public var name: String
    /// True unless this account may add files to the drive. The server
    /// checks every write again either way.
    public var readOnly: Bool
    /// The drive's capacity, when there is one to report; 0 is unknown, and
    /// the extension then reports plenty free.
    public var totalBytes: Int64
    /// How much of what it streams the extension may keep; 0 when the person
    /// chose no limit in Settings.
    public var cacheLimitBytes: Int64

    public init(name: String, readOnly: Bool, totalBytes: Int64 = 0, cacheLimitBytes: Int64) {
        self.name = name; self.readOnly = readOnly; self.totalBytes = totalBytes
        self.cacheLimitBytes = cacheLimitBytes
    }
}

/// Answers the onyxfs extension about one drive: listings, stats, where a
/// file's bytes are, the bytes of a file kept offline, what changed, and the
/// disk's figures. Every answer is JSON; so is every error, as
/// `{ "error": "<sentence>" }`.
public struct FSResponder: Sendable {
    /// The drive, as SyncDomain.identifier.
    public let scope: String
    let source: any FSSource
    let log: FSChangeLog

    /// `firstGeneration`: where this drive's generations start. By default
    /// the time in milliseconds, so a generation handed out before — by an
    /// earlier launch, or an earlier mount of the drive — is always older
    /// than any current one, and answered with `all: true`.
    public init(scope: String, source: any FSSource, firstGeneration: UInt64 = FSChangeLog.launchGeneration()) {
        self.scope = scope
        self.source = source
        log = FSChangeLog(source: source, firstGeneration: firstGeneration)
    }

    /// The longest a `changes` long-poll is held, whatever it asks for: it
    /// holds one of the bridge's connections while it waits.
    public static let longestWait: TimeInterval = 60

    // MARK: - Endpoints

    /// `POST /fs/v1/session`, once FSBridge has traded the ticket for `key`.
    func sessionAnswer(key: String) async -> DAVResponse {
        let (generation, view) = await log.current()
        let info = await source.volumeInfo()
        return Self.json(200, SessionJSON(session: key, generation: generation,
                                          volume: volumeJSON(info, view), cacheLimitBytes: max(0, info.cacheLimitBytes)))
    }

    /// `GET /fs/v1/list?path=`: the folder's entries, folders first, then
    /// files, each by name. 404 when there is no such folder.
    func list(path raw: String?) async -> DAVResponse {
        guard let raw, let path = Self.mountedPath(raw) else { return Self.badPath }
        await source.listed(path)
        let (generation, view) = await log.current()
        guard let kids = view.children(of: path) else { return Self.error(404, "There is no such folder.") }
        let local = await keptOffline(kids)
        return Self.json(200, ListJSON(path: Self.wirePath(path), generation: generation,
                                       entries: kids.map { EntryJSON($0, local: local) }))
    }

    /// `GET /fs/v1/stat?path=`: one entry; `/` is the drive itself, named
    /// after it.
    func stat(path raw: String?) async -> DAVResponse {
        guard let raw, let path = Self.mountedPath(raw) else { return Self.badPath }
        let (generation, view) = await log.current()
        guard let node = view.node(at: path) else { return Self.error(404, "There is no such file or folder.") }
        let local = await keptOffline([node])
        var entry = EntryJSON(node, local: local)
        if path.isEmpty {
            let info = await source.volumeInfo()
            entry.name = Self.volumeName(info.name)
        }
        return Self.json(200, StatJSON(generation: generation, entry: entry))
    }

    /// `GET /fs/v1/source?id=`: where to read a file from — this Mac (then
    /// through `/data`), or storage by a presigned link.
    func source(id: String?) async -> DAVResponse {
        guard let id, !id.isEmpty else { return Self.error(400, "The file id is missing.") }
        // Found in this drive first: nothing is signed for a file the
        // session's drive does not show.
        let (_, view) = await log.current()
        guard let node = view.file(id: id) else { return Self.error(404, "There is no such file.") }
        if let url = await localURL(of: node), let size = DAVResponder.regularFileSize(url) {
            return Self.json(200, SourceJSON(kind: "local", url: nil, expiresAt: nil, size: size, version: node.version))
        }
        guard let entry = node.mirrorEntry else { return Self.unavailable }
        do {
            let link = try await source.remoteLink(for: entry)
            return Self.json(200, SourceJSON(kind: "remote", url: link.url.absoluteString,
                                             expiresAt: Int64(link.expiresAt.timeIntervalSince1970.rounded(.down)),
                                             size: node.size, version: node.version))
        } catch {
            return Self.refusal(error)
        }
    }

    /// `GET /fs/v1/data?id=` (Range welcome): the bytes of a file kept on
    /// this Mac; a file that is not is a 307 to storage.
    func data(id: String?, range: String?) async -> DAVResponse {
        guard let id, !id.isEmpty else { return Self.error(400, "The file id is missing.") }
        let (_, view) = await log.current()
        guard let node = view.file(id: id) else { return Self.error(404, "There is no such file.") }
        if let url = await localURL(of: node), let served = Self.serveLocal(url, node: node, range: range) {
            return served
        }
        guard let entry = node.mirrorEntry else { return Self.unavailable }
        do {
            let link = try await source.remoteLink(for: entry)
            // Presigned and short-lived: never let anything keep it.
            return DAVResponse(status: 307, headers: [("Location", link.url.absoluteString), ("Cache-Control", "no-store")])
        } catch {
            return Self.refusal(error)
        }
    }

    /// `GET /fs/v1/changes?since=&wait=`: the folders whose listing changed
    /// since that generation, as soon as there are any, or none after
    /// `wait` seconds.
    func changes(since raw: String?, wait rawWait: String?) async -> DAVResponse {
        guard let raw, let since = UInt64(raw) else { return Self.error(400, "since must be a generation.") }
        var wait: TimeInterval = 0
        if let rawWait {
            guard let seconds = Double(rawWait), seconds.isFinite, seconds >= 0 else {
                return Self.error(400, "wait must be a number of seconds.")
            }
            wait = min(seconds, Self.longestWait)
        }
        let answer = await log.changes(since: since, wait: .milliseconds(Int64(wait * 1000)))
        return Self.json(200, ChangesJSON(generation: answer.generation, all: answer.all,
                                          paths: answer.paths.map(Self.wirePath)))
    }

    /// Whether a write may not touch `raw` (a wire path): it, or the nearest
    /// folder above it that exists, is locked (FSView.isLocked). An unreadable
    /// path is not locked here; the write turns it down on its own.
    func isLocked(_ raw: String) async -> Bool {
        guard let path = Self.mountedPath(raw) else { return false }
        let (_, view) = await log.current()
        return view.isLocked(path)
    }

    /// `GET /fs/v1/volume`: the disk's figures, now.
    func volume() async -> DAVResponse {
        let (_, view) = await log.current()
        return Self.json(200, volumeJSON(await source.volumeInfo(), view))
    }

    /// `GET /fs/v1/icon`: the drive's disk icon, an .icns, which the extension
    /// puts where macOS looks for a disk's own. 404 when it has none.
    func icon() async -> DAVResponse {
        guard let icon = await source.volumeIcon(), !icon.isEmpty else { return Self.error(404, "This drive has no icon.") }
        return DAVResponse(status: 200, headers: [("Content-Type", "image/icns"), ("Cache-Control", "no-store")],
                           body: .data(icon))
    }

    // MARK: - Pieces

    private func volumeJSON(_ info: FSVolumeInfo, _ view: FSView) -> VolumeJSON {
        VolumeJSON(scope: scope, name: Self.volumeName(info.name), readOnly: info.readOnly,
                   totalBytes: max(0, info.totalBytes), usedBytes: view.index.byteCount,
                   fileCount: view.index.fileCount)
    }

    /// The ids of the files among `nodes` kept on this Mac: pending uploads
    /// by where they were staged, the mirror's by the pin store's records.
    private func keptOffline(_ nodes: [FSNode]) async -> Set<String> {
        let mirrorFiles = nodes.compactMap { $0.isFolder || $0.staged != nil ? nil : $0.mirrorEntry }
        return mirrorFiles.isEmpty ? [] : await source.keptOffline(mirrorFiles)
    }

    /// Where the file's bytes are on this Mac, if they are: staged, for one
    /// the overlay holds, else its offline copy, checked on disk.
    private func localURL(of node: FSNode) async -> URL? {
        if let staged = node.staged { return staged }
        guard let entry = node.mirrorEntry else { return nil }
        return await source.localCopy(of: entry)
    }

    /// A local file, or a range of it. Sized from the file on disk, as
    /// DAVResponder does: the bytes served and the length promised come from
    /// the same place. Nil when it is not a readable file after all.
    static func serveLocal(_ url: URL, node: FSNode, range: String?) -> DAVResponse? {
        guard let size = DAVResponder.regularFileSize(url) else { return nil }
        var headers: [(String, String)] = [
            ("Accept-Ranges", "bytes"),
            ("Content-Type", "application/octet-stream"),
            ("ETag", "\"\(node.version)\""),
        ]
        switch DAVResponder.byteRange(range, size: size) {
        case .whole:
            return DAVResponse(status: 200, headers: headers, body: .file(url, offset: 0, length: size))
        case let .partial(first, last):
            headers.append(("Content-Range", "bytes \(first)-\(last)/\(size)"))
            return DAVResponse(status: 206, headers: headers, body: .file(url, offset: first, length: last - first + 1))
        case .unsatisfiable:
            var refused = Self.error(416, "The range is outside the file.")
            refused.headers.append(("Content-Range", "bytes */\(size)"))
            return refused
        }
    }

    /// What the server said when it would not sign a link: a file it no
    /// longer has, or has no copy of, as such; anything else — offline, a
    /// hiccup — as worth another try.
    static func refusal(_ error: Error) -> DAVResponse {
        if case let OnyxError.http(status, message)? = error as? OnyxError {
            if status == 404 { return Self.error(404, "This file is no longer on the server.") }
            if status == 409 { return Self.error(409, message ?? "This file has no stored copy to read.") }
        }
        return unavailable
    }

    // MARK: - Paths

    /// A path as the protocol writes it ("/", "/a/b") as a mounted path (""
    /// for the drive, "a/b"), or nil when it breaks the rules: absolute, no
    /// trailing slash but the root's, no empty, "." or ".." segment, no NUL.
    /// Case and all are kept; FSView matches it exactly.
    static func mountedPath(_ raw: String) -> String? {
        guard raw.hasPrefix("/") else { return nil }
        if raw == "/" { return "" }
        let rest = raw.dropFirst()
        let segments = rest.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.unicodeScalars.contains("\0") })
        else { return nil }
        return String(rest)
    }

    /// A mounted path as the protocol writes it: absolute, NFC.
    static func wirePath(_ path: String) -> String {
        "/" + path.precomposedStringWithCanonicalMapping
    }

    static func wireName(_ name: String) -> String { name.precomposedStringWithCanonicalMapping }

    /// The drive's name as the disk's: what a file system takes for a name
    /// (MirrorIndex.safeName — "Q1/Q2" is "Q1:Q2", which Finder shows as
    /// "Q1/Q2"), in NFC. The same in the resource URL, `volume` and the
    /// root's `stat`, so the probe and the mounted disk agree.
    public static func volumeName(_ name: String) -> String {
        wireName(MirrorIndex.safeName(name))
    }

    // MARK: - JSON

    static let badPath = FSResponder.error(400, "The path must be absolute, with no empty, \".\" or \"..\" parts and no trailing slash.")

    /// Retry-able: the extension backs off and asks again.
    static let unavailable: DAVResponse = {
        var r = FSResponder.error(503, "Not available right now.")
        r.headers.append(("Retry-After", "5"))
        return r
    }()

    static func error(_ status: Int, _ message: String) -> DAVResponse {
        json(status, ErrorJSON(error: message))
    }

    static func json<T: Encodable>(_ status: Int, _ value: T) -> DAVResponse {
        let encoder = JSONEncoder()
        // Sorted, so an answer is the same bytes every time; slashes as they
        // are, so paths and links read as themselves.
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let body = try? encoder.encode(value) else {
            return DAVResponse(status: 500, headers: [("Content-Type", "application/json")],
                               body: .data(Data(#"{"error":"The answer could not be written."}"#.utf8)))
        }
        return DAVResponse(status: status, headers: [("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                           body: .data(body))
    }

    /// An Entry, as the protocol has it. `id` is written as null for a
    /// folder, not left out.
    struct EntryJSON: Encodable {
        var name: String
        let type: String
        let id: String?
        let size: Int64
        let mtime: Double
        /// When the file was made (its birth time), seconds since 1970.
        let btime: Double
        let version: String
        let local: Bool
        let pending: Bool
        /// Sent only when true, so every other entry reads as it always did.
        let readOnly: Bool

        init(_ node: FSNode, local keptOffline: Set<String>) {
            name = FSResponder.wireName(node.name)
            type = node.isFolder ? "dir" : "file"
            id = node.isFolder ? nil : node.fileId
            size = node.isFolder ? 0 : node.size
            let t = node.modified.timeIntervalSince1970
            mtime = t.isFinite ? t : 0
            let b = node.created.timeIntervalSince1970
            btime = b.isFinite ? b : mtime
            version = node.version
            local = !node.isFolder && (node.staged != nil || node.fileId.map(keptOffline.contains) == true)
            pending = node.pending
            readOnly = node.readOnly
        }

        enum CodingKeys: String, CodingKey { case name, type, id, size, mtime, btime, version, local, pending, readOnly }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(name, forKey: .name)
            try c.encode(type, forKey: .type)
            if let id { try c.encode(id, forKey: .id) } else { try c.encodeNil(forKey: .id) }
            try c.encode(size, forKey: .size)
            try c.encode(mtime, forKey: .mtime)
            try c.encode(btime, forKey: .btime)
            try c.encode(version, forKey: .version)
            try c.encode(local, forKey: .local)
            try c.encode(pending, forKey: .pending)
            if readOnly { try c.encode(true, forKey: .readOnly) }
        }
    }

    struct VolumeJSON: Encodable {
        let scope: String
        let name: String
        let readOnly: Bool
        let totalBytes: Int64
        let usedBytes: Int64
        let fileCount: Int
    }

    struct SessionJSON: Encodable {
        let session: String
        let generation: UInt64
        let volume: VolumeJSON
        let cacheLimitBytes: Int64
    }

    struct ListJSON: Encodable {
        let path: String
        let generation: UInt64
        let entries: [EntryJSON]
    }

    struct StatJSON: Encodable {
        let generation: UInt64
        let entry: EntryJSON
    }

    struct SourceJSON: Encodable {
        let kind: String
        /// Remote only; left out for a local file.
        let url: String?
        let expiresAt: Int64?
        let size: Int64
        let version: String
    }

    struct ChangesJSON: Encodable {
        let generation: UInt64
        let all: Bool
        let paths: [String]
    }

    struct ErrorJSON: Encodable {
        let error: String
    }
}

/// Which listings changed, generation by generation, for one drive: what
/// `changes` answers from, and where every answer's `generation` comes from.
///
/// A generation moves each time the drive shows something new — a folder's
/// listing that is not what it was — and at no other time, so a change the
/// extension could not see wakes nobody. The first question after a change
/// works out which folders it touched, once, by comparing the tree before
/// and after (FSView.changedFolders); every answer after reads what was kept.
public actor FSChangeLog {
    public private(set) var generation: UInt64
    /// The oldest generation a precise answer can be given from; anything
    /// older, or unknown, is told to drop everything.
    private var floor: UInt64
    private var seenRevision: UInt64?
    private var view: FSView?
    private var steps: [Step] = []
    private var keptPaths = 0
    private let source: any FSSource

    /// One generation's move: the folders it changed, or nil for "all".
    private struct Step {
        let to: UInt64
        let paths: Set<String>?
    }

    struct Answer: Equatable {
        let generation: UInt64
        let all: Bool
        /// Mounted paths, sorted; empty when `all`.
        let paths: [String]
    }

    /// Kept for this many generations, and this many folders over all of
    /// them; past either the oldest go, and a client that far behind drops
    /// everything instead.
    static let maxSteps = 256
    static let maxPaths = 50_000
    /// More folders than this, in one move or in one answer, is answered as
    /// "all": the extension lists afresh as it goes, rather than invalidate
    /// thousands one by one.
    static let allAbove = 1_000

    /// The time in milliseconds: see FSResponder.init.
    public static func launchGeneration() -> UInt64 {
        UInt64(max(1, (Date().timeIntervalSince1970 * 1000).rounded(.down)))
    }

    init(source: any FSSource, firstGeneration: UInt64) {
        self.source = source
        generation = firstGeneration
        floor = firstGeneration
    }

    /// The drive now, and its generation.
    func current() async -> (generation: UInt64, view: FSView) {
        let snapshot = await source.snapshot()
        // Another question may have got here first, with this or a later
        // revision, while this one waited for the snapshot.
        if let view, let seen = seenRevision, snapshot.revision <= seen { return (generation, view) }
        let fresh = FSView(index: snapshot.index, overlay: snapshot.overlay, collections: snapshot.collections)
        if let view {
            let changed = FSView.changedFolders(from: view, to: fresh)
            if !changed.isEmpty {
                generation += 1
                record(Step(to: generation, paths: changed.count > Self.allAbove ? nil : changed))
            }
        }
        seenRevision = snapshot.revision
        view = fresh
        return (generation, fresh)
    }

    /// What changed since `since`, waiting up to `wait` for something to
    /// when nothing has yet. Holds nothing while it waits.
    func changes(since: UInt64, wait: Duration) async -> Answer {
        var now = await current().generation
        if since == now, wait > .zero {
            let deadline = ContinuousClock.now + wait
            while now == since, ContinuousClock.now < deadline, !Task.isCancelled {
                await source.waitForChange(after: seenRevision ?? 0, timeout: deadline - ContinuousClock.now)
                // A change nobody can see (the pins, a field no entry shows)
                // leaves the generation where it was: wait on.
                now = await current().generation
            }
        }
        return answer(since: since, at: now)
    }

    private func answer(since: UInt64, at now: UInt64) -> Answer {
        let all = Answer(generation: now, all: true, paths: [])
        if since == now { return Answer(generation: now, all: false, paths: []) }
        if since > now || since < floor { return all }
        var paths = Set<String>()
        for step in steps where step.to > since {
            guard let moved = step.paths else { return all }
            paths.formUnion(moved)
            if paths.count > Self.allAbove { return all }
        }
        return Answer(generation: now, all: false, paths: paths.sorted())
    }

    private func record(_ step: Step) {
        steps.append(step)
        keptPaths += step.paths?.count ?? 0
        while steps.count > Self.maxSteps || (keptPaths > Self.maxPaths && steps.count > 1) {
            let dropped = steps.removeFirst()
            keptPaths -= dropped.paths?.count ?? 0
            floor = dropped.to
        }
    }
}
