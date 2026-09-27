import FSKit
import Foundation
import OnyxFSCore

/// One mounted drive, as the kernel sees it: FSKit's calls, each translated
/// into the engine's (VolumeEngine) and back. Nothing is decided here.
///
/// It is case-insensitive and case-preserving, like the Mac's own disks and
/// like the drive itself (names in a folder are unique ignoring case — the
/// mirror looks them up that way), with 64-bit ids, hidden files and fast
/// statfs; no links.
/// Reads are cached by the kernel (macOS 27's data cache): the engine is
/// asked only for what the kernel does not already hold, and when the web
/// changes a file the kernel's copy of it is dropped (`changed`).
@available(macOS 27.0, *)
final class OnyxVolume: FSVolume, FSVolume.Handler, FSVolume.PathConfOperations,
                        FSVolume.ReadWriteHandler, FSVolume.DataCacheHandler, FSVolume.XattrHandler, @unchecked Sendable {
    let engine: any VolumeEngine
    private let items = ItemTable()
    private let uid = getuid()
    private let gid = getgid()

    init(engine: any VolumeEngine, volumeID: FSVolume.Identifier) {
        self.engine = engine
        super.init(volumeID: volumeID, volumeName: FSFileName(string: engine.volumeName))
        engine.observeChanges { [weak self] changed, everything in
            self?.changed(changed, everything: everything)
        }
    }

    // MARK: - What the volume is

    var supportedVolumeCapabilities: FSVolume.SupportedCapabilities {
        let c = FSVolume.SupportedCapabilities()
        c.supportsPersistentObjectIDs = false
        c.supports64BitObjectIDs = true
        c.supportsSymbolicLinks = false
        c.supportsHardLinks = false
        c.supportsHiddenFiles = true
        c.supportsFastStatFS = true
        c.supports2TBFiles = true
        c.supportsSparseFiles = false
        c.doesNotSupportImmutableFiles = true
        c.doesNotSupportSettingFilePermissions = true
        c.caseFormat = .insensitiveCasePreserving
        return c
    }

    /// The drive's own size. With no quota the server reports 0 for the
    /// total, and then the volume shows what is used plus a free figure no
    /// copy would run into, so no app refuses to write thinking it full.
    var volumeStatistics: FSStatFSResult {
        let stats = engine.statistics
        let block: UInt64 = 4096
        let total = stats.totalBytes > stats.usedBytes ? stats.totalBytes : stats.usedBytes + (8 << 40)
        let free = total - stats.usedBytes
        let result = FSStatFSResult(fileSystemTypeName: FileSystemKind.shortName)
        result.blockSize = Int(block)
        result.ioSize = 1 << 20
        result.totalBytes = total
        result.usedBytes = stats.usedBytes
        result.freeBytes = free
        result.availableBytes = engine.readOnly ? 0 : free
        result.totalBlocks = total / block
        result.usedBlocks = stats.usedBytes / block
        result.freeBlocks = free / block
        result.availableBlocks = engine.readOnly ? 0 : free / block
        result.totalFiles = stats.fileCount + 1_000_000
        result.freeFiles = 1_000_000
        return result
    }

    var maximumLinkCount: Int { 1 }
    var maximumNameLength: Int { 255 }
    var restrictsOwnershipChanges: Bool { true }
    var truncatesLongNames: Bool { false }
    var maximumXattrSize: Int { 128 * 1024 }
    var maximumFileSize: UInt64 { UInt64(Int64.max) }

    // MARK: - Life

    func activateVolume(options: FSTaskOptions) async throws -> FSActivateResult {
        guard let result = FSActivateResult(rootItem: items.item(for: engine.rootID)) else { throw Self.posix(EIO) }
        return result
    }

    func deactivateVolume(options: FSDeactivateOptions) async throws {}

    func mount(options: FSTaskOptions) async throws {}

    func unmount() async {
        // Whatever is still being written goes to the app first: an eject
        // must not lose a copy that Finder already called done.
        try? await engine.synchronize()
        await engine.shutdown()
    }

    func synchronize(flags: FSSyncFlags) async throws {
        try await Self.mapped { try await self.engine.synchronize() }
    }

    // MARK: - Names

    func lookupItem(named name: FSFileName, in directory: FSItem, context: FSContext) async throws -> FSLookupItemResult {
        let node = try await Self.mapped { try await self.engine.lookup(Self.string(name), in: Self.id(directory)) }
        guard let result = FSLookupItemResult(foundItem: items.item(for: node.id), itemName: name,
                                              itemAttributes: attributes(of: node)) else { throw Self.posix(EIO) }
        return result
    }

    func reclaimItem(_ item: FSItem) async throws {
        guard let item = item as? OnyxItem else { return }
        if items.reclaim(item) { await engine.forget(item.id) }
    }

    func enumerateDirectory(_ directory: FSItem, startingAt cookie: FSDirectoryCookie, verifier: FSDirectoryVerifier,
                            attributes wanted: FSItem.GetAttributesRequest?, packer: FSDirectoryEntryPacker,
                            context: FSContext) async throws -> FSEnumerateDirectoryResult {
        let dirID = Self.id(directory)
        let (dir, children) = try await Self.mapped {
            (try await self.engine.node(dirID), try await self.engine.children(of: dirID))
        }
        // Cookies are positions: 1 and 2 are "." and ".." (readdir only),
        // then the children in the engine's order. The verifier is the
        // listing itself, so a folder that changed between two calls is
        // re-read from the start rather than skipping or repeating a name.
        let listing = UInt64(truncatingIfNeeded: children.map { "\($0.id)\u{0}\($0.name)" }.joined(separator: "\u{1}").hashValue)
        if verifier.rawValue != 0, verifier.rawValue != listing, cookie.rawValue != 0 {
            throw fs_errorForPOSIXError(Int32(FSError.Code.invalidDirectoryCookie.rawValue))
        }
        var position = cookie.rawValue
        if wanted == nil {
            let dots: [(String, UInt64)] = [(".", dir.id), ("..", dir.id == engine.rootID ? dir.id : dir.parent)]
            while position < 2 {
                let (name, id) = dots[Int(position)]
                position += 1
                guard packer.packEntry(name: FSFileName(string: name), itemType: .directory,
                                       itemID: FSItem.Identifier(rawValue: id) ?? .invalid,
                                       nextCookie: FSDirectoryCookie(rawValue: position),
                                       attributes: nil) else {
                    return try Self.enumerated(listing)
                }
            }
        }
        let start = Int(position) - (wanted == nil ? 2 : 0)
        guard start >= 0, start <= children.count else {
            throw fs_errorForPOSIXError(Int32(FSError.Code.invalidDirectoryCookie.rawValue))
        }
        for (offset, child) in children[start...].enumerated() {
            let next = FSDirectoryCookie(rawValue: UInt64(start + offset + 1 + (wanted == nil ? 2 : 0)))
            guard packer.packEntry(name: FSFileName(string: child.name),
                                   itemType: child.isDirectory ? .directory : .file,
                                   itemID: FSItem.Identifier(rawValue: child.id) ?? .invalid,
                                   nextCookie: next,
                                   attributes: wanted == nil ? nil : attributes(of: child)) else { break }
        }
        return try Self.enumerated(listing)
    }

    private static func enumerated(_ verifier: UInt64) throws -> FSEnumerateDirectoryResult {
        guard let result = FSEnumerateDirectoryResult(verifier: verifier) else { throw posix(EIO) }
        return result
    }

    // MARK: - Attributes

    func attributes(_ desired: FSItem.GetAttributesRequest, of item: FSItem, context: FSContext) async throws -> FSGetAttributesResult {
        let node = try await Self.mapped { try await self.engine.node(Self.id(item)) }
        guard let result = FSGetAttributesResult(attributes: attributes(of: node)) else { throw Self.posix(EIO) }
        return result
    }

    /// Size (truncating, extending) and the modification date are kept;
    /// the rest — owner, mode, flags — is accepted and ignored, as on any
    /// volume that does not store permissions (and Finder sets them on
    /// every copy).
    func setAttributes(_ request: FSItem.SetAttributesRequest, on item: FSItem, context: FSContext) async throws -> FSSetAttributesResult {
        let id = Self.id(item)
        var node = try await Self.mapped { try await self.engine.node(id) }
        if request.isValid(.size), !node.isDirectory, request.size != node.size {
            guard !engine.readOnly else { throw Self.posix(EACCES) }
            node = try await Self.mapped { try await self.engine.setSize(id, to: request.size) }
        }
        if request.isValid(.modifyTime) {
            let date = Date(timeIntervalSince1970: Double(request.modifyTime.tv_sec) + Double(request.modifyTime.tv_nsec) / 1e9)
            if !engine.readOnly { node = try await Self.mapped { try await self.engine.setModified(id, to: date) } }
        }
        request.consumedAttributes = [.size, .modifyTime, .mode, .uid, .gid, .flags, .accessTime, .changeTime, .birthTime, .backupTime, .addedTime]
        guard let result = FSSetAttributesResult(attributes: attributes(of: node), freeSpace: nil) else { throw Self.posix(EIO) }
        return result
    }

    private func attributes(of node: VolumeNode) -> FSItem.Attributes {
        let a = FSItem.Attributes()
        let writable = !engine.readOnly
        a.type = node.isDirectory ? .directory : .file
        a.mode = node.isDirectory
            ? UInt32(S_IFDIR) | (writable ? 0o755 : 0o555)
            : UInt32(S_IFREG) | (writable ? 0o644 : 0o444)
        a.uid = uid
        a.gid = gid
        a.linkCount = node.isDirectory ? 2 : 1
        a.size = node.size
        a.allocSize = (node.size + 4095) / 4096 * 4096
        a.fileID = FSItem.Identifier(rawValue: node.id) ?? .invalid
        a.parentID = FSItem.Identifier(rawValue: node.parent) ?? .invalid
        let modified = Self.timespec(node.modified)
        a.modifyTime = modified
        a.changeTime = modified
        a.accessTime = modified
        a.birthTime = Self.timespec(node.created)
        a.flags = 0
        return a
    }

    // MARK: - Making, moving, removing

    func createItem(named name: FSFileName, type: FSItem.ItemType, in directory: FSItem,
                    attributes: FSItem.SetAttributesRequest, context: FSContext) async throws -> FSCreateItemResult {
        guard !engine.readOnly else { throw Self.posix(EACCES) }
        guard type == .file || type == .directory else { throw Self.posix(ENOTSUP) }
        let dirID = Self.id(directory)
        let (node, dir) = try await Self.mapped {
            let made = try await self.engine.create(Self.string(name), in: dirID, isDirectory: type == .directory)
            return (made, try await self.engine.node(dirID))
        }
        attributes.consumedAttributes = [.mode, .uid, .gid, .flags]
        guard let result = FSCreateItemResult(newItem: items.item(for: node.id), newItemName: name,
                                              newItemAttributes: self.attributes(of: node),
                                              directoryAttributes: self.attributes(of: dir), freeSpace: nil)
        else { throw Self.posix(EIO) }
        return result
    }

    func createSymbolicLink(named name: FSFileName, in directory: FSItem, attributes: FSItem.SetAttributesRequest,
                            linkContents: FSFileName, context: FSContext) async throws -> FSCreateSymlinkResult {
        throw Self.posix(ENOTSUP)
    }

    func createLink(to item: FSItem, named name: FSFileName, in directory: FSItem, context: FSContext) async throws -> FSCreateLinkResult {
        throw Self.posix(ENOTSUP)
    }

    func readSymbolicLink(_ item: FSItem, context: FSContext) async throws -> FSReadSymlinkResult {
        throw Self.posix(EINVAL)
    }

    func renameItem(_ item: FSItem, inDirectory sourceDirectory: FSItem, named sourceName: FSFileName,
                    to destinationName: FSFileName, inDirectory destinationDirectory: FSItem, overItem: FSItem?,
                    context: FSContext) async throws -> FSRenameItemResult {
        guard !engine.readOnly else { throw Self.posix(EACCES) }
        let from = Self.id(sourceDirectory), to = Self.id(destinationDirectory)
        let replaced = overItem.map(Self.id)
        let (node, source, destination) = try await Self.mapped {
            let moved = try await self.engine.rename(Self.id(item), from: from, name: Self.string(sourceName),
                                                     to: to, newName: Self.string(destinationName), replacing: replaced)
            return (moved, try await self.engine.node(from), try await self.engine.node(to))
        }
        let over = replaced.map { _ in self.gone() }
        guard let result = FSRenameItemResult(newName: destinationName, renamedItemAttributes: attributes(of: node),
                                              sourceDirectoryAttributes: attributes(of: source),
                                              destinationDirectoryAttributes: attributes(of: destination),
                                              overItemAttributes: over, freeSpace: nil)
        else { throw Self.posix(EIO) }
        return result
    }

    func removeItem(_ item: FSItem, named name: FSFileName, from directory: FSItem, context: FSContext) async throws -> FSRemoveItemResult {
        guard !engine.readOnly else { throw Self.posix(EACCES) }
        let dirID = Self.id(directory)
        let dir = try await Self.mapped {
            try await self.engine.remove(Self.id(item), name: Self.string(name), from: dirID)
            return try await self.engine.node(dirID)
        }
        guard let result = FSRemoveItemResult(itemAttributes: gone(), directoryAttributes: attributes(of: dir), freeSpace: nil)
        else { throw Self.posix(EIO) }
        return result
    }

    /// What is left of an item once it is removed: no links.
    private func gone() -> FSItem.Attributes {
        let a = FSItem.Attributes()
        a.linkCount = 0
        return a
    }

    // MARK: - Bytes

    func read(from item: FSItem, at offset: off_t, length: Int, into buffer: FSMutableFileDataBuffer) async throws -> FSReadFileResult {
        let id = Self.id(item)
        let data = try await Self.mapped { try await self.engine.read(id, at: offset, count: min(length, buffer.length)) }
        let count = buffer.withUnsafeMutableBytes { target in data.copyBytes(to: target) }
        let node = try await Self.mapped { try await self.engine.node(id) }
        guard let result = FSReadFileResult(bytesRead: count, itemAttributes: attributes(of: node)) else { throw Self.posix(EIO) }
        return result
    }

    func write(contents: Data, to item: FSItem, at offset: off_t) async throws -> FSWriteFileResult {
        guard !engine.readOnly else { throw Self.posix(EACCES) }
        let id = Self.id(item)
        let (written, node) = try await Self.mapped {
            let n = try await self.engine.write(id, at: offset, data: contents)
            return (n, try await self.engine.node(id))
        }
        guard let result = FSWriteFileResult(bytesWritten: written, itemAttributes: attributes(of: node), freeSpace: nil)
        else { throw Self.posix(EIO) }
        return result
    }

    // MARK: - Open, close and the kernel's cache

    var isDataCacheInhibited: Bool { false }

    /// Reads are cached by the kernel. A file open for writing is cached
    /// write-through, so what an app writes reaches staging as it writes and
    /// the upload on close has it all.
    func open(_ item: FSItem, modes: FSVolume.OpenModes, cacheMode: FSVolume.DataCacheMode,
              context: FSContext) async throws -> FSOpenItemResult {
        let id = Self.id(item)
        if modes.contains(.write) {
            guard !engine.readOnly else { throw Self.posix(EACCES) }
            try await Self.mapped { try await self.engine.beginWriting(id, truncating: false) }
        }
        return FSOpenItemResult(grantedCoherency: Self.coherency(for: cacheMode))
    }

    func upgrade(_ item: FSItem, cacheMode: FSVolume.DataCacheMode, context: FSContext) async throws -> FSUpgradeItemResult {
        if cacheMode == .readWriteWithCache {
            guard !engine.readOnly else { throw Self.posix(EACCES) }
            let id = Self.id(item)
            try await Self.mapped { try await self.engine.beginWriting(id, truncating: false) }
        }
        return FSUpgradeItemResult(grantedCoherency: Self.coherency(for: cacheMode))
    }

    /// The last close: a file that was written goes to the app now. A
    /// failure here cannot reach the app that closed it (close returns
    /// nothing); the engine keeps the file pending, and Onyx says so.
    func close(_ item: FSItem, context: FSContext) async {
        try? await engine.finishWriting(Self.id(item))
    }

    private static func coherency(for mode: FSVolume.DataCacheMode) -> FSVolume.KernelCacheCoherencyType {
        switch mode {
        case .readWithCache: return .readCache
        case .readWriteWithCache: return .writeThrough
        default: return .noCache
        }
    }

    /// Changed elsewhere: the kernel's cached bytes of those files go, and
    /// an item that no longer exists is revoked. Called off every lock, as
    /// setCacheState requires.
    private func changed(_ ids: Set<UInt64>, everything: Bool) {
        let targets = everything ? items.all : ids.compactMap(items.existing)
        for item in targets {
            _ = setCacheState(for: item, cacheMode: .readWithCache, coherencyType: .readCache, action: .invalidate)
        }
    }

    // MARK: - Extended attributes (this Mac's only)

    var xattrOperationsInhibited: Bool { false }

    func supportedXattrNames(for item: FSItem) -> [FSFileName] { [] }

    func xattr(named name: FSFileName, of item: FSItem, context: FSContext) async throws -> FSGetXattrResult {
        let id = Self.id(item)
        let value = try await Self.mapped { try await self.engine.xattr(named: Self.string(name), of: id) }
        guard let result = FSGetXattrResult(xattrValue: value) else { throw Self.posix(EIO) }
        return result
    }

    func setXattr(named name: FSFileName, to value: Data?, on item: FSItem, policy: FSVolume.SetXattrPolicy,
                  context: FSContext) async throws -> FSSetXattrResult {
        let id = Self.id(item)
        try await Self.mapped {
            try await self.engine.setXattr(named: Self.string(name), of: id,
                                           to: policy == .delete ? nil : value,
                                           createOnly: policy == .mustCreate, replaceOnly: policy == .mustReplace)
        }
        guard let result = FSSetXattrResult(freeSpace: nil) else { throw Self.posix(EIO) }
        return result
    }

    func xattrs(of item: FSItem, context: FSContext) async throws -> FSListXattrsResult {
        let id = Self.id(item)
        let names = try await Self.mapped { try await self.engine.xattrNames(of: id) }
        guard let result = FSListXattrsResult(xattrNames: names.map { FSFileName(string: $0) }) else { throw Self.posix(EIO) }
        return result
    }

    // MARK: - Helpers

    private static func id(_ item: FSItem) -> UInt64 {
        (item as? OnyxItem)?.id ?? 0
    }

    private static func string(_ name: FSFileName) -> String {
        name.string ?? String(decoding: name.data, as: UTF8.self)
    }

    private static func timespec(_ date: Date) -> timespec {
        let seconds = date.timeIntervalSince1970
        let whole = seconds.rounded(.down)
        return Darwin.timespec(tv_sec: Int(whole), tv_nsec: Int((seconds - whole) * 1e9))
    }

    static func posix(_ code: Int32) -> any Error { fs_errorForPOSIXError(code) }

    /// The engine's errors as the kernel wants them.
    private static func mapped<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let VolumeError.posix(code) {
            throw fs_errorForPOSIXError(code)
        } catch is CancellationError {
            throw fs_errorForPOSIXError(EINTR)
        }
    }
}

/// This file system's short name, as its Info.plist declares it (FSShortName):
/// "onyxfs", or "onyxfsdev" in a dev build (scripts/build-mac.sh) — what
/// statfs reports, and what the app knows its own disks by.
enum FileSystemKind {
    static let shortName: String = {
        let attributes = Bundle.main.object(forInfoDictionaryKey: "EXAppExtensionAttributes") as? [String: Any]
        return attributes?["FSShortName"] as? String ?? "onyxfs"
    }()
}
