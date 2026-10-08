import Foundation
import UniformTypeIdentifiers

/// The server's write routes as the drive writer needs them — OnyxAPI in
/// the app, a fake in tests.
public protocol DriveWriteAPI: Sendable {
    func updateFile(id: String, name: String?, folder: String?, filespaceId: String?) async throws
    func deleteFile(id: String) async throws
    func createFolder(path: String, filespaceId: String?) async throws
    func moveFolder(from: String, to: String, filespaceId: String?) async throws
    func deleteFolder(path: String, filespaceId: String?) async throws
}

extension OnyxAPI: DriveWriteAPI {}

/// What is in the drive now, as its mirror has it.
public protocol DriveTree: Sendable {
    /// The item at a path within the drive ("/Footage/Take 1.mov"): a file
    /// (with its id) or a folder; nil when there is none.
    func item(at path: String) async -> DriveItem?
    /// When the file at `path` last changed, by the server's clock (its
    /// updatedAt); nil when there is no file there.
    func changed(at path: String) async -> Date?
    /// Bring the mirror up to date now, after a change made here, so the
    /// next listing already shows it.
    func refresh() async
    /// Bring the mirror up to date before long: after an upload finishes,
    /// whose file is listed meanwhile (pending, read from this Mac's copy).
    /// The app's syncs at most once a second, however many finish, and
    /// tells the writer when the mirror has moved (`mirrorChanged`).
    func refreshSoon() async
    /// The folder at `path` as the server names it, where the mirror shows
    /// it under a name of its own (MirrorEntry.serverPath); "" for the drive
    /// itself, nil when there is no folder there.
    func serverPath(at path: String) async -> String?
}

extension DriveTree {
    /// A tree whose names are the server's own.
    public func serverPath(at path: String) async -> String? { nil }
    /// A tree that can only be brought up to date now. Whoever keeps it
    /// tells the writer when it has moved, as the app does (`mirrorChanged`).
    public func refreshSoon() async { await refresh() }
}

public enum DriveItem: Sendable, Equatable {
    case file(id: String)
    case folder
}

