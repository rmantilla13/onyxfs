import Testing
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import OnyxKit

private let oldThumb = "_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.jpg"

/// A file as the feed or the detail route has it.
private func row(_ id: String, _ name: String, mime: String? = "video/mp4", size: Int64 = 4_000_000_000,
                 version: Int = 1, created: Int64 = 1, thumbnail: String? = nil, thumbnailUrl: String? = nil,
                 sizes: [String]? = nil, width: Double? = nil, height: Double? = nil) -> FileItem {
    var file = FileItem(id: id, name: name, folder: "", kind: "video", mime: mime, size: size,
                        url: "https://s3.test/team/\(name)?X-Amz-Signature=x", storageKey: "team/\(name)",
                        thumbnailUrl: thumbnailUrl, tags: [], notes: nil, caption: nil, visibility: "org",
                        version: version, contentHash: nil, createdBy: nil, createdAt: EpochMillis(created),
                        updatedAt: nil, deletedAt: nil, seq: nil)
    file.thumbnailKey = thumbnail
    file.thumbSizes = sizes
    if width != nil || height != nil { file.metadata = FileMetadata(width: width, height: height) }
    return file
}

/// A JPEG of `width` x `height`, as storage would send an old thumbnail.
private func jpeg(_ width: Int, _ height: Int) -> Data {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(red: 0.3, green: 0.6, blue: 0.9, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let data = NSMutableData()
    let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return data as Data
}

private func picture(_ width: Int, _ height: Int) -> EncodedPicture {
    EncodedPicture(data: Data(repeating: 7, count: width), size: PixelSize(width: width, height: height))
}

/// The server and storage, as far as the worker is concerned: canned rows,
/// answers the test sets, and everything asked written down.
private final class StubServer: ThumbnailServer, @unchecked Sendable {
    private let lock = NSLock()
    private var rows: [String: FileItem] = [:]
    private var refused: Set<String> = []
    private var stored: [String: Data] = [:]
    private var unsupported = false
    private var calls: [String] = []
    private(set) var records: [(fileId: String, thumbnailKey: String, posterKey: String?, sizes: [String], media: MediaFacts)] = []
    private var putHeaders: [(url: URL, type: String, cache: String?)] = []
    private var keys = 0

    func add(_ file: FileItem) { lock.withLock { rows[file.id] = file } }
    func refuse(_ id: String) { lock.withLock { _ = refused.insert(id) } }
    func store(_ data: Data, at url: String) { lock.withLock { stored[url] = data } }
    func stopTakingThumbnails() { lock.withLock { unsupported = true } }
    var log: [String] { lock.withLock { calls } }
    var puts: [(url: URL, type: String, cache: String?)] { lock.withLock { putHeaders } }
    func recorded() -> [(fileId: String, thumbnailKey: String, posterKey: String?, sizes: [String], media: MediaFacts)] {
        lock.withLock { records }
    }
    private func note(_ call: String) { lock.withLock { calls.append(call) } }

    func mayRecordThumbnail(fileId: String) async throws -> Bool {
        note("may \(fileId)")
        if lock.withLock({ unsupported }) { throw OnyxAPI.thumbnailsUnsupported }
        return !lock.withLock { refused.contains(fileId) }
    }

    func fileDetail(id: String) async throws -> OnyxAPI.FileDetail {
        note("ask \(id)")
        guard let file = lock.withLock({ rows[id] }) else { throw OnyxError.http(status: 404, message: "File not found") }
        return OnyxAPI.FileDetail(file: file, storage: "s3", canWrite: true)
    }

    private func target(_ suffix: String, siblings: [String]) -> OnyxAPI.PreviewTarget {
        let uuid = lock.withLock { () -> String in
            keys += 1
            return String(format: "00000000-0000-4000-8000-%012d", keys)
        }
        let key = "_thumbs/\(uuid)\(suffix).jpg"
        var named: [String: OnyxAPI.PreviewTarget.Sibling] = [:]
        for size in siblings {
            named[size] = .init(putUrl: URL(string: "https://s3.test/_thumbs/\(uuid).\(size).jpg?sig")!,
                                key: "_thumbs/\(uuid).\(size).jpg")
        }
        return OnyxAPI.PreviewTarget(putUrl: URL(string: "https://s3.test/\(key)?sig")!, key: key,
                                     cacheControl: "private, max-age=31536000, immutable",
                                     siblings: siblings.isEmpty ? nil : named)
    }

    func presignThumbnail(contentType: String, sizes: [String]) async throws -> OnyxAPI.PreviewTarget {
        note("presign thumb \(contentType) \(sizes.joined(separator: ","))")
        return target("", siblings: sizes)
    }

    func presignPoster(contentType: String) async throws -> OnyxAPI.PreviewTarget {
        note("presign poster \(contentType)")
        return target(".poster", siblings: [])
    }

    func recordThumbnail(fileId: String, thumbnailKey: String, posterKey: String?, thumbSizes: [String],
                         media: MediaFacts) async throws -> FileItem {
        note("record \(fileId)")
        lock.withLock { records.append((fileId, thumbnailKey, posterKey, thumbSizes, media)) }
        var file = lock.withLock { rows[fileId] } ?? row(fileId, "uploaded.mov")
        file.thumbnailKey = thumbnailKey
        file.thumbSizes = thumbSizes
        return file
    }

    func put(_ data: Data, to url: URL, contentType: String, cacheControl: String?) async throws {
        note("put \(url.path)")
        lock.withLock { putHeaders.append((url, contentType, cacheControl)) }
    }

    func fetch(_ url: URL) async throws -> Data {
        note("fetch \(url.absoluteString)")
        guard let data = lock.withLock({ stored[url.absoluteString] }) else { throw OnyxError.http(status: 404, message: nil) }
        return data
    }

    func download(_ url: URL, to destination: URL) async throws {
        note("download")
        try Data("image".utf8).write(to: destination)
    }
}

/// Drawing, as far as the worker is concerned: a canned set, or the error a
/// test chooses, and how many draws were ever under way at once.
private final class StubDrawing: ThumbnailDrawing, @unchecked Sendable {
    private let lock = NSLock()
    private var inFlight = 0
    private var peak = 0
    private var draws: [String] = []
    private var failure: Error?
    private var pause: TimeInterval = 0
    private var gate: CheckedContinuation<Void, Never>?
    private var holding = false

    func fail(with error: Error?) { lock.withLock { failure = error } }
    func slow(_ seconds: TimeInterval) { lock.withLock { pause = seconds } }
    /// The next draw waits until `release`.
    func hold() { lock.withLock { holding = true } }
    func release() {
        let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            holding = false
            defer { gate = nil }
            return gate
        }
        waiting?.resume()
    }
    var drawn: [String] { lock.withLock { draws } }
    var mostAtOnce: Int { lock.withLock { peak } }
    var isHolding: Bool { lock.withLock { gate != nil } }

    static let set = PreviewSet(format: .jpeg, grid: picture(1024, 576), sm: picture(683, 384), xs: picture(213, 120),
                                large: picture(1920, 1080), media: MediaFacts(width: 3840, height: 2160, duration: 42.5))

    private func draw(_ what: String) async throws -> PreviewSet {
        let (error, seconds, wait) = lock.withLock { () -> (Error?, TimeInterval, Bool) in
            inFlight += 1
            peak = max(peak, inFlight)
            draws.append(what)
            return (failure, pause, holding)
        }
        defer { lock.withLock { inFlight -= 1 } }
        if wait { await withCheckedContinuation { continuation in lock.withLock { gate = continuation } } }
        if seconds > 0 { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
        if let error { throw error }
        return Self.set
    }

    func video(_ url: URL, mime: String?) async throws -> PreviewSet { try await draw(url.lastPathComponent) }
    func image(_ file: URL, bytes: Int64?, mime: String?, name: String) async throws -> PreviewSet { try await draw(name) }
}

private final class Watcher: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [ThumbnailWorker.Report] = []
    func add(_ report: ThumbnailWorker.Report) { lock.withLock { all.append(report) } }
    var reports: [ThumbnailWorker.Report] { lock.withLock { all } }
}

