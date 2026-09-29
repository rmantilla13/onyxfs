import Foundation
import Testing
@testable import OnyxKit

/// A server and a bucket that answer at once, so what is measured is the
/// queue's own bookkeeping: nothing here waits on a network.
struct InstantTransport: UploadTransport {
    func presign(_ job: UploadJob) async throws -> OnyxAPI.PresignedPut {
        .init(putUrl: URL(string: "https://bucket.test/k")!, publicUrl: nil, key: "k/\(job.id)", name: job.name)
    }
    func startMultipart(_ job: UploadJob) async throws -> OnyxAPI.MultipartUpload { throw URLError(.unsupportedURL) }
    func signParts(uploadId: String, parts: [Int]) async throws -> [Int: URL] { [:] }
    func multipartStatus(uploadId: String) async throws -> OnyxAPI.MultipartStatus { .init(done: [], partSize: 0, partCount: 0) }
    func completeMultipart(uploadId: String) async throws -> OnyxAPI.CompletedUpload { throw URLError(.unsupportedURL) }
    func abortMultipart(uploadId: String) async throws {}
    func record(_ job: UploadJob, key: String, publicUrl: String?) async throws -> OnyxAPI.RecordedFile {
        .init(id: "file-\(job.id)", name: job.name, folder: job.folder, size: job.size)
    }
    func replaceContent(_ job: UploadJob, key: String) async throws -> OnyxAPI.RecordedFile {
        .init(id: job.replaceOf ?? "?", name: job.name, folder: job.folder, size: job.size)
    }
    func put(_ file: URL, offset: Int64, length: Int64, to url: URL, contentType: String?,
             progress: @escaping @Sendable (Int64) -> Void) async throws {
        progress(length)
    }
}

/// Counts the jobs the queue says are done, and wakes whoever waits for a
/// number of them: the bench ends on the queue's own word, not on a sleep.
actor Finished {
    private var count = 0
    private var waiting: (target: Int, resume: CheckedContinuation<Void, Never>)?

    func add() {
        count += 1
        if let waiting, count >= waiting.target {
            self.waiting = nil
            waiting.resume.resume()
        }
    }

    func wait(for target: Int) async {
        if count >= target { return }
        await withCheckedContinuation { waiting = (target, $0) }
    }
}

/// Copying a thousand small files onto a drive: before, the queue's own
/// bookkeeping held it to about two files a second — each job waited out
/// its settle moment inside one of the four slots — and jobs.json was
/// written whole on every change. Measured on this bench before the
/// change: 516 s for the thousand, and jobs.json written 4,000 times,
/// 686 MB in all.
///
/// `ONYX_BENCH_N` and `ONYX_BENCH_SETTLE` change the size and the settle
/// moment, to compare builds; the numbers are printed either way.
@Suite struct UploadQueueBenchTests {
    @Test func aThousandSmallFilesAreHeldUpByNothingButTheSettleMoment() async throws {
        let environment = ProcessInfo.processInfo.environment
        let count = environment["ONYX_BENCH_N"].flatMap(Int.init) ?? 1_000
        let settle = environment["ONYX_BENCH_SETTLE"].flatMap(Double.init) ?? 2
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let sources = scratch(); defer { try? FileManager.default.removeItem(at: sources) }
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
        let files = try (0..<count).map { n -> URL in
            let url = sources.appendingPathComponent("photo-\(n).jpg")
            try Data(repeating: UInt8(n & 0xff), count: 2_048).write(to: url)
            return url
        }
        let queue = try UploadQueue(directory: dir, transport: InstantTransport(), settle: settle)
        let finished = Finished()
        await queue.observe { job in if job.state == .done { Task { await finished.add() } } }

        let start = ContinuousClock.now
        for (n, file) in files.enumerated() {
            try await queue.enqueue(from: file, scope: "drive.d1", filespaceId: "d1", folder: "Shoot",
                                    name: "photo-\(n).jpg", mime: "image/jpeg")
        }
        let queued = ContinuousClock.now - start
        await finished.wait(for: count)
        let elapsed = ContinuousClock.now - start
        let disk = await queue.disk
        print("""
            upload bench: \(count) files, settle \(settle) s — queued in \(queued), all done in \(elapsed); \
            jobs.json written \(disk.snapshots)× (\(disk.snapshotBytes) bytes), \
            journal \(disk.appends) lines (\(disk.appendBytes) bytes)
            """)
        // The settle moment is waited out once, beside the others, not four
        // at a time: the whole thousand is done soon after it.
        #expect(elapsed < .seconds(settle + 10))
        // Written in proportion to what changed, not to what changed times
        // what is waiting: a few kilobytes a file, where it was a megabyte.
        #expect(disk.snapshotBytes + disk.appendBytes < count * 8_192)
        #expect(disk.snapshots <= 20)
    }

    /// A large file of 64 parts, each taking 20 ms to send and each batch
    /// of sixteen signatures 50 ms to get. Signed a batch at a time, with
    /// the next asked for only once all sixteen had landed, the line stood
    /// idle for every signature: 4 × (50 + 4 × 20) ms. Signed ahead, only
    /// the first one is waited for: 50 + 16 × 20 ms. Printed, not asserted:
    /// a clock that busy in a test proves little.
    @Test func aLargeFilesPartsFlowWithoutStoppingForSignatures() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        let data = Data(repeating: 5, count: Int(UploadQueue.multipartThreshold))
        await server.setPartSize(Int64(data.count / 64))
        await server.setPutDelay(20_000_000)
        await server.setSignDelay(50_000_000)
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        let finished = Finished()
        await queue.observe { job in if job.state == .done { Task { await finished.add() } } }
        let start = ContinuousClock.now
        try await queue.enqueue(from: try source(data), scope: "library", filespaceId: nil, folder: "",
                                name: "big.mov", mime: "video/quicktime")
        await finished.wait(for: 1)
        let elapsed = ContinuousClock.now - start
        print("parts bench: 64 parts of 20 ms, 4 signatures of 50 ms — all done in \(elapsed)")
        #expect(await server.objects["assembled"] == data)
        #expect(await server.mostPutsAtOnce == UploadQueue.partConcurrency)
    }

    /// The menu bar's summary with a thousand files waiting: it asked for
    /// every job, sorted them, then asked for each one's progress in turn —
    /// a thousand and one trips to the queue — and did so on every change
    /// to any job, some four thousand times for a thousand files. Now one
    /// question, at most four times a second.
    @Test func theMenusSummaryIsOneQuestion() async throws {
        let count = 1_000
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let held = Gate()
        let queue = try UploadQueue(directory: dir, transport: InstantTransport(), settle: 2, sleep: { _ in await held.wait() })
        for n in 0..<count {
            try await queue.enqueue(from: try source(Data(repeating: 1, count: 100)), scope: "drive.d1", filespaceId: "d1",
                                    folder: "Shoot", name: "photo-\(n).jpg", mime: "image/jpeg")
        }
        let clock = ContinuousClock()
        let before = await clock.measure {
            // What the Mac did before, on every change.
            let jobs = await queue.all().sorted { $0.path < $1.path }
            var sent: Int64 = 0
            for job in jobs where job.state == .queued || job.state == .uploading { sent += await queue.sent(job.id) }
            _ = sent
        }
        var summary = UploadQueue.Summary()
        let after = await clock.measure { summary = await queue.summary() }
        print("summary bench: \(count) waiting — every job and each one's progress \(before), one question \(after)")
        #expect(summary.waiting == count && summary.totalBytes == Int64(count * 100))
        #expect(after < before)
        await held.open()
    }
}
