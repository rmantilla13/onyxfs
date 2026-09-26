import Foundation
import Testing
@testable import OnyxKit

/// A pretend server and bucket: records what was asked, holds the bytes
/// PUT to it, fails on command.
private actor FakeServer: UploadTransport {
    var calls: [String] = []
    var objects: [String: Data] = [:]
    var parts: [Int: Data] = [:]
    var failNext: [String: Error] = [:]
    var partSize: Int64 = 10
    var partCount = 0

    func log(_ call: String) throws {
        calls.append(call)
        if let error = failNext.removeValue(forKey: call) { throw error }
    }

    func setFailure(_ call: String, _ error: Error) { failNext[call] = error }

    func presign(_ job: UploadJob) async throws -> OnyxAPI.PresignedPut {
        try log("presign")
        return .init(putUrl: URL(string: "https://bucket.test/k/\(job.name)")!, publicUrl: "https://bucket.test/k/\(job.name)",
                     key: "drive/\(job.path.dropFirst())", name: job.name)
    }

    func startMultipart(_ job: UploadJob) async throws -> OnyxAPI.MultipartUpload {
        try log("create")
        partCount = Int((job.size + partSize - 1) / partSize)
        return .init(id: "mp-1", key: "drive/\(job.path.dropFirst())", name: job.name, partSize: partSize, partCount: partCount)
    }

    func signParts(uploadId: String, parts: [Int]) async throws -> [Int: URL] {
        try log("sign \(parts.map(String.init).joined(separator: ","))")
        return Dictionary(uniqueKeysWithValues: parts.map { ($0, URL(string: "https://bucket.test/part/\($0)")!) })
    }

    func multipartStatus(uploadId: String) async throws -> OnyxAPI.MultipartStatus {
        try log("status")
        return .init(done: Set(parts.keys), partSize: partSize, partCount: partCount)
    }

    func completeMultipart(uploadId: String) async throws -> OnyxAPI.CompletedUpload {
        try log("complete")
        let joined = parts.keys.sorted().reduce(into: Data()) { $0.append(parts[$1]!) }
        objects["assembled"] = joined
        return .init(key: "drive/assembled", publicUrl: nil, name: "assembled")
    }

    func record(_ job: UploadJob, key: String, publicUrl: String?) async throws -> OnyxAPI.RecordedFile {
        try log("record \(job.path)")
        return .init(id: "file-\(job.name)", name: job.name, folder: job.folder, size: job.size)
    }

    func put(_ file: URL, offset: Int64, length: Int64, to url: URL, contentType: String?,
             progress: @escaping @Sendable (Int64) -> Void) async throws {
        try log("put \(url.lastPathComponent)")
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let data = try handle.read(upToCount: Int(length)) ?? Data()
        if url.path.contains("/part/"), let n = Int(url.lastPathComponent) { parts[n] = data } else { objects[url.lastPathComponent] = data }
        progress(Int64(data.count))
    }
}

private func scratch() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("uploads-\(UUID().uuidString)", isDirectory: true)
}

private func source(_ bytes: Data) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("src-\(UUID().uuidString)")
    try bytes.write(to: url)
    return url
}

