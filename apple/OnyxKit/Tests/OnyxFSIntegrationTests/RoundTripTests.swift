import Foundation
import Testing
@testable import OnyxFSCore
@testable import OnyxKit

/// A drive mounted end to end, minus FSKit and the socket: the extension's
/// engine (DriveEngine over ClientBridge, FSBridgeClient, FileReader and a
/// ChunkStore) talking to the app's bridge (FSBridge, FSResponder), with a
/// pretend drive and server behind it. Each half has tests of its own
/// against its reading of ONYXFS.md; these are where the two readings meet.
@Suite struct RoundTripTests {
    static let scope = "drive.d1"

    @Test func aMountedDriveListsReadsAndStreams() async throws {
        let server = Server()
        let take = Pattern.bytes(3 << 20)
        try await server.add("/Footage/Take 1.mov", take)
        let readme = try await server.add("/Readme.md", Data("hello".utf8))
        let mount = try await Mount(server)
        defer { mount.remove() }
        // Kept offline on this Mac: read from its copy there, through the app
        // (bytes of its own here, so a read from storage would show).
        try await mount.drive.keep(readme, Data("local".utf8), in: mount.dir)

        let engine = mount.engine
        let top = try await engine.children(of: DriveEngine.rootID)
        #expect(Set(top.map(\.name)) == ["Footage", "Readme.md", ".metadata_never_index", "com.apple.timemachine.donotpresent"])
        let footage = try await engine.lookup("footage", in: DriveEngine.rootID)
        let file = try await engine.lookup("TAKE 1.MOV", in: footage.id)
        #expect(file.size == UInt64(take.count))

        // Read as a player does: a megabyte at a time, from storage by link.
        var read = Data()
        while read.count < take.count {
            read.append(try await engine.read(file.id, at: Int64(read.count), count: 1 << 20))
        }
        #expect(read == take)
        let local = try await engine.lookup("Readme.md", in: DriveEngine.rootID)
        #expect(try await engine.read(local.id, at: 0, count: 100) == Data("local".utf8))
    }

    /// The Activity window's figures end to end: what the engine read and
    /// wrote, and what its client fetched from storage, reach the app for
    /// this drive about a second later (TransferMeter → POST /fs/v1/activity).
    @Test func whatADiskMovesReachesTheApp() async throws {
        let server = Server()
        let take = Pattern.bytes(3 << 20)
        try await server.add("/Take 1.mov", take)
        let mount = try await Mount(server)
        defer { mount.remove() }
        let heard = Tally()
        mount.app.onActivity { scope, moved in heard.add(scope, moved) }

        let engine = mount.engine
        let file = try await engine.lookup("Take 1.mov", in: DriveEngine.rootID)
        var read = 0
        while read < take.count {
            read += try await engine.read(file.id, at: Int64(read), count: 1 << 20).count
        }
        let notes = try await engine.create("Notes.txt", in: DriveEngine.rootID, isDirectory: false)
        try await engine.beginWriting(notes.id, truncating: false)
        _ = try await engine.write(notes.id, at: 0, data: Data("hello world".utf8))
        try await engine.finishWriting(notes.id)

        let expected = FSActivity(read: Int64(take.count), download: Int64(take.count), write: 11)
        let deadline = ContinuousClock.now + .seconds(5)
        while heard.total != expected, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(heard.total == expected)
        #expect(heard.scopes == [Self.scope])
    }

