import Foundation

/// Files being written on this Mac, until their bytes are handed to the app
/// (which uploads them). One staging file per item being written, in the
/// extension's own container; written in place as the app writing it writes,
/// read back from here while it is open, and removed once the app has it.
///
/// Not kept across a restart of the extension: a copy the kernel had not
/// finished is a copy Finder reported as failed, and one that had finished
/// was handed to the app when it closed.
public actor StagingArea {
    public enum Failure: Error, Equatable {
        case posix(Int32)
    }

    private let directory: URL
    private var files: [UInt64: URL] = [:]

    public init(directory: URL) throws {
        self.directory = directory
        // What an earlier run left: nothing will ever hand it over now.
        try? FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    public func contains(_ id: UInt64) -> Bool { files[id] != nil }

    public func url(_ id: UInt64) -> URL? { files[id] }

    /// An empty staging file for a new file (or one being truncated to 0).
    @discardableResult
    public func create(_ id: UInt64) throws -> URL {
        if let existing = files[id] {
            try handle(existing, writing: true).truncate(atOffset: 0)
            return existing
        }
        let url = directory.appendingPathComponent(UUID().uuidString)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw Failure.posix(EIO) }
        files[id] = url
        return url
    }

    /// A new file whose bytes are already on this Mac, at `source`: staged as
    /// a copy of them (a clone, on APFS: nothing is read).
    public func adopt(_ id: UInt64, from source: URL) throws {
        if let existing = files.removeValue(forKey: id) { try? FileManager.default.removeItem(at: existing) }
        let url = directory.appendingPathComponent(UUID().uuidString)
        do { try FileManager.default.copyItem(at: source, to: url) } catch { throw Failure.posix(EIO) }
        files[id] = url
    }

    /// Copy on write: an existing file about to be changed is brought here
    /// whole first, `size` bytes read through `fetch` in pieces (so a large
    /// file never sits in memory at once).
    public func materialize(_ id: UInt64, size: UInt64, piece: Int = 8 << 20,
                            fetch: @Sendable (_ offset: Int64, _ count: Int) async throws -> Data) async throws {
        guard files[id] == nil else { return }
        let url = directory.appendingPathComponent(UUID().uuidString)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw Failure.posix(EIO) }
        let out = try handle(url, writing: true)
        defer { try? out.close() }
        var offset: UInt64 = 0
        do {
            while offset < size {
                let count = Int(min(UInt64(piece), size - offset))
                let data = try await fetch(Int64(offset), count)
                guard !data.isEmpty else { break }
                try out.write(contentsOf: data)
                offset += UInt64(data.count)
            }
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        files[id] = url
    }

    public func write(_ id: UInt64, at offset: Int64, _ data: Data) throws -> Int {
        guard let url = files[id] else { throw Failure.posix(EBADF) }
        let out = try handle(url, writing: true)
        defer { try? out.close() }
        do {
            try out.seek(toOffset: UInt64(max(0, offset)))
            try out.write(contentsOf: data)
        } catch {
            throw Failure.posix(ENOSPC)
        }
        return data.count
    }

    public func read(_ id: UInt64, at offset: Int64, count: Int) throws -> Data {
        guard let url = files[id] else { throw Failure.posix(EBADF) }
        let input = try handle(url, writing: false)
        defer { try? input.close() }
        try input.seek(toOffset: UInt64(max(0, offset)))
        return try input.read(upToCount: count) ?? Data()
    }

    public func truncate(_ id: UInt64, to size: UInt64) throws {
        guard let url = files[id] else { throw Failure.posix(EBADF) }
        let out = try handle(url, writing: true)
        defer { try? out.close() }
        try out.truncate(atOffset: size)
    }

    public func size(_ id: UInt64) -> UInt64 {
        guard let url = files[id],
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return 0 }
        return (attributes[.size] as? NSNumber)?.uint64Value ?? 0
    }

    public func remove(_ id: UInt64) {
        guard let url = files.removeValue(forKey: id) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private func handle(_ url: URL, writing: Bool) throws -> FileHandle {
        do {
            return writing ? try FileHandle(forUpdating: url) : try FileHandle(forReadingFrom: url)
        } catch {
            throw Failure.posix(EIO)
        }
    }
}
