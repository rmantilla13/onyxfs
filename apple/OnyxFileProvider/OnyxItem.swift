import FileProvider
import UniformTypeIdentifiers
import OnyxKit

/// The items a Finder location is made of: the location itself, its folders,
/// and its files.
///
/// Read-only for now, and each item says so in `capabilities`. That is what
/// makes Finder refuse a drop or a rename up front rather than accept it and
/// then lose it — a File Provider that takes a write it cannot perform loses
/// the file, because the system considers it handed over. Writes are the next
/// milestone (ROADMAP 5.4), after the conflict policy (5.5) is written down.
enum OnyxItem {
    static func root(named name: String) -> NSFileProviderItem { RootItem(name: name) }

    static func folder(_ path: String) -> NSFileProviderItem { FolderItem(path: path) }

    static func file(_ file: ReplicaFile) -> NSFileProviderItem { FileNode(file: file) }

    /// The item for an identifier, from the replica. Nil when it is not there.
    static func item(for id: NSFileProviderItemIdentifier, in replica: Replica, rootName: String) -> NSFileProviderItem? {
        if id == .rootContainer { return root(named: rootName) }
        if let path = Replica.folderPath(ofID: id.rawValue) {
            return replica.folders.contains(path) ? folder(path) : nil
        }
        return replica.file(id: id.rawValue).map(file)
    }

    /// The parent of something at `path` ("" is the root).
    static func parent(of folderPath: String) -> NSFileProviderItemIdentifier {
        folderPath.isEmpty ? .rootContainer : NSFileProviderItemIdentifier(Replica.folderID(folderPath))
    }
}

private final class RootItem: NSObject, NSFileProviderItem {
    let name: String
    init(name: String) { self.name = name }
    var itemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
    var filename: String { name }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading, .allowsContentEnumerating] }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data("root".utf8), metadataVersion: Data("root".utf8))
    }
}

private final class FolderItem: NSObject, NSFileProviderItem {
    let path: String
    init(path: String) { self.path = path }
    var itemIdentifier: NSFileProviderItemIdentifier { .init(Replica.folderID(path)) }
    var parentItemIdentifier: NSFileProviderItemIdentifier { OnyxItem.parent(of: Replica.parentPath(path)) }
    var filename: String { Replica.lastComponent(path) }
    var contentType: UTType { .folder }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading, .allowsContentEnumerating] }
    /// A folder is its path — rename one on the web and it becomes a
    /// different folder (Replica explains why) — so the path is its version.
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data("folder".utf8), metadataVersion: Data(path.utf8))
    }
}

/// `itemVersion` is the part worth understanding. The system decides whether
/// to re-download from these two opaque blobs, and it treats them
/// independently:
///
///   contentVersion  the BYTES. Changing it invalidates the local copy and
///                   forces a fetch — of a 40 GB master, over the network.
///   metadataVersion the name, dates, parent. Cheap to apply.
///
/// So content is keyed on `contentHash` when the server has one and falls back
/// to `version` only when it does not. Keying content on `version` alone would
/// make every rename re-download the file.
private final class FileNode: NSObject, NSFileProviderItem {
    let file: ReplicaFile
    init(file: ReplicaFile) { self.file = file }

    var itemIdentifier: NSFileProviderItemIdentifier { .init(file.id) }
    var parentItemIdentifier: NSFileProviderItemIdentifier { OnyxItem.parent(of: file.folder) }
    /// A "/" cannot appear in a name on disk; Finder shows ":" as "/" anyway.
    var filename: String { file.name.replacingOccurrences(of: "/", with: ":") }

    var contentType: UTType {
        if let mime = file.mime, let type = UTType(mimeType: mime) { return type }
        return UTType(filenameExtension: (file.name as NSString).pathExtension) ?? .data
    }

    var documentSize: NSNumber? { file.size.map { NSNumber(value: $0) } }
    var creationDate: Date? { file.createdAt?.date }
    var contentModificationDate: Date? { (file.updatedAt ?? file.createdAt)?.date }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading] }

    var itemVersion: NSFileProviderItemVersion {
        let content = file.contentHash ?? "v\(file.version)"
        return NSFileProviderItemVersion(contentVersion: Data(content.utf8),
                                         metadataVersion: Data("\(file.version)|\(file.folder)|\(file.name)".utf8))
    }
}
