import Foundation
import Testing
@testable import OnyxKit

/// A pretend server and bucket: records what was asked, holds the bytes
/// PUT to it, fails on command.
actor FakeServer: UploadTransport {
    var calls: [String] = []
    /// What each recorded or swapped job said of the file's own dates:
    /// (created, modified), by path.
    var dates: [String: (Date?, Date?)] = [:]
    var objects: [String: Data] = [:]
    /// Large uploads open, by id: their parts.
    var uploads: [String: [Int: Data]] = [:]
    var opened = 0
    var failNext: [String: [Error]] = [:]
    var partSize: Int64 = 10
    var partCount = 0
    /// How long each PUT takes, and how many were in flight at once: all of
    /// them, and of the large uploads, how many had a part in flight.
    var putDelay: UInt64 = 0
    var putsInFlight = 0
    var mostPutsAtOnce = 0
    var partsInFlight: [String: Int] = [:]
    var mostUploadsAtOnce = 0

    func setPutDelay(_ nanoseconds: UInt64) { putDelay = nanoseconds }

    func log(_ call: String) throws {
        calls.append(call)
        if var errors = failNext[call], !errors.isEmpty {
            let error = errors.removeFirst()
            failNext[call] = errors.isEmpty ? nil : errors
            throw error
        }
    }

    func setFailure(_ call: String, _ error: Error, times: Int = 1) { failNext[call] = Array(repeating: error, count: times) }
    /// These, one per call, in order.
    func setFailures(_ call: String, _ errors: [Error]) { failNext[call] = errors }

    /// "presign" for a new file; "presign for <id>" for new contents of one.
    func presign(_ job: UploadJob) async throws -> OnyxAPI.PresignedPut {
        try log(job.replaceOf.map { "presign for \($0)" } ?? "presign")
        let key = job.replaceOf.map { "drive/\($0)-new" } ?? "drive/\(job.path.dropFirst())"
        return .init(putUrl: URL(string: "https://bucket.test/k/\(job.name)")!, publicUrl: "https://bucket.test/k/\(job.name)",
                     key: key, name: job.name)
    }

    func startMultipart(_ job: UploadJob) async throws -> OnyxAPI.MultipartUpload {
        try log(job.replaceOf.map { "create for \($0)" } ?? "create")
        partCount = Int((job.size + partSize - 1) / partSize)
        opened += 1
        uploads["mp-\(opened)"] = [:]
        return .init(id: "mp-\(opened)", key: "drive/\(job.path.dropFirst())", name: job.name, partSize: partSize, partCount: partCount)
    }

    func signParts(uploadId: String, parts: [Int]) async throws -> [Int: URL] {
        try log("sign \(parts.map(String.init).joined(separator: ","))")
        return Dictionary(uniqueKeysWithValues: parts.map { ($0, URL(string: "https://bucket.test/part/\(uploadId)/\($0)")!) })
    }

    func multipartStatus(uploadId: String) async throws -> OnyxAPI.MultipartStatus {
        try log("status")
        guard let parts = uploads[uploadId] else { throw OnyxAPI.Refusal(status: 404, message: "Upload not found") }
        return .init(done: Set(parts.keys), partSize: partSize, partCount: partCount)
    }

    func completeMultipart(uploadId: String) async throws -> OnyxAPI.CompletedUpload {
        try log("complete")
        guard let parts = uploads.removeValue(forKey: uploadId) else { throw OnyxAPI.Refusal(status: 404, message: "Upload not found") }
        let joined = parts.keys.sorted().reduce(into: Data()) { $0.append(parts[$1]!) }
        objects["assembled"] = joined
        return .init(key: "drive/assembled", publicUrl: nil, name: "assembled")
    }

    func abortMultipart(uploadId: String) async throws {
        try log("abort \(uploadId)")
        uploads[uploadId] = nil
    }

    func record(_ job: UploadJob, key: String, publicUrl: String?) async throws -> OnyxAPI.RecordedFile {
        try log("record \(job.path)")
        dates[job.path] = (job.fileCreatedAt, job.fileModifiedAt)
        return .init(id: "file-\(job.name)", name: job.name, folder: job.folder, size: job.size)
    }

    /// The swap: the same file, new bytes, changed at t=2 s.
    func replaceContent(_ job: UploadJob, key: String) async throws -> OnyxAPI.RecordedFile {
        try log("swap \(job.replaceOf ?? "?") <- \(key)")
        dates[job.path] = (job.fileCreatedAt, job.fileModifiedAt)
        return .init(id: job.replaceOf ?? "?", name: job.name, folder: job.folder, size: job.size, updatedAt: EpochMillis(2_000))
    }

    func put(_ file: URL, offset: Int64, length: Int64, to url: URL, contentType: String?,
             progress: @escaping @Sendable (Int64) -> Void) async throws {
        try log("put \(url.lastPathComponent)")
        let upload = url.path.contains("/part/") ? url.deletingLastPathComponent().lastPathComponent : nil
        putsInFlight += 1
        mostPutsAtOnce = max(mostPutsAtOnce, putsInFlight)
        if let upload {
            partsInFlight[upload, default: 0] += 1
            mostUploadsAtOnce = max(mostUploadsAtOnce, partsInFlight.count)
        }
        defer {
            putsInFlight -= 1
            if let upload {
                partsInFlight[upload, default: 1] -= 1
                if partsInFlight[upload] == 0 { partsInFlight[upload] = nil }
            }
        }
        if putDelay > 0 { try await Task.sleep(nanoseconds: putDelay) }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let data = try handle.read(upToCount: Int(length)) ?? Data()
        if url.path.contains("/part/"), let n = Int(url.lastPathComponent) {
            // Storage keeps no part for an upload that is gone.
            uploads[url.deletingLastPathComponent().lastPathComponent]?[n] = data
        } else {
            objects[url.lastPathComponent] = data
        }
        progress(Int64(data.count))
    }
}