/// Waits (briefly) until the queue has nothing left that is not done or failed.
private func settle(_ queue: UploadQueue) async {
    for _ in 0..<500 {
        if await queue.all().allSatisfy({ $0.state == .failed }) { return }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
}

@Suite struct UploadQueueTests {
    @Test func aSmallFileIsPresignedPutAndRecorded() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        let queue = try UploadQueue(directory: dir, transport: server, sleep: { _ in })
        let seen = Recorder()
        await queue.observe { job in Task { await seen.add(job) } }
        try await queue.enqueue(from: try source(Data("hello".utf8)), scope: "drive.d1", filespaceId: "d1",
                                folder: "Footage", name: "Take 1.mov", mime: "video/quicktime")
        await settle(queue)
        #expect(await server.calls == ["presign", "put Take 1.mov", "record /Footage/Take 1.mov"])
        #expect(await server.objects["Take 1.mov"] == Data("hello".utf8))
        #expect(await queue.all().isEmpty)
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(await seen.last?.state == .done)
        #expect(await seen.last?.fileId == "file-Take 1.mov")
        // The staged copy is gone once the server has the file.
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("files").path).isEmpty)
    }

    /// Over the threshold: in parts. Part 5 fails once; the retry asks the
    /// bucket what it already has and sends only what is missing.
    @Test func aLargeFileGoesInPartsAndResumesWhereItStopped() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("put 5", URLError(.networkConnectionLost))
        let big = Data(count: Int(UploadQueue.multipartThreshold)) + Data((0..<95).map { UInt8($0) })
        await server.setPartSize(Int64(big.count / 9))
        let queue = try UploadQueue(directory: dir, transport: server, sleep: { _ in })
        try await queue.enqueue(from: try source(big), scope: "library", filespaceId: nil, folder: "",
                                name: "big.mov", mime: "video/quicktime")
        await settle(queue)
        let calls = await server.calls
        #expect(calls.first == "create")
        #expect(calls.filter { $0 == "put 1" }.count == 1)
        #expect(calls.filter { $0 == "put 5" }.count == 2)
        #expect(calls.filter { $0 == "status" }.count == 2)
        #expect(calls.contains("complete"))
        #expect(calls.last == "record /big.mov")
        #expect(await server.objects["assembled"] == big)
        #expect(await queue.all().isEmpty)
    }

    @Test func aRefusalFailsAtOnceWithTheServersWords() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("presign", OnyxError.http(status: 403, message: "You can view this drive but not add to it."))
        let queue = try UploadQueue(directory: dir, transport: server, sleep: { _ in })
        let job = try await queue.enqueue(from: try source(Data([1])), scope: "drive.d1", filespaceId: "d1",
                                          folder: "", name: "a.txt", mime: "text/plain")
        await settle(queue)
        let failed = await queue.job(job.id)
        #expect(failed?.state == .failed)
        #expect(failed?.lastError == "You can view this drive but not add to it.")
        #expect(await server.calls == ["presign"])
        // Retry, once the owner has made them an editor.
        await queue.retry(job.id)
        await settle(queue)
        #expect(await queue.job(job.id) == nil)
    }

    @Test func aHiccupIsRetried() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("record /a.txt", OnyxError.http(status: 503, message: nil))
        let queue = try UploadQueue(directory: dir, transport: server, sleep: { _ in })
        try await queue.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil,
                                folder: "", name: "a.txt", mime: "text/plain")
        await settle(queue)
        #expect(await server.calls == ["presign", "put a.txt", "record /a.txt", "presign", "put a.txt", "record /a.txt"])
        #expect(await queue.all().isEmpty)
    }

    @Test func renamedBeforeItArrivedItLandsAtTheNewPlace() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet))
        let gate = Gate()
        let queue = try UploadQueue(directory: dir, transport: server, sleep: { _ in await gate.wait() })
        let job = try await queue.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil,
                                          folder: "", name: "untitled.txt", mime: "text/plain")
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(await queue.pending(scope: "library", path: "/untitled.txt")?.id == job.id)
        await queue.retarget(job.id, folder: "Notes", name: "ideas.txt")
        await gate.open()
        await settle(queue)
        #expect(await server.calls.last == "record /Notes/ideas.txt")
    }

    @Test func deletedBeforeItArrivedItNeverDoes() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet))
        let gate = Gate()
        let queue = try UploadQueue(directory: dir, transport: server, sleep: { _ in await gate.wait() })
        let job = try await queue.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil,
                                          folder: "", name: "oops.txt", mime: "text/plain")
        try await Task.sleep(nanoseconds: 20_000_000)
        await queue.cancel(job.id)
        await gate.open()
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await server.calls == ["presign"])
        #expect(await queue.all().isEmpty)
    }

    @Test func aRestartPicksUpWhatWasWaiting() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let offline = FakeServer()
        await offline.setFailure("presign", URLError(.notConnectedToInternet))
        let gate = Gate()
        let first = try UploadQueue(directory: dir, transport: offline, sleep: { _ in await gate.wait() })
        try await first.enqueue(from: try source(Data("later".utf8)), scope: "library", filespaceId: nil,
                                folder: "", name: "later.txt", mime: "text/plain")
        try await Task.sleep(nanoseconds: 20_000_000)

        // The app quits and starts again, the network back.
        let online = FakeServer()
        let second = try UploadQueue(directory: dir, transport: online, sleep: { _ in })
        #expect(await second.all().map(\.name) == ["later.txt"])
        await second.resume()
        await settle(second)
        #expect(await online.objects["later.txt"] == Data("later".utf8))
        await gate.open()
    }
}

private actor Recorder {
    var jobs: [UploadJob] = []
    var last: UploadJob? { jobs.last }
    func add(_ job: UploadJob) { jobs.append(job) }
}

private actor Gate {
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiting.append($0) }
    }
    func open() {
        isOpen = true
        waiting.forEach { $0.resume() }
        waiting = []
    }
}

private extension FakeServer {
    func setPartSize(_ size: Int64) { partSize = size }
}
