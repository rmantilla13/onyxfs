import Foundation

// The types the Finder mount is built from, shared by its three parts:
//
//   MirrorIndex / DriveMirror  what a drive holds, as the web shows it, with
//                              paths a file system can use
//   DAVResponder               answers rclone's WebDAV requests from that
//   FSResponder                answers the onyxfs extension (a drive as a
//                              disk, through FSKit) from the same
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
    /// When the file itself last changed, as Finder shows it: its own date
    /// (`fileModifiedAt`, what it had where it was made) where the server
    /// has one, else when its row last changed. For a folder, when anything
    /// beneath it last changed on the server (`changed`).
    ///
    /// rclone keys its cache on size and this time, so it must move when the
    /// bytes do — and it does: new contents come with their own date, or
    /// the server stamps the swap with now. A rename, which leaves the bytes
    /// alone, leaves it too, as on any disk.
    public let modified: Date
    /// When the file was made, as Finder shows it: its own date where the
    /// server has one, else when it was added here.
    public let created: Date
    /// When anything about it last changed on the server (the row's
    /// updatedAt): what says the mirror has caught up with a change made
    /// here, which `modified`, the file's own date, cannot — an upload may
    /// carry one from years ago.
    public let changed: Date
    /// Changes exactly when the bytes do: the content hash when the server
    /// has one, else "v<version>". Nil for folders.
    public let etag: String?
    public let mime: String?
    /// The server's fingerprint of the bytes (the object's ETag in storage),
    /// when it has one. Unlike `etag`, which falls back to the row's version,
    /// it stays put when the file is renamed or moved — which re-keys the
    /// object and bumps the version — so a cache of the bytes keyed on it
    /// survives a move (onyxfs, FSNode). Nil for folders.
    public let contentHash: String?
    /// For a folder, its path as the server names it — what its write
    /// routes take — where the index shows it under a name of its own: " (2)"
    /// for one that differs from another only in case, ":" for a "/", or a
    /// spelling of its own. Nil when `path` is the server's too, and for
    /// files, which the server knows by id.
    public let serverPath: String?

    /// `created` and `changed` default to `modified`, which is what an entry
    /// with no dates of its own (a folder) has for all three.
    public init(kind: Kind, name: String, path: String, fileId: String?, size: Int64,
                modified: Date, etag: String?, mime: String?, contentHash: String? = nil,
                created: Date? = nil, changed: Date? = nil, serverPath: String? = nil) {
        self.kind = kind; self.name = name; self.path = path; self.fileId = fileId
        self.size = size; self.modified = modified; self.etag = etag; self.mime = mime
        self.contentHash = contentHash
        self.created = created ?? modified
        self.changed = changed ?? modified
        self.serverPath = serverPath == path ? nil : serverPath
    }

    public var isFolder: Bool { kind == .folder }

    /// A folder's path as the server names it (`serverPath`, else `path`).
    public var apiPath: String { serverPath ?? path }
}

/// What the pin store needs from a drive's index (MirrorIndex conforms).
public protocol PinnableIndex: Sendable {
    /// Every file at or beneath a folder path ("" = the whole drive).
    func files(under folderPath: String) -> [MirrorEntry]
    /// A file by its server id, wherever it is.
    func file(id: String) -> MirrorEntry?
    /// Whether `path` is a folder ("" = the drive itself). A pinned folder
    /// that is not — renamed or deleted on the web — is shown as not found,
    /// rather than read as a folder with nothing in it.
    func hasFolder(at path: String) -> Bool
    /// Whether a file this index lacks is really gone. When false — the
    /// drive is still being fetched — the store deletes nothing.
    var isAuthoritative: Bool { get }
}

/// The folder one account's things are kept in on this Mac, for one server:
/// "account-" and 24 hex of a hash of both. Another account signed in here —
/// or the same address on another server — has a folder of its own, so it
/// never reads, serves or deletes what was kept for this one. The same
/// identity DriveMirror keeps: the server as given, the address in lower case.
public enum AccountFolder {
    public static func name(server: URL, account: String) -> String {
        "account-" + SigV4.sha256Hex(server.absoluteString + "\n" + account.lowercased()).prefix(24)
    }

    public static func isName(_ name: String) -> Bool {
        name.hasPrefix("account-") && name.count == 32
            && name.dropFirst(8).allSatisfy { "0123456789abcdef".contains($0) }
    }
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
