import Foundation

/// A drive's collections as folders on its disk: a read-only "Collections"
/// folder at the top, a folder in it for each collection, and in each the
/// files that collection gathers (the web's lib/collections.js), each one
/// the drive's own file shown again.
///
/// A file here is its mirror entry under another path: the same id and the
/// same version, so its bytes, the extension's cached chunks and an offline
/// copy are the real file's, never a second copy. Nothing in it may be
/// made, written, moved or deleted (FSNode.readOnly, and the bridge refuses
/// it too): a move out of a collection would move the real file.
///
/// Built whole, by the app's CollectionsFolder, and swapped in; cheap to
/// read, like MirrorIndex.
public struct FSCollections: Sendable, Equatable {
    /// One collection, as it is to be shown: its files are the mirrors'
    /// entries for them, in any order.
    public struct Folder: Sendable, Equatable {
        public let id: String
        public let name: String
        public let entries: [MirrorEntry]

        public init(id: String, name: String, entries: [MirrorEntry]) {
            self.id = id; self.name = name; self.entries = entries
        }
    }

    /// What the folder at the top is called, unless the drive has a real
    /// folder by that name, which keeps it (rootName(avoiding:)).
    public static let folderName = "Collections"

    /// The top folder's name on this disk.
    public let rootName: String
    private let nodes: [String: FSNode]
    private let kids: [String: [FSNode]]
    private let byID: [String: String]

    public static let none = FSCollections(rootName: folderName, nodes: [:], kids: [:], byID: [:])

    private init(rootName: String, nodes: [String: FSNode], kids: [String: [FSNode]], byID: [String: String]) {
        self.rootName = rootName; self.nodes = nodes; self.kids = kids; self.byID = byID
    }

    /// The folders for `folders`, under `rootName`. No collections, no
    /// folder: an empty Collections folder would only ask what it is for.
    public init(_ folders: [Folder], rootName: String = FSCollections.folderName) {
        guard !folders.isEmpty else { self = .none; return }
        var nodes: [String: FSNode] = [:]
        var kids: [String: [FSNode]] = [:]
        var byID: [String: String] = [:]

        let names = MirrorIndex.uniqueNames(folders.map {
            MirrorIndex.Item(isFolder: true, name: MirrorIndex.safeName($0.name), seen: 0, created: nil, key: $0.id)
        })
        var newest = Date(timeIntervalSince1970: 0)
        var rootKids: [FSNode] = []
        for (folder, name) in zip(folders, names) {
            let path = rootName + "/" + name
            // One file listed twice by a collection still shows once.
            var seen = Set<String>()
            let entries = folder.entries.filter { !$0.isFolder && $0.fileId.map { seen.insert($0).inserted } == true }
            let fileNames = MirrorIndex.uniqueNames(entries.map {
                MirrorIndex.Item(isFolder: false, name: $0.name, seen: 0,
                                 created: Int64(($0.created.timeIntervalSince1970 * 1000).rounded()), key: $0.fileId ?? $0.path)
            })
            var files: [FSNode] = []
            files.reserveCapacity(entries.count)
            var changed = Date(timeIntervalSince1970: 0)
            for (entry, fileName) in zip(entries, fileNames) {
                let node = FSNode(path: path + "/" + fileName, name: fileName, isFolder: false, fileId: entry.fileId,
                                  size: max(0, entry.size), modified: entry.modified, content: FSNode.contentTag(entry),
                                  mirrorEntry: entry, created: entry.created, readOnly: true)
                files.append(node)
                nodes[node.path] = node
                if let id = entry.fileId, byID[id] == nil { byID[id] = node.path }
                changed = max(changed, entry.modified)
            }
            files.sort { FSView.listsBefore($0, $1) }
            kids[path] = files
            let folderNode = FSNode(path: path, name: name, isFolder: true, fileId: nil, size: 0, modified: changed,
                                    content: "", readOnly: true)
            nodes[path] = folderNode
            rootKids.append(folderNode)
            newest = max(newest, changed)
        }
        rootKids.sort { FSView.listsBefore($0, $1) }
        kids[rootName] = rootKids
        nodes[rootName] = FSNode(path: rootName, name: rootName, isFolder: true, fileId: nil, size: 0,
                                 modified: newest, content: "", readOnly: true)
        self.init(rootName: rootName, nodes: nodes, kids: kids, byID: byID)
    }

    public var isEmpty: Bool { nodes.isEmpty }

    /// The top folder's name on a drive whose top level already holds
    /// `taken` (folded names): Collections, or Collections (Onyx), (2)…
    /// when the drive has its own folder by that name.
    public static func rootName(avoiding taken: (String) -> Bool) -> String {
        if !taken(folderName) { return folderName }
        var candidate = "\(folderName) (Onyx)"
        var n = 2
        while taken(candidate) {
            candidate = "\(folderName) (Onyx \(n))"
            n += 1
        }
        return candidate
    }

    /// The folder at the top.
    var root: FSNode? { nodes[rootName] }

    func node(at path: String) -> FSNode? { nodes[path] }

    func children(of path: String) -> [FSNode]? { kids[path] }

    /// A file shown here, by the server's id.
    func file(id: String) -> FSNode? { byID[id].flatMap { nodes[$0] } }

    /// Every folder here, the top one first.
    var folderPaths: [String] {
        guard !nodes.isEmpty else { return [] }
        return [rootName] + (kids[rootName] ?? []).map(\.path)
    }

    /// Whether `path` is the top folder or anything in it.
    func contains(_ path: String) -> Bool {
        !nodes.isEmpty && (path == rootName || path.hasPrefix(rootName + "/"))
    }
}
