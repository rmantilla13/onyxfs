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
    /// Paths the app says are locked (BridgeEntry.readOnly): a collection's.
    var locked: Set<String> = []
    var pendingChanges: [BridgeChanges] = []
    var nextID = 1

    func addFolder(_ path: String) { folders.insert(path) }
    func addFile(_ path: String, _ bytes: Data) {
        files[path] = ("f\(nextID)", bytes, "v1")
        nextID += 1
    }
    func setReadOnly(_ on: Bool) { readOnly = on }
    func lock(_ path: String) { locked.insert(path) }
    func bytes(_ path: String) -> Data? { files[path]?.bytes }
    func fileID(_ path: String) -> String? { files[path]?.id }
    func push(_ changes: BridgeChanges) { pendingChanges.append(changes) }

    /// The next listing of a path is answered as the folder is when it is
    /// asked for, but only once released: a listing on its way while the
    /// engine goes on answering other calls.
    private var holdNext: Set<String> = []
    private var held: [String: CheckedContinuation<Void, Never>] = [:]
    func holdNextListing(of path: String) { holdNext.insert(path) }
    func isHolding(_ path: String) -> Bool { held[path] != nil }
    func release(_ path: String) { held.removeValue(forKey: path)?.resume() }
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
        let out = entries(in: path)
        if holdNext.remove(path) != nil { await withCheckedContinuation { held[path] = $0 } }
        return out
    }

    private func entries(in path: String) -> [BridgeEntry] {
        let prefix = path == "/" ? "/" : path + "/"
        var out: [BridgeEntry] = []
        for folder in folders where folder != path && folder.hasPrefix(prefix) && !folder.dropFirst(prefix.count).contains("/") {
            out.append(BridgeEntry(name: String(folder.dropFirst(prefix.count)), isDirectory: true, readOnly: locked.contains(folder)))
        }
        for (filePath, file) in files where filePath.hasPrefix(prefix) && !filePath.dropFirst(prefix.count).contains("/") {
            out.append(BridgeEntry(name: String(filePath.dropFirst(prefix.count)), isDirectory: false, id: file.id,
                                   size: Int64(file.bytes.count), version: file.version, readOnly: locked.contains(filePath)))
        }
        return out
    }

    private var holdPut = false
    private var heldPut: CheckedContinuation<Void, Never>?
    func holdNextPut() { holdPut = true }
    func isHoldingPut() -> Bool { heldPut != nil }
    func releasePut() { heldPut?.resume(); heldPut = nil }

    func putFile(_ path: String, from: URL, modified: Date?, created: Date?) async throws -> BridgeEntry {
        if holdPut { holdPut = false; await withCheckedContinuation { heldPut = $0 } }
        let bytes = try Data(contentsOf: from)
        calls.append("put \(path) \(bytes.count)")
        dates[path] = (modified, created)
        if readOnly { throw BridgeFailure.forbidden("You can view this drive but not add to it.") }
        if files[path] != nil { replaceBytes(path, bytes) } else { addFile(path, bytes) }
        let file = files[path]!
        return BridgeEntry(name: (path as NSString).lastPathComponent, isDirectory: false, id: file.id,
                           size: Int64(bytes.count), version: file.version, pending: true)
    }

    private var holdMkdir = false
    private var heldMkdir: CheckedContinuation<Void, Never>?
    func holdNextMkdir() { holdMkdir = true }
    func isHoldingMkdir() -> Bool { heldMkdir != nil }
    func releaseMkdir() { heldMkdir?.resume(); heldMkdir = nil }

    func mkdir(_ path: String) async throws -> BridgeEntry {
        if holdMkdir { holdMkdir = false; await withCheckedContinuation { heldMkdir = $0 } }
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

    /// What the engine counted for the Activity window, in order.
    nonisolated let counted = Counted()
    nonisolated func count(_ kind: TransferMeter.Kind, bytes: Int) { counted.add("\(kind) \(bytes)") }

    final class Counted: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String] = []
        func add(_ item: String) { lock.withLock { items.append(item) } }
        var all: [String] { lock.withLock { items } }
    }

    struct Bytes: ByteSource {
        let data: Data
        func read(offset: Int64, length: Int) async throws -> Data {
            let start = Int(min(Int64(data.count), max(0, offset)))
            return data.subdata(in: start..<min(data.count, start + length))
        }
    }
}

