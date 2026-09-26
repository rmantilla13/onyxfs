import Foundation

// The types the Finder mount is built from, shared by its three parts:
//
//   MirrorIndex / DriveMirror  what a drive holds, as the web shows it, with
//                              paths a file system can use
//   DAVResponder               answers rclone's WebDAV requests from that
//   PinStore                   the files kept on this Mac for offline use
//
// rclone mounts each drive in Finder over macOS's own NFS client and reads it
// through a WebDAV bridge in this app. The bridge lists exactly what the
// server's access-checked feed says (/api/files/delta), and hands file reads
// to storage by redirect, so bytes stream straight from the bucket, a range
// at a time, and nothing is shown that the web would not show.

/// One thing in a mounted drive: a folder or a file, at a path a file system
/// can use.
public struct MirrorEntry: Sendable, Equatable, Hashable {
    public enum Kind: Sendable, Equatable, Hashable { case folder, file }

    public let kind: Kind
    /// Unique within its parent (case-insensitively), and safe as a file name:
    /// no "/", no control characters, never empty, never "." or "..".
    public let name: String
    /// As mounted: "" for the drive itself, else "Folder/Sub/name.ext" using
    /// the unique names. Never starts or ends with "/".
    public let path: String
    /// The server's id, for files.
    public let fileId: String?
    /// Bytes; 0 for folders.
    public let size: Int64
    /// The file's updatedAt, else its createdAt; for a folder, its newest
    /// file's. Moves with every change to a file, bytes or not: rclone keys
    /// its cache on size and this time, so it must never stand still while
    /// the bytes change.
    public let modified: Date
    /// Changes exactly when the bytes do: the content hash when the server
    /// has one, else "v<version>". Nil for folders.
    public let etag: String?
    public let mime: String?

    public init(kind: Kind, name: String, path: String, fileId: String?, size: Int64,
                modified: Date, etag: String?, mime: String?) {
        self.kind = kind; self.name = name; self.path = path; self.fileId = fileId
        self.size = size; self.modified = modified; self.etag = etag; self.mime = mime
    }

    public var isFolder: Bool { kind == .folder }
}

/// What the pin store needs from a drive's index (MirrorIndex conforms).
public protocol PinnableIndex: Sendable {
    /// Every file at or beneath a folder path ("" = the whole drive).
    func files(under folderPath: String) -> [MirrorEntry]
    /// A file by its server id, wherever it is.
    func file(id: String) -> MirrorEntry?
    /// Whether a file this index lacks is really gone. When false — the
    /// drive is still being fetched — the store deletes nothing.
    var isAuthoritative: Bool { get }
}

/// Where the bytes of a file come from, when the bridge is asked for them.
public enum DAVContent: Sendable, Equatable {
    /// Stream from storage: a short-lived presigned URL (range requests work).
    case redirect(URL)
    /// Serve from this Mac: a pinned copy.
    case local(URL)
    /// Neither: offline and not pinned, or the server refused.
    case unavailable
}

/// What the bridge answers from: one drive's tree, and its bytes.
public protocol DAVSource: Sendable {
    func entry(at path: String) async -> MirrorEntry?
    /// Nil when `path` is not a folder.
    func children(of path: String) async -> [MirrorEntry]?
    func content(for entry: MirrorEntry) async -> DAVContent
}

/// A thing to keep on this Mac for offline use, in one drive.
public struct PinRule: Codable, Sendable, Hashable {
    public enum Target: Codable, Sendable, Hashable {
        /// One file, by server id — it stays pinned wherever it moves.
        case file(id: String)
        /// A folder by its mounted path, and everything in it now or later;
        /// "" is the whole drive.
        case folder(path: String)
    }
    /// The drive, as SyncDomain.identifier ("drive.<id>" or "library").
    public let scope: String
    public let target: Target

    public init(scope: String, target: Target) {
        self.scope = scope; self.target = target
    }
}