    @Test func theDrivesIconIsOnTheDisk() async throws {
        let server = Server()
        try await server.add("/Readme.md", Data("hello".utf8))
        let icns = try #require(DriveIcon.icns(color: "#22D3EE", name: "Client Deliverables"))
        let mount = try await Mount(server, icon: icns)
        defer { mount.remove() }
        let engine = mount.engine

        let top = try await engine.children(of: DriveEngine.rootID)
        #expect(Set(top.map(\.name)) == ["Readme.md", ".metadata_never_index", "com.apple.timemachine.donotpresent",
                                         ".VolumeIcon.icns", "._."])
        let icon = try await engine.lookup(".VolumeIcon.icns", in: DriveEngine.rootID)
        #expect(icon.hidden && icon.size == UInt64(icns.count))
        #expect(try await engine.read(icon.id, at: 0, count: icns.count + 1) == icns)
        let root = try await engine.lookup("._.", in: DriveEngine.rootID)
        #expect(root.hidden)
        #expect(AppleDouble.finderFlags(of: try await engine.read(root.id, at: 0, count: 8192)) == AppleDouble.hasCustomIcon)
        #expect(await server.calls.isEmpty, "none of it reaches the server")

        // A drive with no icon mounts as it did.
        let plain = try await Mount(Server())
        defer { plain.remove() }
        #expect(!(try await plain.engine.children(of: DriveEngine.rootID).map(\.name).contains(".VolumeIcon.icns")))
    }

    @Test func findersChangesReachTheServerAndComeBack() async throws {
        let server = Server()
        let readme = try await server.add("/Readme.md", Data("version one".utf8))
        let mount = try await Mount(server)
        defer { mount.remove() }
        let engine = mount.engine

        // Copied in.
        let cut = try await engine.create("Cut.mov", in: DriveEngine.rootID, isDirectory: false)
        try await engine.beginWriting(cut.id, truncating: false)
        _ = try await engine.write(cut.id, at: 0, data: Data("hello ".utf8))
        _ = try await engine.write(cut.id, at: 6, data: Data("world".utf8))
        try await engine.finishWriting(cut.id)
        #expect(await server.calls == ["write /Cut.mov 11"])
        #expect(try await engine.read(cut.id, at: 0, count: 50) == Data("hello world".utf8))

        // Saved over: the same file on the server, new bytes.
        let doc = try await engine.lookup("Readme.md", in: DriveEngine.rootID)
        try await engine.beginWriting(doc.id, truncating: true)
        _ = try await engine.write(doc.id, at: 0, data: Data("v2".utf8))
        try await engine.finishWriting(doc.id)
        #expect(await server.calls.last == "write /Readme.md 2")
        #expect(await server.file(at: "/Readme.md")?.id == readme)
        #expect(try await engine.read(doc.id, at: 0, count: 50) == Data("v2".utf8))

        // A folder, a move into it, a delete.
        let selects = try await engine.create("Selects", in: DriveEngine.rootID, isDirectory: true)
        _ = try await engine.rename(cut.id, from: DriveEngine.rootID, name: "Cut.mov", to: selects.id,
                                    newName: "Cut.mov", replacing: nil)
        try await engine.remove(doc.id, name: "Readme.md", from: DriveEngine.rootID)
        #expect(await server.calls.suffix(3) == ["mkdir /Selects", "move /Cut.mov -> /Selects/Cut.mov", "remove /Readme.md"])
        #expect(try await engine.children(of: selects.id).map(\.name) == ["Cut.mov"])
        #expect(try await engine.read(cut.id, at: 6, count: 50) == Data("world".utf8))
    }

    /// A folder from Frame.io Drive named with a space at its end, copied in
    /// by Finder. The server keeps names without one (as `Server` does here),
    /// so the disk makes it without one, and Finder, which goes on asking for
    /// it with the space, finds it — and what it copies into it.
    @Test func aFolderWhoseNameEndsInASpaceIsCopiedIn() async throws {
        let server = Server()
        let mount = try await Mount(server)
        defer { mount.remove() }
        let engine = mount.engine
        let made = try await engine.create("0065_Enraged:PaidMedia ", in: DriveEngine.rootID, isDirectory: true)
        #expect(made.name == "0065_Enraged:PaidMedia")
        let folder = try await engine.lookup("0065_Enraged:PaidMedia ", in: DriveEngine.rootID)
        #expect(folder.id == made.id)
        let cut = try await engine.create("cut.mov ", in: folder.id, isDirectory: false)
        try await engine.beginWriting(cut.id, truncating: false)
        _ = try await engine.write(cut.id, at: 0, data: Data("frames".utf8))
        try await engine.finishWriting(cut.id)
        #expect(await server.calls == ["mkdir /0065_Enraged:PaidMedia", "write /0065_Enraged:PaidMedia/cut.mov 6"])
        #expect(try await engine.children(of: folder.id).map(\.name) == ["cut.mov"])
        #expect(try await engine.read(cut.id, at: 0, count: 50) == Data("frames".utf8))
    }

    /// A viewer's drive: the engine refuses before asking, and the bridge
    /// refuses whoever asks anyway.
    @Test func aViewersDriveIsReadOnlyAllTheWay() async throws {
        let server = Server()
        try await server.add("/Readme.md", Data("hello".utf8))
        let mount = try await Mount(server, readOnly: true)
        defer { mount.remove() }
        #expect(await mount.engine.readOnly)
        await #expect(throws: VolumeError.posix(EACCES)) {
            _ = try await mount.engine.create("x.txt", in: DriveEngine.rootID, isDirectory: false)
        }
        await #expect(throws: BridgeFailure.self) { _ = try await mount.bridge.mkdir("/Selects") }
        #expect(await server.calls.isEmpty)
    }

    @Test func aChangeOnTheWebReachesTheEngine() async throws {
        let server = Server()
        try await server.add("/Footage/a.mov", Data([1]))
        let mount = try await Mount(server)
        defer { mount.remove() }
        let engine = mount.engine
        let footage = try await engine.lookup("Footage", in: DriveEngine.rootID)
        #expect(try await engine.children(of: footage.id).map(\.name) == ["a.mov"])
        let heard = Heard()
        await engine.observeChanges { ids, all in Task { await heard.add(ids, all) } }
        try await Task.sleep(for: .milliseconds(50)) // the long poll is waiting
        try await server.add("/Footage/b.mov", Data([2]))
        for _ in 0..<400 where await !heard.ids.contains(footage.id) { try await Task.sleep(for: .milliseconds(5)) }
        #expect(await heard.ids.contains(footage.id))
        #expect(try await engine.children(of: footage.id).map(\.name) == ["a.mov", "b.mov"])
        await engine.shutdown()
    }

    /// Unmounted by the app (or the app quit): the engine's calls fail
    /// rather than hang, and nothing is shown that was not there.
    @Test func anUnmountedDriveAnswersNoMore() async throws {
        let server = Server()
        try await server.add("/Footage/a.mov", Data([1]))
        let mount = try await Mount(server)
        defer { mount.remove() }
        mount.app.end(scope: Self.scope)
        await #expect(throws: BridgeFailure.disconnected) { _ = try await mount.bridge.list("/Footage") }
        await #expect(throws: VolumeError.self) { _ = try await mount.engine.lookup("Footage", in: DriveEngine.rootID) }
    }
}

