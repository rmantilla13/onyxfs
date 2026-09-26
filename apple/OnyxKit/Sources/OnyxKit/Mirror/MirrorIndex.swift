import Foundation

/// A drive's tree as a file system sees it: every file in the replica, at a
/// path made of names a file system accepts.
///
/// The server's names are not file names. A file can be called "Q1/Q2 plan",
/// or nothing at all, and two files in one folder can share a name or differ
/// only in case — which a Mac, being case-insensitive, treats as one name, so
/// one file would hide the other. The index settles each of those, the same
/// way every time for the same replica, so a path the mount has handed out
/// keeps naming the same file.
///
/// Immutable and built whole. The bridge answers every listing and stat from
/// it, so lookups are dictionary hits; a sync builds a new index rather than
/// patching this one.
public struct MirrorIndex: Sendable, PinnableIndex {
    /// The root first, then depth-first: each folder, its own files, then
    /// each subfolder's subtree in listing order. Everything beneath a folder
    /// is one contiguous run, which is what `files(under:)` reads.
    private let entries: [MirrorEntry]
    /// Folded path (see `key`) → position in `entries`.
    private let positions: [String: Int]
    private let byID: [String: Int]
    /// By a folder's position: its children in listing order, and where its
    /// run in `entries` ends.
    private let slots: [Int: Slot]

    private struct Slot: Sendable {
        let children: [Int]
        let end: Int
    }

    /// A folder waiting to be laid out, and where it goes in its parent's
    /// list of children.
    private struct Pending {
        let serverPath: String
        let name: String
        let path: String
        let key: String
        let parent: Int
        let slot: Int
    }

    public let fileCount: Int
    /// Folders beneath the root; the drive itself is not counted.
    public let folderCount: Int