func scratch() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("uploads-\(UUID().uuidString)", isDirectory: true)
}

func source(_ bytes: Data) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("src-\(UUID().uuidString)")
    try bytes.write(to: url)
    return url
}

/// Waits (briefly) until the queue has nothing left that is not done or failed.
func settle(_ queue: UploadQueue) async {
    for _ in 0..<500 {
        if await queue.all().allSatisfy({ $0.state == .failed }) { return }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
}

@Suite struct UploadQueueTests {
    @Test func aSmallFileIsPresignedPutAndRecorded() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
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
        // The staged copy stays while Finder may still read it (until the
        // mirror shows the server's), and goes when released.
        let files = dir.appendingPathComponent("files").path
        #expect(try FileManager.default.contentsOfDirectory(atPath: files).count == 1)
        let id = try #require(await seen.last?.id)
        await queue.release(id)
        #expect(try FileManager.default.contentsOfDirectory(atPath: files).isEmpty)
    }

    /// Over the threshold: in parts. Part 5 fails once; the retry asks the
    /// bucket what it already has and sends only what is missing.
    @Test func aFilesOwnDatesAreRecordedWithIt() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        let born = Date(timeIntervalSince1970: 1_551_000_000), changed = Date(timeIntervalSince1970: 1_551_530_000)
        try await queue.enqueue(from: try source(Data("x".utf8)), scope: "drive.d1", filespaceId: "d1",
                                folder: "Footage", name: "Old.mov", mime: "video/quicktime", created: born, modified: changed)
        try await queue.enqueue(from: try source(Data("y".utf8)), scope: "drive.d1", filespaceId: "d1",
                                folder: "Footage", name: "Cut.mov", mime: "video/quicktime", replaceOf: "f9", modified: changed)
        await settle(queue)
        let recorded = try #require(await server.dates["/Footage/Old.mov"])
        #expect(recorded.0 == born && recorded.1 == changed)
        // New contents carry when they were written; the file keeps its own created date.
        let swapped = try #require(await server.dates["/Footage/Cut.mov"])
        #expect(swapped.0 == nil && swapped.1 == changed)
    }

    @Test func aJobSavedBeforeDatesWereKeptStillLoads() throws {
        // A queue written by an older build: no fileCreatedAt, no fileModifiedAt.
        let json = #"{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","scope":"drive.d1","filespaceId":"d1","folder":"","name":"a.mov","staged":"/tmp/a","size":1,"mime":"video/quicktime","state":"queued","attempts":0}"#
        let job = try JSONDecoder().decode(UploadJob.self, from: Data(json.utf8))
        #expect(job.fileCreatedAt == nil && job.fileModifiedAt == nil && job.name == "a.mov")
    }

    @Test func aLargeFileGoesInPartsAndResumesWhereItStopped() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("put 5", URLError(.networkConnectionLost))
        let big = Data(count: Int(UploadQueue.multipartThreshold)) + Data((0..<95).map { UInt8($0) })
        await server.setPartSize(Int64(big.count / 9))
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
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
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
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
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        try await queue.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil,
                                folder: "", name: "a.txt", mime: "text/plain")
        await settle(queue)
        // The bytes were in storage already: only the recording is asked again.
        #expect(await server.calls == ["presign", "put a.txt", "record /a.txt", "record /a.txt"])
        #expect(await queue.all().isEmpty)
    }

    @Test func renamedBeforeItArrivedItLandsAtTheNewPlace() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet))
        let gate = Gate()
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in await gate.wait() })
        let job = try await queue.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil,
                                          folder: "", name: "untitled.txt", mime: "text/plain")
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(await queue.pending(scope: "library", path: "/untitled.txt")?.id == job.id)
        await queue.retarget(job.id, folder: "Notes", name: "ideas.txt", replacing: nil)
        await gate.open()
        await settle(queue)
        #expect(await server.calls.last == "record /Notes/ideas.txt")
    }

    @Test func deletedBeforeItArrivedItNeverDoes() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet))
        let gate = Gate()
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in await gate.wait() })
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
        let first = try UploadQueue(directory: dir, transport: offline, settle: 0, sleep: { _ in await gate.wait() })
        try await first.enqueue(from: try source(Data("later".utf8)), scope: "library", filespaceId: nil,
                                folder: "", name: "later.txt", mime: "text/plain")
        try await Task.sleep(nanoseconds: 20_000_000)

        // The app quits and starts again, the network back.
        let online = FakeServer()
        let second = try UploadQueue(directory: dir, transport: online, settle: 0, sleep: { _ in })
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

