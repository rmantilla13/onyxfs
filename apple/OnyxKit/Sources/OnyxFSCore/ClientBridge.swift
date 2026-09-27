import Foundation

/// DriveEngine's bridge (EngineBridge) over the real one: FSBridgeClient
/// for the protocol, and for bytes a FileReader per file, streaming through
/// the drive's ChunkStore. What the client reports as FSBridgeError, the
/// engine gets as BridgeFailure — the one error type it maps for the kernel.
public final class ClientBridge: EngineBridge {
    public let client: FSBridgeClient
    let store: ChunkStore

    public init(client: FSBridgeClient, store: ChunkStore) {
        self.client = client
        self.store = store
    }

    /// The drive as its session found it: where the engine starts.
    public var initialVolume: BridgeVolume {
        Self.volume(client.session.volume, generation: client.session.generation)
    }

    public func volume() async throws -> BridgeVolume {
        let info = try await mapped { try await self.client.volume() }
        return Self.volume(info, generation: 0)
    }

    public func list(_ path: String) async throws -> [BridgeEntry] {
        try await mapped { try await self.client.list(path: path) }.entries.map(Self.entry)
    }

    public func putFile(_ path: String, from: URL, modified: Date?, created: Date?) async throws -> BridgeEntry {
        Self.entry(try await mapped { try await self.client.putFile(path: path, from: from, mtime: modified, btime: created) })
    }

    public func mkdir(_ path: String) async throws -> BridgeEntry {
        Self.entry(try await mapped { try await self.client.mkdir(path: path) })
    }

    public func rename(_ from: String, to: String, replace: Bool) async throws -> BridgeEntry {
        Self.entry(try await mapped { try await self.client.rename(from: from, to: to, replace: replace) })
    }

    public func delete(_ path: String) async throws {
        try await mapped { try await self.client.delete(path: path) }
    }

    public func changes(since generation: UInt64) async throws -> BridgeChanges {
        let news = try await mapped { try await self.client.changes(since: generation) }
        return BridgeChanges(generation: news.generation, paths: news.paths, all: news.all)
    }

    public func reader(for entry: BridgeEntry) async throws -> any ByteSource {
        guard let id = entry.id else { throw BridgeFailure.notFound }
        return Reader(FileReader(fileId: id, version: entry.version, size: entry.size, client: client, store: store,
                                 local: entry.local))
    }

    // MARK: -

    /// A FileReader whose errors are the engine's.
    struct Reader: ByteSource {
        let reader: FileReader
        init(_ reader: FileReader) { self.reader = reader }

        func read(offset: Int64, length: Int) async throws -> Data {
            try await ClientBridge.mapped { try await reader.read(offset: offset, length: length) }
        }

        func close() async { await reader.close() }
    }

    static func entry(_ e: FSEntry) -> BridgeEntry {
        BridgeEntry(name: e.name, isDirectory: e.isDirectory, id: e.id, size: e.size, modified: e.modified,
                    version: e.version, pending: e.pending, local: e.local, created: e.created)
    }

    static func volume(_ info: FSVolumeInfo, generation: UInt64) -> BridgeVolume {
        BridgeVolume(name: info.name, readOnly: info.readOnly, totalBytes: info.totalBytes, usedBytes: info.usedBytes,
                     fileCount: info.fileCount, generation: generation)
    }

    @discardableResult
    static func mapped<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as FSBridgeError {
            throw failure(error)
        }
    }

    private func mapped<T>(_ body: () async throws -> T) async throws -> T {
        try await Self.mapped(body)
    }

    static func failure(_ error: FSBridgeError) -> BridgeFailure {
        switch error {
        case .disconnected: return .disconnected
        case .notFound: return .notFound
        case let .forbidden(message): return .forbidden(message)
        case let .conflict(message): return .exists(message)
        case let .server(message): return .other(message)
        default: return .posix(Int32(error.posixCode.rawValue), String(describing: error))
        }
    }
}
