import Foundation

/// The local copy of one Finder location's tree: every file the server says
/// is in it, and the folders they sit in.
///
/// It is what the File Provider answers from. The system asks about items
/// constantly — every Finder redraw, every stat — and a network round trip per
/// question is exactly what a File Provider exists to avoid. So the extension
/// keeps this, applies each delta page to it, and tells the system what the
/// page changed.
///
/// Folders are derived, not stored. A file row says which folder it is in
/// ("Campaigns/2026"); the server's folder list adds the empty ones. A folder
/// exists while anything puts it there, and is gone the moment nothing does —
/// so renaming a folder on the web, which moves every file in it, makes the
/// old folder disappear and the new one appear without a folder ever being
/// renamed as such.
///
/// Pure value type, no FileProvider import: the whole of the tree logic is
/// testable on its own (ReplicaTests).
public struct Replica: Codable, Sendable, Equatable {
    public private(set) var files: [String: ReplicaFile] = [:]
    /// The scope's folders as the server last listed them (`folders=1`).
    public private(set) var listedFolders: Set<String> = []
    /// Where the next delta request starts.
    public var cursor: Int64 = 0
    /// The access fingerprint the replica was built under (DeltaPage.scope).
    public var scope: String?

    public init() {}

    // MARK: - Identifiers

    /// The item identifier of a folder. Files use their server id, which is a
    /// UUID; folders have no id on the server, so they are named by path with
    /// a prefix no UUID can start with.
    public static func folderID(_ path: String) -> String { "folder:" + path }

    /// The folder path an identifier names, or nil for a file's.
    public static func folderPath(ofID id: String) -> String? {
        id.hasPrefix("folder:") ? String(id.dropFirst("folder:".count)) : nil
    }

    /// "a/b/c" → "a/b"; "a" → "" (the root).
    public static func parentPath(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    /// "a/b/c" → "c".
    public static func lastComponent(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: slash)...])
    }

    // MARK: - The tree

    /// Every folder that exists: each file's folder and its ancestors, and
    /// each listed folder and its ancestors. Never includes the root ("").
    public var folders: Set<String> {
        var out = Set<String>()
        func add(_ path: String) {
            var p = Self.clean(path)
            while !p.isEmpty, out.insert(p).inserted { p = Self.parentPath(p) }
        }
        for f in files.values { add(f.folder) }
        for f in listedFolders { add(f) }
        return out
    }

    /// What sits directly in a folder ("" for the root).
    public func children(of path: String) -> (folders: [String], files: [ReplicaFile]) {
        let parent = Self.clean(path)
        let subfolders = folders.filter { Self.parentPath($0) == parent }.sorted()
        let inside = files.values.filter { $0.folder == parent }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return (subfolders, inside)
    }

    public func file(id: String) -> ReplicaFile? { files[id] }

    // MARK: - Applying a page

    /// What one page did to the tree, in item identifiers: the files and
    /// folders to (re)report, and the ones to remove.
    public struct Diff: Equatable, Sendable {
        public var updated: [String] = []
        public var deleted: [String] = []
        public var isEmpty: Bool { updated.isEmpty && deleted.isEmpty }
        public init(updated: [String] = [], deleted: [String] = []) {
            self.updated = updated; self.deleted = deleted
        }
    }

    /// Apply one delta page and say what changed.
    ///
    /// A soft-deleted row is treated as gone even if a server sent it among
    /// the changes (the current one does not; an older one did), so trash
    /// never shows in Finder. `folders`, when present, replaces the listed
    /// folders wholesale — the server sends the complete list, because an
    /// empty folder can come or go without any file row changing.
    @discardableResult
    public mutating func apply(changed: [FileItem], deleted: [String], folders listed: [String]? = nil,
                               cursor newCursor: Int64? = nil) -> Diff {
        let before = folders
        var diff = Diff()

        for item in changed {
            if item.deletedAt != nil {
                if files.removeValue(forKey: item.id) != nil { diff.deleted.append(item.id) }
            } else {
                let file = ReplicaFile(item)
                if files[file.id] != file { diff.updated.append(file.id) }
                files[file.id] = file
            }
        }
        for id in deleted where files.removeValue(forKey: id) != nil {
            diff.deleted.append(id)
        }
        if let listed { listedFolders = Set(listed.map(Self.clean).filter { !$0.isEmpty }) }

        let after = folders
        diff.updated.append(contentsOf: after.subtracting(before).sorted().map(Self.folderID))
        diff.deleted.append(contentsOf: before.subtracting(after).sorted().map(Self.folderID))
        if let newCursor { cursor = max(cursor, newCursor) }
        // Net of the whole page: an id is reported once, as what it is now. A
        // file changed and then hard-deleted in the same page is a deletion,
        // never both — reporting both would let the system apply them in
        // either order.
        let kept = files
        func present(_ id: String) -> Bool {
            if let path = Self.folderPath(ofID: id) { return after.contains(path) }
            return kept[id] != nil
        }
        diff.updated = Self.unique(diff.updated.filter(present))
        diff.deleted = Self.unique(diff.deleted.filter { !present($0) })
        return diff
    }

    /// Forget everything: for a scope change, or signing out.
    public mutating func reset(scope: String? = nil) {
        files = [:]
        listedFolders = []
        cursor = 0
        self.scope = scope
    }

    /// A folder path as the replica keys it: no leading, trailing or doubled
    /// slashes. File parents and folder ids both go through this, so they
    /// always agree.
    public static func clean(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: true).joined(separator: "/")
    }

    static func unique(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }
}

/// One file as the replica keeps it: what Finder shows and what decides a
/// re-download, and nothing else. Not the presigned links a delta row
/// carries — they expire, the item's bytes are fetched through a fresh link
/// when opened, and at a hundred thousand files they were most of the size.
public struct ReplicaFile: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    /// Cleaned (Replica.clean), so it matches the folders' identifiers.
    public let folder: String
    public let mime: String?
    public let size: Int64?
    public let version: Int
    public let contentHash: String?
    public let createdAt: EpochMillis?
    public let updatedAt: EpochMillis?

    public init(_ item: FileItem) {
        id = item.id
        name = item.name
        folder = Replica.clean(item.folder)
        mime = item.mime
        size = item.size
        version = item.version
        contentHash = item.contentHash
        createdAt = item.createdAt
        updatedAt = item.updatedAt
    }
}
