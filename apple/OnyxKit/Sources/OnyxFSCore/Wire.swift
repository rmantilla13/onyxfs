import Foundation

// onyxfs bridge protocol v1: what Onyx.app answers on 127.0.0.1 for one
// mounted drive, and what the extension sends it. JSON, UTF-8.
//
// These types decode what the app sends. They encode too, so a test can play
// the app, and so the app could answer with them one day.

/// A file or a folder, as the bridge lists it.
public struct FSEntry: Codable, Sendable, Hashable {
    public enum Kind: String, Codable, Sendable, Hashable {
        case file
        case dir
    }

    /// NFC, never empty, never containing "/".
    public var name: String
    public var type: Kind
    /// The server's file id. Nil for folders, and for a file this Mac has
    /// not uploaded yet.
    public var id: String?
    /// Bytes; 0 for folders.
    public var size: Int64
    /// Seconds since 1970. For a folder, its newest child's, or 0.
    public var mtime: Double
    /// When the file was made, seconds since 1970; nil from an app that
    /// does not say, when the modification time stands in.
    public var btime: Double?
    /// Changes whenever the bytes may have, and only then: it keys the chunk
    /// cache, so a rename keeps what was cached and new bytes never read old.
    public var version: String
    /// The bytes are on this Mac, so /fs/v1/data serves them without the
    /// network.
    public var local: Bool
    /// The bytes are still uploading from this Mac.
    public var pending: Bool
    /// Nothing may be made, written, moved or deleted here, whatever the
    /// drive allows: a collection's files, which are the drive's own files
    /// shown again (the app's virtual Collections folder).
    public var readOnly: Bool

    public init(name: String, type: Kind, id: String? = nil, size: Int64 = 0, mtime: Double = 0,
                version: String = "", local: Bool = false, pending: Bool = false, btime: Double? = nil,
                readOnly: Bool = false) {
        self.name = name; self.type = type; self.id = id; self.size = size; self.mtime = mtime
        self.version = version; self.local = local; self.pending = pending; self.btime = btime
        self.readOnly = readOnly
    }

    public var isDirectory: Bool { type == .dir }
    public var modified: Date { Date(timeIntervalSince1970: mtime) }
    public var created: Date? { btime.map { Date(timeIntervalSince1970: $0) } }

    enum CodingKeys: String, CodingKey {
        case name, type, id, size, mtime, btime, version, local, pending, readOnly
    }

    /// Only the name and type are required. A field the app leaves out takes
    /// a folder's value, and `pending` is newer than the rest, so an app that
    /// predates writes still decodes.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        type = try c.decode(Kind.self, forKey: .type)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        size = try c.decodeIfPresent(Int64.self, forKey: .size) ?? 0
        mtime = try c.decodeIfPresent(Double.self, forKey: .mtime) ?? 0
        btime = try c.decodeIfPresent(Double.self, forKey: .btime)
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? ""
        local = try c.decodeIfPresent(Bool.self, forKey: .local) ?? false
        pending = try c.decodeIfPresent(Bool.self, forKey: .pending) ?? false
        readOnly = try c.decodeIfPresent(Bool.self, forKey: .readOnly) ?? false
    }
}

/// What the drive is, for statfs and for choosing read-only or read-write.
public struct FSVolumeInfo: Codable, Sendable, Hashable {
    public var scope: String
    public var name: String
    public var readOnly: Bool
    /// 0 when unknown.
    public var totalBytes: Int64
    public var usedBytes: Int64
    public var fileCount: Int64

    /// What a volume of unknown size reports as free: apps refuse to copy
    /// onto a disk that looks full, and a drive in the cloud is not.
    public static let unknownFreeBytes: Int64 = 8 << 40

    public init(scope: String, name: String, readOnly: Bool, totalBytes: Int64 = 0, usedBytes: Int64 = 0,
                fileCount: Int64 = 0) {
        self.scope = scope; self.name = name; self.readOnly = readOnly
        self.totalBytes = totalBytes; self.usedBytes = usedBytes; self.fileCount = fileCount
    }

    /// The size to report: the drive's own, or what is used plus 8 TiB.
    public var capacityBytes: Int64 {
        totalBytes > 0 ? max(totalBytes, usedBytes) : usedBytes + Self.unknownFreeBytes
    }

    public var freeBytes: Int64 { capacityBytes - usedBytes }

