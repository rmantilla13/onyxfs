import Foundation

/// The app's bridge as DriveEngine uses it: the onyxfs protocol (ONYXFS.md)
/// over FSBridgeClient in the extension, a fake in tests. Paths are the
/// drive's own ("/Footage/Take 1.mov", "/" for the top).
public protocol EngineBridge: Sendable {
    func volume() async throws -> BridgeVolume
    /// A folder's contents. `.notFound` when there is no such folder.
    func list(_ path: String) async throws -> [BridgeEntry]
    /// The whole file at `from` becomes the file at `path` (new, or the
    /// existing one's new contents); answered as soon as the app has it.
    /// `modified` and `created`: the dates the writer gave it.
    func putFile(_ path: String, from: URL, modified: Date?, created: Date?) async throws -> BridgeEntry
    func mkdir(_ path: String) async throws -> BridgeEntry
    func rename(_ from: String, to: String, replace: Bool) async throws -> BridgeEntry
    func delete(_ path: String) async throws
    /// Long-polls for the folders whose listing changed since `generation`.
    func changes(since generation: UInt64) async throws -> BridgeChanges
    /// Something to read the file's bytes from — FileReader, which streams
    /// and caches.
    func reader(for entry: BridgeEntry) async throws -> any ByteSource
}

public protocol ByteSource: Sendable {
    /// Up to `length` bytes from `offset`; fewer at the end, none past it.
    func read(offset: Int64, length: Int) async throws -> Data
    /// No longer read: whatever it fetched ahead can go.
    func close() async
}

extension ByteSource {
    public func close() async {}
}

public struct BridgeEntry: Sendable, Equatable {
    public var name: String
    public var isDirectory: Bool
    public var id: String?
    public var size: Int64
    public var modified: Date
    /// When the file was made; nil when the app did not say.
    public var created: Date?
    /// Moves when the bytes may have changed; keys the chunk cache.
    public var version: String
    /// Still uploading from this Mac.
    public var pending: Bool
    /// Its bytes are on this Mac (kept offline, or still uploading).
    public var local: Bool

    public init(name: String, isDirectory: Bool, id: String? = nil, size: Int64 = 0, modified: Date = Date(timeIntervalSince1970: 0),
                version: String = "", pending: Bool = false, local: Bool = false, created: Date? = nil) {
        self.name = name; self.isDirectory = isDirectory; self.id = id; self.size = size
        self.modified = modified; self.version = version; self.pending = pending; self.local = local
        self.created = created
    }
}

public struct BridgeVolume: Sendable, Equatable {
    public var name: String
    public var readOnly: Bool
    public var totalBytes: Int64
    public var usedBytes: Int64
    public var fileCount: Int64
    public var generation: UInt64

    public init(name: String, readOnly: Bool, totalBytes: Int64 = 0, usedBytes: Int64 = 0, fileCount: Int64 = 0, generation: UInt64 = 0) {
        self.name = name; self.readOnly = readOnly; self.totalBytes = totalBytes
        self.usedBytes = usedBytes; self.fileCount = fileCount; self.generation = generation
    }
}

public struct BridgeChanges: Sendable, Equatable {
    public var generation: UInt64
    public var paths: [String]
    public var all: Bool

    public init(generation: UInt64, paths: [String], all: Bool = false) {
        self.generation = generation; self.paths = paths; self.all = all
    }
}

/// What can go wrong at the bridge, as the file system reports it.
public enum BridgeFailure: Error, Equatable {
    /// The app is gone or restarted (its session with this volume ended).
    case disconnected
    case notFound
    /// The server's refusal, in its words.
    case forbidden(String)
    case exists(String)
    case other(String)
    /// Anything else, as the file system reports it (EDQUOT, ESTALE …).
    case posix(Int32, String)

    public var errno: Int32 {
        switch self {
        case .disconnected: return EIO
        case .notFound: return ENOENT
        case .forbidden: return EACCES
        case .exists: return EEXIST
        case .other: return EIO
        case let .posix(code, _): return code
        }
    }
}
