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
    /// Bring the mirror up to date now, after a change made here, so the
    /// next listing already shows it.
    func refresh() async
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
///   has it.
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
        public var failed: String?
    }

    let scope: String
    let filespaceId: String?
    let api: any DriveWriteAPI
    let tree: any DriveTree
    let uploads: UploadQueue
    private var pending: [String: Pending] = [:] {
        didSet { revision &+= 1 }
    }
    /// Uploads recorded, not yet in the mirror: path → file id.
    private var arrived: [String: String] = [:]
    /// A file saved over an existing one: once the new copy is recorded,
    /// the old one goes. (Until the server can replace a file's bytes in
    /// place, keeping its id — then this becomes that call.)
    private var replacing: [UUID: String] = [:]
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
                   staged: URL(fileURLWithPath: file.staged))
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
    public func putFile(path: String, from file: URL, modified: Date? = nil) async throws -> Pending {
        let (folder, name) = try Self.split(path)
        if let waiting = pending[path] {
            // Written again before the first copy arrived: only the latest goes.
            await uploads.cancel(waiting.job)
            pending[path] = nil
        }
        let existing = await tree.item(at: path)
        if existing == .folder { throw Failure.posix(EISDIR, nil) }
        let mime = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let job: UploadJob
        do {
            job = try await uploads.enqueue(from: file, scope: scope, filespaceId: filespaceId, folder: folder, name: name, mime: mime)
        } catch {
            throw Failure.posix(EIO, error.localizedDescription)
        }
        if case let .file(id)? = existing { replacing[job.id] = id }
        let entry = Pending(job: job.id, path: path, size: job.size, staged: job.staged,
                            modified: modified ?? Date(), failed: nil)
        pending[path] = entry
        return entry
    }

    public func mkdir(path: String) async throws {
        switch await tree.item(at: path) {
        case .folder?: return
        case .file?: throw Failure.posix(EEXIST, nil)
        case nil: break
        }
        try await server { try await self.api.createFolder(path: Self.relative(path), filespaceId: self.filespaceId) }
    }

    /// `replace`: a file already at `to` gives way (how an app saves: write
    /// a new copy, then move it over the old).
    public func rename(from: String, to: String, replace: Bool) async throws {
        guard from != to else { return }
        let target = await tree.item(at: to) ?? pending[to].map { .file(id: "pending:\($0.job)") }
        if target != nil, !replace { throw Failure.posix(EEXIST, nil) }
        let (newFolder, newName) = try Self.split(to)

        if let moving = pending[from], let id = await uploads.fileId(for: moving.job) {
            // Uploaded a moment ago: it is a file on the server now.
            pending[from] = nil
            arrived[from] = nil
            try await renameFile(id, from: from, to: to, over: target)
            await tree.refresh()
            await uploads.release(moving.job)
            return
        }
        if let moving = pending[from] {
            // Still uploading: it lands at the new place instead.
            if let over = pending[to] { await uploads.cancel(over.job); pending[to] = nil }
            if case let .file(id)? = await tree.item(at: to) { replacing[moving.job] = id }
            await uploads.retarget(moving.job, folder: newFolder, name: newName)
            var moved = moving
            moved.path = to
            pending[from] = nil
            pending[to] = moved
            return
        }

        switch await tree.item(at: from) {
        case nil:
            throw Failure.posix(ENOENT, nil)
        case .folder?:
            if target != nil { throw Failure.posix(EEXIST, "A folder cannot replace another item.") }
            try await server { try await self.api.moveFolder(from: Self.relative(from), to: Self.relative(to), filespaceId: self.filespaceId) }
        case let .file(id)?:
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
            try await server { try await self.api.updateFile(id: id, name: nil, folder: newFolder, filespaceId: self.filespaceId) }
        }
        if oldName != newName {
            try await server { try await self.api.updateFile(id: id, name: newName, folder: nil, filespaceId: self.filespaceId) }
        }
    }

    public func delete(path: String) async throws {
        if let waiting = pending[path] {
            pending[path] = nil
            arrived[path] = nil
            if let id = await uploads.fileId(for: waiting.job) {
                // Uploaded a moment ago: delete the file it became.
                try await server { try await self.api.deleteFile(id: id) }
                await tree.refresh()
                await uploads.release(waiting.job)
            } else {
                await uploads.cancel(waiting.job)
            }
            return
        }
        switch await tree.item(at: path) {
        case nil:
            throw Failure.posix(ENOENT, nil)
        case .folder?:
            try await server { try await self.api.deleteFolder(path: Self.relative(path), filespaceId: self.filespaceId) }
        case let .file(id)?:
            try await server { try await self.api.deleteFile(id: id) }
        }
        await tree.refresh()
    }

    // MARK: - Uploads finishing

    /// The upload queue's news about one of this drive's jobs.
    public func uploadChanged(_ job: UploadJob) async {
        guard job.scope == scope, let path = pending.first(where: { $0.value.job == job.id })?.key else { return }
        switch job.state {
        case .done:
            if let id = job.fileId { arrived[path] = id }
            if let old = replacing.removeValue(forKey: job.id), old != job.fileId {
                try? await api.deleteFile(id: old)
            }
            await tree.refresh()
            await mirrorChanged()
        case .failed:
            pending[path]?.failed = job.lastError
        default:
            pending[path]?.failed = nil
        }
    }

    /// The mirror moved on: pending files it now holds are no longer
    /// pending (checked against the mirror, so a listing never loses a file
    /// between "uploaded" and "synced").
    public func mirrorChanged() async {
        for (path, id) in arrived {
            if case let .file(found)? = await tree.item(at: path), found == id {
                arrived[path] = nil
                // The mirror shows the server's copy now: Finder reads that,
                // and the staged one can go.
                if let job = pending.removeValue(forKey: path)?.job { await uploads.release(job) }
            }
        }
    }

    // MARK: -

    private func server(_ call: () async throws -> Void) async throws {
        do {
            try await call()
        } catch let OnyxError.http(status, message) {
            switch status {
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
}

// The bridge's write routes land here (FSBridge.writer(for:)).
extension DriveWriter: FSWriteTarget {
    public func write(path: String, from file: URL, modified: Date?) async throws {
        _ = try await putFile(path: path, from: file, modified: modified)
    }

    public func makeFolder(path: String) async throws { try await mkdir(path: path) }

    public func move(from: String, to: String, replace: Bool) async throws {
        try await rename(from: from, to: to, replace: replace)
    }

    public func remove(path: String) async throws { try await delete(path: path) }
}
