import Foundation

/// What the volume needs from the engine behind it. The FSKit glue in this
/// folder only translates between the kernel's calls and these; everything
/// that decides anything — the tree, streaming, the cache, writes, uploads —
/// is the engine's (OnyxFSCore), which is plain Swift and tested on its own.
///
/// Errors are POSIX codes (`VolumeError.posix`), which the glue hands the
/// kernel as they are: ENOENT for a name that is not there, EACCES for a
/// drive this account may only view, EROFS, EIO when the app cannot be
/// reached.
public protocol VolumeEngine: AnyObject, Sendable {
    /// The drive's name: the volume's, and its folder in /Volumes.
    var volumeName: String { get }
    /// This account may only view the drive.
    var readOnly: Bool { get }
    var rootID: UInt64 { get }

    /// Kept current by the engine: statfs asks often and cannot wait.
    var statistics: VolumeStatistics { get }

    func node(_ id: UInt64) async throws -> VolumeNode
    /// ENOENT when there is no such name.
    func lookup(_ name: String, in directory: UInt64) async throws -> VolumeNode
    /// A folder's contents, in a stable order.
    func children(of directory: UInt64) async throws -> [VolumeNode]
    /// Up to `count` bytes from `offset`; fewer at the end of the file.
    func read(_ id: UInt64, at offset: Int64, count: Int) async throws -> Data

    func create(_ name: String, in directory: UInt64, isDirectory: Bool) async throws -> VolumeNode
    /// A file is about to be written: an existing one is brought into
    /// staging whole first (copy on write) unless it is being truncated.
    func beginWriting(_ id: UInt64, truncating: Bool) async throws
    func write(_ id: UInt64, at offset: Int64, data: Data) async throws -> Int
    func setSize(_ id: UInt64, to size: UInt64) async throws -> VolumeNode
    func setModified(_ id: UInt64, to date: Date) async throws -> VolumeNode
    /// The last writer closed it (or asked for it to be synced): its bytes
    /// go to the app, which uploads them.
    func finishWriting(_ id: UInt64) async throws
    func rename(_ id: UInt64, from directory: UInt64, name: String,
                to newDirectory: UInt64, newName: String, replacing: UInt64?) async throws -> VolumeNode
    func remove(_ id: UInt64, name: String, from directory: UInt64) async throws
    func synchronize() async throws
    /// The kernel no longer holds the item.
    func forget(_ id: UInt64) async

    /// Extended attributes are this Mac's alone: kept by the engine, never
    /// uploaded (and having them keeps macOS from writing `._` files).
    func xattr(named name: String, of id: UInt64) async throws -> Data
    func setXattr(named name: String, of id: UInt64, to value: Data?, createOnly: Bool, replaceOnly: Bool) async throws
    func xattrNames(of id: UInt64) async throws -> [String]

    /// Called with the ids whose contents or listing changed elsewhere (the
    /// web, another Mac), so the kernel's caches of them can be dropped.
    func observeChanges(_ handler: @escaping @Sendable (_ changed: Set<UInt64>, _ everything: Bool) -> Void)
    func shutdown() async
}

public struct VolumeNode: Sendable, Equatable {
    public init(id: UInt64, parent: UInt64, name: String, isDirectory: Bool, size: UInt64,
                modified: Date, created: Date, localOnly: Bool) {
        self.id = id; self.parent = parent; self.name = name; self.isDirectory = isDirectory
        self.size = size; self.modified = modified; self.created = created; self.localOnly = localOnly
    }

    public var id: UInt64
    public var parent: UInt64
    public var name: String
    public var isDirectory: Bool
    public var size: UInt64
    public var modified: Date
    public var created: Date
    /// Only on this Mac (.DS_Store and the like): never on the web.
    public var localOnly: Bool

    /// Hidden in Finder, as macOS's own files are on any disk. Most hide by
    /// their dot; the Time Machine marker at the root
    /// (com.apple.timemachine.donotpresent) and a folder's Icon\r have none.
    public var hidden: Bool { localOnly }
}

public struct VolumeStatistics: Sendable, Equatable {
    public init(totalBytes: UInt64, usedBytes: UInt64, fileCount: UInt64) {
        self.totalBytes = totalBytes; self.usedBytes = usedBytes; self.fileCount = fileCount
    }

    public var totalBytes: UInt64
    public var usedBytes: UInt64
    public var fileCount: UInt64
}

public enum VolumeError: Error, Equatable {
    case posix(Int32)
}