/// Until `path` holds `bytes` on the server (uploads after a promotion go
/// once the rename has answered).
private func sent(_ bridge: FakeBridge, _ path: String, _ bytes: Data) async throws -> Bool {
    for _ in 0..<500 {
        if await bridge.bytes(path) == bytes { return true }
        try await Task.sleep(nanoseconds: 2_000_000)
    }
    return false
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
        // macOS's own are hidden in Finder, the marker with no dot to hide it too.
        #expect(top.map(\.hidden) == [false, true, true])
        let footage = try await engine.lookup("footage", in: DriveEngine.rootID) // as Finder asks: any case
        #expect(footage.name == "Footage" && footage.isDirectory)
        let take = try await engine.lookup("TAKE 1.MOV", in: footage.id)
        #expect(take.size == 6)
        // The same id every time it is asked for.
        #expect(try await engine.lookup("Take 1.mov", in: footage.id).id == take.id)
        #expect(String(decoding: try await engine.read(take.id, at: 2, count: 100), as: UTF8.self) == "ames")
        await #expect(throws: VolumeError.posix(ENOENT)) { try await engine.lookup("nope", in: footage.id) }
    }

    /// For the app's Activity window: what apps read from the drive and
    /// wrote to it — a file being written, read back, included — and none of
    /// macOS's own files, which never leave this Mac.
    @Test func readsAndWritesAreCountedButMacOSOwnFilesAreNot() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/Take 1.mov", Data("frames".utf8))
        let engine = try await makeEngine(bridge)
        let take = try await engine.lookup("Take 1.mov", in: DriveEngine.rootID)
        _ = try await engine.read(take.id, at: 0, count: 100)
        let cut = try await engine.create("Cut.mov", in: DriveEngine.rootID, isDirectory: false)
        try await engine.beginWriting(cut.id, truncating: false)
        _ = try await engine.write(cut.id, at: 0, data: Data("hello".utf8))
        _ = try await engine.read(cut.id, at: 0, count: 10)
        let store = try await engine.create(".DS_Store", in: DriveEngine.rootID, isDirectory: false)
        _ = try await engine.write(store.id, at: 0, data: Data("view".utf8))
        _ = try await engine.read(store.id, at: 0, count: 10)
        #expect(bridge.counted.all == ["read 6", "write 5", "read 5"])
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

    /// Finder asks for "Selects " — a folder from Frame.io Drive, say, with
    /// a space at the end of its name. The server keeps names without one,
    /// so it is made as "Selects", and Finder's next step, which still says
    /// "Selects ", finds it. Before, the folder it had just made could not be
    /// found, and Finder stopped the copy: "its name is too long or includes
    /// characters that are invalid on the destination volume".
    @Test func aNameIsMadeAsTheServerWillKeepIt() async throws {
        let bridge = FakeBridge()
        let engine = try await makeEngine(bridge)
        let selects = try await engine.create("Selects ", in: DriveEngine.rootID, isDirectory: true)
        #expect(selects.name == "Selects")
        #expect(try await engine.lookup("Selects ", in: DriveEngine.rootID).id == selects.id)
        #expect(try await engine.lookup(" selects", in: DriveEngine.rootID).id == selects.id)
        let cut = try await engine.create("cut.mov\u{A0}", in: selects.id, isDirectory: false)
        #expect(cut.name == "cut.mov")
        _ = try await engine.write(cut.id, at: 0, data: Data("take".utf8))
        try await engine.finishWriting(cut.id)
        _ = try await engine.rename(cut.id, from: selects.id, name: "cut.mov ", to: selects.id, newName: " final.mov ", replacing: nil)
        #expect(try await engine.children(of: selects.id).map(\.name) == ["final.mov"])
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") } == [
            "mkdir /Selects", "put /Selects/cut.mov 4", "rename /Selects/cut.mov -> /Selects/final.mov",
        ])
        // The name of one that is there already, but for its spaces: that one.
        await #expect(throws: VolumeError.posix(EEXIST)) {
            try await engine.create("Selects\t", in: DriveEngine.rootID, isDirectory: true)
        }
        // Nothing but spaces is no name at all.
        await #expect(throws: VolumeError.posix(EINVAL)) {
            try await engine.create("   ", in: DriveEngine.rootID, isDirectory: true)
        }
    }

    /// macOS's own names are not the server's to trim: "Icon\r" holds a
    /// folder's custom icon, and is not the person's file "Icon". The
    /// AppleDouble half of a file follows the file's name.
    @Test func macOSOwnNamesAreKeptAsTheyAre() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/Icon", Data("mine".utf8))
        let engine = try await makeEngine(bridge)
        let icon = try await engine.create("Icon\r", in: DriveEngine.rootID, isDirectory: false)
        #expect(icon.name == "Icon\r")
        #expect(try await engine.lookup("Icon\r", in: DriveEngine.rootID).id == icon.id)
        #expect(try await engine.lookup("Icon", in: DriveEngine.rootID).id != icon.id)
        let apple = try await engine.create("._Selects ", in: DriveEngine.rootID, isDirectory: false)
        #expect(apple.name == "._Selects")
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") }.isEmpty)
    }

    /// The engine answers other calls while a listing is on its way. What
    /// they make meanwhile — a file Finder has begun to copy, a folder it has
    /// just made — is still there when the listing lands, rather than
    /// forgotten because the listing was asked for before it existed.
    @Test func whatIsMadeWhileAListingIsOnItsWayStaysListed() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Selects")
        let engine = try await makeEngine(bridge)
        let selects = try await engine.lookup("Selects", in: DriveEngine.rootID)
        await bridge.holdNextListing(of: "/Selects")
        let listing = Task { try await engine.children(of: selects.id) }
        for _ in 0..<400 where await !bridge.isHolding("/Selects") { try await Task.sleep(nanoseconds: 5_000_000) }
        #expect(await bridge.isHolding("/Selects"))
        let cut = try await engine.create("cut.mov", in: selects.id, isDirectory: false)
        let day = try await engine.create("Day 1", in: selects.id, isDirectory: true)
        await bridge.release("/Selects")
        _ = try await listing.value
        #expect(Set(try await engine.children(of: selects.id).map(\.name)) == ["cut.mov", "Day 1"])
        #expect(try await engine.lookup("Day 1", in: selects.id).id == day.id)
        _ = try await engine.write(cut.id, at: 0, data: Data("take".utf8))
        try await engine.finishWriting(cut.id)
        #expect(await bridge.bytes("/Selects/cut.mov") == Data("take".utf8))
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

    /// Opening a zip in Finder: Archive Utility unpacks it in .TemporaryItems,
    /// macOS's own folder, then moves what it unpacked beside the zip. It
    /// becomes the drive's — on the web, folders and all — where before it
    /// stayed on this Mac, and the move took the file system down.
    @Test func whatArchiveUtilityUnpacksBecomesTheDrives() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Shoot")
        await bridge.addFile("/Shoot/Frames.zip", Data("zip".utf8))
        let engine = try await makeEngine(bridge)
        let shoot = try await engine.lookup("Shoot", in: DriveEngine.rootID)
        let temp = try await engine.create(".TemporaryItems", in: DriveEngine.rootID, isDirectory: true)
        let user = try await engine.create("folders.501", in: temp.id, isDirectory: true)
        let frames = try await engine.create("Frames", in: user.id, isDirectory: true)
        let a = try await engine.create("a.jpg", in: frames.id, isDirectory: false)
        _ = try await engine.write(a.id, at: 0, data: Data("first".utf8))
        let day = try await engine.create("Day 2", in: frames.id, isDirectory: true)
        let b = try await engine.create("b.jpg", in: day.id, isDirectory: false)
        _ = try await engine.write(b.id, at: 0, data: Data("second!".utf8))
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") }.isEmpty, "unpacking stays on this Mac")

        let moved = try await engine.rename(frames.id, from: user.id, name: "Frames", to: shoot.id, newName: "Frames", replacing: nil)
        #expect(moved.id == frames.id, "the same item, for the kernel")
        #expect(!moved.localOnly)
        let calls = await bridge.calls.filter { !$0.hasPrefix("list") }
        #expect(calls.contains("mkdir /Shoot/Frames"))
        #expect(calls.contains("mkdir /Shoot/Frames/Day 2"))
        #expect(try await sent(bridge, "/Shoot/Frames/a.jpg", Data("first".utf8)))
        #expect(try await sent(bridge, "/Shoot/Frames/Day 2/b.jpg", Data("second!".utf8)))
        let all = await bridge.calls
        #expect(all.firstIndex(of: "mkdir /Shoot/Frames/Day 2")! < all.firstIndex { $0.hasPrefix("put /Shoot/Frames/Day 2/b.jpg") }!,
                "folders before what is in them")

        // Listed where it went, and gone from where it was unpacked.
        let names = try await engine.children(of: frames.id).map(\.name).sorted()
        #expect(names == ["Day 2", "a.jpg"])
        #expect(try await engine.children(of: user.id).isEmpty)
        let read = try await engine.lookup("a.jpg", in: frames.id)
        #expect(String(decoding: try await engine.read(read.id, at: 0, count: 10), as: UTF8.self) == "first")
    }

    /// Archive Utility now unpacks into a scratch folder of its own beside
    /// the zip (.ArchiveServiceTemp.sb-…): nothing of it reaches the server
    /// until what it unpacked is moved out, and then only that does.
    @Test func archiveServicesScratchFolderStaysHere() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Footage")
        let engine = try await makeEngine(bridge)
        let footage = try await engine.lookup("Footage", in: DriveEngine.rootID)
        let scratch = try await engine.create(".ArchiveServiceTemp.sb-646fd00c-ZqgRoN", in: footage.id, isDirectory: true)
        #expect(scratch.localOnly)
        let sample = try await engine.create("Sample", in: scratch.id, isDirectory: true)
        let a = try await engine.create("a.txt", in: sample.id, isDirectory: false)
        _ = try await engine.write(a.id, at: 0, data: Data("hello".utf8))
        try await engine.finishWriting(a.id)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") }.isEmpty, "unpacking stays on this Mac")
        _ = try await engine.rename(sample.id, from: scratch.id, name: "Sample", to: footage.id, newName: "Sample", replacing: nil)
        try await engine.remove(scratch.id, name: ".ArchiveServiceTemp.sb-646fd00c-ZqgRoN", from: footage.id)
        #expect(try await sent(bridge, "/Footage/Sample/a.txt", Data("hello".utf8)))
        #expect(!(await bridge.calls.contains { $0.contains("ArchiveServiceTemp") }))
        let listed = try await engine.lookup("a.txt", in: sample.id)
        #expect(listed.size == 5)
    }

    /// An app saving safely writes the new copy in .TemporaryItems and swaps
    /// it over the original: the file on the web gets the new bytes, as a new
    /// version of itself.
    @Test func aSafeSaveFromTemporaryItemsReplacesTheFile() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/notes.txt", Data("old".utf8))
        let engine = try await makeEngine(bridge)
        let original = try await engine.lookup("notes.txt", in: DriveEngine.rootID)
        let temp = try await engine.create(".TemporaryItems", in: DriveEngine.rootID, isDirectory: true)
        let copy = try await engine.create("notes.txt", in: temp.id, isDirectory: false)
        _ = try await engine.write(copy.id, at: 0, data: Data("brand new".utf8))
        try await engine.finishWriting(copy.id)
        _ = try await engine.rename(copy.id, from: temp.id, name: "notes.txt", to: DriveEngine.rootID, newName: "notes.txt",
                                    replacing: original.id)
        #expect(try await sent(bridge, "/notes.txt", Data("brand new".utf8)))
        #expect(await bridge.fileID("/notes.txt") == "f1", "the same file on the server, a new version of it")
        let now = try await engine.lookup("notes.txt", in: DriveEngine.rootID)
        #expect(String(decoding: try await engine.read(now.id, at: 0, count: 20), as: UTF8.self) == "brand new")
    }

    /// macOS's own files moving among themselves stay its own, and a real file
    /// still cannot become one.
    @Test func macOSOwnFilesMovingAmongThemselvesStayOnThisMac() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/real.txt", Data("r".utf8))
        let engine = try await makeEngine(bridge)
        let temp = try await engine.create(".TemporaryItems", in: DriveEngine.rootID, isDirectory: true)
        let x = try await engine.create("x", in: temp.id, isDirectory: false)
        _ = try await engine.rename(x.id, from: temp.id, name: "x", to: temp.id, newName: "y", replacing: nil)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") }.isEmpty)
        let real = try await engine.lookup("real.txt", in: DriveEngine.rootID)
        await #expect(throws: VolumeError.posix(EPERM)) {
            _ = try await engine.rename(real.id, from: DriveEngine.rootID, name: "real.txt", to: temp.id, newName: "real.txt", replacing: nil)
        }
    }

    /// The rename answers before what it moved has gone up: a big unpacked
    /// folder does not hold up the app that moved it.
    @Test func aPromotedFolderIsSentAfterTheRenameAnswers() async throws {
        let bridge = FakeBridge()
        let engine = try await makeEngine(bridge)
        let temp = try await engine.create(".TemporaryItems", in: DriveEngine.rootID, isDirectory: true)
        let unpacked = try await engine.create("Unpacked", in: temp.id, isDirectory: true)
        let file = try await engine.create("a.txt", in: unpacked.id, isDirectory: false)
        _ = try await engine.write(file.id, at: 0, data: Data("a".utf8))
        await bridge.holdNextPut()
        let moved = try await engine.rename(unpacked.id, from: temp.id, name: "Unpacked", to: DriveEngine.rootID, newName: "Unpacked", replacing: nil)
        #expect(moved.name == "Unpacked")
        while !(await bridge.isHoldingPut()) { try await Task.sleep(nanoseconds: 1_000_000) }
        // The file reads from here meanwhile, and goes up once let through.
        let a = try await engine.lookup("a.txt", in: unpacked.id)
        #expect(String(decoding: try await engine.read(a.id, at: 0, count: 5), as: UTF8.self) == "a")
        try await engine.remove(temp.id, name: ".TemporaryItems", from: DriveEngine.rootID)
        await bridge.releasePut()
        #expect(try await sent(bridge, "/Unpacked/a.txt", Data("a".utf8)))
    }

    /// The folder something was unpacked in, removed while its folders are
    /// being made on the server: the move is refused, nothing is left half
    /// moved, and the file system stays up.
    @Test func aFolderRemovedWhileItsFoldersAreMadeIsRefusedWhole() async throws {
        let bridge = FakeBridge()
        let engine = try await makeEngine(bridge)
        let temp = try await engine.create(".TemporaryItems", in: DriveEngine.rootID, isDirectory: true)
        let unpacked = try await engine.create("Unpacked", in: temp.id, isDirectory: true)
        let file = try await engine.create("a.txt", in: unpacked.id, isDirectory: false)
        _ = try await engine.write(file.id, at: 0, data: Data("a".utf8))
        await bridge.holdNextMkdir()
        let moving = Task { try await engine.rename(unpacked.id, from: temp.id, name: "Unpacked", to: DriveEngine.rootID, newName: "Unpacked", replacing: nil) }
        while !(await bridge.isHoldingMkdir()) { try await Task.sleep(nanoseconds: 1_000_000) }
        try await engine.remove(temp.id, name: ".TemporaryItems", from: DriveEngine.rootID)
        await bridge.releaseMkdir()
        await #expect(throws: VolumeError.posix(ESTALE)) { _ = try await moving.value }
        #expect(!(await bridge.calls.contains { $0.hasPrefix("put") }), "nothing sent")
        #expect(try await engine.children(of: DriveEngine.rootID).allSatisfy { $0.name != "a.txt" })
    }

    /// macOS's own files inside an unpacked folder stay on this Mac.
    @Test func finderOwnFilesInsideAPromotedFolderStayHere() async throws {
        let bridge = FakeBridge()
        let engine = try await makeEngine(bridge)
        let temp = try await engine.create(".TemporaryItems", in: DriveEngine.rootID, isDirectory: true)
        let unpacked = try await engine.create("Unpacked", in: temp.id, isDirectory: true)
        let store = try await engine.create(".DS_Store", in: unpacked.id, isDirectory: false)
        _ = try await engine.write(store.id, at: 0, data: Data("view".utf8))
        let apple = try await engine.create("._a.txt", in: unpacked.id, isDirectory: false)
        _ = try await engine.write(apple.id, at: 0, data: Data([1]))
        let file = try await engine.create("a.txt", in: unpacked.id, isDirectory: false)
        _ = try await engine.write(file.id, at: 0, data: Data("a".utf8))
        _ = try await engine.rename(unpacked.id, from: temp.id, name: "Unpacked", to: DriveEngine.rootID, newName: "Unpacked", replacing: nil)
        #expect(try await sent(bridge, "/Unpacked/a.txt", Data("a".utf8)))
        #expect(!(await bridge.calls.contains { $0.contains(".DS_Store") || $0.contains("._a.txt") }))
        let kept = try await engine.lookup(".DS_Store", in: unpacked.id)
        #expect(String(decoding: try await engine.read(kept.id, at: 0, count: 10), as: UTF8.self) == "view")
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

    @Test func aLockedFolderRefusesEveryChangeOnAWritableDrive() async throws {
        // The app's Collections folder: the drive's own files shown again.
        let bridge = FakeBridge()
        await bridge.addFolder("/Collections")
        await bridge.addFolder("/Collections/Picks")
        await bridge.addFile("/Collections/Picks/a.mov", Data([1, 2, 3]))
        await bridge.addFile("/b.mov", Data([4]))
        for path in ["/Collections", "/Collections/Picks", "/Collections/Picks/a.mov"] { await bridge.lock(path) }
        let engine = try await makeEngine(bridge)
        let top = try await engine.lookup("Collections", in: DriveEngine.rootID)
        let picks = try await engine.lookup("Picks", in: top.id)
        let a = try await engine.lookup("a.mov", in: picks.id)
        #expect(a.readOnly && picks.readOnly && top.readOnly)

        let refused = VolumeError.posix(EACCES)
        await #expect(throws: refused) { try await engine.create("new.txt", in: picks.id, isDirectory: false) }
        await #expect(throws: refused) { try await engine.create("Sub", in: top.id, isDirectory: true) }
        await #expect(throws: refused) { try await engine.beginWriting(a.id, truncating: true) }
        await #expect(throws: refused) { try await engine.write(a.id, at: 0, data: Data([9])) }
        await #expect(throws: refused) { _ = try await engine.setSize(a.id, to: 0) }
        await #expect(throws: refused) { try await engine.remove(a.id, name: "a.mov", from: picks.id) }
        // Out of it (the real file would move), and into it.
        await #expect(throws: refused) {
            _ = try await engine.rename(a.id, from: picks.id, name: "a.mov", to: DriveEngine.rootID, newName: "a.mov", replacing: nil)
        }
        let b = try await engine.lookup("b.mov", in: DriveEngine.rootID)
        await #expect(throws: refused) {
            _ = try await engine.rename(b.id, from: DriveEngine.rootID, name: "b.mov", to: picks.id, newName: "b.mov", replacing: nil)
        }
        #expect(await bridge.calls.allSatisfy { $0.hasPrefix("list") || $0.hasPrefix("volume") }, "nothing reached the app but listings")
        // Reading still works, and the rest of the drive is writable.
        #expect(try await engine.read(a.id, at: 0, count: 3) == Data([1, 2, 3]))
        _ = try await engine.create("Selects", in: DriveEngine.rootID, isDirectory: true)
        // Finder's own files still land, kept on this Mac.
        _ = try await engine.create(".DS_Store", in: picks.id, isDirectory: false)
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
