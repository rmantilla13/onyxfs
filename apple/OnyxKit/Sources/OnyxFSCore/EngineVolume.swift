import Foundation

/// DriveEngine as the FSKit glue holds it (VolumeEngine). The kernel asks
/// some things synchronously — statfs, whether the volume is read-only —
/// which an actor cannot answer without waiting, so those are kept here and
/// brought up to date whenever the engine hears the drive changed.
public final class EngineVolume: VolumeEngine, @unchecked Sendable {
    public let engine: DriveEngine
    public let volumeName: String
    public var rootID: UInt64 { DriveEngine.rootID }
    private let lock = NSLock()
    private var cachedReadOnly: Bool
    private var cachedStatistics: VolumeStatistics

    public init(engine: DriveEngine, volume: BridgeVolume) {
        self.engine = engine
        volumeName = volume.name
        cachedReadOnly = volume.readOnly
        cachedStatistics = VolumeStatistics(totalBytes: UInt64(max(0, volume.totalBytes)),
                                            usedBytes: UInt64(max(0, volume.usedBytes)),
                                            fileCount: UInt64(max(0, volume.fileCount)))
    }

    public var readOnly: Bool { lock.withLock { cachedReadOnly } }
    public var statistics: VolumeStatistics { lock.withLock { cachedStatistics } }

    private func refreshCache() async {
        let readOnly = await engine.readOnly
        let statistics = await engine.statistics
        lock.withLock {
            cachedReadOnly = readOnly
            cachedStatistics = statistics
        }
    }

    public func node(_ id: UInt64) async throws -> VolumeNode { try await engine.node(id) }
    public func lookup(_ name: String, in directory: UInt64) async throws -> VolumeNode { try await engine.lookup(name, in: directory) }
    public func children(of directory: UInt64) async throws -> [VolumeNode] { try await engine.children(of: directory) }
    public func read(_ id: UInt64, at offset: Int64, count: Int) async throws -> Data { try await engine.read(id, at: offset, count: count) }
    public func create(_ name: String, in directory: UInt64, isDirectory: Bool) async throws -> VolumeNode {
        try await engine.create(name, in: directory, isDirectory: isDirectory)
    }
    public func beginWriting(_ id: UInt64, truncating: Bool) async throws { try await engine.beginWriting(id, truncating: truncating) }
    public func write(_ id: UInt64, at offset: Int64, data: Data) async throws -> Int { try await engine.write(id, at: offset, data: data) }
    public func setSize(_ id: UInt64, to size: UInt64) async throws -> VolumeNode { try await engine.setSize(id, to: size) }
    public func setModified(_ id: UInt64, to date: Date) async throws -> VolumeNode { try await engine.setModified(id, to: date) }
    public func setCreated(_ id: UInt64, to date: Date) async throws -> VolumeNode { try await engine.setCreated(id, to: date) }
    public func finishWriting(_ id: UInt64) async throws { try await engine.finishWriting(id) }
    public func rename(_ id: UInt64, from directory: UInt64, name: String, to newDirectory: UInt64,
                       newName: String, replacing: UInt64?) async throws -> VolumeNode {
        try await engine.rename(id, from: directory, name: name, to: newDirectory, newName: newName, replacing: replacing)
    }
    public func remove(_ id: UInt64, name: String, from directory: UInt64) async throws {
        try await engine.remove(id, name: name, from: directory)
    }
    public func synchronize() async throws { try await engine.synchronize() }
    public func forget(_ id: UInt64) async { await engine.forget(id) }
    public func xattr(named name: String, of id: UInt64) async throws -> Data { try await engine.xattr(named: name, of: id) }
    public func setXattr(named name: String, of id: UInt64, to value: Data?, createOnly: Bool, replaceOnly: Bool) async throws {
        try await engine.setXattr(named: name, of: id, to: value, createOnly: createOnly, replaceOnly: replaceOnly)
    }
    public func xattrNames(of id: UInt64) async throws -> [String] { try await engine.xattrNames(of: id) }

    public func observeChanges(_ handler: @escaping @Sendable (Set<UInt64>, Bool) -> Void) {
        let engine = self.engine
        let refresh: @Sendable () async -> Void = { [weak self] in await self?.refreshCache() }
        Task {
            await engine.observeChanges { ids, everything in
                Task {
                    await refresh()
                    handler(ids, everything)
                }
            }
        }
    }

    public func shutdown() async { await engine.shutdown() }
}
