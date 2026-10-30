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

    /// What the app was told Archive Utility could not unzip.
    var unzips: [UnzipFailure] = []
    func unzipFailed(_ failure: UnzipFailure) async { unzips.append(failure) }

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

/// `name` in `folder`, marked as a browser marks a download.
private func downloaded(_ engine: DriveEngine, _ name: String, in folder: UInt64) async throws {
    let zip = try await engine.lookup(name, in: folder)
    try await engine.setXattr(named: "com.apple.quarantine", of: zip.id, to: Data("0081;6ada8c8c;Chrome;".utf8),
                              createOnly: false, replaceOnly: false)
}

/// What the app was told, once it has been (the engine tells it after the
/// remove that showed the unzip failed has answered).
private func reported(_ bridge: FakeBridge) async throws -> UnzipFailure? {
    for _ in 0..<500 {
        if let first = await bridge.unzips.first { return first }
        try await Task.sleep(nanoseconds: 2_000_000)
    }
    return nil
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

    /// As rename(2): a folder takes an empty folder's place, never a full
    /// one's — the server's replace would take what it held with it — and a
    /// file and a folder never take each other's. Nothing refused reaches
    /// the server.
    @Test func aFolderReplacesOnlyAnEmptyFolder() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Cut")
        await bridge.addFile("/Cut/a.mov", Data([1]))
        await bridge.addFolder("/Empty")
        await bridge.addFolder("/Full")
        await bridge.addFile("/Full/b.mov", Data([2]))
        await bridge.addFolder("/Junk")
        await bridge.addFile("/notes.txt", Data("n".utf8))
        let engine = try await makeEngine(bridge)
        let root = DriveEngine.rootID
        let cut = try await engine.lookup("Cut", in: root)
        let empty = try await engine.lookup("Empty", in: root)
        let full = try await engine.lookup("Full", in: root)
        let junk = try await engine.lookup("Junk", in: root)
        let notes = try await engine.lookup("notes.txt", in: root)
        _ = try await engine.create(".DS_Store", in: junk.id, isDirectory: false)
        let draft = try await engine.create("draft.txt", in: root, isDirectory: false)
        _ = try await engine.write(draft.id, at: 0, data: Data("d".utf8))

        await #expect(throws: VolumeError.posix(ENOTEMPTY)) {
            _ = try await engine.rename(cut.id, from: root, name: "Cut", to: root, newName: "Full", replacing: full.id)
        }
        // macOS's own files are what a folder holds, as on any disk.
        await #expect(throws: VolumeError.posix(ENOTEMPTY)) {
            _ = try await engine.rename(cut.id, from: root, name: "Cut", to: root, newName: "Junk", replacing: junk.id)
        }
        await #expect(throws: VolumeError.posix(ENOTDIR)) {
            _ = try await engine.rename(cut.id, from: root, name: "Cut", to: root, newName: "notes.txt", replacing: notes.id)
        }
        await #expect(throws: VolumeError.posix(EISDIR)) {
            _ = try await engine.rename(notes.id, from: root, name: "notes.txt", to: root, newName: "Empty", replacing: empty.id)
        }
        // One not on the server yet would have had the folder deleted to make way.
        await #expect(throws: VolumeError.posix(EISDIR)) {
            _ = try await engine.rename(draft.id, from: root, name: "draft.txt", to: root, newName: "Full", replacing: full.id)
        }
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") }.isEmpty)
        #expect(await bridge.bytes("/Full/b.mov") == Data([2]))
        #expect(try await engine.children(of: full.id).map(\.name) == ["b.mov"])

        let moved = try await engine.rename(cut.id, from: root, name: "Cut", to: root, newName: "Empty", replacing: empty.id)
        #expect(moved.id == cut.id)
        #expect(try await engine.lookup("Empty", in: root).id == cut.id)
        // Its own name in another case is no folder in the way, full as it is.
        _ = try await engine.rename(cut.id, from: root, name: "Empty", to: root, newName: "EMPTY", replacing: cut.id)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") } == [
            "rename /Cut -> /Empty (replace)", "rename /Empty -> /EMPTY",
        ])
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

    /// Archive Utility cannot unzip a zip from the internet on a drive. It
    /// claims the result's name beside the zip, unpacks into its scratch
    /// folder there, and throws it all away (Error 1), deepest first: the
    /// app is told which folder, which zips, what was unpacked, and the
    /// placeholder — named, not removed, since Archive Utility removes its own.
    @Test func anUnzipArchiveUtilityThrewAwayIsReported() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Footage")
        await bridge.addFile("/Footage/c4.zip", Data("zip".utf8))
        await bridge.addFile("/Footage/plain.zip", Data("zip".utf8))
        let engine = try await makeEngine(bridge)
        let footage = try await engine.lookup("Footage", in: DriveEngine.rootID)
        try await downloaded(engine, "c4.zip", in: footage.id)

        let scratch = try await engine.create(".ArchiveServiceTemp.sb-4f3493ac-pKpKhG", in: footage.id, isDirectory: true)
        _ = try await engine.create("Walmart Ad Videos", in: footage.id, isDirectory: true)
        // The person's own, made meanwhile: not Archive Utility's.
        _ = try await engine.create("untitled folder", in: footage.id, isDirectory: true)
        let unpacked = try await engine.create("Walmart Ad Videos", in: scratch.id, isDirectory: true)
        let video = try await engine.create("a.mp4", in: unpacked.id, isDirectory: false)
        _ = try await engine.write(video.id, at: 0, data: Data("frames".utf8))
        try await engine.finishWriting(video.id)
        try await engine.remove(video.id, name: "a.mp4", from: unpacked.id)
        try await engine.remove(unpacked.id, name: "Walmart Ad Videos", from: scratch.id)
        try await engine.remove(scratch.id, name: ".ArchiveServiceTemp.sb-4f3493ac-pKpKhG", from: footage.id)

        #expect(try await reported(bridge) == UnzipFailure(folder: "/Footage", zips: ["c4.zip"], unpacked: ["Walmart Ad Videos"],
                                                            unpackedCount: 1, placeholders: ["Walmart Ad Videos"]))
        #expect(!(await bridge.calls.contains { $0.hasPrefix("delete") }), "Archive Utility removes its placeholder itself")
    }

    /// A zip of one file: its placeholder is an empty file, numbered past
    /// one already there ("solo 2.txt").
    @Test func aOneFileZipsPlaceholderIsAnEmptyFile() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/solo.txt", Data("solo".utf8))
        await bridge.addFile("/solo.zip", Data("zip".utf8))
        let engine = try await makeEngine(bridge)
        try await downloaded(engine, "solo.zip", in: DriveEngine.rootID)
        let scratch = try await engine.create(".ArchiveServiceTemp.sb-4f3493ac-iEug2D", in: DriveEngine.rootID, isDirectory: true)
        let placeholder = try await engine.create("solo 2.txt", in: DriveEngine.rootID, isDirectory: false)
        try await engine.finishWriting(placeholder.id)
        let unpacked = try await engine.create("solo.txt", in: scratch.id, isDirectory: false)
        try await engine.remove(unpacked.id, name: "solo.txt", from: scratch.id)
        try await engine.remove(scratch.id, name: ".ArchiveServiceTemp.sb-4f3493ac-iEug2D", from: DriveEngine.rootID)
        #expect(try await reported(bridge) == UnzipFailure(folder: "/", zips: ["solo.zip"], unpacked: ["solo.txt"],
                                                            unpackedCount: 1, placeholders: ["solo 2.txt"]))
    }

    /// The same unzip where it works: what was unpacked moves out into the
    /// placeholder before the scratch folder goes. Nothing to tell.
    @Test func anUnzipThatWorkedIsNotReported() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Footage")
        await bridge.addFile("/Footage/c4.zip", Data("zip".utf8))
        let engine = try await makeEngine(bridge)
        let footage = try await engine.lookup("Footage", in: DriveEngine.rootID)
        try await downloaded(engine, "c4.zip", in: footage.id)
        let scratch = try await engine.create(".ArchiveServiceTemp.sb-4f3493ac-Gr7u5e", in: footage.id, isDirectory: true)
        let placeholder = try await engine.create("Walmart Ad Videos", in: footage.id, isDirectory: true)
        let unpacked = try await engine.create("Walmart Ad Videos", in: scratch.id, isDirectory: true)
        let video = try await engine.create("a.mp4", in: unpacked.id, isDirectory: false)
        _ = try await engine.write(video.id, at: 0, data: Data("frames".utf8))
        try await engine.finishWriting(video.id)
        _ = try await engine.rename(video.id, from: unpacked.id, name: "a.mp4", to: placeholder.id, newName: "a.mp4", replacing: nil)
        try await engine.remove(unpacked.id, name: "Walmart Ad Videos", from: scratch.id)
        try await engine.remove(scratch.id, name: ".ArchiveServiceTemp.sb-4f3493ac-Gr7u5e", from: footage.id)
        #expect(try await sent(bridge, "/Footage/Walmart Ad Videos/a.mp4", Data("frames".utf8)))
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(await bridge.unzips.isEmpty)
    }

    /// Archive Utility can unzip a zip from no browser here: one it threw
    /// away (cancelled, say) is its own business.
    @Test func anUnzipOfAZipFromNoBrowserIsNotReported() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/c4.zip", Data("zip".utf8))
        let engine = try await makeEngine(bridge)
        let scratch = try await engine.create(".ArchiveServiceTemp.sb-4f3493ac-8AIyqc", in: DriveEngine.rootID, isDirectory: true)
        let unpacked = try await engine.create("a.txt", in: scratch.id, isDirectory: false)
        try await engine.remove(unpacked.id, name: "a.txt", from: scratch.id)
        try await engine.remove(scratch.id, name: ".ArchiveServiceTemp.sb-4f3493ac-8AIyqc", from: DriveEngine.rootID)
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(await bridge.unzips.isEmpty)
    }

    @Test func archiveUtilitysNumbersComeOff() {
        #expect(DriveEngine.unnumbered("Footage 2", isDirectory: true) == "Footage")
        #expect(DriveEngine.unnumbered("notes 12.txt", isDirectory: false) == "notes.txt")
        #expect(DriveEngine.unnumbered("v1.2 3", isDirectory: true) == "v1.2")
        #expect(DriveEngine.unnumbered("Take 2a", isDirectory: true) == "Take 2a")
        #expect(DriveEngine.unnumbered("2", isDirectory: true) == "2")
        #expect(DriveEngine.unnumbered("Footage", isDirectory: true) == "Footage")
    }

    /// rmdir takes an empty folder only. The kernel leaves it to the file
    /// system, and the server's delete takes a folder whole, so `rmdir` on a
    /// folder with files in it took them all.
    @Test func aFolderWithSomethingInItIsNotRemoved() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Shoot")
        await bridge.addFile("/Shoot/a.mov", Data("frames".utf8))
        let engine = try await makeEngine(bridge)
        let shoot = try await engine.lookup("Shoot", in: DriveEngine.rootID)
        await #expect(throws: VolumeError.posix(ENOTEMPTY)) {
            try await engine.remove(shoot.id, name: "Shoot", from: DriveEngine.rootID)
        }
        #expect(!(await bridge.calls.contains { $0.hasPrefix("delete") }))
        #expect(try await engine.lookup("a.mov", in: shoot.id).size == 6)
        // macOS's own files count as on any disk; emptied, as Finder empties
        // one, it goes.
        let ds = try await engine.create(".DS_Store", in: shoot.id, isDirectory: false)
        try await engine.remove(try await engine.lookup("a.mov", in: shoot.id).id, name: "a.mov", from: shoot.id)
        await #expect(throws: VolumeError.posix(ENOTEMPTY)) {
            try await engine.remove(shoot.id, name: "Shoot", from: DriveEngine.rootID)
        }
        try await engine.remove(ds.id, name: ".DS_Store", from: shoot.id)
        try await engine.remove(shoot.id, name: "Shoot", from: DriveEngine.rootID)
        #expect(await bridge.calls.contains("delete /Shoot"))
    }

    /// Archive Utility's helper makes a scratch folder (.AU.…) and renames it
    /// to .AU.….nosync. Made on the server, the rename was refused (a real
    /// folder cannot become this Mac's) and the folder stayed on the web.
    @Test func archiveUtilitysHelperScratchStaysHere() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Shoot")
        let engine = try await makeEngine(bridge)
        let shoot = try await engine.lookup("Shoot", in: DriveEngine.rootID)
        let scratch = try await engine.create(".AU.9g2qX", in: shoot.id, isDirectory: true)
        #expect(scratch.localOnly)
        let renamed = try await engine.rename(scratch.id, from: shoot.id, name: ".AU.9g2qX", to: shoot.id,
                                              newName: ".AU.9g2qX.nosync", replacing: nil)
        #expect(renamed.localOnly)
        try await engine.remove(renamed.id, name: ".AU.9g2qX.nosync", from: shoot.id)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") }.isEmpty, "nothing of it reaches the server")
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

    /// The same save from deeper in, as NSDocument makes it on a disk that
    /// has an item replacement folder (/.TemporaryItems/folders.<uid>/…):
    /// the copy is macOS's only for where it sits, its name is the
    /// document's, and it may still be open when it is moved over the
    /// document. Its bytes go up to the document's path — the same file, a
    /// new version of it — nothing is deleted or sent from .TemporaryItems,
    /// and the web's next listing does not make it macOS's again.
    @Test func aSafeSaveFromDeepInTemporaryItemsReachesTheWebOpenOrClosed() async throws {
        for closedFirst in [false, true] {
            let bridge = FakeBridge()
            await bridge.addFile("/Report.rtf", Data("old".utf8))
            let engine = try await makeEngine(bridge)
            let document = try await engine.lookup("Report.rtf", in: DriveEngine.rootID)
            let temp = try await engine.create(".TemporaryItems", in: DriveEngine.rootID, isDirectory: true)
            let user = try await engine.create("folders.501", in: temp.id, isDirectory: true)
            let copy = try await engine.create("Report.rtf", in: user.id, isDirectory: false)
            #expect(copy.localOnly && copy.hidden, "macOS's, for where it sits")
            let saved = Data("{\\rtf1 new}".utf8)
            try await engine.beginWriting(copy.id, truncating: false)
            _ = try await engine.write(copy.id, at: 0, data: saved)
            if closedFirst { try await engine.finishWriting(copy.id) }
            let moved = try await engine.rename(copy.id, from: user.id, name: "Report.rtf", to: DriveEngine.rootID,
                                                newName: "Report.rtf", replacing: document.id)
            #expect(!moved.localOnly && !moved.hidden, "the drive's now, and shown")
            if !closedFirst { try await engine.finishWriting(copy.id) }
            #expect(try await sent(bridge, "/Report.rtf", saved))
            #expect(await bridge.fileID("/Report.rtf") == "f1", "the same file on the server, a new version of it")
            #expect(await bridge.calls.filter { !$0.hasPrefix("list") } == ["put /Report.rtf \(saved.count)"],
                    "nothing deleted, and nothing sent from .TemporaryItems")

            await engine.apply(BridgeChanges(generation: 1, paths: ["/"]))
            let listed = try await engine.lookup("Report.rtf", in: DriveEngine.rootID)
            #expect(listed.id == copy.id && !listed.localOnly)
            #expect(try await engine.read(listed.id, at: 0, count: 64) == saved)
            #expect(try await engine.children(of: user.id).isEmpty)
        }
    }

    /// TextEdit saving on a drive, as watched on one (0.5.27, where every
    /// such save failed): a sandboxed app's NSDocument, with no item
    /// replacement folder on the disk and no swap, writes its copy into
    /// "<name>.sb-…" beside the document, renames the document to another
    /// "<name>.sb-…", moves the copy into its place, and removes the one set
    /// aside and the folder. The server is asked for one thing — the copy,
    /// put to the document's path: the same file, a new version of it — and
    /// the listing the copy sets off meanwhile, which still has the document
    /// where it was, does not bring its name back.
    @Test func aSandboxedAppsSaveIsANewVersionOfTheDocument() async throws {
        let bridge = FakeBridge()
        await bridge.addFolder("/Docs")
        await bridge.addFile("/Docs/Report.rtf", Data("old".utf8))
        let engine = try await makeEngine(bridge)
        let docs = try await engine.lookup("Docs", in: DriveEngine.rootID)
        let document = try await engine.lookup("Report.rtf", in: docs.id)

        let saving = try await engine.create("Report.rtf.sb-d22dcccc-3mKm0y", in: docs.id, isDirectory: true)
        #expect(saving.localOnly, "the copy's folder is this Mac's")
        let copy = try await engine.create("Report.rtf", in: saving.id, isDirectory: false)
        let saved = Data("{\\rtf1 new}".utf8)
        try await engine.beginWriting(copy.id, truncating: false)
        _ = try await engine.write(copy.id, at: 0, data: saved)
        try await engine.finishWriting(copy.id)

        let aside = try await engine.rename(document.id, from: docs.id, name: "Report.rtf", to: docs.id,
                                            newName: "Report.rtf.sb-d22dcccc-MMh3N9", replacing: nil)
        #expect(aside.id == document.id && aside.hidden)
        #expect(try await engine.read(aside.id, at: 0, count: 10) == Data("old".utf8), "still the server's bytes")
        await engine.apply(BridgeChanges(generation: 1, paths: ["/Docs"]))
        await #expect(throws: VolumeError.posix(ENOENT)) { try await engine.lookup("Report.rtf", in: docs.id) }

        let moved = try await engine.rename(copy.id, from: saving.id, name: "Report.rtf", to: docs.id,
                                            newName: "Report.rtf", replacing: nil)
        #expect(!moved.localOnly)
        try await engine.remove(aside.id, name: "Report.rtf.sb-d22dcccc-MMh3N9", from: docs.id)
        try await engine.remove(saving.id, name: "Report.rtf.sb-d22dcccc-3mKm0y", from: docs.id)

        #expect(try await sent(bridge, "/Docs/Report.rtf", saved))
        #expect(await bridge.fileID("/Docs/Report.rtf") == "f1", "the same file on the server, a new version of it")
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") } == ["put /Docs/Report.rtf \(saved.count)"],
                "no folder made, nothing renamed or trashed on the server")
        #expect(try await engine.children(of: docs.id).map(\.name) == ["Report.rtf"])
        let now = try await engine.lookup("Report.rtf", in: docs.id)
        #expect(now.id == copy.id && !now.hidden)
        #expect(try await engine.read(now.id, at: 0, count: 64) == saved)
    }

    /// What made every such save fail on 0.5.27: the copy's upload sets off
    /// a listing of the folder, which comes back with the document still
    /// under its name just as the document is set aside. Merged after it,
    /// that listing put the old name back and lost what was set aside: the
    /// copy could not be moved in (EEXIST), nor the document put back.
    @Test func aListingOnItsWayWhileTheDocumentIsSetAsideChangesNothing() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/Report.rtf", Data("old".utf8))
        let engine = try await makeEngine(bridge)
        let document = try await engine.lookup("Report.rtf", in: DriveEngine.rootID)
        let saving = try await engine.create("Report.rtf.sb-d22dcccc-3mKm0y", in: DriveEngine.rootID, isDirectory: true)
        let copy = try await engine.create("Report.rtf", in: saving.id, isDirectory: false)
        _ = try await engine.write(copy.id, at: 0, data: Data("new".utf8))
        try await engine.finishWriting(copy.id)

        await bridge.holdNextListing(of: "/")
        let listing = Task { await engine.apply(BridgeChanges(generation: 1, paths: ["/"])) }
        while !(await bridge.isHolding("/")) { try await Task.sleep(nanoseconds: 1_000_000) }
        let aside = try await engine.rename(document.id, from: DriveEngine.rootID, name: "Report.rtf", to: DriveEngine.rootID,
                                            newName: "Report.rtf.sb-d22dcccc-MMh3N9", replacing: nil)
        await bridge.release("/")
        await listing.value

        _ = try await engine.rename(copy.id, from: saving.id, name: "Report.rtf", to: DriveEngine.rootID,
                                    newName: "Report.rtf", replacing: nil)
        try await engine.remove(aside.id, name: "Report.rtf.sb-d22dcccc-MMh3N9", from: DriveEngine.rootID)
        #expect(try await sent(bridge, "/Report.rtf", Data("new".utf8)))
        #expect(await bridge.fileID("/Report.rtf") == "f1")
    }

    /// The same save failing once the document is set aside: NSFileManager
    /// puts it back. Nothing reached the server, and the document is as it
    /// was, under its id.
    @Test func aSafeSaveThatFailsPutsTheDocumentBackAsItWas() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/Report.rtf", Data("old".utf8))
        let engine = try await makeEngine(bridge)
        let document = try await engine.lookup("Report.rtf", in: DriveEngine.rootID)
        let aside = try await engine.rename(document.id, from: DriveEngine.rootID, name: "Report.rtf", to: DriveEngine.rootID,
                                            newName: "Report.rtf.sb-d22dcccc-MMh3N9", replacing: nil)
        let back = try await engine.rename(aside.id, from: DriveEngine.rootID, name: "Report.rtf.sb-d22dcccc-MMh3N9",
                                           to: DriveEngine.rootID, newName: "Report.rtf", replacing: nil)
        #expect(back.id == document.id && !back.localOnly)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") }.isEmpty)
        await engine.apply(BridgeChanges(generation: 1, paths: ["/"]))
        #expect(try await engine.lookup("Report.rtf", in: DriveEngine.rootID).id == document.id)
        #expect(try await engine.read(document.id, at: 0, count: 10) == Data("old".utf8))
        #expect(try await engine.children(of: DriveEngine.rootID).filter { !$0.hidden }.map(\.name) == ["Report.rtf"])
    }

    /// Set aside and removed, with nothing moved into its place: the
    /// document is removed (to the web's trash), as on any disk. One with
    /// changes still on their way to the server is not set aside at all.
    @Test func aDocumentSetAsideAndRemovedIsRemoved() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/Report.rtf", Data("old".utf8))
        await bridge.addFile("/Notes.txt", Data("n".utf8))
        let engine = try await makeEngine(bridge)
        let document = try await engine.lookup("Report.rtf", in: DriveEngine.rootID)
        let aside = try await engine.rename(document.id, from: DriveEngine.rootID, name: "Report.rtf", to: DriveEngine.rootID,
                                            newName: "Report.rtf.sb-d22dcccc-MMh3N9", replacing: nil)
        try await engine.remove(aside.id, name: "Report.rtf.sb-d22dcccc-MMh3N9", from: DriveEngine.rootID)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") } == ["delete /Report.rtf"])

        let notes = try await engine.lookup("Notes.txt", in: DriveEngine.rootID)
        try await engine.beginWriting(notes.id, truncating: true)
        _ = try await engine.write(notes.id, at: 0, data: Data("unsent".utf8))
        await #expect(throws: VolumeError.posix(EBUSY)) {
            _ = try await engine.rename(notes.id, from: DriveEngine.rootID, name: "Notes.txt", to: DriveEngine.rootID,
                                        newName: "Notes.txt.sb-0badf00d-a1B2c3", replacing: nil)
        }
        #expect(try await engine.lookup("Notes.txt", in: DriveEngine.rootID).id == notes.id)
    }

    /// What a save left on the server under a safe save's name before this
    /// (0.5.27 left the document so) is the drive's: listed, and renamed
    /// back by the server. A folder — a package document — set aside is the
    /// server's rename too, as it always was.
    @Test func safeSaveNamesTheServerHasStayTheDrives() async throws {
        let bridge = FakeBridge()
        await bridge.addFile("/Report.rtf.sb-d22dcccc-MMh3N9", Data("old".utf8))
        await bridge.addFolder("/Letter.rtfd")
        let engine = try await makeEngine(bridge)
        let left = try await engine.lookup("Report.rtf.sb-d22dcccc-MMh3N9", in: DriveEngine.rootID)
        #expect(!left.localOnly && !left.hidden)
        _ = try await engine.rename(left.id, from: DriveEngine.rootID, name: "Report.rtf.sb-d22dcccc-MMh3N9", to: DriveEngine.rootID,
                                    newName: "Report.rtf", replacing: nil)
        let package = try await engine.lookup("Letter.rtfd", in: DriveEngine.rootID)
        _ = try await engine.rename(package.id, from: DriveEngine.rootID, name: "Letter.rtfd", to: DriveEngine.rootID,
                                    newName: "Letter.rtfd.sb-d22dcccc-Qw3rTy", replacing: nil)
        #expect(await bridge.calls.filter { !$0.hasPrefix("list") } == [
            "rename /Report.rtf.sb-d22dcccc-MMh3N9 -> /Report.rtf", "rename /Letter.rtfd -> /Letter.rtfd.sb-d22dcccc-Qw3rTy",
        ])
        #expect(LocalOnly.isSafeSave("Report.rtf.sb-d22dcccc-3mKm0y"))
        #expect(!LocalOnly.isSafeSave("Report.sb-d22dcccc-3mKm0") && !LocalOnly.isSafeSave(".sb-d22dcccc-3mKm0y")
                && !LocalOnly.isSafeSave("Report.rtf.sb-D22DCCCC-3mKm0y") && !LocalOnly.isSafeSave("Report.rtf.sb-d22dcccc_3mKm0y"))
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
        // Emptied first, as any removal of a folder is (rmdir takes no other).
        try await engine.remove(file.id, name: "a.txt", from: unpacked.id)
        try await engine.remove(unpacked.id, name: "Unpacked", from: temp.id)
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
