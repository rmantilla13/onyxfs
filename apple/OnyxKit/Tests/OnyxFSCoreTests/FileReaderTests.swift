import Foundation
import Testing
@testable import OnyxFSCore

/// The streaming reader, against the stub's storage. Every read is checked
/// byte for byte against the pattern, and the storage log says what was
/// fetched, when, and how many times.
struct FileReaderTests {
    static let MiB: Int64 = 1 << 20
    static let chunk: Int64 = 8 << 20

    struct Setup {
        let stub: Stub
        let client: FSBridgeClient
        let store: ChunkStore
        let folder: URL

        func reader(_ entry: FSEntry, tuning: FileReader.Tuning = .quick,
                    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }) -> FileReader {
            FileReader(fileId: entry.id!, version: entry.version, size: entry.size, client: client, store: store,
                       local: entry.local, tuning: tuning, now: now)
        }

        func chunkRange(_ index: Int64, size: Int64) -> String {
            "bytes=\(index * chunk)-\(min((index + 1) * chunk, size) - 1)"
        }
    }

    func setUp(cacheLimit: Int64 = 1 << 30) async throws -> Setup {
        let stub = Stub()
        let client = try await stub.connect()
        // Each test removes it when it ends (`defer { removeFolder(s.folder) }`).
        let folder = try temporaryFolder()
        let store = try ChunkStore(directory: folder, limitBytes: cacheLimit)
        return Setup(stub: stub, client: client, store: store, folder: folder)
    }

    // MARK: - Streaming

    @Test func aHundredMiBStreamsSequentiallyWithReadAhead() async throws {
        let s = try await setUp(cacheLimit: 0)    // the app's "no limit"
        defer { removeFolder(s.folder) }
        let size = 100 * Self.MiB
        let file = s.stub.addFile("/Master.mov", size: size)
        let reader = s.reader(file)

        var offset: Int64 = 0
        var wrong: Int64?
        while offset < size {
            let data = try await reader.read(offset: offset, length: Int(Self.MiB))
            if data != Pattern.bytes(offset..<(offset + Int64(data.count)), seed: 7) || data.count != Self.MiB {
                wrong = offset
                break
            }
            offset += Int64(data.count)
        }
        #expect(wrong == nil, "bytes differ at \(wrong ?? 0)")
        #expect(try await reader.read(offset: size, length: 4096).isEmpty)

        // Thirteen chunks, the last one 4 MiB, each fetched exactly once.
        let ranges = s.stub.storageRequests.map(\.range)
        #expect(ranges.count == 13)
        #expect(Set(ranges) == Set((0..<13).map { Optional(s.chunkRange($0, size: size)) }))
        #expect(ranges.contains("bytes=\(96 * Self.MiB)-\(100 * Self.MiB - 1)"))
        #expect(s.stub.requests("/fs/v1/source").count == 1, "one presigned URL for the whole file")

        // Every chunk after the first was fetched ahead of the read that
        // needed it, and the window grew to its full 16 chunks.
        let stats = await reader.stats()
        #expect(stats.fetches == 13)
        #expect(stats.readAheadFetches == 12)
        #expect(stats.peakWindow == 16)
        #expect(stats.peakInFlight <= 4)
        #expect(stats.bytesRead == size)

        // Opened again: all of it from the cache, and no link asked for.
        let again = s.reader(file)
        offset = 0
        while offset < size {
            let data = try await again.read(offset: offset, length: 4 * Int(Self.MiB))
            #expect(data.count == 4 * Self.MiB)
            offset += Int64(data.count)
        }
        #expect(s.stub.storageRequests.count == 13)
        #expect(s.stub.requests("/fs/v1/source").count == 1)
        #expect(await again.stats().cacheHits == 25)
    }

    @Test func randomSeeksReadExactBytes() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let size = 40 * Self.MiB + 12_345
        let file = s.stub.addFile("/Odd.mov", size: size, seed: 3)
        let reader = s.reader(file)
        var random = SplitMix(seed: 2026)
        for _ in 0..<150 {
            let offset = Int64(random.next() % UInt64(size + 2 * Self.MiB))   // now and then past the end
            let length = Int(random.next() % UInt64(3 * Self.MiB)) + 1
            let data = try await reader.read(offset: offset, length: length)
            let expected = offset < size ? Pattern.bytes(offset..<min(offset + Int64(length), size), seed: 3) : Data()
            #expect(data == expected, "read of \(length) at \(offset)")
            if data != expected { break }
        }
        let stats = await reader.stats()
        #expect(stats.seeks > 50)
        #expect(stats.fetches == s.stub.storageRequests.count)
    }

    @Test func readsAtTheEndReturnWhatExists() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let size = 2 * Self.chunk + 100
        let file = s.stub.addFile("/Short tail.mov", size: size, seed: 5)
        let reader = s.reader(file)
        #expect(try await reader.read(offset: size - 50, length: 1000) == Pattern.bytes((size - 50)..<size, seed: 5))
        #expect(s.stub.storageRequests.last?.range == "bytes=\(2 * Self.chunk)-\(size - 1)", "the short last chunk")
        #expect(try await reader.read(offset: size, length: 10).isEmpty)
        #expect(try await reader.read(offset: size + 1000, length: 10).isEmpty)
        #expect(try await reader.read(offset: 0, length: 0).isEmpty)

        let empty = s.stub.addFile("/Empty.txt", size: 0)
        let before = s.stub.storageRequests.count
        #expect(try await s.reader(empty).read(offset: 0, length: 4096).isEmpty)
        #expect(s.stub.storageRequests.count == before)
    }

    @Test func aReadAcrossAChunkBoundaryIsWhole() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let size = 3 * Self.chunk
        let file = s.stub.addFile("/Across.mov", size: size)
        let reader = s.reader(file)
        let start = Self.chunk - 1000
        #expect(try await reader.read(offset: start, length: 5000) == Pattern.bytes(start..<(start + 5000), seed: 7))
        #expect(Set(s.stub.storageRequests.compactMap(\.range)).isSuperset(of: [s.chunkRange(0, size: size),
                                                                             s.chunkRange(1, size: size)]))
    }

    // MARK: - Links

    @Test func aRefusedLinkIsReplacedOnce() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let file = s.stub.addFile("/Take.mov", size: 20 * Self.MiB)
        s.stub.refuseSignatures(through: 1)   // the first link has expired
        let reader = s.reader(file)
        #expect(try await reader.read(offset: 0, length: 4096) == Pattern.bytes(0..<4096, seed: 7))
        #expect(s.stub.storageRequests.map(\.signature).prefix(2) == [1, 2])
        #expect(await reader.stats().sourceFetches == 2)
    }

    @Test func aLinkStorageKeepsRefusingIsAnErrorThatPasses() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let file = s.stub.addFile("/Take.mov", size: 20 * Self.MiB)
        s.stub.refuseEverySignature()
        let reader = s.reader(file)
        await #expect(throws: FSBridgeError.storage(status: 403)) { try await reader.read(offset: 0, length: 10) }
        #expect(s.stub.requests("/fs/v1/source").count == 2, "one refresh, not a loop")

        s.stub.refuseEverySignature(false)
        #expect(try await reader.read(offset: 0, length: 10) == Pattern.bytes(0..<10, seed: 7))
    }

    @Test func aLinkIsReplacedAMinuteBeforeItExpires() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let file = s.stub.addFile("/Long.mov", size: 50 * Self.MiB)
        let clock = TestClock()
        let reader = s.reader(file, now: { Date().timeIntervalSince1970 + clock.offset })
        _ = try await reader.read(offset: 0, length: 10)
        clock.offset = 830          // 70 s left of 900: still good
        _ = try await reader.read(offset: 2 * Self.chunk, length: 10)
        #expect(s.stub.requests("/fs/v1/source").count == 1)
        clock.offset = 845          // 55 s left: replace it before using it
        _ = try await reader.read(offset: 4 * Self.chunk, length: 10)
        #expect(s.stub.requests("/fs/v1/source").count == 2)
        #expect(s.stub.storageRequests.last?.signature == 2)
    }

    // MARK: - Failures

    @Test func networkErrorsAreTriedThreeTimes() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let file = s.stub.addFile("/Flaky.mov", size: 50 * Self.MiB)
        let reader = s.reader(file)

        s.stub.failStorage([.networkConnectionLost, .timedOut])
        #expect(try await reader.read(offset: 0, length: 10) == Pattern.bytes(0..<10, seed: 7))
        #expect(await reader.stats().retries == 2)

        s.stub.failStorage([.networkConnectionLost, .networkConnectionLost, .networkConnectionLost])
        await #expect(throws: FSBridgeError.network(.networkConnectionLost)) {
            try await reader.read(offset: 3 * Self.chunk, length: 10)
        }

        s.stub.answerStorage([503, 500])
        #expect(try await reader.read(offset: 5 * Self.chunk, length: 10)
                == Pattern.bytes((5 * Self.chunk)..<(5 * Self.chunk + 10), seed: 7))
        // And what failed is fetched afresh when read again.
        #expect(try await reader.read(offset: 3 * Self.chunk, length: 10)
                == Pattern.bytes((3 * Self.chunk)..<(3 * Self.chunk + 10), seed: 7))
    }

    // MARK: - Sharing and cancelling

    @Test func readersOfOneChunkShareOneFetch() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let file = s.stub.addFile("/Shared.mov", size: 30 * Self.MiB)
        let reader = s.reader(file)
        s.stub.hold(0..<1)     // chunk 0 waits
        let reads = (0..<8).map { i in
            Task { try await reader.read(offset: Int64(i) * 65_536, length: 65_536) }
        }
        try await eventually { s.stub.heldCount == 1 }
        try await Task.sleep(nanoseconds: 50_000_000)
        s.stub.release()
        for (i, read) in reads.enumerated() {
            let offset = Int64(i) * 65_536
            #expect(try await read.value == Pattern.bytes(offset..<(offset + 65_536), seed: 7))
        }
        #expect(s.stub.storageRequests.filter { $0.range == s.chunkRange(0, size: 30 * Self.MiB) }.count == 1)
    }

    @Test func aCancelledReadLeavesTheFetchToFinishAndBeCached() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let file = s.stub.addFile("/Cancelled.mov", size: 30 * Self.MiB)
        let reader = s.reader(file)
        s.stub.hold(0..<1)
        let read = Task { try await reader.read(offset: 0, length: 4096) }
        try await eventually { s.stub.heldCount == 1 }
        read.cancel()
        // The read gives up at once, while storage still has not answered...
        await #expect(throws: CancellationError.self) { try await read.value }
        #expect(s.stub.heldCount == 1)
        // ...and the fetch goes on, into the cache.
        s.stub.release()
        let key = ChunkStore.Key(fileId: file.id!, version: file.version)
        try await eventually { await s.store.contains(key, index: 0) }
        let before = s.stub.storageRequests.count
        #expect(try await reader.read(offset: 0, length: 4096) == Pattern.bytes(0..<4096, seed: 7))
        #expect(s.stub.storageRequests.count == before)
    }

    @Test func readAheadDroppedAfterASeekIsNeverCached() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let size = 100 * Self.MiB
        let file = s.stub.addFile("/Scrub.mov", size: size)
        let reader = s.reader(file)
        s.stub.hold(Self.chunk..<(3 * Self.chunk))    // chunks 1 and 2 wait
        _ = try await reader.read(offset: 0, length: Int(Self.MiB))
        _ = try await reader.read(offset: Self.MiB, length: Int(Self.MiB))    // sequential: 1 and 2 are fetched ahead
        try await eventually { s.stub.heldCount == 2 }

        _ = try await reader.read(offset: 80 * Self.MiB, length: Int(Self.MiB))    // a seek
        try await eventually { s.stub.heldCount == 0 }    // both cancelled
        let stats = await reader.stats()
        #expect(stats.droppedFetches == 2 && stats.seeks == 1)
        let key = ChunkStore.Key(fileId: file.id!, version: file.version)
        #expect(await !s.store.contains(key, index: 1))
        #expect(await !s.store.contains(key, index: 2))

        s.stub.hold(nil)
        #expect(try await reader.read(offset: Self.chunk, length: 4096)
                == Pattern.bytes(Self.chunk..<(Self.chunk + 4096), seed: 7))
    }

    @Test func closeStopsReadAhead() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let file = s.stub.addFile("/Closed.mov", size: 100 * Self.MiB)
        let reader = s.reader(file)
        s.stub.hold(Self.chunk..<(100 * Self.MiB))
        _ = try await reader.read(offset: 0, length: 4096)
        _ = try await reader.read(offset: 4096, length: 4096)
        try await eventually { s.stub.heldCount == 2 }
        await reader.close()
        try await eventually { s.stub.heldCount == 0 }
        #expect(await reader.stats().droppedFetches == 2)
    }

    @Test func aSmallCacheStillStreams() async throws {
        // Room for three chunks: read-ahead shrinks to fit, and old chunks go.
        let s = try await setUp(cacheLimit: 3 * (Self.chunk + 32))
        defer { removeFolder(s.folder) }
        let size = 40 * Self.MiB
        let file = s.stub.addFile("/Big for its cache.mov", size: size, seed: 11)
        let reader = s.reader(file)
        var offset: Int64 = 0
        while offset < size {
            let data = try await reader.read(offset: offset, length: Int(2 * Self.MiB))
            #expect(data == Pattern.bytes(offset..<(offset + Int64(data.count)), seed: 11))
            offset += Int64(data.count)
        }
        let stats = await s.store.stats()
        #expect(stats.bytes <= stats.limitBytes && stats.evictions >= 2)
        #expect(await reader.stats().peakWindow == 1)
        #expect(s.stub.storageRequests.count == 5, "no chunk fetched twice")
    }

    // MARK: - Where the bytes are

    @Test func aLocalFileIsReadThroughTheBridgeAndNotCachedAgain() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let size = 20 * Self.MiB
        let file = s.stub.addFile("/Kept.mov", size: size, seed: 9, local: true)
        let reader = s.reader(file)
        #expect(try await reader.read(offset: 5 * Self.MiB, length: Int(3 * Self.MiB))
                == Pattern.bytes((5 * Self.MiB)..<(8 * Self.MiB), seed: 9))
        #expect(try await reader.read(offset: size - 10, length: 100) == Pattern.bytes((size - 10)..<size, seed: 9))
        #expect(try await reader.read(offset: size, length: 100).isEmpty)
        #expect(s.stub.requests("/fs/v1/data").map { $0.headers["Range"] }
                == ["bytes=\(5 * Self.MiB)-\(8 * Self.MiB - 1)", "bytes=\(size - 10)-\(size - 1)"])
        #expect(s.stub.storageRequests.isEmpty)
        #expect(await s.store.stats().writes == 0)
    }

    @Test func aFileThatTurnsOutToBeLocalIsReadLocally() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        var file = s.stub.addFile("/Pinned since.mov", size: 20 * Self.MiB, seed: 4, local: true)
        file.local = false   // the entry the reader was opened from is older
        let reader = s.reader(file)
        #expect(try await reader.read(offset: 100, length: 1000) == Pattern.bytes(100..<1100, seed: 4))
        #expect(s.stub.storageRequests.isEmpty)
        #expect(s.stub.requests("/fs/v1/data").count >= 1)
    }

    @Test func aNewerVersionIsFollowedBeforeAnythingIsRead() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        var file = s.stub.addFile("/Replaced.mov", size: 20 * Self.MiB, seed: 8, version: "v2")
        file.version = "v1"    // the entry was listed before the web replaced the file
        let reader = s.reader(file)
        #expect(try await reader.read(offset: 0, length: 4096) == Pattern.bytes(0..<4096, seed: 8))
        #expect(await s.store.contains(ChunkStore.Key(fileId: file.id!, version: "v2"), index: 0))
    }

    @Test func aNewVersionAfterBytesWereReadIsStale() async throws {
        let s = try await setUp()
        defer { removeFolder(s.folder) }
        let file = s.stub.addFile("/Changing.mov", size: 40 * Self.MiB)
        let reader = s.reader(file)
        _ = try await reader.read(offset: 0, length: 4096)
        // Replaced on the web: the old object is gone and the link with it.
        s.stub.setVersion(of: file.id!, to: "v2", seed: 99)
        s.stub.refuseSignatures(through: 1)
        await #expect(throws: FSBridgeError.stale) { try await reader.read(offset: 30 * Self.MiB, length: 10) }
        await #expect(throws: FSBridgeError.stale) { try await reader.read(offset: 0, length: 10) }
    }

    @Test func aStagingFileIsReadFromDiskAsItGrows() async throws {
        let folder = try temporaryFolder()
        defer { removeFolder(folder) }
        let url = folder.appendingPathComponent("staging.bin")
        try Pattern.bytes(0..<10_000, seed: 1).write(to: url)
        let reader = FileReader(staging: url)
        #expect(try await reader.read(offset: 9000, length: 5000) == Pattern.bytes(9000..<10_000, seed: 1))
        #expect(try await reader.read(offset: 10_000, length: 5).isEmpty)
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Pattern.bytes(10_000..<10_500, seed: 1))
        try handle.close()
        #expect(try await reader.read(offset: 10_000, length: 1000) == Pattern.bytes(10_000..<10_500, seed: 1))
        let gone = FileReader(staging: folder.appendingPathComponent("missing"))
        await #expect(throws: FSBridgeError.notFound) { try await gone.read(offset: 0, length: 1) }
    }
}

extension FileReader.Tuning {
    /// The real policy, with retries that do not keep a test waiting.
    static var quick: FileReader.Tuning {
        var tuning = FileReader.Tuning()
        tuning.retryDelays = [0.01]
        return tuning
    }
}

/// A settable offset from now.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double = 0
    var offset: Double {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// A seeded generator, so a failing sequence of seeks can be replayed.
struct SplitMix: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