    /// `emptyFolderDate` dates a folder with no files beneath it, and a file
    /// the server sent no dates for. A fixed value, not now: a date that moved
    /// on every rebuild would tell every client the folder had changed.
    ///
    /// The walk is a loop, not recursion: it runs on a concurrency thread,
    /// whose stack a drive nested deeply enough would overflow.
    public init(_ replica: Replica, emptyFolderDate: Date = Date(timeIntervalSince1970: 0)) {
        var subfolders: [String: [String]] = [:]
        for path in replica.folders { subfolders[Replica.parentPath(path), default: []].append(path) }
        var filesIn: [String: [ReplicaFile]] = [:]
        for file in replica.files.values { filesIn[Replica.clean(file.folder), default: []].append(file) }

        var entries: [MirrorEntry] = []
        entries.reserveCapacity(replica.files.count + subfolders.count + 1)
        var positions: [String: Int] = [:]
        positions.reserveCapacity(entries.capacity)
        var byID: [String: Int] = [:]
        byID.reserveCapacity(replica.files.count)
        var children: [Int: [Int]] = [:]
        var folderChildren: [Int: Int] = [:]
        var newest: [Int: Date] = [:]
        var preorder: [Int] = []

        var stack = [Pending(serverPath: "", name: "", path: "", key: "", parent: -1, slot: -1)]
        while let folder = stack.popLast() {
            let at = entries.count
            preorder.append(at)
            positions[folder.key] = at
            if folder.parent >= 0 { children[folder.parent]![folder.slot] = at }
            entries.append(MirrorEntry(kind: .folder, name: folder.name, path: folder.path, fileId: nil, size: 0,
                                       modified: emptyFolderDate, etag: nil, mime: nil))

            let subs = subfolders[folder.serverPath] ?? []
            let files = filesIn[folder.serverPath] ?? []
            var items: [Item] = []
            items.reserveCapacity(subs.count + files.count)
            for f in subs {
                items.append(Item(isFolder: true, name: Self.safeName(Replica.lastComponent(f)), created: nil, key: f))
            }
            for f in files {
                items.append(Item(isFolder: false, name: Self.safeName(f.name), created: f.createdAt?.raw, key: f.id))
            }
            let names = Self.uniqueNames(items)
            let namedSubs = zip(subs, names[..<subs.count]).sorted { Self.listsBefore($0.1, $1.1) }
            let namedFiles = zip(files, names[subs.count...]).sorted { Self.listsBefore($0.1, $1.1) }

            // Subfolders take the first slots, filled in as each is laid out.
            var kids = [Int](repeating: -1, count: items.count)
            for (j, (file, name)) in namedFiles.enumerated() {
                let modified = (file.updatedAt ?? file.createdAt)?.date ?? emptyFolderDate
                let hash = file.contentHash.flatMap { $0.isEmpty ? nil : $0 }
                let position = entries.count
                kids[subs.count + j] = position
                positions[Self.join(folder.key, Self.fold(name))] = position
                byID[file.id] = position
                entries.append(MirrorEntry(kind: .file, name: name, path: Self.join(folder.path, name),
                                           fileId: file.id, size: file.size ?? 0, modified: modified,
                                           etag: hash ?? "v\(file.version)", mime: file.mime))
                newest[at] = max(newest[at] ?? modified, modified)
            }
            children[at] = kids
            folderChildren[at] = subs.count
            // Reversed onto the stack, so they come off in listing order.
            for (i, (sub, name)) in namedSubs.enumerated().reversed() {
                stack.append(Pending(serverPath: sub, name: name, path: Self.join(folder.path, name),
                                     key: Self.join(folder.key, Self.fold(name)), parent: at, slot: i))
            }
        }

        // Children before parents: each folder's run ends where its last
        // subfolder's does, and it is as new as the newest thing in it.
        var slots: [Int: Slot] = [:]
        for at in preorder.reversed() {
            let kids = children[at]!
            let subs = folderChildren[at]!
            var end = at + 1 + (kids.count - subs)
            var latest = newest[at]
            for sub in kids[..<subs] {
                end = max(end, slots[sub]!.end)
                if let d = newest[sub] { latest = max(latest ?? d, d) }
            }
            if let latest {
                newest[at] = latest
                let e = entries[at]
                entries[at] = MirrorEntry(kind: .folder, name: e.name, path: e.path, fileId: nil, size: 0,
                                          modified: latest, etag: nil, mime: nil)
            }
            slots[at] = Slot(children: kids, end: end)
        }

        self.entries = entries
        self.positions = positions
        self.byID = byID
        self.slots = slots
        self.fileCount = byID.count
        self.folderCount = slots.count - 1
    }

    // MARK: - Lookups

    /// "" or "/" is the drive itself. Slashes are forgiven; "." and ".." are
    /// not — the bridge never resolves them, so nothing can climb out.
    ///
    /// Case-insensitive, as Finder asks. Names are unique case-insensitively
    /// within a folder, so an exact match and a case-insensitive one can
    /// never be two different entries, and one lookup serves both.
    public func entry(at path: String) -> MirrorEntry? {
        position(of: path).map { entries[$0] }
    }

    /// Folders first, then files, each in Finder's order. Nil when `path` is
    /// not a folder.
    public func children(of path: String) -> [MirrorEntry]? {
        guard let at = position(of: path), let slot = slots[at] else { return nil }
        return slot.children.map { entries[$0] }
    }

    public func file(id: String) -> MirrorEntry? {
        byID[id].map { entries[$0] }
    }

    /// Every file at any depth beneath a folder ("" = the whole drive): the
    /// folder's own files, then each subfolder's, in listing order. Empty
    /// when `folderPath` is not a folder.
    public func files(under folderPath: String) -> [MirrorEntry] {
        guard let at = position(of: folderPath), let slot = slots[at] else { return [] }
        return entries[(at + 1)..<slot.end].filter { !$0.isFolder }
    }