/// Finder's changes to a drive mounted as a disk (onyxfs), made on the
/// server — so the web shows exactly what Finder does.
///
/// - A file copied in goes to the upload queue, and is listed at once as
///   pending (its bytes read back from the queue's copy) until the server
///   has it. Written over a file already there — or moved over one, as an
///   app saves — it becomes that file's new contents: the same file on the
///   web, with its tags, comments and links.
/// - A rename, move or delete of a file still uploading changes where it
///   will land, or stops it; of anything else, is the server's own rename,
///   move or delete (to the trash when the web's trash is on).
/// - After each change the mirror is brought up to date before answering,
///   so Finder's next look at the folder already agrees with the web.
///
/// Who may do what is the server's: its 403 comes back as a Failure with
/// its sentence, which Finder shows as "you don't have permission".
public actor DriveWriter {
    public enum Failure: Error, Equatable {
        /// errno for the file system; `message` for the log and the menu.
        case posix(Int32, String?)
    }

    public struct Pending: Sendable, Equatable {
        public let job: UUID
        public var path: String
        public let size: Int64
        public let staged: String
        public let modified: Date
        /// Its birth time where it was written, if the writer said.
        public var created: Date? = nil
        public var failed: String?
        /// The server's file whose contents these become, if any.
        public var replaceOf: String? = nil
    }

    /// An upload the server has, the mirror not yet: its file (nil when an
    /// attempt whose answer was lost recorded it), and when it changed.
    struct Arrival: Sendable, Equatable {
        let id: String?
        let changedAt: Date?
    }

    let scope: String
    let filespaceId: String?
    let api: any DriveWriteAPI
    let tree: any DriveTree
    let uploads: UploadQueue
    private var pending: [String: Pending] = [:] {
        didSet { revision &+= 1 }
    }
    /// Each pending file's path, by its job: the queue's news names the job,
    /// and a thousand files on their way are not searched for each.
    private var jobPaths: [UUID: String] = [:]
    /// Uploads recorded, not yet in the mirror, by path.
    private var arrived: [String: Arrival] = [:]
    /// Moves whenever the pending files change, so the bridge's view of the
    /// drive (mirror + overlay) moves with it.
    public private(set) var revision: UInt64 = 0

    public init(scope: String, filespaceId: String?, api: any DriveWriteAPI, tree: any DriveTree, uploads: UploadQueue) {
        self.scope = scope
        self.filespaceId = filespaceId
        self.api = api
        self.tree = tree
        self.uploads = uploads
    }

    // MARK: - Listing

    /// Files copied in and not yet on the server, for the bridge to list.
    public func pendingFiles() -> [Pending] { Array(pending.values) }

    /// The pending files as the bridge lays them over the mirror: listed
    /// at their paths, read from their staged copies, under an id of their
    /// own until the server gives them theirs.
    public func overlay() -> (FSOverlay, UInt64) {
        let nodes = pending.values.map { file in
            FSNode(path: Self.relative(file.path), name: (file.path as NSString).lastPathComponent, isFolder: false,
                   fileId: Self.pendingID(file.job), size: file.size, modified: file.modified,
                   content: "pending:\(file.job.uuidString):\(file.size)", pending: true,
                   staged: URL(fileURLWithPath: file.staged), created: file.created)
        }
        return (FSOverlay(nodes: nodes), revision)
    }

    /// The id a pending file answers to at the bridge ("pending:<job>").
    public static func pendingID(_ job: UUID) -> String { "pending:\(job.uuidString)" }

    public func pending(at path: String) -> Pending? { pending[path] }

    // MARK: - Changes

    /// A file written in Finder, whole: its bytes at `file` (taken by the
    /// upload queue). An existing file at `path` is replaced.
    @discardableResult
    /// `modified` and `created` are the dates the file had where it was
    /// written — Finder's copy keeps a file's — and go to the server with it.
    public func putFile(path: String, from file: URL, modified: Date? = nil, created: Date? = nil) async throws -> Pending {
        let (shown, name) = try Self.split(path)
        let folder = await serverFolder(shown)
        let existing = await tree.item(at: path)
        if existing == .folder { throw Failure.posix(EISDIR, nil) }
        var replaceOf: String?
        if case let .file(id)? = existing { replaceOf = id }
        if let waiting = unlist(path) {
            // Written again before the first copy arrived: only the latest
            // goes — as new contents for the file the first became, if it has.
            if let id = await arrivedFile(waiting) {
                replaceOf = id
                await uploads.release(waiting.job)
            } else {
                await uploads.cancel(waiting.job)
                replaceOf = replaceOf ?? waiting.replaceOf
            }
            arrived[path] = nil
        }
        let mime = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let job: UploadJob
        do {
            job = try await uploads.enqueue(from: file, scope: scope, filespaceId: filespaceId, folder: folder, name: name,
                                            mime: mime, replaceOf: replaceOf, created: created, modified: modified)
        } catch {
            throw Failure.posix(EIO, error.localizedDescription)
        }
        let entry = Pending(job: job.id, path: path, size: job.size, staged: job.staged,
                            modified: modified ?? Date(), created: created, failed: nil, replaceOf: replaceOf)
        list(entry)
        return entry
    }

    public func mkdir(path: String) async throws {
        switch await tree.item(at: path) {
        case .folder?: return
        case .file?: throw Failure.posix(EEXIST, nil)
        case nil: break
        }
        let made = await serverFolder(path)
        try await server { try await self.api.createFolder(path: made, filespaceId: self.filespaceId) }
        // The bridge answers a new folder with its entry, read from the
        // mirror: without this it is not there yet, and Finder is told the
        // folder it just made does not exist.
        await tree.refresh()
    }

    /// `replace`: a file already at `to` gives way (how an app saves: write
    /// a new copy, then move it over the old).
    public func rename(from: String, to: String, replace: Bool) async throws {
        guard from != to else { return }
        let target = await tree.item(at: to) ?? pending[to].map { .file(id: "pending:\($0.job)") }
        if target != nil, !replace { throw Failure.posix(EEXIST, nil) }
        let (newFolder, newName) = try Self.split(to)
        if target == .folder, pending[from] != nil { throw Failure.posix(EISDIR, nil) }

        if let moving = pending[from], let id = await arrivedFile(moving) {
            // Uploaded a moment ago: it is a file on the server now.
            unlist(from)
            arrived[from] = nil
            try await renameFile(id, from: from, to: to, over: target)
            await tree.refresh()
            await uploads.release(moving.job)
            return
        }
        if let moving = pending[from] {
            // Still uploading: it lands at the new place instead. Moved over
            // a file, it becomes that file's new contents (an app's save).
            var over: String?
            if case let .file(id)? = await tree.item(at: to) { over = id }
            if let other = unlist(to) {
                if let id = await arrivedFile(other) {
                    over = id
                    await uploads.release(other.job)
                } else {
                    await uploads.cancel(other.job)
                    over = over ?? other.replaceOf
                }
                arrived[to] = nil
            }
            var replacing = over
            if let replaced = moving.replaceOf {
                // New contents for a file the server has: that file moves,
                // and the contents follow it.
                try await renameFile(replaced, from: from, to: to, over: over.map { .file(id: $0) })
                replacing = replaced
            }
            let landing = await serverFolder(newFolder)
            await uploads.retarget(moving.job, folder: landing, name: newName, replacing: replacing)
            var moved = moving
            moved.path = to
            moved.replaceOf = replacing
            unlist(from)
            list(moved)
            if moving.replaceOf != nil { await tree.refresh() }
            return
        }

        switch await tree.item(at: from) {
        case nil:
            throw Failure.posix(ENOENT, nil)
        case .folder?:
            if target != nil { throw Failure.posix(EEXIST, "A folder cannot replace another item.") }
            let source = await serverFolder(from)
            let destination = await serverFolder(to)
            try await server { try await self.api.moveFolder(from: source, to: destination, filespaceId: self.filespaceId) }
            // Files still on their way into it go where it went. Else they
            // land in its old place — which the app that moved it may remove
            // next, taking them with it (Archive Utility does).
            for (path, moving) in pending where path.hasPrefix(from + "/") {
                let newPath = to + path.dropFirst(from.count)
                let (folder, name) = try Self.split(newPath)
                if await arrivedFile(moving) != nil {
                    // On the server already: the folder took it along.
                    unlist(path)
                    arrived[path] = nil
                    continue
                }
                await uploads.retarget(moving.job, folder: await serverFolder(folder), name: name, replacing: moving.replaceOf)
                var moved = moving
                moved.path = newPath
                unlist(path)
                list(moved)
            }
        case let .file(id)?:
            if target == .folder { throw Failure.posix(EISDIR, nil) }
            try await renameFile(id, from: from, to: to, over: target)
        }
        await tree.refresh()
    }

    private func renameFile(_ id: String, from: String, to: String, over target: DriveItem?) async throws {
        if case let .file(overID)? = target, overID != id, !overID.hasPrefix("pending:") {
            try await server { try await self.api.deleteFile(id: overID) }
        }
        let (oldFolder, oldName) = try Self.split(from)
        let (newFolder, newName) = try Self.split(to)
        // One call when only the name or only the folder changes; the
        // server's move keeps the name, so a move-and-rename is two.
        if oldFolder != newFolder {
            let folder = await serverFolder(newFolder)
            try await server { try await self.api.updateFile(id: id, name: nil, folder: folder, filespaceId: self.filespaceId) }
        }
        if oldName != newName {
            try await server { try await self.api.updateFile(id: id, name: newName, folder: nil, filespaceId: self.filespaceId) }
        }
    }

    public func delete(path: String) async throws {
        if let waiting = pending[path] {
            let uploaded = await arrivedFile(waiting)
            unlist(path)
            arrived[path] = nil
            if let id = uploaded {
                // Uploaded a moment ago: delete the file it became.
                try await server { try await self.api.deleteFile(id: id) }
                await tree.refresh()
                await uploads.release(waiting.job)
            } else {
                await uploads.cancel(waiting.job)
                if let replaced = waiting.replaceOf {
                    // Its old contents are still the server's: that file goes.
                    try await server { try await self.api.deleteFile(id: replaced) }
                    await tree.refresh()
                }
            }
            return
        }
        switch await tree.item(at: path) {
        case nil:
            throw Failure.posix(ENOENT, nil)
        case .folder?:
            let folder = await serverFolder(path)
            do {
                try await server { try await self.api.deleteFolder(path: folder, filespaceId: self.filespaceId) }
            } catch let Failure.posix(code, message) where code == EEXIST {
                // The server's 409: the folder holds files this account was
                // never shown, and nothing was deleted. Finder says "not empty".
                throw Failure.posix(ENOTEMPTY, message)
            }
        case let .file(id)?:
            try await server { try await self.api.deleteFile(id: id) }
        }
        await tree.refresh()
    }

    // MARK: - Uploads finishing

    /// The upload queue's news about one of this drive's jobs. Only what
    /// changes the listing moves `revision`: a job going from waiting to
    /// sending, a thousand times over, is not news to Finder.
    public func uploadChanged(_ job: UploadJob) async {
        guard job.scope == scope, let path = jobPaths[job.id], let entry = pending[path] else { return }
        switch job.state {
        case .done:
            arrived[path] = Arrival(id: job.fileId ?? entry.replaceOf, changedAt: job.changedAt)
            // Before long, however many finish at once (DriveTree.refreshSoon).
            // The file stays listed meanwhile, read from its copy here, and
            // leaves pending once the mirror shows it (mirrorChanged).
            await tree.refreshSoon()
        case .failed:
            if entry.failed != job.lastError { pending[path]?.failed = job.lastError }
        default:
            if entry.failed != nil { pending[path]?.failed = nil }
        }
    }

    /// The mirror moved on: pending files it now holds — the change itself,
    /// not just a file by that name — are no longer pending (checked
    /// against the mirror, so a listing never loses a file, or shows its
    /// old bytes, between "uploaded" and "synced").
    public func mirrorChanged() async {
        for (path, arrival) in arrived {
            guard case let .file(found)? = await tree.item(at: path), arrival.id == nil || found == arrival.id else { continue }
            if let changedAt = arrival.changedAt, let shown = await tree.changed(at: path), shown < changedAt { continue }
            arrived[path] = nil
            // The mirror shows the server's copy now: Finder reads that,
            // and the staged one can go.
            if let job = unlist(path)?.job { await uploads.release(job) }
        }
    }

    /// A file on its way, listed at its path.
    private func list(_ entry: Pending) {
        if let other = pending.updateValue(entry, forKey: entry.path), other.job != entry.job {
            jobPaths[other.job] = nil
        }
        jobPaths[entry.job] = entry.path
    }

    /// No longer listed at `path`: arrived, cancelled or moved.
    @discardableResult
    private func unlist(_ path: String) -> Pending? {
        guard let entry = pending.removeValue(forKey: path) else { return nil }
        if jobPaths[entry.job] == path { jobPaths[entry.job] = nil }
        return entry
    }

    /// The file a pending upload became, once the server has it.
    private func arrivedFile(_ file: Pending) async -> String? {
        if let id = await uploads.fileId(for: file.job) { return id }
        guard let arrival = arrived[file.path] else { return nil }
        if let id = arrival.id { return id }
        // Recorded by an attempt whose answer was lost: the mirror has its id.
        await tree.refresh()
        if case let .file(found)? = await tree.item(at: file.path) { return found }
        return nil
    }

    // MARK: -

    private func server(_ call: () async throws -> Void) async throws {
        do {
            try await call()
        } catch let OnyxError.http(status, message) {
            switch status {
            // Refused as asked: most often a name the server will not take
            // (lib/folder-ops.js), which Finder says is a name it cannot use.
            case 400: throw Failure.posix(EINVAL, message)
            case 401, 403: throw Failure.posix(EACCES, message)
            case 404: throw Failure.posix(ENOENT, message)
            case 409: throw Failure.posix(EEXIST, message)
            case 413: throw Failure.posix(EDQUOT, message)
            default: throw Failure.posix(EIO, message)
            }
        } catch OnyxError.notAuthenticated {
            throw Failure.posix(EACCES, "Not signed in.")
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.posix(EIO, error.localizedDescription)
        }
    }

    /// "/Footage/Day 1/Take 1.mov" → ("Footage/Day 1", "Take 1.mov").
    static func split(_ path: String) throws -> (folder: String, name: String) {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard let name = parts.last, !parts.contains(".."), !parts.contains(".") else { throw Failure.posix(EINVAL, nil) }
        return (parts.dropLast().joined(separator: "/"), name)
    }

    /// The server names folders without the leading slash.
    static func relative(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: true).joined(separator: "/")
    }

    /// A folder path as Finder has it, as the server names it: the deepest
    /// folder along it that the mirror has, by its server path
    /// (DriveTree.serverPath) — a folder shown as "photos (2)" beside
    /// "Photos" is "photos" on the server — then the rest as given, for a
    /// folder not there yet (one being made, a move's new name). Without
    /// this a change to a folder shown under a name of its own reached a
    /// folder the server does not have.
    func serverFolder(_ path: String) async -> String {
        var known = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        var rest: [String] = []
        while !known.isEmpty {
            if let base = await tree.serverPath(at: known.joined(separator: "/")) {
                return ([base] + rest).filter { !$0.isEmpty }.joined(separator: "/")
            }
            rest.insert(known.removeLast(), at: 0)
        }
        return rest.joined(separator: "/")
    }
}

// The bridge's write routes land here (FSBridge.writer(for:)).
extension DriveWriter: FSWriteTarget {
    public func write(path: String, from file: URL, modified: Date?, created: Date?) async throws {
        _ = try await putFile(path: path, from: file, modified: modified, created: created)
    }

    public func makeFolder(path: String) async throws { try await mkdir(path: path) }

    public func move(from: String, to: String, replace: Bool) async throws {
        try await rename(from: from, to: to, replace: replace)
    }

    public func remove(path: String) async throws { try await delete(path: path) }
}
