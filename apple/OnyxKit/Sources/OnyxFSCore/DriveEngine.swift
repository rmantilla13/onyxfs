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
        var localOnly: Bool
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

    let bridge: any EngineBridge
    let staging: StagingArea
    let local: LocalStore
    private(set) var volume: BridgeVolume
    private var nodes: [UInt64: Node] = [:]
    private var byPath: [String: UInt64] = [:]
    private var nextID: UInt64 = 16
    private var writing: [UInt64: Writing] = [:]
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
        // and are not the drive's: not counted.
        if node.localOnly {
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
        if dir.localOnly || LocalOnly.isLocalOnly(name) {
            try await wrap {
                if isDirectory { try await self.local.createDirectory(path) } else { try await self.local.createFile(path) }
            }
            return Self.public(insert(name: name, parent: dir.id, isDirectory: isDirectory, size: 0,
                                      modified: now(), fileId: nil, version: "", localOnly: true, unsent: false))
        }
        guard !readOnly else { throw VolumeError.posix(EACCES) }
        if isDirectory {
            let entry = try await wrap { try await self.bridge.mkdir(path) }
            return Self.public(insert(entry, parent: dir.id))
        }
        let node = insert(name: name, parent: dir.id, isDirectory: false, size: 0, modified: now(),
                          fileId: nil, version: "", localOnly: false, unsent: true)
        try await wrap { _ = try await self.staging.create(node.id) }
        // A new file goes up even if nothing is ever written to it.
        writing[node.id] = Writing(dirty: true)
        return Self.public(node)
    }

    /// Nothing is fetched yet: an app that truncates first (most saves)
    /// never downloads the old bytes.
    public func beginWriting(_ id: UInt64, truncating: Bool) async throws {
        guard let node = nodes[id], !node.isDirectory else { throw VolumeError.posix(EISDIR) }
        if node.localOnly { return }
        guard !readOnly else { throw VolumeError.posix(EACCES) }
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
        guard !readOnly else { throw VolumeError.posix(EACCES) }
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
            guard !readOnly else { throw VolumeError.posix(EACCES) }
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

        let local = node.localOnly || to.localOnly || LocalOnly.isLocalOnly(newName)
        if local {
            // macOS's own files move among themselves; a real file cannot
            // become one (it would vanish from the web) or leave being one.
            guard node.localOnly, to.localOnly || LocalOnly.isLocalOnly(newName) || !LocalOnly.isLocalOnly(node.name) else {
                throw VolumeError.posix(EPERM)
            }
            await self.local.move(node.path, to: newPath)
        } else {
            guard !readOnly else { throw VolumeError.posix(EACCES) }
            if node.unsent {
                // Not on the server yet: it goes up under the new name.
                if let over, over.id != id { try await removeFromServer(over) }
            } else {
                _ = try await wrap { try await self.bridge.rename(node.path, to: newPath, replace: over != nil && over?.id != id) }
            }
            await self.local.move(node.path, to: newPath)
        }
        if let over, over.id != id { drop(over.id) }
        move(id, from: from.id, to: to.id, newName: newName)
        return Self.public(nodes[id]!)
    }

    public func remove(_ id: UInt64, name: String, from directory: UInt64) async throws {
        guard let node = nodes[id] else { throw VolumeError.posix(ESTALE) }
        if node.localOnly {
            await local.remove(node.path)
        } else {
            guard !readOnly else { throw VolumeError.posix(EACCES) }
            try await removeFromServer(node)
            await local.removeAttributes(under: node.path)
        }
        drop(id)
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
                   modified: node.modified, created: node.created, localOnly: node.localOnly)
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
