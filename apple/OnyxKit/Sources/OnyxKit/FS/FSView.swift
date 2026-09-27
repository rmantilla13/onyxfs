import Foundation

// The tree the onyxfs bridge answers from: the drive's mirror, with whatever
// this Mac has written that the mirror does not show yet laid over it
// (FSOverlay), and without the names macOS keeps to itself (FSNames).
//
// Every answer FSResponder gives — a listing, a stat, a file by id, which
// listings changed — reads through FSView, so writes from Finder can sit
// over the mirror without the answers changing shape.

/// One file or folder as the bridge describes it.
public struct FSNode: Sendable, Equatable {
    /// As mounted: "" for the drive itself, else "Folder/name.ext" with the
    /// mirror's unique names. Never starts or ends with "/".
    public let path: String
    public let name: String
    public let isFolder: Bool
    /// The server's id, for files; nil for folders, and for a file still on
    /// its way to the server.
    public let fileId: String?
    /// Bytes; 0 for folders.
    public let size: Int64
    /// As Finder shows them (MirrorEntry): the file's own dates where the
    /// server has them.
    public let modified: Date
    public let created: Date
    /// What a file's `version` is made from: whatever moves with its bytes,
    /// and nothing that moves without them (FSNode.contentTag). Unused for
    /// folders, whose version is their path's.
    public let content: String
    /// Still uploading from this Mac.
    public let pending: Bool
    /// Its bytes on this Mac, for a node the overlay holds (a file still
    /// uploading). A mirror file's offline copy is the pin store's to find.
    public let staged: URL?
    /// The mirror's own entry, for what the mirror shows: the pin store and
    /// presigning go by it.
    public let mirrorEntry: MirrorEntry?

    public init(path: String, name: String, isFolder: Bool, fileId: String?, size: Int64, modified: Date,
                content: String, pending: Bool = false, staged: URL? = nil, mirrorEntry: MirrorEntry? = nil,
                created: Date? = nil) {
        self.path = path; self.name = name; self.isFolder = isFolder; self.fileId = fileId
        self.size = size; self.modified = modified; self.content = content; self.pending = pending
        self.staged = staged; self.mirrorEntry = mirrorEntry
        self.created = created ?? modified
    }

    /// A mirror entry as the bridge shows it.
    public init(_ entry: MirrorEntry) {
        self.init(path: entry.path, name: entry.name, isFolder: entry.isFolder, fileId: entry.fileId,
                  size: entry.isFolder ? 0 : max(0, entry.size), modified: entry.modified,
                  content: entry.isFolder ? "" : Self.contentTag(entry), mirrorEntry: entry, created: entry.created)
    }

    /// What in a mirror file moves with its bytes. The server's content
    /// hash (the object's ETag in storage) when it has one: a rename or a
    /// move re-keys the object and bumps every other marker, but not that,
    /// so the extension's cached chunks survive it. A file without one — a
    /// row older than the hash, not yet filled in — goes by its version and
    /// when its row changed, which move with every write to it, a rename
    /// included: its cache is thrown away more often than it need be, never
    /// kept when the bytes may be new.
    static func contentTag(_ entry: MirrorEntry) -> String {
        if let hash = entry.contentHash, !hash.isEmpty { return "hash:" + hash }
        let millis = Int64((entry.changed.timeIntervalSince1970 * 1000).rounded())
        return "write:\(entry.etag ?? ""):\(millis)"
    }

    /// Opaque, 32 hex digits. A file's changes when its bytes may have, and
    /// only then (size and `content`; never its path or its storage key): it
    /// keys the extension's chunk cache. A folder's is its path's.
    public var version: String {
        let basis = isFolder ? "dir\n/" + path.precomposedStringWithCanonicalMapping : "file\n\(size)\n\(content)"
        return String(SigV4.sha256Hex(basis).prefix(32))
    }
}

/// What this Mac has changed in a drive that its mirror does not show yet.
///
/// The seam for writes from Finder: a file copied onto the disk shows at
/// once, served from where it was staged, while it uploads; a folder made,
/// moved or deleted shows so before the feed confirms it. Nothing fills it
/// yet (writes come next), but every answer already reads through it.
///
/// Paths are exact (FSNode.path). The mirror goes on answering for anything
/// the overlay does not mention.
public struct FSOverlay: Sendable, Equatable {
    /// Shown at their paths, in place of whatever the mirror has there.
    public var nodes: [String: FSNode]
    /// Paths the mirror still shows that this Mac has moved or deleted:
    /// not shown, and nothing beneath them is either — unless the overlay
    /// has put a node there itself.
    public var hidden: Set<String>

    public init(nodes: [FSNode] = [], hidden: Set<String> = []) {
        self.nodes = Dictionary(nodes.map { ($0.path, $0) }, uniquingKeysWith: { _, last in last })
        self.hidden = hidden
    }

    public static let none = FSOverlay()

    public var isEmpty: Bool { nodes.isEmpty && hidden.isEmpty }

    /// Whether the mirror's `path` is out of sight: it, or a folder it is in,
    /// was moved or deleted here.
    func hides(_ path: String) -> Bool {
        guard !hidden.isEmpty else { return false }
        var p = path
        while true {
            if hidden.contains(p) { return true }
            if p.isEmpty { return false }
            p = Replica.parentPath(p)
        }
    }
}

/// Names the bridge never lists: what macOS writes on any disk for itself —
/// Finder's view settings, AppleDouble halves, the Trash, Spotlight's index,
/// the event log, temporary files, a custom icon. The extension keeps them
/// in its own container; they never reach the server, and one that did
/// from elsewhere is not shown.
public enum FSNames {
    static let reserved: Set<String> = [".DS_Store", ".Trashes", ".Spotlight-V100", ".fseventsd",
                                        ".TemporaryItems", "Icon\r"]

