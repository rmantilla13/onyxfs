import Foundation
import Testing
@testable import OnyxFSCore

/// The chunk cache is the difference between scrubbing a master from disk and
/// fetching it again. What must hold: a hit is exactly the bytes written, a
/// damaged chunk is a miss and not a wrong answer, the limit is kept by
/// dropping what was used longest ago, and a restart keeps what was there.
struct ChunkStoreTests {
    static let key = ChunkStore.Key(fileId: "file-1", version: "v1")
    static let chunk = 64 * 1024

    func bytes(_ index: Int, length: Int = ChunkStoreTests.chunk, seed: UInt64 = 1) -> Data {
        Pattern.bytes(Int64(index * Self.chunk)..<Int64(index * Self.chunk + length), seed: seed)
    }

    /// Room for `chunks` chunks, digests included.
    func limit(_ chunks: Int) -> Int64 { Int64(chunks * (Self.chunk + ChunkStore.digestLength)) }

    @Test func aHitIsTheBytesWritten() async throws {
        let store = try ChunkStore(directory: try temporaryFolder(), limitBytes: limit(10))
        await store.write(Self.key, index: 3, data: bytes(3))
        #expect(await store.read(Self.key, index: 3, expectedLength: Self.chunk, range: 0..<Self.chunk) == bytes(3))
        #expect(await store.read(Self.key, index: 3, expectedLength: Self.chunk, range: 100..<5000)
                == bytes(3).subdata(in: 100..<5000))
        // Another index, another version, another file: misses.
        #expect(await store.read(Self.key, index: 4, expectedLength: Self.chunk, range: 0..<10) == nil)
        let v2 = ChunkStore.Key(fileId: "file-1", version: "v2")
        #expect(await store.read(v2, index: 3, expectedLength: Self.chunk, range: 0..<10) == nil)
        let stats = await store.stats()
        #expect(stats.chunks == 1 && stats.hits == 2 && stats.misses == 2 && stats.writes == 1)
        #expect(stats.bytes == Int64(Self.chunk + ChunkStore.digestLength))
    }

    @Test func theKeyIsTheFileAndItsVersion() {
        #expect(ChunkStore.Key(fileId: "a", version: "b") == ChunkStore.Key(fileId: "a", version: "b"))
        #expect(ChunkStore.Key(fileId: "a", version: "b") != ChunkStore.Key(fileId: "a", version: "c"))
        #expect(ChunkStore.Key(fileId: "ab", version: "c") != ChunkStore.Key(fileId: "a", version: "bc"))
        #expect(ChunkStore.isKeyName(ChunkStore.Key(fileId: "a", version: "b").hex))
    }

    @Test func theLeastRecentlyUsedGoFirst() async throws {
        let folder = try temporaryFolder()
        let store = try ChunkStore(directory: folder, limitBytes: limit(3))
        for index in 0..<3 {
            await store.write(Self.key, index: index, data: bytes(index))
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        // Chunk 0 is used again, so 1 is now the oldest.
        _ = await store.read(Self.key, index: 0, expectedLength: Self.chunk, range: 0..<1)
        await store.write(Self.key, index: 3, data: bytes(3))

        #expect(await store.contains(Self.key, index: 0))
        #expect(await !store.contains(Self.key, index: 1))
        #expect(await store.contains(Self.key, index: 2))
        #expect(await store.contains(Self.key, index: 3))
        let stats = await store.stats()
        #expect(stats.chunks == 3 && stats.evictions == 1 && stats.bytes <= stats.limitBytes)
        // And from the disk too.
        let files = try FileManager.default.contentsOfDirectory(atPath: folder.appendingPathComponent(Self.key.hex).path)
        #expect(Set(files) == ["0", "2", "3"])
    }

    @Test func aLimitOfZeroIsNoLimit() async throws {
        // The app's "no limit" arrives as cacheLimitBytes 0: keep everything.
        let store = try ChunkStore(directory: try temporaryFolder(), limitBytes: 0)
        for index in 0..<20 { await store.write(Self.key, index: index, data: bytes(index)) }
        let stats = await store.stats()
        #expect(stats.chunks == 20 && stats.evictions == 0 && stats.limitBytes == .max)
    }

    @Test func theDiskIsNeverFilledPastItsSpareGigabyte() async throws {
        // Whatever the limit, a gigabyte stays free on the cache's disk: here
        // the disk has room for two and a half chunks beyond it.
        let chunkBytes = Int64(Self.chunk + ChunkStore.digestLength)
        let free = ChunkStore.spareSpace + chunkBytes * 5 / 2
        let store = try ChunkStore(directory: try temporaryFolder(), limitBytes: 0, freeSpace: { _ in free })
        for index in 0..<4 {
            await store.write(Self.key, index: index, data: bytes(index))
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        #expect(await store.contains(Self.key, index: 2))
        #expect(await store.contains(Self.key, index: 3))
        let stats = await store.stats()
        #expect(stats.chunks == 2 && stats.evictions == 2 && stats.skipped == 0)

        // No room, and nothing of ours to make it with: the chunk is not kept.
        let full = try ChunkStore(directory: try temporaryFolder(), limitBytes: 0,
                                  freeSpace: { _ in ChunkStore.spareSpace + chunkBytes / 2 })
        await full.write(Self.key, index: 0, data: bytes(0))
        #expect(await !full.contains(Self.key, index: 0))
        #expect(await full.stats().skipped == 1)
    }

    @Test func aVersionsFolderGoesWithItsLastChunk() async throws {
        let folder = try temporaryFolder()
        let store = try ChunkStore(directory: folder, limitBytes: limit(1))
        let other = ChunkStore.Key(fileId: "file-2", version: "v1")
        await store.write(Self.key, index: 0, data: bytes(0))
        await store.write(other, index: 0, data: bytes(0))
        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent(Self.key.hex).path))
        #expect(await store.contains(other, index: 0))
    }

    @Test func aRestartKeepsWhatWasThere() async throws {
        let folder = try temporaryFolder()
        do {
            let store = try ChunkStore(directory: folder, limitBytes: limit(10))
            for index in 0..<4 { await store.write(Self.key, index: index, data: bytes(index)) }
            // The last chunk of a file is short.
            await store.write(Self.key, index: 4, data: bytes(4, length: 1000))
        }
        let reopened = try ChunkStore(directory: folder, limitBytes: limit(10))
        let stats = await reopened.stats()
        #expect(stats.chunks == 5)
        #expect(stats.bytes == Int64(4 * (Self.chunk + 32) + 1000 + 32))
        for index in 0..<4 {
            #expect(await reopened.read(Self.key, index: index, expectedLength: Self.chunk, range: 0..<Self.chunk)
                    == bytes(index))
        }
        #expect(await reopened.read(Self.key, index: 4, expectedLength: 1000, range: 0..<1000) == bytes(4, length: 1000))
    }

    @Test func aRestartWithASmallerLimitEvictsAtOnce() async throws {
        let folder = try temporaryFolder()
        do {
            let store = try ChunkStore(directory: folder, limitBytes: limit(10))
            for index in 0..<6 {
                await store.write(Self.key, index: index, data: bytes(index))
                try await Task.sleep(nanoseconds: 5_000_000)
            }
        }
        // Last use survives a restart through the chunk's modification time.
        let small = try ChunkStore(directory: folder, limitBytes: limit(2))
        #expect(await small.stats().chunks == 2)
        #expect(await small.contains(Self.key, index: 4))
        #expect(await small.contains(Self.key, index: 5))
    }

    @Test func aShortChunkIsAMissAndIsDeleted() async throws {
        let folder = try temporaryFolder()
        let store = try ChunkStore(directory: folder, limitBytes: limit(10))
        await store.write(Self.key, index: 0, data: bytes(0))
        let file = folder.appendingPathComponent(Self.key.hex).appendingPathComponent("0")
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: 1000)
        try handle.close()

        #expect(await store.read(Self.key, index: 0, expectedLength: Self.chunk, range: 0..<10) == nil)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        let stats = await store.stats()
        #expect(stats.discarded == 1 && stats.chunks == 0 && stats.bytes == 0)
    }

    @Test func aChunkOfTheWrongLengthForTheFileIsAMiss() async throws {
        // The reader expects a full chunk where a short one was kept: the
        // file grew under the same version. Never hand out a short answer.
        let store = try ChunkStore(directory: try temporaryFolder(), limitBytes: limit(10))
        await store.write(Self.key, index: 0, data: bytes(0, length: 500))
        #expect(await store.read(Self.key, index: 0, expectedLength: Self.chunk, range: 0..<100) == nil)
    }

    @Test func damagedBytesFromAnEarlierRunAreCaughtByTheDigest() async throws {
        let folder = try temporaryFolder()
        do {
            let store = try ChunkStore(directory: folder, limitBytes: limit(10))
            await store.write(Self.key, index: 0, data: bytes(0))
            await store.write(Self.key, index: 1, data: bytes(1))
        }
        // Same length, one byte different: what a crash can leave behind.
        let file = folder.appendingPathComponent(Self.key.hex).appendingPathComponent("1")
        var damaged = try Data(contentsOf: file)
        damaged[12345] ^= 0xFF
        try damaged.write(to: file)

        let reopened = try ChunkStore(directory: folder, limitBytes: limit(10))
        #expect(await reopened.read(Self.key, index: 1, expectedLength: Self.chunk, range: 0..<100) == nil)
        #expect(await reopened.read(Self.key, index: 0, expectedLength: Self.chunk, range: 0..<100)
                == bytes(0).prefix(100))
        #expect(await reopened.stats().discarded == 1)
    }

    @Test func leftoversAreClearedAtStart() async throws {
        let folder = try temporaryFolder()
        let staging = folder.appendingPathComponent(".tmp")
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try Data(count: 5000).write(to: staging.appendingPathComponent("half-written"))
        let keyFolder = folder.appendingPathComponent(Self.key.hex)
        try FileManager.default.createDirectory(at: keyFolder, withIntermediateDirectories: true)
        try Data(count: 10).write(to: keyFolder.appendingPathComponent("7"))   // too short to be a chunk
        try Data("mine".utf8).write(to: folder.appendingPathComponent("notes.txt"))

        let store = try ChunkStore(directory: folder, limitBytes: limit(10))
        #expect(await store.stats().chunks == 0)
        #expect(try FileManager.default.contentsOfDirectory(atPath: staging.path).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: keyFolder.appendingPathComponent("7").path))
        // What is not the store's is left alone.
        #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("notes.txt").path))
    }

    @Test func manyWritersAndReadersAtOnce() async throws {
        let store = try ChunkStore(directory: try temporaryFolder(), limitBytes: limit(8))
        await withTaskGroup(of: Void.self) { group in
            for index in 0..<32 {
                group.addTask {
                    await store.write(Self.key, index: index, data: self.bytes(index))
                    if let hit = await store.read(Self.key, index: index, expectedLength: Self.chunk, range: 0..<Self.chunk) {
                        #expect(hit == self.bytes(index))
                    }
                }
            }
        }
        let stats = await store.stats()
        #expect(stats.chunks <= 8 && stats.bytes <= stats.limitBytes && stats.writes == 32)
    }
}