actor Gate {
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

extension FakeServer {
    func setPartSize(_ size: Int64) { partSize = size }
}

@Suite struct UploadQueueCleanupTests {
    /// A copy kept for reading by an earlier run is not read by anything now.
    @Test func copiesKeptByAnEarlierRunAreClearedAtStart() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        let first = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        try await first.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil, folder: "", name: "a.txt", mime: "text/plain")
        await settle(first)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("files").path).count == 1)
        _ = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("files").path).isEmpty)
    }
}

/// What happens after the bytes are in storage: recorded once, swapped in
/// once, and a key that is no good any more traded for a new one — never a
/// second copy of a file, never bytes sent twice without need.
@Suite struct UploadRecoveryTests {
    /// The server recorded the file, but its answer was lost: asked again it
    /// says 409, which means done — not a failure, not a second upload.
    @Test func aLostAnswerToTheRecordIsNotASecondFile() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailures("record /a.txt", [
            URLError(.networkConnectionLost),
            OnyxAPI.Refusal(status: 409, message: "That stored object already belongs to a file in the library."),
        ])
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        let seen = Seen()
        await queue.observe { job in Task { await seen.add(job) } }
        try await queue.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil, folder: "",
                                name: "a.txt", mime: "text/plain")
        await settle(queue)
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(await server.calls == ["presign", "put a.txt", "record /a.txt", "record /a.txt"])
        #expect(await seen.last?.state == .done)
        #expect(await seen.last?.fileId == nil) // the mirror will say which
    }

    /// Saved over a file: new contents under a key issued for that file, then
    /// swapped in. A file moved to another folder meanwhile makes the key no
    /// good (409 moved): a new one, and the bytes again.
    @Test func newContentsAreSwappedInAndAMovedFileGetsANewKey() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("swap notes <- drive/notes-new",
                                OnyxAPI.Refusal(status: 409, code: "moved", message: "The file moved while uploading."))
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        let seen = Seen()
        await queue.observe { job in Task { await seen.add(job) } }
        try await queue.enqueue(from: try source(Data("v2".utf8)), scope: "drive.d1", filespaceId: "d1", folder: "",
                                name: "notes.txt", mime: "text/plain", replaceOf: "notes")
        await settle(queue)
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(await server.calls == [
            "presign for notes", "put notes.txt", "swap notes <- drive/notes-new",
            "presign for notes", "put notes.txt", "swap notes <- drive/notes-new",
        ])
        #expect(await seen.last?.fileId == "notes")
        #expect(await seen.last?.changedAt == Date(timeIntervalSince1970: 2))
    }

    /// The file saved over was deleted on the web meanwhile: the bytes are
    /// not lost — they become a file of their own, where Finder has them.
    @Test func newContentsForADeletedFileBecomeANewFile() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("presign for notes", OnyxAPI.Refusal(status: 404, message: "File not found"))
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        try await queue.enqueue(from: try source(Data("v2".utf8)), scope: "drive.d1", filespaceId: "d1", folder: "",
                                name: "notes.txt", mime: "text/plain", replaceOf: "notes")
        await settle(queue)
        #expect(await server.calls == ["presign for notes", "presign", "put notes.txt", "record /notes.txt"])
    }

    /// A key more than a day old, or one someone else's change used up,
    /// is refused (403 not_issued): upload again for a new one. Any other
    /// 403 is the server meaning it.
    @Test func aKeyNoLongerIssuedIsTradedForANewOne() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("record /a.txt", OnyxAPI.Refusal(status: 403, code: "not_issued", message: "Not issued."))
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        try await queue.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil, folder: "",
                                name: "a.txt", mime: "text/plain")
        await settle(queue)
        #expect(await server.calls == ["presign", "put a.txt", "record /a.txt", "presign", "put a.txt", "record /a.txt"])
        #expect(UploadQueue.next(after: OnyxAPI.Refusal(status: 403, message: "Your role can view files but not add them."),
                                 replacing: false) == .fail)
    }

    /// A large upload the server forgot (aborted after a week untouched):
    /// begun again, not failed.
    @Test func aForgottenLargeUploadStartsAgain() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setFailure("status", OnyxAPI.Refusal(status: 404, message: "Upload not found"))
        let big = Data(count: Int(UploadQueue.multipartThreshold) + 10)
        await server.setPartSize(Int64(big.count / 4 + 1))
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        try await queue.enqueue(from: try source(big), scope: "library", filespaceId: nil, folder: "",
                                name: "big.mov", mime: "video/quicktime")
        await settle(queue)
        let calls = await server.calls
        #expect(calls.prefix(3) == ["create", "status", "abort mp-1"])
        #expect(calls.filter { $0 == "create" }.count == 2)
        #expect(calls.last == "record /big.mov")
        #expect(await server.objects["assembled"] == big)
    }

    /// A file deleted in its first moment (an app's temporary file) was
    /// never sent at all.
    @Test func nothingIsSentForAFileGoneInItsFirstMoment() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        let gate = Gate()
        let queue = try UploadQueue(directory: dir, transport: server, settle: 2, sleep: { _ in await gate.wait() })
        let job = try await queue.enqueue(from: try source(Data([1])), scope: "library", filespaceId: nil, folder: "",
                                          name: "~lock.tmp", mime: "application/octet-stream")
        try await Task.sleep(nanoseconds: 20_000_000)
        await queue.cancel(job.id)
        await gate.open()
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await server.calls.isEmpty)
    }
}