    /// A path as the index keys it: no leading, trailing or doubled slashes.
    /// Nil if any segment is "." or "..".
    public static func normalize(_ path: String) -> String? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return parts.joined(separator: "/")
    }

    private func position(of path: String) -> Int? {
        guard let clean = Self.normalize(path) else { return nil }
        return positions[Self.key(clean)]
    }

    // MARK: - Names

    /// Case-insensitive identity of a name. String equality already ignores
    /// Unicode normalization, so "é" typed either way is one name, as on APFS.
    static func fold(_ name: String) -> String { name.lowercased() }

    /// Folded segment by segment, as the index was built, so the key of a
    /// path is unique exactly when its names are unique in their folders.
    static func key(_ path: String) -> String {
        path.split(separator: "/").map { fold(String($0)) }.joined(separator: "/")
    }

    static func join(_ parent: String, _ name: String) -> String {
        parent.isEmpty ? name : parent + "/" + name
    }

    /// A server name as a file name: "/" becomes ":" (which Finder shows as
    /// "/"), control characters go, and a name that is empty or "." or ".."
    /// becomes "Untitled". Only true control characters (Cc) are removed —
    /// format characters such as the joiner inside an emoji are part of the
    /// name.
    static func safeName(_ raw: String) -> String {
        var scalars = String.UnicodeScalarView()
        for s in raw.unicodeScalars {
            if s == "/" { scalars.append(":") }
            else if s.properties.generalCategory != .control { scalars.append(s) }
        }
        let name = String(scalars)
        return name.isEmpty || name == "." || name == ".." ? "Untitled" : name
    }

    /// "a.png" → "a (2).png"; "notes" or a folder → "notes (2)". A leading
    /// dot is a hidden file's name, not an extension.
    static func suffixed(_ name: String, _ n: Int, isFolder: Bool) -> String {
        if !isFolder, let dot = name.lastIndex(of: "."), dot != name.startIndex,
           name.index(after: dot) != name.endIndex {
            return "\(name[..<dot]) (\(n))\(name[dot...])"
        }
        return "\(name) (\(n))"
    }

    struct Item {
        let isFolder: Bool
        /// Already safe (safeName).
        let name: String
        let created: Int64?
        /// The server id of a file, the server path of a folder: unique, so
        /// the order below is total and the outcome never depends on
        /// dictionary order.
        let key: String
    }

    /// Names for the items of one folder, unique case-insensitively.
    ///
    /// Of items that collide, the first keeps its name and the rest take
    /// " (2)", " (3)"…: folders first, because renaming a folder moves every
    /// path beneath it; then the oldest, so an upload never renames a file
    /// that was there before it. Every name an item has on its own is claimed
    /// before any suffix is handed out, so a real "a (2).png" keeps its name
    /// and the second "a.png" becomes "a (3).png".
    static func uniqueNames(_ items: [Item]) -> [String] {
        var names = items.map(\.name)
        guard items.count > 1 else { return names }
        var groups: [String: [Int]] = [:]
        for (i, item) in items.enumerated() { groups[fold(item.name), default: []].append(i) }
        guard groups.count < items.count else { return names }

        var taken = Set(groups.keys)
        for key in groups.keys.filter({ groups[$0]!.count > 1 }).sorted() {
            let ranked = groups[key]!.sorted { claimsFirst(items[$0], items[$1]) }
            var n = 2
            for i in ranked.dropFirst() {
                var candidate: String
                repeat {
                    candidate = suffixed(items[i].name, n, isFolder: items[i].isFolder)
                    n += 1
                } while !taken.insert(fold(candidate)).inserted
                names[i] = candidate
            }
        }
        return names
    }

    private static func claimsFirst(_ a: Item, _ b: Item) -> Bool {
        if a.isFolder != b.isFolder { return a.isFolder }
        switch (a.created, b.created) {
        case let (x?, y?) where x != y: return x < y
        case (.some, nil): return true
        case (nil, .some): return false
        default: return a.key < b.key
        }
    }

    /// Finder's order, with a tie-break so names it counts as equal
    /// ("a1", "a01") still come out the same way every time.
    static func listsBefore(_ a: String, _ b: String) -> Bool {
        switch a.localizedStandardCompare(b) {
        case .orderedAscending: return true
        case .orderedDescending: return false
        case .orderedSame: return a < b
        }
    }
}
