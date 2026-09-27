import Foundation
import Testing
@testable import OnyxFSCore

/// The app's bridge, pretend: a tree of folders and files with bytes, what
/// was asked of it, and a switch to hang the change feed.
private actor FakeBridge: EngineBridge {
    var folders: Set<String> = ["/"]
    var files: [String: (id: String, bytes: Data, version: String)] = [:]
    var calls: [String] = []
    /// The dates each put came with: (modified, created).
    var dates: [String: (Date?, Date?)] = [:]
    var readsFrom: [String] = []
    var readOnly = false
    var pendingChanges: [BridgeChanges] = []
    var nextID = 1

    func addFolder(_ path: String) { folders.insert(path) }
    func addFile(_ path: String, _ bytes: Data) {
        files[path] = ("f\(nextID)", bytes, "v1")
        nextID += 1
    }
    func setReadOnly(_ on: Bool) { readOnly = on }
    func bytes(_ path: String) -> Data? { files[path]?.bytes }
    func push(_ changes: BridgeChanges) { pendingChanges.append(changes) }
    func replaceBytes(_ path: String, _ bytes: Data) {
        guard let file = files[path] else { return }
        files[path] = (file.id, bytes, "v\(Int(file.version.dropFirst())! + 1)")
    }

    func volume() async throws -> BridgeVolume {
        BridgeVolume(name: "Client Deliverables", readOnly: readOnly, totalBytes: 0, usedBytes: 100, fileCount: Int64(files.count))
    }

    func list(_ path: String) async throws -> [BridgeEntry] {
        calls.append("list \(path)")
        guard folders.contains(path) else { throw BridgeFailure.notFound }
        let prefix = path == "/" ? "/" : path + "/"
        var out: [BridgeEntry] = []
        for folder in folders where folder != path && folder.hasPrefix(prefix) && !folder.dropFirst(prefix.count).contains("/") {
            out.append(BridgeEntry(name: String(folder.dropFirst(prefix.count)), isDirectory: true))
        }
        for (filePath, file) in files where filePath.hasPrefix(prefix) && !filePath.dropFirst(prefix.count).contains("/") {
            out.append(BridgeEntry(name: String(filePath.dropFirst(prefix.count)), isDirectory: false, id: file.id,
                                   size: Int64(file.bytes.count), version: file.version))
        }
        return out
    }

    func putFile(_ path: String, from: URL, modified: Date?, created: Date?) async throws -> BridgeEntry {
        let bytes = try Data(contentsOf: from)
        calls.append("put \(path) \(bytes.count)")
        dates[path] = (modified, created)
        if readOnly { throw BridgeFailure.forbidden("You can view this drive but not add to it.") }
        if files[path] != nil { replaceBytes(path, bytes) } else { addFile(path, bytes) }
        let file = files[path]!
        return BridgeEntry(name: (path as NSString).lastPathComponent, isDirectory: false, id: file.id,
                           size: Int64(bytes.count), version: file.version, pending: true)
    }

    func mkdir(_ path: String) async throws -> BridgeEntry {
        calls.append("mkdir \(path)")
        folders.insert(path)
        return BridgeEntry(name: (path as NSString).lastPathComponent, isDirectory: true)
    }

    func rename(_ from: String, to: String, replace: Bool) async throws -> BridgeEntry {
        calls.append("rename \(from) -> \(to)\(replace ? " (replace)" : "")")
        if let file = files.removeValue(forKey: from) {
            files[to] = file
            return BridgeEntry(name: (to as NSString).lastPathComponent, isDirectory: false, id: file.id,
                               size: Int64(file.bytes.count), version: file.version)
        }
        folders.remove(from)
        folders.insert(to)
        return BridgeEntry(name: (to as NSString).lastPathComponent, isDirectory: true)
    }

    func delete(_ path: String) async throws {
        calls.append("delete \(path)")
        files[path] = nil
        folders.remove(path)
    }

    func changes(since generation: UInt64) async throws -> BridgeChanges {
        while pendingChanges.isEmpty {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        return pendingChanges.removeFirst()
    }

    func reader(for entry: BridgeEntry) async throws -> any ByteSource {
        guard let (path, file) = files.first(where: { $0.value.id == entry.id }) else { throw BridgeFailure.notFound }
        readsFrom.append(path)
        return Bytes(data: file.bytes)
    }

    struct Bytes: ByteSource {
        let data: Data
        func read(offset: Int64, length: Int) async throws -> Data {
            let start = Int(min(Int64(data.count), max(0, offset)))
            return data.subdata(in: start..<min(data.count, start + length))
        }
    }
}

private func makeEngine(_ bridge: FakeBridge) async throws -> DriveEngine {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("engine-\(UUID().uuidString)")
    return DriveEngine(bridge: bridge, volume: try await bridge.volume(),
                       staging: try StagingArea(directory: root.appendingPathComponent("staging")),
                       local: try LocalStore(directory: root.appendingPathComponent("local")))
}

@Suite struct DriveEngineTests {
    @Test func listsTheDriveWithMacOSOwnFilesKeptApart() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Footage")
        await bridge.addFile("/Footage/Take 1.mov", Data("frames".utf8))
        await bridge.addFile("/.DS_Store", Data("web junk".utf8)) // the bridge never lists these; a stray one is ignored
        let engine = try await makeEngine(bridge)
        let top = try await engine.children(of: DriveEngine.rootID)
        #expect(top.map(\.name) == ["Footage", ".metadata_never_index", "com.apple.timemachine.donotpresent"])
        let footage = try await engine.lookup("footage", in: DriveEngine.rootID) // as Finder asks: any case
        #expect(footage.name == "Footage" && footage.isDirectory)
        let take = try await engine.lookup("TAKE 1.MOV", in: footage.id)
        #expect(take.size == 6)
        // The same id every time it is asked for.
        #expect(try await engine.lookup("Take 1.mov", in: footage.id).id == take.id)
        #expect(String(decoding: try await engine.read(take.id, at: 2, count: 100), as: UTF8.self) == "ames")
        await #expect(throws: VolumeError.posix(ENOENT)) { try await engine.lookup("nope", in: footage.id) }
    }

    @Test func aCopiedFileIsListedAtOnceAndUploadedOnClose() async throws {
        let bridge = FakeBridge()
        let engine = try await makeEngine(bridge)
        let file = try await engine.create("Cut.mov", in: DriveEngine.rootID, isDirectory: false)
        try await engine.beginWriting(file.id, truncating: false)
        _ = try await engine.write(file.id, at: 0, data: Data("hello ".utf8))
        _ = try await engine.write(file.id, at: 6, data: Data("world".utf8))
        // Listed and readable before it is sent.
        #expect(try await engine.children(of: DriveEngine.rootID).contains { $0.name == "Cut.mov" && $0.size == 11 })
        #expect(String(decoding: try await engine.read(file.id, at: 0, count: 50), as: UTF8.self) == "hello world")
        #expect(await !bridge.calls.contains { $0.hasPrefix("put") })
        try await engine.finishWriting(file.id)
        #expect(await bridge.calls.contains("put /Cut.mov 11"))
        // Now it reads as the server's.
        #expect(String(decoding: try await engine.read(file.id, at: 0, count: 5), as: UTF8.self) == "hello")
    }

    @Test func aCopyKeepsTheDatesFinderGivesIt() async throws {
        let bridge = FakeBridge()
        let engine = try await makeEngine(bridge)
        let file = try await engine.create("Old.mov", in: DriveEngine.rootID, isDirectory: false)
        try await engine.beginWriting(file.id, truncating: false)
        _ = try await engine.write(file.id, at: 0, data: Data("bytes".utf8))
        // Finder's copy sets the original's dates once the bytes are in.
        let modified = Date(timeIntervalSince1970: 1_551_530_000), born = Date(timeIntervalSince1970: 1_551_000_000)
        _ = try await engine.setModified(file.id, to: modified)
        let node = try await engine.setCreated(file.id, to: born)
        #expect(node.created == born && node.modified == modified, "shown as Finder set them")
        try await engine.finishWriting(file.id)
        let sent = try #require(await bridge.dates["/Old.mov"])
        #expect(sent.0 == modified && sent.1 == born, "and sent with the bytes")
    }

    @Test func changingAFileBringsItHereFirstAndSendsItWhole() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/notes.txt", Data("abcdef".utf8))
        let engine = try await makeEngine(bridge)
        let notes = try await engine.lookup("notes.txt", in: DriveEngine.rootID)
        try await engine.beginWriting(notes.id, truncating: false)
        _ = try await engine.write(notes.id, at: 2, data: Data("XY".utf8))
        try await engine.finishWriting(notes.id)
        #expect(await bridge.bytes("/notes.txt") == Data("abXYef".utf8))
        #expect(await bridge.readsFrom == ["/notes.txt"])
    }

    @Test func aSaveThatEmptiesFirstNeverDownloadsTheOldBytes() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/big.mov", Data(count: 1000))
        let engine = try await makeEngine(bridge)
        let big = try await engine.lookup("big.mov", in: DriveEngine.rootID)
        try await engine.beginWriting(big.id, truncating: true)
        _ = try await engine.write(big.id, at: 0, data: Data("new".utf8))
        try await engine.finishWriting(big.id)
        #expect(await bridge.readsFrom.isEmpty)
        #expect(await bridge.bytes("/big.mov") == Data("new".utf8))
    }

    @Test func foldersRenamesAndDeletesAreTheServers() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Old")
        await bridge.addFile("/Old/a.mov", Data([1]))
        let engine = try await makeEngine(bridge)
        let old = try await engine.lookup("Old", in: DriveEngine.rootID)
        let a = try await engine.lookup("a.mov", in: old.id)
        let made = try await engine.create("Cuts", in: DriveEngine.rootID, isDirectory: true)
        #expect(made.isDirectory)
        _ = try await engine.rename(old.id, from: DriveEngine.rootID, name: "Old", to: DriveEngine.rootID, newName: "New", replacing: nil)
        // The file inside kept its id through its folder's rename.
        let new = try await engine.lookup("New", in: DriveEngine.rootID)
        #expect(new.id == old.id)
        #expect(try await engine.lookup("a.mov", in: new.id).id == a.id)
        _ = try await engine.rename(a.id, from: new.id, name: "a.mov", to: made.id, newName: "final.mov", replacing: nil)
        try await engine.remove(a.id, name: "final.mov", from: made.id)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") } == [
            "mkdir /Cuts", "rename /Old -> /New", "rename /New/a.mov -> /Cuts/final.mov", "delete /Cuts/final.mov",
        ])
    }

    @Test func aFileStillBeingWrittenIsRenamedAndDeletedHere() async throws {
        let bridge = FakeBridge()
        let engine = try await makeEngine(bridge)
        let draft = try await engine.create("untitled.txt", in: DriveEngine.rootID, isDirectory: false)
        _ = try await engine.write(draft.id, at: 0, data: Data("x".utf8))
        _ = try await engine.rename(draft.id, from: DriveEngine.rootID, name: "untitled.txt", to: DriveEngine.rootID,
                                    newName: "ideas.txt", replacing: nil)
        try await engine.finishWriting(draft.id)
        let scratch = try await engine.create("scratch.txt", in: DriveEngine.rootID, isDirectory: false)
        try await engine.remove(scratch.id, name: "scratch.txt", from: DriveEngine.rootID)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") } == ["put /ideas.txt 1"])
    }

    @Test func savingOverAFileMovesTheNewCopyOverTheOld() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/report.pages", Data("v1".utf8))
        let engine = try await makeEngine(bridge)
        let report = try await engine.lookup("report.pages", in: DriveEngine.rootID)
        let temp = try await engine.create("report.pages.sb-123", in: DriveEngine.rootID, isDirectory: false)
        _ = try await engine.write(temp.id, at: 0, data: Data("v2".utf8))
        try await engine.finishWriting(temp.id)
        _ = try await engine.rename(temp.id, from: DriveEngine.rootID, name: "report.pages.sb-123", to: DriveEngine.rootID,
                                    newName: "report.pages", replacing: report.id)
        #expect(await bridge.calls.contains("rename /report.pages.sb-123 -> /report.pages (replace)"))
        await #expect(throws: VolumeError.posix(EEXIST)) {
            let other = try await engine.create("other.txt", in: DriveEngine.rootID, isDirectory: false)
            _ = try await engine.rename(other.id, from: DriveEngine.rootID, name: "other.txt", to: DriveEngine.rootID,
                                        newName: "report.pages", replacing: nil)
        }
    }

    @Test func finderGetsNoTrashAndDeletesToTheWebsInstead() async throws {
        let engine = try await makeEngine(FakeBridge())
        await #expect(throws: VolumeError.posix(EPERM)) {
            try await engine.create(".Trashes", in: DriveEngine.rootID, isDirectory: true)
        }
    }

    @Test func macOSOwnFilesStayOnThisMacAndSurviveARemount() async throws {
        let bridge = FakeBridge()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("engine-\(UUID().uuidString)")
        let local = try LocalStore(directory: root.appendingPathComponent("local"))
        var engine = DriveEngine(bridge: bridge, volume: try await bridge.volume(),
                                 staging: try StagingArea(directory: root.appendingPathComponent("staging")), local: local)
        let store = try await engine.create(".DS_Store", in: DriveEngine.rootID, isDirectory: false)
        _ = try await engine.write(store.id, at: 0, data: Data("view".utf8))
        try await engine.finishWriting(store.id)
        let apple = try await engine.create("._Take.mov", in: DriveEngine.rootID, isDirectory: false)
        _ = try await engine.write(apple.id, at: 0, data: Data([1, 2]))
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") }.isEmpty)

        engine = DriveEngine(bridge: bridge, volume: try await bridge.volume(),
                             staging: try StagingArea(directory: root.appendingPathComponent("staging")),
                             local: try LocalStore(directory: root.appendingPathComponent("local")))
        let again = try await engine.lookup(".DS_Store", in: DriveEngine.rootID)
        #expect(String(decoding: try await engine.read(again.id, at: 0, count: 10), as: UTF8.self) == "view")
    }

    @Test func attributesStayLocalAndFollowRenames() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/a.mov", Data([1]))
        let engine = try await makeEngine(bridge)
        let a = try await engine.lookup("a.mov", in: DriveEngine.rootID)
        try await engine.setXattr(named: "com.apple.metadata:_kMDItemUserTags", of: a.id, to: Data("Red".utf8),
                                  createOnly: false, replaceOnly: false)
        _ = try await engine.rename(a.id, from: DriveEngine.rootID, name: "a.mov", to: DriveEngine.rootID, newName: "b.mov", replacing: nil)
        #expect(try await engine.xattr(named: "com.apple.metadata:_kMDItemUserTags", of: a.id) == Data("Red".utf8))
        #expect(try await engine.xattrNames(of: a.id) == ["com.apple.metadata:_kMDItemUserTags"])
    }

    @Test func aViewersDriveRefusesChangesButKeepsFindersOwnFiles() async throws {
        let bridge = FakeBridge()
        await bridge.setReadOnly(true)
        await bridge.addFile("/a.mov", Data([1]))
        let engine = try await makeEngine(bridge)
        await #expect(throws: VolumeError.posix(EACCES)) {
            try await engine.create("new.txt", in: DriveEngine.rootID, isDirectory: false)
        }
        let a = try await engine.lookup("a.mov", in: DriveEngine.rootID)
        await #expect(throws: VolumeError.posix(EACCES)) { try await engine.remove(a.id, name: "a.mov", from: DriveEngine.rootID) }
        _ = try await engine.create(".DS_Store", in: DriveEngine.rootID, isDirectory: false) // Finder's window state still works
    }

    @Test func aChangeOnTheWebReachesTheKernel() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Footage")
        await bridge.addFile("/Footage/a.mov", Data([1]))
        await bridge.addFile("/Footage/b.mov", Data([2]))
        let engine = try await makeEngine(bridge)
        let footage = try await engine.lookup("Footage", in: DriveEngine.rootID)
        let a = try await engine.lookup("a.mov", in: footage.id)
        let b = try await engine.lookup("b.mov", in: footage.id)
        let heard = Heard()
        await engine.observeChanges { ids, all in Task { await heard.add(ids, all) } }
        // On the web: a.mov replaced, b.mov deleted, c.mov added.
        await bridge.replaceBytes("/Footage/a.mov", Data([9, 9]))
        try await bridge.delete("/Footage/b.mov")
        await bridge.addFile("/Footage/c.mov", Data([3]))
        await bridge.push(BridgeChanges(generation: 5, paths: ["/Footage"]))
        for _ in 0..<200 where await heard.ids.isEmpty { try await Task.sleep(nanoseconds: 5_000_000) }
        let ids = await heard.ids
        #expect(ids.contains(a.id) && ids.contains(b.id))
        #expect(try await engine.lookup("a.mov", in: footage.id).size == 2)
        #expect(try await engine.children(of: footage.id).map(\.name) == ["a.mov", "c.mov"])
        await engine.shutdown()
    }
}

private actor Heard {
    var ids: Set<UInt64> = []
    var all = false
    func add(_ more: Set<UInt64>, _ everything: Bool) {
        ids.formUnion(more)
        all = all || everything
    }
}