private actor Seen {
    var jobs: [UploadJob] = []
    var last: UploadJob? { jobs.last }
    func add(_ job: UploadJob) { jobs.append(job) }
}


/// Several at once: a large file's parts, small files, large files — each
/// within its own limit.
@Suite struct UploadConcurrencyTests {
    private func big(_ fill: UInt8) -> Data {
        Data(repeating: fill, count: Int(UploadQueue.multipartThreshold)) + Data((0..<95).map { UInt8($0) })
    }

    @Test func aLargeFileSendsItsPartsSeveralAtOnce() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        let data = big(7)
        await server.setPartSize(Int64(data.count / 9))
        await server.setPutDelay(50_000_000)
        let queue = try UploadQueue(directory: dir, transport: server, settle: 0, sleep: { _ in })
        try await queue.enqueue(from: try source(data), scope: "library", filespaceId: nil, folder: "",
                                name: "big.mov", mime: "video/quicktime")
        await settle(queue)
        #expect(await server.mostPutsAtOnce == UploadQueue.partConcurrency, "four parts in flight, not one after another")
        #expect(await server.objects["assembled"] == data, "every part, in its place")
        #expect(await queue.all().isEmpty)
    }

    @Test func smallFilesGoFourAtATime() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setPutDelay(50_000_000)
        // All of them queued before any is sent (the settle moment waits on
        // the gate), so what goes at once is the queue's limit, not how fast
        // this test could hand them over.
        let gate = Gate()
        let queue = try UploadQueue(directory: dir, transport: server, settle: 1, sleep: { _ in await gate.wait() })
        for n in 1...7 {
            try await queue.enqueue(from: try source(Data([UInt8(n)])), scope: "library", filespaceId: nil, folder: "",
                                    name: "photo-\(n).jpg", mime: "image/jpeg")
        }
        await gate.open()
        for _ in 0..<5 { await settle(queue) }
        #expect(await server.mostPutsAtOnce == UploadQueue.concurrency)
        #expect(await server.objects.count == 7)
        #expect(await queue.all().isEmpty)
    }

    @Test func noMoreThanTwoLargeFilesAtOnceAndSmallOnesGoBesideThem() async throws {
        let dir = scratch(); defer { try? FileManager.default.removeItem(at: dir) }
        let server = FakeServer()
        await server.setPartSize(Int64(big(0).count / 3))
        await server.setPutDelay(50_000_000)
        let gate = Gate()
        let queue = try UploadQueue(directory: dir, transport: server, settle: 1, sleep: { _ in await gate.wait() })
        for n in 1...3 {
            try await queue.enqueue(from: try source(big(UInt8(n))), scope: "library", filespaceId: nil, folder: "",
                                    name: "take-\(n).mov", mime: "video/quicktime")
        }
        try await queue.enqueue(from: try source(Data([9])), scope: "library", filespaceId: nil, folder: "",
                                name: "note.txt", mime: "text/plain")
        await gate.open()
        for _ in 0..<5 { await settle(queue) }
        #expect(await server.mostUploadsAtOnce == UploadQueue.largeConcurrency)
        #expect(await server.objects["note.txt"] == Data([9]), "a small file is not held up behind them")
        #expect(await queue.all().isEmpty)
    }

    @Test func progressCountsWhatEachPartInFlightHasSent() {
        let tally = PartTally(sent: 100)
        #expect(tally.sending(1, 10) == 110)
        #expect(tally.sending(2, 5) == 115)
        #expect(tally.sending(1, 30) == 135, "a part's own progress replaces, not adds to, what it said before")
        #expect(tally.finished(1, 40) == 145)
        #expect(tally.finished(2, 40) == 180)
        #expect(tally.total == 180)
    }
}