// MARK: - The pieces

/// What the app heard from its disks: the sum, and for which drives.
final class Tally: @unchecked Sendable {
    private let lock = NSLock()
    private var sum = FSActivity()
    private var heardFrom: Set<String> = []

    func add(_ scope: String, _ moved: FSActivity) {
        lock.withLock {
            sum.read += moved.read
            sum.download += moved.download
            sum.write += moved.write
            heardFrom.insert(scope)
        }
    }

    var total: FSActivity { lock.withLock { sum } }
    var scopes: Set<String> { lock.withLock { heardFrom } }
}

/// One drive mounted: the app's bridge serving `server`'s drive, and the
/// extension's engine connected to it with a real ticket.
struct Mount {
    let app: FSBridge
    let drive: Drive
    let bridge: ClientBridge
    let engine: DriveEngine
    let dir: URL
    let port: Int

    init(_ server: Server, readOnly: Bool = false, icon: Data? = nil) async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("onyxfs-rt-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        drive = Drive(readOnly: readOnly, icon: icon)
        await server.attach(drive)
        app = FSBridge()
        app.register(FSResponder(scope: RoundTripTests.scope, source: drive, firstGeneration: 1_000))
        app.setWriter(server, for: RoundTripTests.scope)
        port = Loopback.serve(app, spool: dir.appendingPathComponent("spool"))

        let ticket = app.sessions.issueTicket(for: RoundTripTests.scope)
        let url = URL(string: "onyxfs-drive://127.0.0.1:\(port)/\(RoundTripTests.scope)?ticket=\(ticket)&name=Client%20Deliverables&v=1")!
        let client = try await FSBridgeClient.connect(to: try FSMountResource(url: url), configuration: Loopback.configuration)
        let store = try ChunkStore(directory: dir.appendingPathComponent("chunks"), limitBytes: client.session.cacheLimitBytes)
        let local = try LocalStore(directory: dir.appendingPathComponent("local"))
        // As EngineFactory does, before anything is listed.
        if let icon = try await client.volumeIcon() { try await local.placeVolumeIcon(icon) }
        bridge = ClientBridge(client: client, store: store)
        engine = DriveEngine(bridge: bridge, volume: bridge.initialVolume,
                             staging: try StagingArea(directory: dir.appendingPathComponent("staging")),
                             local: local)
    }