private struct Rig {
    let server = StubServer()
    let drawing = StubDrawing()
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("onyxkit-worker-\(UUID().uuidString)")
    let watcher = Watcher()

    func worker(timeout: TimeInterval = 30, ledger: URL? = nil) async -> ThumbnailWorker {
        let worker = ThumbnailWorker(server: server, drawing: drawing, folder: folder.appendingPathComponent("work"),
                                     ledgerFile: ledger, jobTimeout: timeout)
        let watcher = self.watcher
        await worker.observe(status: { _ in }, reports: { watcher.add($0) })
        return worker
    }

    /// Files as the mirror hands them over, the server knowing each.
    func offer(_ files: [FileItem], to worker: ThumbnailWorker, scope: String = "drive.d1") async {
        for file in files { server.add(file) }
        await worker.update(scope: scope, files: files.map(ReplicaFile.init))
    }

    /// A file just uploaded, linked into the worker's folder as the app does.
    func upload(_ id: String, name: String, to worker: ThumbnailWorker) async throws -> URL {
        let bytes = folder.appendingPathComponent("\(id)-\(name)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("video".utf8).write(to: bytes)
        await worker.offer(.init(fileId: id, scope: "drive.d1", name: name, mime: "video/mp4", size: 5,
                                 kind: .video, url: bytes))
        return bytes
    }

    func tearDown() { try? FileManager.default.removeItem(at: folder) }
}

/// The worker: what it asks, in what order, what it hands in, and what it
/// leaves alone — one job at a time, never in a loop.
struct ThumbnailWorkerTests {
    @Test func aMissingThumbnailIsMadeAndRecordedAsTheBrowserRecordsIt() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        await rig.offer([row("v1", "GX010042.MP4")], to: worker)
        await worker.idle()

