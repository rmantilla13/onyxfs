import FileProvider
import UniformTypeIdentifiers
import OnyxKit

/// One item as the File Provider sees it.
///
/// `itemVersion` is the part worth understanding. The system decides whether
/// to re-download from these two opaque blobs, and it treats them
/// independently:
///
///   contentVersion  the BYTES. Changing it invalidates the local copy and
///                   forces a fetch — of a 40 GB master, over the network,
///                   on someone's phone.
///   metadataVersion the name, dates, parent. Cheap to apply.
///
/// So content is keyed on `contentHash` when the server has one and falls back
/// to `version` only when it does not. Keying content on `version` alone would
/// make every rename re-download the file, which is exactly the behaviour a
/// File Provider exists to avoid.
final class OnyxItem: NSObject, NSFileProviderItem {
    let file: FileItem
    let filespaceId: String

    init(file: FileItem, filespaceId: String) {
        self.file = file
        self.filespaceId = filespaceId
    }

    var storageKey: String? { file.storageKey }

    var itemIdentifier: NSFileProviderItemIdentifier { .init(file.id) }

    /// Flat for now: every file hangs off the root. Folder hierarchy is the
    /// next milestone and needs stable identifiers for folders, which the
    /// server does not yet mint.
    var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }

    var filename: String { file.name }

    var contentType: UTType {
        if let mime = file.mime, let type = UTType(mimeType: mime) { return type }
        return UTType(filenameExtension: (file.name as NSString).pathExtension) ?? .data
    }

    var documentSize: NSNumber? { file.size.map { NSNumber(value: $0) } }
    var creationDate: Date?? { file.createdAt?.date }
    var contentModificationDate: Date?? { file.updatedAt?.date }

    var itemVersion: NSFileProviderItemVersion {
        let content = file.contentHash ?? "v\(file.version)"
        return NSFileProviderItemVersion(
            contentVersion: Data(content.utf8),
            metadataVersion: Data("\(file.version)".utf8))
    }

    /// Read-only until the write path lands. Advertising write capability the
    /// extension does not implement makes the system hand over a file it then
    /// cannot save — and remove its own copy in the process.
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading] }

    static var root: NSFileProviderItem { RootItem() }

    private final class RootItem: NSObject, NSFileProviderItem {
        var itemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
        var parentItemIdentifier: NSFileProviderItemIdentifier { .rootContainer }
        var filename: String { "Onyx" }
        var contentType: UTType { .folder }
        var capabilities: NSFileProviderItemCapabilities { [.allowsReading, .allowsContentEnumerating] }
    }
}