    func remove() {
        Loopback.stop(port)
        try? FileManager.default.removeItem(at: dir)
    }
}

/// The drive as the app sees it (the mirror's part): what the server has,
/// what is kept offline here, and where storage has the bytes.
actor Drive: OnyxKit.FSSource {
    private var revision: UInt64 = 1
    private var index = MirrorIndex(Replica())
    private var info: OnyxKit.FSVolumeInfo
    private var kept: [String: URL] = [:]
    private let icon: Data?

    init(readOnly: Bool, icon: Data? = nil) {
        info = OnyxKit.FSVolumeInfo(name: "Client Deliverables", readOnly: readOnly, cacheLimitBytes: 0)
        self.icon = icon
    }

    func volumeIcon() -> Data? { icon }

    func show(_ index: MirrorIndex) {
        self.index = index
        revision += 1
    }

    func keep(_ id: String, _ bytes: Data, in dir: URL) throws {
        let copy = dir.appendingPathComponent("kept-\(id)")
        try bytes.write(to: copy)
        kept[id] = copy
        revision += 1
    }

    func snapshot() -> FSSnapshot { FSSnapshot(revision: revision, index: index) }

    func waitForChange(after seen: UInt64, timeout: Duration) async {
        let deadline = ContinuousClock.now + timeout
        while revision <= seen, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(2))
        }
    }

    func keptOffline(_ entries: [MirrorEntry]) -> Set<String> {
        Set(entries.compactMap(\.fileId)).intersection(kept.keys)
    }

    func localCopy(of entry: MirrorEntry) -> URL? { entry.fileId.flatMap { kept[$0] } }

    func remoteLink(for entry: MirrorEntry) throws -> FSRemoteLink {
        FSRemoteLink(url: URL(string: "https://storage.test\(Server.object(entry.fileId ?? "", entry.etag ?? ""))")!,
                     expiresAt: Date().addingTimeInterval(3_600))
    }

    func volumeInfo() -> OnyxKit.FSVolumeInfo { info }
}