    public static func isLocalOnly(_ name: String) -> Bool {
        reserved.contains(name) || name.hasPrefix("._")
    }

    /// Whether any segment of a mounted path is one of them.
    static func isLocalOnly(path: String) -> Bool {
        path.split(separator: "/").contains { isLocalOnly(String($0)) }
    }
}

/// One drive at one moment: its mirror's index with this Mac's overlay on
/// top. Cheap to make; every lookup is worked out when asked.
struct FSView: Sendable {
    let index: MirrorIndex
    let overlay: FSOverlay

    init(index: MirrorIndex, overlay: FSOverlay = .none) {
        self.index = index
        self.overlay = overlay
    }

    /// The node at an exact mounted path ("" = the drive), or nil.
    ///
    /// Exact means case and all: the index answers either case, as Finder
    /// asks a Mac's own disks, but this disk says it is case-sensitive, and
    /// "Photos" and "photos" must not both name one folder. Only Unicode
    /// normalization is forgiven — Swift compares strings by canonical
    /// equivalence — since a name reaches a disk in either form.
    func node(at path: String) -> FSNode? {
        if FSNames.isLocalOnly(path: path) { return nil }
        if let put = overlay.nodes[path] { return put }
        if overlay.hides(path) { return nil }
        return mirrorNode(at: path)
    }

    private func mirrorNode(at path: String) -> FSNode? {
        if path.isEmpty {
            // The drive itself, even before its first sync.
            return index.entry(at: "").map(FSNode.init)
                ?? FSNode(path: "", name: "", isFolder: true, fileId: nil, size: 0,
                          modified: Date(timeIntervalSince1970: 0), content: "")
        }
        guard let entry = index.entry(at: path), entry.path == path else { return nil }
        return FSNode(entry)
    }

    /// A folder's contents: folders first, then files, each by name as
    /// Finder orders them. Nil when `path` is not a folder.
    func children(of path: String) -> [FSNode]? {
        if FSNames.isLocalOnly(path: path) { return nil }
        // node(at:), with the mirror's half kept: its folder's contents are
        // listed only when that folder itself is in sight at this very path.
        let mirrorFolder = overlay.hides(path) ? nil : mirrorNode(at: path)
        guard let folder = overlay.nodes[path] ?? mirrorFolder, folder.isFolder else { return nil }
        let put = overlayChildren(of: path)
        var kids: [FSNode] = []
        if mirrorFolder?.isFolder == true, let entries = index.children(of: path) {
            // A name the overlay has put here is its node, not the mirror's.
            let covered = Set(put.map(\.name))
            kids.reserveCapacity(entries.count)
            for entry in entries where !FSNames.isLocalOnly(entry.name) {
                if !covered.isEmpty, covered.contains(entry.name) { continue }
                if overlay.hides(entry.path) { continue }
                kids.append(FSNode(entry))
            }
        }
        // The index has its own in order already; only the overlay's are placed.
        for node in put {
            let at = kids.firstIndex { Self.listsBefore(node, $0) } ?? kids.endIndex
            kids.insert(node, at: at)
        }
        return kids
    }

    private func overlayChildren(of path: String) -> [FSNode] {
        guard !overlay.nodes.isEmpty else { return [] }
        return overlay.nodes.values
            .filter { !$0.path.isEmpty && Replica.parentPath($0.path) == path && !FSNames.isLocalOnly($0.name) }
            .sorted { Self.listsBefore($0, $1) }
    }

    /// Folders first, then files, each in Finder's order (MirrorIndex).
    static func listsBefore(_ a: FSNode, _ b: FSNode) -> Bool {
        if a.isFolder != b.isFolder { return a.isFolder }
        return MirrorIndex.listsBefore(a.name, b.name)
    }

    /// A file by the server's id, when it is in sight: not under a name the
    /// bridge never lists, nor moved or deleted here.
    func file(id: String) -> FSNode? {
        if let put = overlay.nodes.values.first(where: { !$0.isFolder && $0.fileId == id }) {
            return node(at: put.path) == put ? put : nil
        }
        guard let entry = index.file(id: id), let found = node(at: entry.path),
              !found.isFolder, found.fileId == id else { return nil }
        return found
    }

    /// Every folder in sight, the drive itself first, each once.
    func folderPaths() -> [String] {
        var paths: [String] = []
        var seen = Set<String>()
        for folder in index.allFolders where node(at: folder.path)?.isFolder == true {
            if seen.insert(folder.path).inserted { paths.append(folder.path) }
        }
        for put in overlay.nodes.values where put.isFolder && node(at: put.path) == put {
            if seen.insert(put.path).inserted { paths.append(put.path) }
        }
        return paths
    }

    /// The folders whose listing is not the same in `old` and `new`: one that
    /// came or went, or any of whose entries did — its name, size, dates,
    /// version or state. What the extension must list again.
    ///
    /// The whole tree is compared, which at a hundred thousand files takes a
    /// fraction of a second; it runs once for each change to the drive, not
    /// for each question about it (FSChangeLog).
    static func changedFolders(from old: FSView, to new: FSView) -> Set<String> {
        var seen = Set<String>()
        var changed = Set<String>()
        for path in old.folderPaths() + new.folderPaths() where seen.insert(path).inserted {
            if old.children(of: path) != new.children(of: path) { changed.insert(path) }
        }
        return changed
    }
}
