import Foundation

/// Everything an onyxfs volume does, without FSKit: the extension's
/// OnyxVolume only translates the kernel's calls into these (VolumeEngine).
///
/// The tree is the bridge's (the app's mirror of the drive), fetched a
/// folder at a time and kept until the bridge says that folder changed —
/// on the web, or from another Mac — or for a few seconds at most. Each
/// path has one id for as long as the volume is mounted, and keeps it
/// through a rename (the kernel's handle on a file follows the file).
///
/// Next to the drive's own items, three kinds of things live only here:
/// - files being written: bytes in the StagingArea until the last close,
///   then handed to the app (which uploads them); listed at once, pending;
/// - macOS's own files (LocalOnly: .DS_Store and the like), kept in the
///   LocalStore and never uploaded;
/// - extended attributes, for every item, in the LocalStore too.
///
/// The Trash: `.Trashes` cannot be made on the volume, which is how Finder
/// learns a volume has no Trash and offers to delete at once instead — and
/// "at once" here is the web's own trash, where it can still be restored.
public actor DriveEngine {
    public static let rootID: UInt64 = 2
    /// A folder's listing is asked for again after this long even if the
    /// bridge said nothing (the change feed is the real signal).
    static let listingTTL: TimeInterval = 10

    struct Node {
        var id: UInt64
        var parent: UInt64
        var name: String
        var path: String
        var isDirectory: Bool
        var size: UInt64
        var modified: Date
        var created: Date
        var fileId: String?
        var version: String
        /// Its bytes are on this Mac (kept offline, or still uploading): read
        /// through the app, not cached a second time.
        var local = false
        /// Locked by the app whatever the drive allows: nothing is made in
        /// it, and it is not written, moved or deleted (BridgeEntry.readOnly).
        var readOnly = false
        var localOnly: Bool
        /// Set aside by a safe save (setAside): the drive's file at this
        /// path, which the server still has there. Local-only and hidden,
        /// read from the server, never sent.
        var setAsideFrom: String? = nil
        /// Made here and not yet handed to the app.
        var unsent: Bool
        /// Its listing, by folded name → id; nil until fetched.
        var children: [String: UInt64]?
        var listedAt: Date?
    }

    struct Writing {
        var dirty = false
        var modified: Date?
        var created: Date?
    }

    /// One of Archive Utility's scratch folders beside a zip, while it
    /// lasts: what was unpacked into it, what was made beside it meanwhile
    /// (the result's placeholder among them), and whether anything unpacked
    /// was moved out into the drive — which an unzip that failed never does.
    struct ArchiveScratch {
        let parent: UInt64
        let path: String
        var unpacked: Set<String> = []
        var made: Set<UInt64> = []
        var delivered = false
    }

    let bridge: any EngineBridge
    let staging: StagingArea
    let local: LocalStore
    private(set) var volume: BridgeVolume
    private var nodes: [UInt64: Node] = [:]
    private var byPath: [String: UInt64] = [:]
    private var nextID: UInt64 = 16
    private var writing: [UInt64: Writing] = [:]
    private var sendingNow: Set<UInt64> = []
    /// Archive Utility's scratch folders, by id; nearly always none.
    private var scratches: [UInt64: ArchiveScratch] = [:]
    /// Paths (folded) whose file a safe save has set aside, and what stands
    /// in for it: the server still has it there, and a listing that shows
    /// it is not believed. Nearly always none.
    private var setAside: [String: UInt64] = [:]
    /// Readers by file and version, the most recently used last: a file
    /// open in several places shares one, and its read-ahead.
    private var readers: [(key: String, source: any ByteSource)] = []
    static let readersKept = 32
    private var generation: UInt64
    private var watching: Task<Void, Never>?
    private var changed: (@Sendable (Set<UInt64>, Bool) -> Void)?
    private let now: @Sendable () -> Date

    public init(bridge: any EngineBridge, volume: BridgeVolume, staging: StagingArea, local: LocalStore,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.bridge = bridge
        self.volume = volume
        self.staging = staging
        self.local = local
        self.generation = volume.generation
        self.now = now
        let root = Node(id: Self.rootID, parent: Self.rootID, name: volume.name, path: "/", isDirectory: true,
                        size: 0, modified: now(), created: now(), fileId: nil, version: "", localOnly: false,
                        unsent: false, children: nil, listedAt: nil)
        nodes[Self.rootID] = root
        byPath[Self.fold("/")] = Self.rootID
    }

    public var readOnly: Bool { volume.readOnly }

    public var statistics: VolumeStatistics {
        VolumeStatistics(totalBytes: UInt64(max(0, volume.totalBytes)), usedBytes: UInt64(max(0, volume.usedBytes)),
                         fileCount: UInt64(max(0, volume.fileCount)))
    }

    // MARK: - Reading the tree

    public func node(_ id: UInt64) throws -> VolumeNode {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        return Self.public(node)
    }

    public func lookup(_ name: String, in directory: UInt64) async throws -> VolumeNode {
        let dir = try folder(directory)
        try await ensureListed(dir.id)
        guard let listing = nodes[dir.id]?.children, let id = listing[Self.fold(name)], let node = nodes[id] else {
            throw VolumeError.posix(ENOENT)
        }
        return Self.public(node)
    }

    public func children(of directory: UInt64) async throws -> [VolumeNode] {
        let dir = try folder(directory)
        try await ensureListed(dir.id)
        let ids = nodes[dir.id]?.children?.values.map { $0 } ?? []
        return ids.compactMap { nodes[$0] }
            .sorted { ($0.isDirectory ? 0 : 1, $0.name.lowercased()) < ($1.isDirectory ? 0 : 1, $1.name.lowercased()) }
            .map(Self.public)
    }

    public func read(_ id: UInt64, at offset: Int64, count: Int) async throws -> Data {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        guard !node.isDirectory else { throw VolumeError.posix(EISDIR) }
        guard offset < Int64(node.size), count > 0 else { return Data() }
        if await staging.contains(id) {
            let data = try await wrap { try await self.staging.read(id, at: offset, count: count) }
            bridge.count(.read, bytes: data.count)
            return data
        }
        // Finder's own files (.DS_Store and the rest) never leave this Mac,
        // and are not the drive's: not counted. A file a safe save set aside
        // is still the drive's, and read from it.
        if node.localOnly, node.setAsideFrom == nil {
            if Self.isRootMarker(node) { return Data() }
            return try await wrap { try await self.local.read(node.path, at: offset, count: count) }
        }
        let source = try await reader(for: node)
        let data = try await wrap { try await source.read(offset: offset, length: count) }
        bridge.count(.read, bytes: data.count)
        return data
    }

    // MARK: - Writing

    /// The node is named as the server will name it (`stored`), which may
    /// not be quite the name asked for: the kernel is told which it is.
    public func create(_ asked: String, in directory: UInt64, isDirectory: Bool) async throws -> VolumeNode {
        let dir = try folder(directory)
        try await ensureListed(dir.id)
        let name = Self.stored(asked)
        guard LocalOnlyPolicy.isValidName(name) else { throw VolumeError.posix(EINVAL) }
        guard nodes[dir.id]?.children?[Self.fold(name)] == nil else { throw VolumeError.posix(EEXIST) }
        let path = Self.join(dir.path, name)
        if name == ".Trashes" {
            // No Trash on this volume: Finder deletes at once instead — into
            // the web's own trash.
            throw VolumeError.posix(EPERM)
        }
        // A safe save's folder for its new copy is this Mac's too: the copy
        // goes up only once it is moved into the drive (promote).
        if dir.localOnly || LocalOnly.isLocalOnly(name) || LocalOnly.isSafeSave(name) {
            try await wrap {
                if isDirectory { try await self.local.createDirectory(path) } else { try await self.local.createFile(path) }
            }
            let node = insert(name: name, parent: dir.id, isDirectory: isDirectory, size: 0,
                              modified: now(), fileId: nil, version: "", localOnly: true, unsent: false)
            noteMade(node, in: dir)
            return Self.public(node)
        }
        guard !readOnly, !dir.readOnly else { throw VolumeError.posix(EACCES) }
        if isDirectory {
            let entry = try await wrap { try await self.bridge.mkdir(path) }
            let node = insert(entry, parent: dir.id)
            noteMade(node, in: dir)
            return Self.public(node)
        }
        let node = insert(name: name, parent: dir.id, isDirectory: false, size: 0, modified: now(),
                          fileId: nil, version: "", localOnly: false, unsent: true)
        // Made where a safe save set a file aside: it goes up to that path
        // as the file's new contents, and the one set aside is only this Mac's.
        if !setAside.isEmpty { setAside[Self.fold(path)] = nil }
        try await wrap { _ = try await self.staging.create(node.id) }
        // A new file goes up even if nothing is ever written to it.
        writing[node.id] = Writing(dirty: true)
        noteMade(node, in: dir)
        return Self.public(node)
    }

    /// Nothing is fetched yet: an app that truncates first (most saves)
    /// never downloads the old bytes.
    public func beginWriting(_ id: UInt64, truncating: Bool) async throws {
        guard let node = nodes[id], !node.isDirectory else { throw VolumeError.posix(EISDIR) }
        if node.localOnly { return }
        guard !readOnly, !node.readOnly else { throw VolumeError.posix(EACCES) }
        if writing[id] == nil { writing[id] = Writing() }
        if truncating { _ = try await setSize(id, to: 0) }
    }

    public func write(_ id: UInt64, at offset: Int64, data: Data) async throws -> Int {
        guard var node = nodes[id], !node.isDirectory else { throw VolumeError.posix(EISDIR) }
        if node.localOnly {
            let n = try await wrap { try await self.local.write(node.path, at: offset, data) }
            node.size = await local.size(node.path)
            node.modified = now()
            nodes[id] = node
            return n
        }
        guard !readOnly, !node.readOnly else { throw VolumeError.posix(EACCES) }
        try await stage(id)
        let n = try await wrap { try await self.staging.write(id, at: offset, data) }
        bridge.count(.write, bytes: n)
        node.size = max(node.size, UInt64(offset) + UInt64(data.count))
        node.modified = now()
        nodes[id] = node
        writing[id, default: Writing()].dirty = true
        return n
    }

    public func setSize(_ id: UInt64, to size: UInt64) async throws -> VolumeNode {
        guard var node = nodes[id], !node.isDirectory else { throw VolumeError.posix(EISDIR) }
        if node.localOnly {
            try await wrap { try await self.local.truncate(node.path, to: size) }
        } else {
            guard !readOnly, !node.readOnly else { throw VolumeError.posix(EACCES) }
            if size == 0 {
                // Emptied: no need for the old bytes at all.
                try await wrap { _ = try await self.staging.create(id) }
            } else {
                try await stage(id)
                try await wrap { try await self.staging.truncate(id, to: size) }
            }
            writing[id, default: Writing()].dirty = true
        }
        node.size = size
        node.modified = now()
        nodes[id] = node
        return Self.public(node)
    }

    /// Finder sets a copy's birth time to its original's: kept, and sent
    /// with the bytes as the file's own created date.
    public func setCreated(_ id: UInt64, to date: Date) async throws -> VolumeNode {
        guard var node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        node.created = date
        nodes[id] = node
        if !node.localOnly, writing[id] != nil { writing[id]?.created = date }
        return Self.public(node)
    }

    public func setModified(_ id: UInt64, to date: Date) async throws -> VolumeNode {
        guard var node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        node.modified = date
        nodes[id] = node
        if node.localOnly {
            await local.setModified(node.path, to: date)
        } else if writing[id] != nil {
            // Sent with the bytes, so the upload keeps the date the copy had.
            writing[id]?.modified = date
        }
        return Self.public(node)
    }

    /// The last close: what was written goes to the app. On failure it stays
    /// staged and pending, and is tried again at the next sync.
    public func finishWriting(_ id: UInt64) async throws {
        // One send at a time: a sync while a promoted file is on its way
        // does not send it twice.
        guard !sendingNow.contains(id) else { return }
        sendingNow.insert(id)
        defer { sendingNow.remove(id) }
        guard let state = writing[id] else { return }
        guard state.dirty, var node = nodes[id], !node.localOnly else {
            if !(state.dirty) { writing[id] = nil; await staging.remove(id) }
            return
        }
        guard let url = await staging.url(id) else { writing[id] = nil; return }
        let entry = try await wrap {
            try await self.bridge.putFile(node.path, from: url, modified: state.modified, created: state.created)
        }
        node.fileId = entry.id
        node.version = entry.version
        node.size = UInt64(max(0, entry.size))
        node.unsent = false
        nodes[id] = node
        writing[id] = nil
        await staging.remove(id)
    }

    /// Named as the server will name it, as `create` is.
    public func rename(_ id: UInt64, from directory: UInt64, name: String,
                       to newDirectory: UInt64, newName asked: String, replacing: UInt64?) async throws -> VolumeNode {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        let from = try folder(directory), to = try folder(newDirectory)
        try await ensureListed(to.id)
        let newName = Self.stored(asked)
        guard LocalOnlyPolicy.isValidName(newName) else { throw VolumeError.posix(EINVAL) }
        let newPath = Self.join(to.path, newName)
        if to.path.hasPrefix("/.Trashes") || newName == ".Trashes" { throw VolumeError.posix(EPERM) }
        let over = to.children?[Self.fold(newName)].flatMap { nodes[$0] }
        if let over, over.id != id, replacing == nil { throw VolumeError.posix(EEXIST) }
        if !scratches.isEmpty { noteMoved(node, to: to, newName: newName) }

        // A sandboxed app's safe save setting the document aside, and the
        // document set aside put back, or moved on.
        if !node.localOnly, !node.isDirectory, !to.localOnly, LocalOnly.isSafeSave(newName) {
            return try await setAside(id, from: from, to: to, newName: newName, over: over)
        }
        if node.setAsideFrom != nil, !to.localOnly, !LocalOnly.isLocalOnly(newName), !LocalOnly.isSafeSave(newName) {
            return try await putBack(id, from: from, to: to, newName: newName, over: over)
        }
        // What macOS made for itself, renamed into the drive under a name of
        // its own: Archive Utility's unpacked files, an app's safe save.
        if node.localOnly, !to.localOnly, !LocalOnly.isLocalOnly(newName), !LocalOnly.isSafeSave(newName) {
            return try await promote(id, from: from, to: to, newName: newName, over: over)
        }
        if let over, over.id != id {
            // As rename(2): a folder replaces only a folder, and only an empty
            // one. The kernel leaves that to the file system, and the server's
            // replace takes what is there whole: a folder moved over another
            // took everything the other held.
            if node.isDirectory != over.isDirectory { throw VolumeError.posix(node.isDirectory ? ENOTDIR : EISDIR) }
            if over.isDirectory {
                try await ensureListed(over.id)
                guard nodes[id] != nil, let target = nodes[over.id] else { throw VolumeError.posix(ESTALE) }
                guard (target.children ?? [:]).isEmpty else { throw VolumeError.posix(ENOTEMPTY) }
            }
        }
        let oldPath = node.path
        if node.localOnly || to.localOnly || LocalOnly.isLocalOnly(newName) {
            // macOS's own files move among themselves; a real file cannot
            // become one (it would vanish from the web).
            guard node.localOnly else { throw VolumeError.posix(EPERM) }
            // The tree first, then the store: anything that runs while the
            // store is asked (the engine is an actor) finds the item where it
            // went — a folder it was in being removed meanwhile takes nothing
            // with it.
            if let over, over.id != id { drop(over.id) }
            move(id, from: from.id, to: to.id, newName: newName)
            await self.local.move(oldPath, to: newPath)
        } else {
            // Out of a locked folder, into one, or a locked item itself: the
            // app would move the real file the locked one stands for.
            guard !readOnly, !node.readOnly, !from.readOnly, !to.readOnly else { throw VolumeError.posix(EACCES) }
            // Into the place of a file a safe save set aside, which the
            // server still has there: it replaces that file.
            let setAsideThere = !setAside.isEmpty && setAside[Self.fold(newPath)] != nil
            if node.unsent {
                // Not on the server yet: it goes up under the new name.
                if let over, over.id != id { try await removeFromServer(over) }
            } else {
                let replace = (over != nil && over?.id != id) || setAsideThere
                _ = try await wrap { try await self.bridge.rename(oldPath, to: newPath, replace: replace) }
            }
            if setAsideThere { setAside[Self.fold(newPath)] = nil }
            if let over, over.id != id { drop(over.id) }
            move(id, from: from.id, to: to.id, newName: newName)
            await self.local.move(oldPath, to: newPath)
        }
        // Removed meanwhile, by another call while this one waited: said so,
        // rather than taking the whole file system down.
        guard let moved = nodes[id] else { throw VolumeError.posix(ESTALE) }
        return Self.public(moved)
    }

    /// A file or folder of macOS's own making (in .TemporaryItems, say)
    /// renamed into the drive under a name of its own becomes the drive's:
    /// what Archive Utility unpacks, and what an app saving safely writes
    /// beside the original before swapping it in. Kept here, it would stay
    /// on this Mac and never reach the web.
    ///
    /// Its folders are made on the server, and its files staged, before
    /// anything here moves: should either fail, the item stays where it was.
    /// Then it and what it holds take their places in the drive, and its
    /// files go up after the rename has answered — pending until sent, as a
    /// copy's are, and sent at the next sync should that fail. macOS's own
    /// files inside it (.DS_Store, ._*) stay this Mac's.
    private func promote(_ id: UInt64, from: Node, to: Node, newName: String, over: Node?) async throws -> VolumeNode {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        guard !readOnly, !to.readOnly else { throw VolumeError.posix(EACCES) }
        if let over, over.id != id {
            // A folder is never put over another (its contents would mix),
            // nor a file over a folder or the other way round.
            if over.isDirectory || node.isDirectory { throw VolumeError.posix(over.isDirectory ? (node.isDirectory ? ENOTEMPTY : EISDIR) : ENOTDIR) }
            guard !over.readOnly else { throw VolumeError.posix(EACCES) }
        }
        let oldPath = node.path, newPath = Self.join(to.path, newName)
        let path = { (relative: String) in relative.isEmpty ? newPath : Self.join(newPath, relative) }
        let items = await promotable(oldPath)
        for item in items where item.directory {
            _ = try await wrap { try await self.bridge.mkdir(path(item.relative)) }
        }
        // Waited on the server: still here, still where it was, its folder
        // still there, and still holding what it held?
        guard let current = nodes[id], current.path == oldPath, nodes[to.id] != nil,
              await promotable(oldPath).map(\.relative) == items.map(\.relative) else { throw VolumeError.posix(ESTALE) }

        // Each item's id — the one the kernel knows it by, where it has one —
        // and its files staged, all before anything moves.
        var planned: [(relative: String, directory: Bool, modified: Date, created: Date, id: UInt64)] = []
        for item in items {
            let known = item.relative.isEmpty ? id : byPath[Self.fold(Self.join(oldPath, item.relative))]
            let pid = known ?? { defer { nextID += 1 }; return nextID }()
            planned.append((item.relative, item.directory, item.modified, nodes[pid]?.created ?? item.modified, pid))
        }
        var staged: [UInt64] = []
        do {
            for item in planned where !item.directory {
                let source = Self.join(oldPath, item.relative.isEmpty ? "" : item.relative)
                guard let url = await local.fileURL(item.relative.isEmpty ? oldPath : source) else { throw VolumeError.posix(ESTALE) }
                try await wrap { try await self.staging.adopt(item.id, from: url) }
                staged.append(item.id)
            }
        } catch {
            for file in staged { await staging.remove(file) }
            throw error
        }

        // Saved over, or a node a listing made for the new path meanwhile:
        // the new bytes go up to its path, as a new version of the file
        // there, and the old node goes.
        if let other = byPath[Self.fold(newPath)], other != id, let replaced = nodes[other] {
            if replaced.unsent { writing[replaced.id] = nil; await staging.remove(replaced.id) }
            drop(replaced.id)
        }
        move(id, from: from.id, to: to.id, newName: newName)
        // Into the place of the document a safe save set aside (setAside):
        // the same, a new version of the file the server has there.
        if !setAside.isEmpty { setAside[Self.fold(newPath)] = nil }
        await local.move(oldPath, to: newPath)

        var sending: [UInt64] = []
        for item in planned {
            let at = path(item.relative)
            let parentPath = item.relative.isEmpty ? to.path : (at as NSString).deletingLastPathComponent
            guard let parent = item.relative.isEmpty ? to.id : byPath[Self.fold(parentPath)] else { continue }
            byPath[Self.fold(at)] = item.id
            let size = item.directory ? 0 : await local.size(at)
            var made = insert(name: (at as NSString).lastPathComponent, parent: parent, isDirectory: item.directory, size: size,
                              modified: item.modified, fileId: nil, version: "", localOnly: false, unsent: !item.directory)
            made.created = item.created
            if item.directory {
                // Its listing is what was made in it, until the server's is asked for.
                made.children = made.children ?? [:]
                made.listedAt = now()
            } else {
                writing[made.id] = Writing(dirty: true, modified: item.modified, created: item.created)
                sending.append(made.id)
            }
            nodes[made.id] = made
        }
        await local.release(planned.map { path($0.relative) })
        // Sent after the rename has answered: a big unpacked folder does not
        // hold up the app that moved it. Not sent (offline, say): pending,
        // for the next sync.
        if !sending.isEmpty {
            Task { for file in sending { try? await self.finishWriting(file) } }
        }
        guard let moved = nodes[id] else { throw VolumeError.posix(ESTALE) }
        return Self.public(moved)
    }

    /// What of a local item and its contents can be the drive's: all of it
    /// but macOS's own files inside it.
    private func promotable(_ path: String) async -> [(relative: String, directory: Bool, modified: Date)] {
        await local.subtree(path).filter { !LocalOnly.isLocalOnly(path: $0.relative) }
    }

    /// A safe save setting the document aside. A sandboxed app's NSDocument
    /// (TextEdit, Preview, Pages) on a volume with no item replacement
    /// folder — a drive's disk has none, as it is not MNT_LOCAL — and no
    /// atomic swap (FSKit refuses RENAME_SWAP) writes the new copy into a
    /// "<name>.sb-…" folder beside the document, renames the document to
    /// another "<name>.sb-…", moves the copy into its place and removes the
    /// one set aside. Done on the server, every such save failed (0.5.27):
    /// a listing the change feed set off while the rename was on its way
    /// came back with it, older than it, put the document's name back and
    /// lost what was set aside — so the copy could not be moved in (EEXIST)
    /// nor the document put back (ESTALE), and the document was left under
    /// the "….sb-…" name. Had it worked, each save would have made a new
    /// file and sent the document to the trash.
    ///
    /// Here the server never sees it go. What is set aside stands in for the
    /// document on this Mac — hidden, read from the server, never sent —
    /// and the server's file there is not listed meanwhile. The copy moved
    /// into its place goes up to its path as its new contents: the same
    /// file, a new version (promote). Put back instead, nothing changes
    /// (putBack); removed with nothing in its place, the document goes.
    private func setAside(_ id: UInt64, from: Node, to: Node, newName: String, over: Node?) async throws -> VolumeNode {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        guard !readOnly, !node.readOnly, !from.readOnly, !to.readOnly else { throw VolumeError.posix(EACCES) }
        // Its bytes must be the server's: with changes of its own still on
        // their way there, it is not set aside, and the save fails whole.
        guard !node.unsent, node.fileId != nil, writing[id]?.dirty != true, !sendingNow.contains(id) else {
            throw VolumeError.posix(EBUSY)
        }
        if let over, over.id != id {
            // Under a safe save's name, only one of its own can be there.
            guard over.localOnly, over.setAsideFrom == nil, !over.isDirectory else { throw VolumeError.posix(EEXIST) }
            drop(over.id)
            await local.remove(over.path)
        }
        let oldPath = node.path
        writing[id] = nil
        move(id, from: from.id, to: to.id, newName: newName)
        nodes[id]?.localOnly = true
        nodes[id]?.setAsideFrom = oldPath
        setAside[Self.fold(oldPath)] = id
        await local.move(oldPath, to: Self.join(to.path, newName))
        guard let moved = nodes[id] else { throw VolumeError.posix(ESTALE) }
        return Self.public(moved)
    }

    /// The document a safe save set aside, put back where it was — the save
    /// failed, and NSFileManager undoes its first move — with nothing asked
    /// of the server, which never saw it go; or moved on under a name of its
    /// own, which is the server's rename of the document.
    private func putBack(_ id: UInt64, from: Node, to: Node, newName: String, over: Node?) async throws -> VolumeNode {
        guard let node = nodes[id], let original = node.setAsideFrom else { throw VolumeError.posix(ESTALE) }
        guard !readOnly, !node.readOnly, !to.readOnly else { throw VolumeError.posix(EACCES) }
        // Something took its place meanwhile (the save's copy): its old
        // contents are not put back over that.
        guard setAside[Self.fold(original)] == id else { throw VolumeError.posix(EPERM) }
        let oldPath = node.path, newPath = Self.join(to.path, newName)
        if Self.fold(newPath) != Self.fold(original) {
            if let over, over.id != id {
                if over.isDirectory { throw VolumeError.posix(EISDIR) }
                guard !over.readOnly else { throw VolumeError.posix(EACCES) }
            }
            _ = try await wrap { try await self.bridge.rename(original, to: newPath, replace: over != nil && over?.id != id) }
            if let over, over.id != id { drop(over.id) }
        }
        setAside[Self.fold(original)] = nil
        move(id, from: from.id, to: to.id, newName: newName)
        nodes[id]?.localOnly = false
        nodes[id]?.setAsideFrom = nil
        await local.move(oldPath, to: newPath)
        guard let moved = nodes[id] else { throw VolumeError.posix(ESTALE) }
        return Self.public(moved)
    }

    public func remove(_ id: UInt64, name: String, from directory: UInt64) async throws {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        if node.isDirectory {
            // rmdir takes an empty folder only. The kernel leaves that to the
            // file system, and the server's delete takes a folder whole: a
            // tool removing a folder only if it is empty took it all.
            try await ensureListed(id)
            guard (nodes[id]?.children ?? [:]).isEmpty else { throw VolumeError.posix(ENOTEMPTY) }
        }
        if node.localOnly {
            if let original = node.setAsideFrom, setAside[Self.fold(original)] == id {
                // Set aside, and removed with nothing moved into its place:
                // the document is removed, as it would be on any disk.
                guard !readOnly, !node.readOnly else { throw VolumeError.posix(EACCES) }
                try await wrap { try await self.bridge.delete(original) }
                setAside[Self.fold(original)] = nil
            }
            await local.remove(node.path)
        } else {
            guard !readOnly, !node.readOnly else { throw VolumeError.posix(EACCES) }
            try await removeFromServer(node)
            await local.removeAttributes(under: node.path)
        }
        drop(id)
        if !scratches.isEmpty, let scratch = scratches.removeValue(forKey: id), !scratch.delivered {
            // Answered first: Archive Utility does not wait on the app.
            Task { await self.failedUnzip(scratch) }
        }
    }

    // MARK: - Archive Utility on a drive

    /// Where Archive Utility unpacks a zip on a drive: a folder of this name
    /// beside it (LocalOnly keeps it on this Mac).
    static let scratchPrefix = ".ArchiveServiceTemp"
    static let quarantine = "com.apple.quarantine"

    /// Archive Utility at work beside a zip: its scratch folder made, what it
    /// unpacks into it, and what it makes beside it for the result.
    private func noteMade(_ node: Node, in dir: Node) {
        if node.isDirectory, node.name.hasPrefix(Self.scratchPrefix), !dir.localOnly {
            scratches[node.id] = ArchiveScratch(parent: dir.id, path: node.path)
            return
        }
        guard !scratches.isEmpty else { return }
        if scratches[dir.id] != nil {
            scratches[dir.id]?.unpacked.insert(node.name)
        } else if !node.localOnly {
            for (id, scratch) in scratches where scratch.parent == dir.id { scratches[id]?.made.insert(node.id) }
        }
    }

    /// Something unpacked moved out into the drive: that unzip worked. A
    /// name moved into a scratch folder was unpacked.
    private func noteMoved(_ node: Node, to: Node, newName: String) {
        let from = Self.fold(node.path)
        for (id, scratch) in scratches {
            if to.id == id { scratches[id]?.unpacked.insert(newName) }
            if from.hasPrefix(Self.fold(scratch.path) + "/"), !to.localOnly, !LocalOnly.isLocalOnly(newName) {
                scratches[id]?.delivered = true
            }
        }
    }

    /// Archive Utility threw away what it unpacked beside a zip and moved
    /// none of it out: an unzip that failed. When a zip there came from the
    /// internet — which Archive Utility cannot unzip on a drive — the app is
    /// told, and unzips it itself. Archive Utility's placeholder for the
    /// result is named, not removed: Archive Utility removes it itself once
    /// its error is closed, and the app does after that if it is still there.
    private func failedUnzip(_ scratch: ArchiveScratch) async {
        guard let folder = nodes[scratch.parent] else { return }
        let unpacked = scratch.unpacked.filter { !LocalOnly.isLocalOnly($0) && $0 != "__MACOSX" }.sorted()
        guard !unpacked.isEmpty else { return }
        var zips: [String] = []
        for id in folder.children?.values.map({ $0 }) ?? [] {
            guard let node = nodes[id], !node.isDirectory, node.name.lowercased().hasSuffix(".zip"),
                  (try? await local.attribute(Self.quarantine, of: node.path)) != nil else { continue }
            zips.append(node.name)
        }
        guard !zips.isEmpty else { return }
        // Named as the result would land: the zip's one item, or a folder
        // named after the zip — with " 2" or the like for a name taken.
        let results = Set((unpacked + zips.map { ($0 as NSString).deletingPathExtension }).map(Self.fold))
        let placeholders = scratch.made.compactMap { id -> String? in
            guard let node = nodes[id], node.parent == scratch.parent, !node.localOnly,
                  node.isDirectory ? (node.children ?? [:]).isEmpty : node.size == 0,
                  results.contains(Self.fold(node.name))
                    || results.contains(Self.fold(Self.unnumbered(node.name, isDirectory: node.isDirectory))) else { return nil }
            return node.name
        }
        await bridge.unzipFailed(UnzipFailure(folder: folder.path, zips: Array(zips.sorted().prefix(UnzipFailure.maxNames)),
                                              unpacked: Array(unpacked.prefix(UnzipFailure.maxNames)),
                                              unpackedCount: unpacked.count, placeholders: placeholders.sorted()))
    }

    /// A name as Archive Utility numbers one it finds taken, without its
    /// number: "Footage" for "Footage 2", "notes.txt" for "notes 2.txt".
    static func unnumbered(_ name: String, isDirectory: Bool) -> String {
        let ext = isDirectory ? "" : (name as NSString).pathExtension
        let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
        guard let space = stem.lastIndex(of: " "), space > stem.startIndex else { return name }
        let number = stem[stem.index(after: space)...]
        guard !number.isEmpty, number.allSatisfy({ $0.isASCII && $0.isNumber }) else { return name }
        let base = String(stem[..<space])
        return ext.isEmpty ? base : "\(base).\(ext)"
    }

    /// Everything written goes to the app now (an eject, a sync).
    public func synchronize() async throws {
        var failure: Error?
        for id in writing.keys where writing[id]?.dirty == true {
            do { try await finishWriting(id) } catch { failure = error }
        }
        if let failure { throw failure }
    }

    public func forget(_ id: UInt64) {
        // Kept: the id stays the path's for the whole mount.
    }

    // MARK: - Extended attributes

    public func xattr(named name: String, of id: UInt64) async throws -> Data {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        return try await wrap { try await self.local.attribute(name, of: node.path) }
    }

    public func setXattr(named name: String, of id: UInt64, to value: Data?, createOnly: Bool, replaceOnly: Bool) async throws {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        try await wrap { try await self.local.setAttribute(name, of: node.path, to: value, createOnly: createOnly, replaceOnly: replaceOnly) }
    }

    public func xattrNames(of id: UInt64) async throws -> [String] {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        return await local.attributeNames(of: node.path)
    }

    // MARK: - Changes from elsewhere

    public func observeChanges(_ handler: @escaping @Sendable (Set<UInt64>, Bool) -> Void) {
        changed = handler
        guard watching == nil else { return }
        watching = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let since = await self.generation
                do {
                    let news = try await self.bridge.changes(since: since)
                    await self.apply(news)
                } catch BridgeFailure.disconnected {
                    return
                } catch {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        }
    }

    public func shutdown() {
        watching?.cancel()
        watching = nil
    }

    /// Folders that changed are listed afresh; what they held that changed
    /// or went is reported, so the kernel drops its copies.
    func apply(_ news: BridgeChanges) async {
        generation = max(generation, news.generation)
        var touched: Set<UInt64> = []
        let folders: [UInt64] = news.all
            ? nodes.values.filter { $0.isDirectory && $0.children != nil }.map(\.id)
            : news.paths.compactMap { byPath[Self.fold($0)] }
        for id in folders {
            let before = nodes[id]?.children?.values.map { ($0, nodes[$0]?.version ?? "") } ?? []
            nodes[id]?.listedAt = nil
            try? await ensureListed(id)
            let after = Set(nodes[id]?.children?.values.map { $0 } ?? [])
            for (child, version) in before where !after.contains(child) || nodes[child]?.version != version {
                touched.insert(child)
            }
            touched.insert(id)
        }
        if let volume = try? await bridge.volume() { self.volume = volume }
        if !touched.isEmpty || news.all { changed?(touched, news.all) }
    }

    // MARK: - The tree, kept

    private func folder(_ id: UInt64) throws -> Node {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        guard node.isDirectory else { throw VolumeError.posix(ENOTDIR) }
        return node
    }

    /// The folder's listing, from the bridge when it is older than the TTL
    /// (or was dropped by a change), merged with what lives only here.
    private func ensureListed(_ id: UInt64) async throws {
        guard let dir = nodes[id] else { throw VolumeError.posix(ESTALE) }
        if let at = dir.listedAt, now().timeIntervalSince(at) < Self.listingTTL, dir.children != nil { return }
        // The engine is an actor, and other calls run while this one waits
        // for the bridge: anything in the folder by the time the listing
        // arrives that was not in it when the listing was asked for was made
        // meanwhile — a file Finder has begun to copy, a folder it has just
        // made — and a listing older than it cannot say it is gone.
        let before = Set(dir.children?.values ?? [:].values)
        var listing: [String: UInt64] = [:]
        if !dir.localOnly {
            let entries: [BridgeEntry]
            do {
                entries = try await bridge.list(dir.path)
            } catch BridgeFailure.notFound {
                entries = []
            } catch let failure as BridgeFailure {
                // Offline or refused: what was listed before still stands.
                if dir.children != nil { return }
                throw VolumeError.posix(failure.errno)
            }
            for entry in entries where !LocalOnly.isLocalOnly(entry.name) {
                // Set aside by a safe save: listed where it was set aside,
                // not where the server still has it.
                if !setAside.isEmpty, setAside[Self.fold(Self.join(dir.path, entry.name))] != nil { continue }
                listing[Self.fold(entry.name)] = upsert(entry, parent: id)
            }
        }
        let kept = await local.names(in: dir.path)
        // No more waiting from here: the folder as it is now is what is
        // merged. Files made here, not yet on the server, stay listed, and
        // so does whatever was made while the listing was on its way.
        for child in nodes[id]?.children?.values ?? [:].values {
            guard let node = nodes[child], node.unsent || node.localOnly || !before.contains(child) else { continue }
            listing[Self.fold(node.name)] = child
        }
        for name in kept where listing[Self.fold(name)] == nil {
            let path = Self.join(dir.path, name)
            let isDir = await local.isDirectory(path)
            let node = insert(name: name, parent: id, isDirectory: isDir, size: await local.size(path),
                              modified: await local.modified(path), fileId: nil, version: "", localOnly: true, unsent: false)
            listing[Self.fold(name)] = node.id
        }
        if id == Self.rootID {
            // Dated as the disk is: 1970 reads as the last day of 1969 in Finder.
            let mounted = nodes[Self.rootID]?.created ?? now()
            for marker in LocalOnly.rootMarkers where listing[Self.fold(marker)] == nil {
                listing[Self.fold(marker)] = insert(name: marker, parent: id, isDirectory: false, size: 0, modified: mounted,
                                                    fileId: nil, version: "", localOnly: true, unsent: false).id
            }
        }
        // Gone from the listing: forgotten, with anything under it — if the
        // listing could have known of it. What was made after it was asked
        // for stays, whichever wait above it came during.
        let listed = Set(listing.values)
        for (_, child) in nodes[id]?.children ?? [:] where !listed.contains(child) {
            if before.contains(child) {
                drop(child, fromParent: false)
            } else if let node = nodes[child] {
                listing[Self.fold(node.name)] = child
            }
        }
        nodes[id]?.children = listing
        nodes[id]?.listedAt = now()
    }

    /// The node for a bridge entry at parent/name: the same id as before if
    /// the path was known, its facts brought up to date.
    private func upsert(_ entry: BridgeEntry, parent: UInt64) -> UInt64 {
        guard let dir = nodes[parent] else { return 0 }
        let path = Self.join(dir.path, entry.name)
        if let id = byPath[Self.fold(path)], var node = nodes[id] {
            if node.unsent || writing[id]?.dirty == true { return id } // this Mac's copy is newer
            node.name = entry.name
            node.isDirectory = entry.isDirectory
            node.size = UInt64(max(0, entry.size))
            node.modified = entry.modified
            node.created = entry.created ?? entry.modified
            node.fileId = entry.id
            node.version = entry.version
            node.local = entry.local
            node.readOnly = entry.readOnly
            nodes[id] = node
            return id
        }
        return insert(entry, parent: parent).id
    }

    @discardableResult
    private func insert(_ entry: BridgeEntry, parent: UInt64) -> Node {
        var node = insert(name: entry.name, parent: parent, isDirectory: entry.isDirectory, size: UInt64(max(0, entry.size)),
                          modified: entry.modified, fileId: entry.id, version: entry.version, localOnly: false, unsent: false)
        node.local = entry.local
        node.readOnly = entry.readOnly
        node.created = entry.created ?? entry.modified
        nodes[node.id] = node
        return node
    }

    private func insert(name: String, parent: UInt64, isDirectory: Bool, size: UInt64, modified: Date,
                        fileId: String?, version: String, localOnly: Bool, unsent: Bool) -> Node {
        let path = Self.join(nodes[parent]?.path ?? "/", name)
        let id = byPath[Self.fold(path)] ?? { defer { nextID += 1 }; return nextID }()
        let node = Node(id: id, parent: parent, name: name, path: path, isDirectory: isDirectory, size: size,
                        modified: modified, created: modified, fileId: fileId, version: version, localOnly: localOnly,
                        unsent: unsent, children: nodes[id]?.children, listedAt: nodes[id]?.listedAt)
        nodes[id] = node
        byPath[Self.fold(path)] = id
        nodes[parent]?.children?[Self.fold(name)] = id
        return node
    }

    /// A rename: the same id at the new path, and everything beneath it
    /// rebased (folders keep their contents).
    private func move(_ id: UInt64, from: UInt64, to: UInt64, newName: String) {
        guard var node = nodes[id], let parent = nodes[to] else { return }
        nodes[from]?.children?[Self.fold(node.name)] = nil
        let oldPath = node.path
        let newPath = Self.join(parent.path, newName)
        node.name = newName
        node.parent = to
        node.path = newPath
        nodes[id] = node
        nodes[to]?.children?[Self.fold(newName)] = id
        for (key, childID) in byPath where key == Self.fold(oldPath) || key.hasPrefix(Self.fold(oldPath) + "/") {
            byPath[key] = nil
            guard var child = nodes[childID] else { continue }
            if childID != id { child.path = newPath + child.path.dropFirst(oldPath.count) }
            nodes[childID] = childID == id ? node : child
            byPath[Self.fold(childID == id ? newPath : child.path)] = childID
        }
        // A folder moved with a document in it set aside: on the server the
        // document went with it.
        if !setAside.isEmpty {
            let old = Self.fold(oldPath)
            for (key, aside) in setAside where key.hasPrefix(old + "/") {
                setAside[key] = nil
                setAside[Self.fold(newPath) + key.dropFirst(old.count)] = aside
                if let original = nodes[aside]?.setAsideFrom, original.count > oldPath.count {
                    nodes[aside]?.setAsideFrom = newPath + original.dropFirst(oldPath.count)
                }
            }
        }
    }

    private func drop(_ id: UInt64, fromParent: Bool = true) {
        guard let node = nodes[id], id != Self.rootID else { return }
        if fromParent { nodes[node.parent]?.children?[Self.fold(node.name)] = nil }
        for (key, childID) in byPath where key == Self.fold(node.path) || key.hasPrefix(Self.fold(node.path) + "/") {
            byPath[key] = nil
            nodes[childID] = nil
            writing[childID] = nil
        }
        nodes[id] = nil
        if !setAside.isEmpty { setAside = setAside.filter { nodes[$0.value] != nil } }
    }

    private func removeFromServer(_ node: Node) async throws {
        if node.unsent {
            await staging.remove(node.id)
            writing[node.id] = nil
            return
        }
        try await wrap { try await self.bridge.delete(node.path) }
    }

    /// Copy on write: a file on the server brought here whole before its
    /// first change, read through its reader in pieces.
    private func stage(_ id: UInt64) async throws {
        if await staging.contains(id) { return }
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        if node.unsent || node.fileId == nil {
            try await wrap { _ = try await self.staging.create(id) }
            return
        }
        let source = try await reader(for: node)
        try await wrap {
            try await self.staging.materialize(id, size: node.size) { offset, count in
                try await source.read(offset: offset, length: count)
            }
        }
    }

    private func reader(for node: Node) async throws -> any ByteSource {
        let key = "\(node.fileId ?? node.path)\u{0}\(node.version)"
        if let at = readers.firstIndex(where: { $0.key == key }) {
            let known = readers.remove(at: at)
            readers.append(known)
            return known.source
        }
        let entry = BridgeEntry(name: node.name, isDirectory: false, id: node.fileId, size: Int64(node.size),
                                modified: node.modified, version: node.version, local: node.local)
        let source = try await wrap { try await self.bridge.reader(for: entry) }
        if let raced = readers.first(where: { $0.key == key }) { return raced.source }
        readers.append((key, source))
        if readers.count > Self.readersKept {
            // The longest unread lets go of its read-ahead.
            let dropped = readers.removeFirst().source
            Task { await dropped.close() }
        }
        return source
    }

    // MARK: - Helpers

    private static func `public`(_ node: Node) -> VolumeNode {
        VolumeNode(id: node.id, parent: node.parent, name: node.name, isDirectory: node.isDirectory, size: node.size,
                   modified: node.modified, created: node.created, localOnly: node.localOnly, readOnly: node.readOnly)
    }

    private static func isRootMarker(_ node: Node) -> Bool {
        node.parent == rootID && LocalOnly.rootMarkers.contains(node.name)
    }

    /// Names compare as Finder compares them: ignoring case, and the
    /// Unicode form a name happened to be typed in — and as the server
    /// stores them, without spaces at either end (`stored`).
    static func fold(_ path: String) -> String {
        trimmedSegments(path).precomposedStringWithCanonicalMapping.lowercased()
    }

    /// A name as the server will keep it: without the whitespace at either
    /// end that it trims from every file and folder name (JavaScript's
    /// `trim`, lib/folder-ops.js). Made here as asked, "Selects " would be
    /// "Selects" on the server, and the folder Finder had just made could
    /// not be found under the name it made it with — so Finder stopped the
    /// copy with "its name is too long or includes characters that are
    /// invalid". macOS's own names are left as they are — "Icon\r" is a
    /// folder's custom icon, not "Icon" — but for the AppleDouble half of a
    /// file, which follows the file's: "._Selects " is "._Selects".
    static func stored(_ name: String) -> String {
        if name.hasPrefix("._") { return "._" + stored(String(name.dropFirst(2))) }
        return LocalOnly.names.contains(name) ? name : name.trimmingCharacters(in: serverTrims)
    }

    /// What JavaScript's `trim` takes: its WhiteSpace and LineTerminator.
    static let serverTrims = CharacterSet(charactersIn:
        "\u{9}\u{A}\u{B}\u{C}\u{D}\u{20}\u{A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}"
        + "\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    /// Each segment of a path as `stored` makes it. Most paths have nothing
    /// to trim, and are returned as they are without being split.
    private static func trimmedSegments(_ path: String) -> String {
        var previous: Unicode.Scalar = "/"
        var edge = false
        for scalar in path.unicodeScalars {
            if (previous == "/" && serverTrims.contains(scalar)) || (scalar == "/" && serverTrims.contains(previous)) {
                edge = true
                break
            }
            previous = scalar
        }
        guard edge || path.unicodeScalars.last.map(serverTrims.contains) == true else { return path }
        return path.split(separator: "/", omittingEmptySubsequences: false)
            .map { stored(String($0)) }
            .joined(separator: "/")
    }

    static func join(_ parent: String, _ name: String) -> String {
        parent == "/" ? "/\(name)" : "\(parent)/\(name)"
    }

    /// Any error, as the kernel wants it.
    private func wrap<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let failure as BridgeFailure {
            throw VolumeError.posix(failure.errno)
        } catch let failure as StagingArea.Failure {
            if case let .posix(code) = failure { throw VolumeError.posix(code) }
            throw VolumeError.posix(EIO)
        } catch let failure as LocalStore.Failure {
            if case let .posix(code) = failure { throw VolumeError.posix(code) }
            throw VolumeError.posix(EIO)
        } catch let error as VolumeError {
            throw error
        } catch is CancellationError {
            throw VolumeError.posix(EINTR)
        } catch {
            throw VolumeError.posix(EIO)
        }
    }
}

/// Names a file system accepts.
enum LocalOnlyPolicy {
    static func isValidName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.contains("/") && name.utf8.count <= 255
    }
}