/// The server, as the drive's writer reaches it: every change made at
/// once and shown in the drive, bytes kept in storage by file and version.
actor Server: FSWriteTarget {
    static let t0: Int64 = 1_790_000_000_000
    private var files: [FileItem] = []
    private var folders: [String] = []
    private(set) var calls: [String] = []
    private var drive: Drive?
    private var made = 0
    private var clock = t0

    func attach(_ drive: Drive) async {
        self.drive = drive
        await publish()
    }

    /// On the web: a file added (or replaced) there. Its id.
    @discardableResult
    func add(_ path: String, _ bytes: Data) async throws -> String {
        let id = put(path, bytes)
        await publish()
        return id
    }

    func file(at path: String) -> FileItem? {
        let (folder, name) = Self.split(path)
        return files.first { $0.folder == folder && $0.name == name }
    }

    static func object(_ id: String, _ etag: String) -> String { "/k/\(id)/\(etag)" }

    // MARK: FSWriteTarget

    func write(path: String, from file: URL, modified: Date?, created: Date?) async throws {
        let bytes = try Data(contentsOf: file)
        try? FileManager.default.removeItem(at: file)
        calls.append("write \(path) \(bytes.count)")
        put(path, bytes, modified: modified, created: created)
        await publish()
    }

    func makeFolder(path: String) async throws {
        calls.append("mkdir \(path)")
        folders.append(Self.kept(String(path.dropFirst())))
        await publish()
    }

    func move(from: String, to: String, replace: Bool) async throws {
        calls.append("move \(from) -> \(to)")
        guard let moving = file(at: from) else { throw DriveWriter.Failure.posix(ENOENT, nil) }
        if let over = file(at: to) { files.removeAll { $0.id == over.id } }
        let bytes = Loopback.stored(Self.object(moving.id, "v\(moving.version)")) ?? Data()
        let (folder, name) = Self.split(to)
        clock += 1_000
        let moved = Self.item(moving.id, name, in: folder, size: moving.size ?? 0, version: moving.version + 2, updated: clock)
        files.removeAll { $0.id == moving.id }
        files.append(moved)
        Loopback.store(Self.object(moved.id, "v\(moved.version)"), bytes)
        await publish()
    }

    func remove(path: String) async throws {
        calls.append("remove \(path)")
        guard let gone = file(at: path) else { throw DriveWriter.Failure.posix(ENOENT, nil) }
        files.removeAll { $0.id == gone.id }
        await publish()
    }

    // MARK: -

    /// As the server records an upload: the file's own dates beside the
    /// row's (lib/file-record.js), its created date kept when new bytes
    /// replace old.
    @discardableResult
    private func put(_ path: String, _ bytes: Data, modified: Date? = nil, created: Date? = nil) -> String {
        let (folder, name) = Self.split(path)
        clock += 1_000
        var item: FileItem
        if let old = file(at: path) {
            item = Self.item(old.id, name, in: folder, size: Int64(bytes.count), version: old.version + 1, updated: clock)
            item.fileCreatedAt = old.fileCreatedAt
            files.removeAll { $0.id == old.id }
        } else {
            made += 1
            item = Self.item("f\(made)", name, in: folder, size: Int64(bytes.count), version: 1, updated: clock)
            item.fileCreatedAt = created.map { EpochMillis(Int64($0.timeIntervalSince1970 * 1000)) }
        }
        item.fileModifiedAt = modified.map { EpochMillis(Int64($0.timeIntervalSince1970 * 1000)) }
        files.append(item)
        Loopback.store(Self.object(item.id, "v\(item.version)"), bytes)
        return item.id
    }

    private func publish() async {
        var replica = Replica()
        replica.apply(changed: files, deleted: [], folders: folders)
        await drive?.show(MirrorIndex(replica))
    }

    /// As the server stores a path: each name without spaces at its ends
    /// (lib/folder-ops.js cleanFolder, and file names on the way in).
    static func split(_ path: String) -> (folder: String, name: String) {
        let parts = kept(path).split(separator: "/").map(String.init)
        return (parts.dropLast().joined(separator: "/"), parts.last ?? "")
    }

    static func kept(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .joined(separator: "/")
    }

    static func item(_ id: String, _ name: String, in folder: String, size: Int64, version: Int, updated: Int64) -> FileItem {
        FileItem(id: id, name: name, folder: folder, kind: "file", mime: nil, size: size, url: nil,
                 storageKey: nil, thumbnailUrl: nil, tags: [], notes: nil, caption: nil, visibility: nil,
                 version: version, contentHash: nil, createdBy: nil, createdAt: EpochMillis(updated - 1),
                 updatedAt: EpochMillis(updated), deletedAt: nil, seq: nil)
    }
}

actor Heard {
    var ids: Set<UInt64> = []
    func add(_ more: Set<UInt64>, _ all: Bool) { ids.formUnion(more) }
}

enum Pattern {
    /// Bytes that say where they are: any byte out of place shows.
    static func bytes(_ count: Int) -> Data {
        Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ $0 >> 8) })
    }
}