        #expect(rig.server.log == [
            "ask v1", "may v1", "presign thumb image/jpeg sm,xs",
            "put /_thumbs/00000000-0000-4000-8000-000000000001.jpg",
            "put /_thumbs/00000000-0000-4000-8000-000000000001.sm.jpg",
            "put /_thumbs/00000000-0000-4000-8000-000000000001.xs.jpg",
            "presign poster image/jpeg", "put /_thumbs/00000000-0000-4000-8000-000000000002.poster.jpg",
            "record v1",
        ])
        #expect(rig.drawing.drawn == ["GX010042.MP4"])
        #expect(rig.server.puts.allSatisfy { $0.type == "image/jpeg" && $0.cache == "private, max-age=31536000, immutable" },
                "each PUT carries the type and the Cache-Control storage keeps")
        let record = try #require(rig.server.recorded().first)
        #expect(record.thumbnailKey == "_thumbs/00000000-0000-4000-8000-000000000001.jpg")
        #expect(record.posterKey == "_thumbs/00000000-0000-4000-8000-000000000002.poster.jpg")
        #expect(record.sizes == ["sm", "xs"])
        #expect(record.media == MediaFacts(width: 3840, height: 2160, duration: 42.5))
        #expect(await worker.ledgerForTesting.entries["v1"]?.outcome == .made)
        #expect(await worker.candidateIDs.isEmpty)
        #expect(rig.watcher.reports.map(\.outcome) == [.made])
        #expect(await worker.hasWakeTimer == false, "nothing due, nothing running, no timer")
    }

    @Test func aFileThisAccountMayNotChangeIsNotDrawnAndNotAskedAboutAgain() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.server.refuse("v1")
        await rig.offer([row("v1", "a.mov")], to: worker)
        await worker.idle()
        #expect(rig.server.log == ["ask v1", "may v1"], "refused before anything is downloaded or drawn")
        #expect(rig.drawing.drawn.isEmpty)
        #expect(await worker.ledgerForTesting.entries["v1"]?.outcome == .refused)
        // The mirror names it again: left alone.
        await rig.offer([row("v1", "a.mov", version: 2)], to: worker)
        await worker.idle()
        #expect(rig.server.log.count == 2)
    }

    @Test func anOld480pxVideoThumbnailIsMadeAgainAndANewerOneKept() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.server.store(jpeg(480, 270), at: "https://s3.test/old?sig")
        rig.server.store(jpeg(1024, 576), at: "https://s3.test/new?sig")
        await rig.offer([
            row("old", "old.mov", created: 2, thumbnail: oldThumb, thumbnailUrl: "https://s3.test/old?sig", width: 1920, height: 1080),
            row("new", "new.mov", created: 1, thumbnail: oldThumb, thumbnailUrl: "https://s3.test/new?sig", width: 1920, height: 1080),
        ], to: worker)
        await worker.idle()
        #expect(rig.drawing.drawn == ["old.mov"])
        #expect(rig.server.recorded().map(\.fileId) == ["old"])
        #expect(!rig.server.log.contains("may new"), "a thumbnail kept needs no permission asked")
        #expect(await worker.ledgerForTesting.entries["new"]?.outcome == .kept)
    }

    @Test func aFailureWaitsItsTurnInsteadOfLooping() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.drawing.fail(with: URLError(.networkConnectionLost))
        await rig.offer([row("v1", "a.mov")], to: worker)
        await worker.idle()
        #expect(rig.drawing.drawn.count == 1)
        let entry = await worker.ledgerForTesting.entries["v1"]
        #expect(entry?.outcome == .failed && entry?.failures == 1)
        #expect(await worker.candidateIDs == ["v1"], "kept, to try again")
        #expect(await worker.hasWakeTimer, "one timer, for an hour from now")
        // Woken by the mirror meanwhile: still not due, so nothing runs.
        await rig.offer([row("v1", "a.mov")], to: worker)
        await worker.idle()
        #expect(rig.drawing.drawn.count == 1)
        #expect(rig.server.recorded().isEmpty)
    }

    @Test func somethingThatCannotBeDrawnWaitsAWeekAndLeavesTheQueue() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.drawing.fail(with: ThumbnailRenderer.Failure.blank)
        await rig.offer([row("v1", "black.mov")], to: worker)
        await worker.idle()
        #expect(await worker.ledgerForTesting.entries["v1"]?.outcome == .unusable)
        #expect(await worker.candidateIDs.isEmpty)
        #expect(rig.watcher.reports.first?.detail == "Every frame tried was blank.")
    }

    @Test func oneJobAtATimeTheNewestVideoFirst() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.drawing.slow(0.02)
        await rig.offer([
            row("a", "a.mov", created: 1), row("b", "b.jpg", mime: "image/jpeg", size: 1000, created: 9),
            row("c", "c.mov", created: 5), row("d", "d.mov", created: 3),
        ], to: worker)
        await worker.idle()
        #expect(rig.drawing.mostAtOnce == 1)
        #expect(rig.drawing.drawn == ["c.mov", "d.mov", "a.mov", "b.jpg"])
        #expect(rig.server.log.filter { $0 == "download" }.count == 1, "an image is read whole; a video is not")
    }

    @Test func anUploadGoesNextFromItsOwnBytesAskingOnlyWhetherItMay() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.drawing.hold()
        await rig.offer([row("m1", "m1.mov", created: 3), row("m2", "m2.mov", created: 2)], to: worker)
        while !rig.drawing.isHolding { try await Task.sleep(nanoseconds: 1_000_000) }
        let bytes = try await rig.upload("u1", name: "GX010099.MP4", to: worker)
        rig.drawing.release()
        await worker.idle()
        #expect(rig.drawing.drawn.count == 3)
        #expect(rig.drawing.drawn[1] == bytes.lastPathComponent, "the upload before the rest of the queue")
        #expect(!rig.server.log.contains("ask u1"), "a file just uploaded is not looked up")
        #expect(rig.server.log.contains("may u1"))
        #expect(rig.server.recorded().map(\.fileId) == ["m1", "u1", "m2"])
        #expect(!FileManager.default.fileExists(atPath: bytes.path), "its link goes once it is drawn")
    }

    @Test func stoppingEndsTheJobInHandAndForgetsTheRest() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.drawing.slow(30)
        await rig.offer([row("a", "a.mov"), row("b", "b.mov")], to: worker)
        while rig.drawing.drawn.isEmpty { try await Task.sleep(nanoseconds: 1_000_000) }
        let bytes = try await rig.upload("u1", name: "x.mov", to: worker)
        await worker.stop()
        await worker.idle()
        #expect(rig.server.recorded().isEmpty)
        #expect(await worker.candidateIDs.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: bytes.path))
        #expect(await worker.ledgerForTesting.entries.isEmpty, "nothing noted for a job stopped")
        // A stopped worker takes nothing more.
        await rig.offer([row("c", "c.mov")], to: worker)
        await worker.idle()
        #expect(rig.drawing.drawn.count == 1)
    }

    @Test func aServerThatDoesNotTakeThemStopsTheQueue() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.server.stopTakingThumbnails()
        await rig.offer([row("a", "a.mov", created: 2), row("b", "b.mov", created: 1)], to: worker)
        await worker.idle()
        #expect(rig.server.log == ["ask a", "may a"], "once, not once per file")
        #expect(rig.drawing.drawn.isEmpty)
        #expect(await worker.ledgerForTesting.entries.isEmpty, "no file is blamed for the server")
    }

    @Test func aStalledJobRunsOutOfTime() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker(timeout: 0.2)
        rig.drawing.slow(10)
        let started = Date()
        await rig.offer([row("a", "a.mov")], to: worker)
        await worker.idle()
        #expect(Date().timeIntervalSince(started) < 5)
        #expect(await worker.ledgerForTesting.entries["a"]?.outcome == .failed)
        #expect(rig.watcher.reports.first?.detail == "It took too long.")
    }

    @Test func whatCameOfEachFileOutlastsARestart() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let ledger = rig.folder.appendingPathComponent("ledger.json")
        let first = await rig.worker(ledger: ledger)
        rig.server.refuse("a")
        await rig.offer([row("a", "a.mov")], to: first)
        await first.idle()
        await first.stop()
        #expect(FileManager.default.fileExists(atPath: ledger.path))

        let second = await rig.worker(ledger: ledger)
        await rig.offer([row("a", "a.mov")], to: second)
        await second.idle()
        #expect(rig.server.log.filter { $0 == "may a" }.count == 1, "not asked again after a relaunch")
    }

    @Test func aFileMadeMeanwhileIsDroppedWithoutAWord() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        // The mirror has not caught up: the server's row has its pictures.
        rig.server.add(row("a", "a.mov", thumbnail: oldThumb, sizes: ["sm", "xs"]))
        await worker.update(scope: "drive.d1", files: [ReplicaFile(row("a", "a.mov"))])
        await worker.idle()
        #expect(rig.server.log == ["ask a"])
        #expect(await worker.candidateIDs.isEmpty)
        #expect(await worker.ledgerForTesting.entries.isEmpty)
        #expect(rig.watcher.reports.isEmpty)
    }

    @Test func theMirrorsWordReplacesWhatWasQueued() async throws {
        let rig = Rig()
        defer { rig.tearDown() }
        let worker = await rig.worker()
        rig.drawing.hold()
        await rig.offer([row("a", "a.mov", created: 9), row("b", "b.mov"), row("c", "c.mov")], to: worker)
        while !rig.drawing.isHolding { try await Task.sleep(nanoseconds: 1_000_000) }
        // b has its thumbnail now; c was deleted; a whole scan names only a.
        var made = row("b", "b.mov", thumbnail: oldThumb, sizes: ["sm", "xs"])
        made.thumbSizes = ["sm", "xs"]
        await worker.update(scope: "drive.d1", files: [ReplicaFile(made)], settled: ["c"])
        #expect(await worker.candidateIDs == ["a"])
        rig.server.add(row("z", "z.mov"))
        await worker.update(scope: "drive.d2", files: [ReplicaFile(row("z", "z.mov"))])
        await worker.update(scope: "drive.d1", files: [], whole: true)
        #expect(await worker.candidateIDs == ["z"], "another drive's are its own")
        rig.drawing.release()
        await worker.idle()
        #expect(rig.drawing.drawn == ["a.mov", "z.mov"], "the job in hand finishes")
    }
}