    enum CodingKeys: String, CodingKey {
        case scope, name, readOnly, totalBytes, usedBytes, fileCount
    }

    /// A drive that does not say otherwise mounts read-only: the safe
    /// reading of a missing field, since the server re-checks writes anyway.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scope = try c.decode(String.self, forKey: .scope)
        name = try c.decode(String.self, forKey: .name)
        readOnly = try c.decodeIfPresent(Bool.self, forKey: .readOnly) ?? true
        totalBytes = try c.decodeIfPresent(Int64.self, forKey: .totalBytes) ?? 0
        usedBytes = try c.decodeIfPresent(Int64.self, forKey: .usedBytes) ?? 0
        fileCount = try c.decodeIfPresent(Int64.self, forKey: .fileCount) ?? 0
    }
}

/// POST /fs/v1/session, less the session key, which never leaves the client.
public struct FSSessionInfo: Sendable, Hashable {
    /// Where the `changes` long-poll starts.
    public var generation: UInt64
    public var volume: FSVolumeInfo
    /// How much the chunk cache may hold on this Mac; 0 is no limit
    /// (`ChunkStore` takes it as it comes).
    public var cacheLimitBytes: Int64

    public static let defaultCacheLimitBytes: Int64 = 50 << 30

    public init(generation: UInt64, volume: FSVolumeInfo, cacheLimitBytes: Int64 = FSSessionInfo.defaultCacheLimitBytes) {
        self.generation = generation; self.volume = volume; self.cacheLimitBytes = cacheLimitBytes
    }
}

/// GET /fs/v1/list: one folder's entries, folders first, then files, by name.
public struct FSListing: Codable, Sendable, Hashable {
    public var path: String
    public var generation: UInt64
    public var entries: [FSEntry]

    public init(path: String, generation: UInt64, entries: [FSEntry]) {
        self.path = path; self.generation = generation; self.entries = entries
    }
}

/// GET /fs/v1/stat: one entry.
public struct FSStat: Codable, Sendable, Hashable {
    public var generation: UInt64
    public var entry: FSEntry

    public init(generation: UInt64, entry: FSEntry) {
        self.generation = generation; self.entry = entry
    }
}

/// GET /fs/v1/source: where a file's bytes are.
public struct FSSource: Codable, Sendable, Hashable {
    public enum Kind: String, Codable, Sendable, Hashable {
        /// A presigned storage URL: range-read it directly.
        case remote
        /// On this Mac: read it through /fs/v1/data.
        case local
    }

    public var kind: Kind
    /// Presigned; set for `remote`.
    public var url: URL?
    /// Seconds since 1970 at which `url` stops working.
    public var expiresAt: Double?
    public var size: Int64
    public var version: String

    public init(kind: Kind, url: URL? = nil, expiresAt: Double? = nil, size: Int64, version: String) {
        self.kind = kind; self.url = url; self.expiresAt = expiresAt; self.size = size; self.version = version
    }
}

/// GET /fs/v1/changes: the folders whose listing changed since a generation.
public struct FSChanges: Codable, Sendable, Hashable {
    public var generation: UInt64
    /// Drop everything: the mirror was rebuilt.
    public var all: Bool
    public var paths: [String]

    public init(generation: UInt64, all: Bool = false, paths: [String] = []) {
        self.generation = generation; self.all = all; self.paths = paths
    }

    enum CodingKeys: String, CodingKey { case generation, all, paths }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generation = try c.decode(UInt64.self, forKey: .generation)
        all = try c.decodeIfPresent(Bool.self, forKey: .all) ?? false
        paths = try c.decodeIfPresent([String].self, forKey: .paths) ?? []
    }
}

// MARK: - Bodies only the client sees

struct SessionRequest: Codable {
    var ticket: String
}

struct SessionReply: Codable {
    var session: String
    var generation: UInt64
    var volume: FSVolumeInfo
    var cacheLimitBytes: Int64?
}

/// PUT /fs/v1/file, POST /fs/v1/mkdir, POST /fs/v1/rename.
struct EntryReply: Codable {
    var entry: FSEntry
    var generation: UInt64?
}

struct PathRequest: Codable {
    var path: String
}

struct RenameRequest: Codable {
    var from: String
    var to: String
    var replace: Bool
}

struct ErrorReply: Codable {
    var error: String
}
