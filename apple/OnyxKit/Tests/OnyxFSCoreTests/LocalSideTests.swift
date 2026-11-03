import Foundation
import Testing
@testable import OnyxFSCore

private func scratch(_ name: String) -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("onyxfs-tests-\(name)-\(UUID().uuidString)", isDirectory: true)
}

@Suite struct LocalOnlyTests {
    @Test func macOSOwnNamesStayLocal() {
        for name in [".DS_Store", "._Take 1.mov", ".Trashes", ".Spotlight-V100", ".fseventsd", ".TemporaryItems", "Icon\r"] {
            #expect(LocalOnly.isLocalOnly(name), "\(name)")
        }
        for name in ["Take 1.mov", ".env", ".gitignore", "_DS_Store", "Icon", "DS_Store"] {
            #expect(!LocalOnly.isLocalOnly(name), "\(name)")
        }
    }

    @Test func anythingUnderALocalFolderIsLocal() {
        #expect(LocalOnly.isLocalOnly(path: "/.Trashes/501/Take 1.mov"))
        #expect(LocalOnly.isLocalOnly(path: "/Footage/._Take 1.mov"))
        #expect(!LocalOnly.isLocalOnly(path: "/Footage/Day 1/Take 1.mov"))
    }

    @Test func rootMarkersAreThemselvesLocal() {
        for name in LocalOnly.rootMarkers { #expect(LocalOnly.isLocalOnly(name)) }
    }
}

@Suite struct LocalStoreTests {
    @Test func localFilesKeepTheirBytesAcrossAReopen() async throws {
        let dir = scratch("store")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.createFile("/Footage/.DS_Store")
        #expect(try await store.write("/Footage/.DS_Store", at: 0, Data("finder".utf8)) == 6)
        _ = try await store.write("/Footage/.DS_Store", at: 6, Data(" view".utf8))
        #expect(await store.size("/Footage/.DS_Store") == 11)

        let again = try LocalStore(directory: dir)
        #expect(await again.exists("/Footage/.DS_Store"))
        #expect(String(decoding: try await again.read("/Footage/.DS_Store", at: 0, count: 100), as: UTF8.self) == "finder view")
        #expect(await again.names(in: "/Footage") == [".DS_Store"])
        #expect(await again.names(in: "/").isEmpty)
    }

    @Test func truncateAndErrors() async throws {
        let dir = scratch("trunc")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.createFile("/.DS_Store")
        _ = try await store.write("/.DS_Store", at: 0, Data(repeating: 1, count: 100))
        try await store.truncate("/.DS_Store", to: 10)
        #expect(await store.size("/.DS_Store") == 10)
        await #expect(throws: LocalStore.Failure.posix(EEXIST)) { try await store.createFile("/.DS_Store") }
        await #expect(throws: LocalStore.Failure.posix(ENOENT)) { try await store.read("/nope", at: 0, count: 1) }
        try await store.createDirectory("/.Trashes")
        await #expect(throws: LocalStore.Failure.posix(EISDIR)) { try await store.read("/.Trashes", at: 0, count: 1) }
    }

    @Test func attributesFollowRenamesAndGoWithTheItem() async throws {
        let dir = scratch("xattr")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.setAttribute("com.apple.metadata:_kMDItemUserTags", of: "/Day 1/Take 1.mov", to: Data("red".utf8))
        let fork = Data(repeating: 7, count: 100_000)
        try await store.setAttribute("com.apple.ResourceFork", of: "/Day 1/Take 1.mov", to: fork)
        #expect(await store.attributeNames(of: "/Day 1/Take 1.mov") == ["com.apple.ResourceFork", "com.apple.metadata:_kMDItemUserTags"])

        // A folder renamed: everything under it answers to the new path.
        await store.move("/Day 1", to: "/Day One")
        #expect(await store.attributeNames(of: "/Day 1/Take 1.mov").isEmpty)
        #expect(try await store.attribute("com.apple.ResourceFork", of: "/Day One/Take 1.mov") == fork)

        let again = try LocalStore(directory: dir)
        #expect(try await again.attribute("com.apple.metadata:_kMDItemUserTags", of: "/Day One/Take 1.mov") == Data("red".utf8))

        await again.removeAttributes(under: "/Day One")
        await #expect(throws: LocalStore.Failure.posix(ENOATTR)) {
            try await again.attribute("com.apple.ResourceFork", of: "/Day One/Take 1.mov")
        }
    }

    @Test func createAndReplaceOnlyAreHonoured() async throws {
        let dir = scratch("flags")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        await #expect(throws: LocalStore.Failure.posix(ENOATTR)) {
            try await store.setAttribute("a", of: "/x", to: Data([1]), replaceOnly: true)
        }
        try await store.setAttribute("a", of: "/x", to: Data([1]), createOnly: true)
        await #expect(throws: LocalStore.Failure.posix(EEXIST)) {
            try await store.setAttribute("a", of: "/x", to: Data([2]), createOnly: true)
        }
        try await store.setAttribute("a", of: "/x", to: nil)
        await #expect(throws: LocalStore.Failure.posix(ENOATTR)) { try await store.setAttribute("a", of: "/x", to: nil) }
        await #expect(throws: LocalStore.Failure.posix(E2BIG)) {
            try await store.setAttribute("big", of: "/x", to: Data(count: LocalStore.maximumAttributeSize + 1))
        }
    }

    /// What is under a path is found through the folders it is in, not by
    /// looking at every path: a real folder renamed takes the local files
    /// at every depth inside it, and nothing beside it that only starts
    /// with its name.
    @Test func whatIsUnderAFolderGoesWithIt() async throws {
        let dir = scratch("tree")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        for path in ["/Shoot/.DS_Store", "/Shoot/Day 1/._Take 1.mov", "/Shoot 2/.DS_Store"] {
            try await store.createFile(path)
        }
        try await store.setAttribute("com.apple.FinderInfo", of: "/Shoot/Day 1", to: Data([1]))
        #expect(await store.names(in: "/Shoot") == [".DS_Store"], "Day 1 is the drive's, not this Mac's")
        #expect(await store.names(in: "/").isEmpty)

        await store.move("/Shoot", to: "/Selects")
        for reopened in [false, true] {
            let current = try reopened ? LocalStore(directory: dir) : store
            #expect(await current.names(in: "/Selects") == [".DS_Store"])
            #expect(await current.names(in: "/Selects/Day 1") == ["._Take 1.mov"])
            #expect(try await current.attribute("com.apple.FinderInfo", of: "/Selects/Day 1") == Data([1]))
            #expect(await current.names(in: "/Shoot").isEmpty)
            #expect(await !current.exists("/Shoot/Day 1/._Take 1.mov"))
            #expect(await current.names(in: "/Shoot 2") == [".DS_Store"], "only starts with the name")
        }

        // Emptied, a folder is nothing here any more: moving it moves nothing.
        let again = try LocalStore(directory: dir)
        await again.remove("/Selects/.DS_Store")
        await again.remove("/Selects/Day 1/._Take 1.mov")
        await again.removeAttributes(under: "/Selects")
        let before = await again.disk.appends
        await again.move("/Selects", to: "/Picks")
        #expect(await again.disk.appends == before)
        #expect(await again.subtree("/Picks").isEmpty)
    }
}

/// How the store is written: every change a line added to its log before
/// the call returns, index.json written whole only now and then, and what
/// a reopen — the next mount — finds.
@Suite struct LocalStoreLogTests {
    /// Each kind of change, read back from the log alone: index.json is
    /// still as the store first wrote it.
    @Test func everyChangeIsInTheLog() async throws {
        let dir = scratch("log")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.createDirectory("/.TemporaryItems")
        try await store.createFile("/.TemporaryItems/folders.501/scratch")
        try await store.createFile("/Footage/._Take 1.mov")
        _ = try await store.write("/Footage/._Take 1.mov", at: 0, Data("apple double".utf8))
        try await store.truncate("/Footage/._Take 1.mov", to: 5)
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        await store.setModified("/Footage/._Take 1.mov", to: date)
        try await store.createFile("/Footage/.DS_Store")
        await store.move("/Footage/.DS_Store", to: "/Footage/.DS_Store 2")
        try await store.createFile("/Gone/.DS_Store")
        await store.remove("/Gone/.DS_Store")
        try await store.createFile("/Sent/._a")
        await store.release(["/Sent/._a"])
        let fork = Data(repeating: 7, count: 100_000)
        try await store.setAttribute("com.apple.ResourceFork", of: "/Footage/Take 1.mov", to: fork)
        try await store.setAttribute("com.apple.metadata:_kMDItemUserTags", of: "/Footage/Take 1.mov", to: Data("red".utf8))
        try await store.setAttribute("com.apple.quarantine", of: "/Footage/Take 1.mov", to: Data("q".utf8))
        try await store.setAttribute("com.apple.quarantine", of: "/Footage/Take 1.mov", to: nil)
        try await store.setAttribute("a", of: "/Old.mov", to: Data([1]))
        await store.removeAttributes(under: "/Old.mov")
        let icon = Data("the drive's icon".utf8)
        try await store.placeVolumeIcon(icon)

        #expect(await store.disk.snapshots == 1, "once, as it was made")
        let written = try JSONDecoder().decode(LocalStore.Index.self, from: Data(contentsOf: dir.appendingPathComponent(LocalStore.indexFile)))
        #expect(written.files.isEmpty && written.attributes.isEmpty && written.volumeIcon == nil)

        let again = try LocalStore(directory: dir)
        #expect(await again.isDirectory("/.TemporaryItems"))
        #expect(await again.names(in: "/.TemporaryItems/folders.501") == ["scratch"])
        #expect(try await again.read("/Footage/._Take 1.mov", at: 0, count: 100) == Data("apple".utf8))
        #expect(await again.modified("/Footage/._Take 1.mov") == date)
        #expect(await again.names(in: "/Footage") == [".DS_Store 2", "._Take 1.mov"])
        #expect(await !again.exists("/Gone/.DS_Store"))
        #expect(await !again.exists("/Sent/._a"))
        #expect(try await again.attribute("com.apple.ResourceFork", of: "/Footage/Take 1.mov") == fork)
        #expect(await again.attributeNames(of: "/Footage/Take 1.mov") == ["com.apple.ResourceFork", "com.apple.metadata:_kMDItemUserTags"])
        #expect(await again.attributeNames(of: "/Old.mov").isEmpty)

        // The icon is known as the store's own: drawn anew, it is replaced.
        let redrawn = Data("drawn anew".utf8)
        try await again.placeVolumeIcon(redrawn)
        #expect(try await again.read(LocalStore.volumeIconPath, at: 0, count: 100) == redrawn)

        // Bytes nothing points at went as their entries did.
        let blobs = try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("blobs").path)
        #expect(blobs.count == 6, "scratch, ._Take 1.mov, .DS_Store 2, the fork, the icon and ._.")
    }

    /// A crash as a line was being written leaves half a line: it says
    /// nothing, and everything before it stands. The reopen folds the log
    /// into index.json, and what is changed after it is logged afresh.
    @Test func aLineCutShortIsPassedOver() async throws {
        let dir = scratch("torn")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.createFile("/.DS_Store")
        let log = try #require(try logs(in: dir).first)
        let handle = try FileHandle(forWritingTo: log)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(#"[{"file":{"path":"/._half","entry":{"blob":"#.utf8))
        try handle.close()

        let second = try LocalStore(directory: dir)
        #expect(await second.exists("/.DS_Store"))
        #expect(await !second.exists("/._half"))
        #expect(try logs(in: dir).isEmpty, "folded into index.json")
        try await second.createFile("/._after")

        let third = try LocalStore(directory: dir)
        #expect(await third.names(in: "/") == [".DS_Store", "._after"])
    }

    /// The log is read as one array; a line that does not read spoils that,
    /// so each is read alone and only that one is passed over.
    @Test func aSpoiltLineCostsOnlyItself() async throws {
        let dir = scratch("spoilt")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.createFile("/.DS_Store")
        let log = try #require(try logs(in: dir).first)
        let handle = try FileHandle(forWritingTo: log)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("not a change\n".utf8))
        try handle.close()
        try await store.createFile("/._after")

        #expect(try await LocalStore(directory: dir).names(in: "/") == [".DS_Store", "._after"])
    }

    /// index.json that cannot be written as the store opens (a folder it
    /// may not write in, here): the log is kept and added to, the half line
    /// a crash left cut away first, so the next line does not join it.
    @Test func aLogThatCannotBeFoldedInIsAddedTo() async throws {
        let dir = scratch("kept")
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
            try? FileManager.default.removeItem(at: dir)
        }
        let store = try LocalStore(directory: dir)
        try await store.createFile("/.DS_Store")
        let log = try #require(try logs(in: dir).first)
        let handle = try FileHandle(forWritingTo: log)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(#"[{"file":{"pa"#.utf8))
        try handle.close()
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)

        let second = try LocalStore(directory: dir)
        #expect(await second.disk.snapshots == 0)
        await second.setModified("/.DS_Store", to: Date(timeIntervalSince1970: 1_700_000_000))
        let third = try LocalStore(directory: dir)
        #expect(await third.modified("/.DS_Store") == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(try logs(in: dir) == [log])
    }

    /// Once the log has outgrown index.json (and `logFloor`), index.json is
    /// written whole, under a new generation, and the log starts again.
    @Test func theLogIsFoldedInOnceItOutgrowsTheIndex() async throws {
        let dir = scratch("fold")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.createFile("/.DS_Store")
        var n = 0
        while await store.disk.snapshots < 2 {
            n += 1
            await store.setModified("/.DS_Store", to: Date(timeIntervalSince1970: Double(n)))
            try #require(n < 10_000)
        }
        let disk = await store.disk
        #expect(disk.appendBytes > LocalStore.logFloor && disk.appendBytes < LocalStore.logFloor + 1024)
        #expect(try logs(in: dir).isEmpty, "the old log goes; the next change starts the new one")
        await store.setModified("/.DS_Store", to: Date(timeIntervalSince1970: 1_700_000_000))
        #expect(try logs(in: dir).count == 1)
        #expect(try await LocalStore(directory: dir).modified("/.DS_Store") == Date(timeIntervalSince1970: 1_700_000_000))
    }

    /// An Onyx from before the log reads index.json alone, and writes it
    /// whole without a generation. The log left beside it is not its log:
    /// read back over it, it would bring back what that Onyx removed.
    @Test func aLogBesideAnIndexWrittenSinceIsNotReadBack() async throws {
        let dir = scratch("older")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.createFile("/Footage/.DS_Store")
        #expect(try logs(in: dir).count == 1)
        let older = #"{"files":{"/Selects/.DS_Store":{"blob":"B1","directory":false,"modified":1700000000}},"attributes":{}}"#
        try Data(older.utf8).write(to: dir.appendingPathComponent(LocalStore.indexFile))

        let again = try LocalStore(directory: dir)
        #expect(await again.exists("/Selects/.DS_Store"))
        #expect(await !again.exists("/Footage/.DS_Store"))
        #expect(try logs(in: dir).isEmpty)
    }

    /// index.json from before the log (every build until this one) opens as
    /// it always did, and is written again with a generation for its log.
    @Test func aStoreFromBeforeTheLogStillOpens() async throws {
        let dir = scratch("before")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("blobs"), withIntermediateDirectories: true)
        try Data("view".utf8).write(to: dir.appendingPathComponent("blobs/B1"))
        let json = #"{"files":{"/Footage/.DS_Store":{"blob":"B1","directory":false,"modified":1700000000}},"attributes":{"/Footage/Take 1.mov":{"com.apple.metadata:_kMDItemUserTags":{"inline":"cmVk"}}},"volumeIcon":"abc"}"#
        try Data(json.utf8).write(to: dir.appendingPathComponent(LocalStore.indexFile))

        let store = try LocalStore(directory: dir)
        #expect(try await store.read("/Footage/.DS_Store", at: 0, count: 10) == Data("view".utf8))
        #expect(await store.names(in: "/Footage") == [".DS_Store"])
        #expect(try await store.attribute("com.apple.metadata:_kMDItemUserTags", of: "/Footage/Take 1.mov") == Data("red".utf8))
        let written = try JSONDecoder().decode(LocalStore.Index.self, from: Data(contentsOf: dir.appendingPathComponent(LocalStore.indexFile)))
        #expect(written.generation != nil && written.volumeIcon == "abc" && written.files.count == 1)
    }

    /// A store as big as the Mac's get. What a change writes is a line of a
    /// few hundred bytes, whatever the store holds — it was all 1.5 MB of
    /// index.json, every time — and a call that changes nothing (a real
    /// file renamed or deleted: the store has nothing of it) writes nothing.
    @Test func aChangeWritesALineHoweverBigTheStore() async throws {
        let dir = scratch("big")
        defer { try? FileManager.default.removeItem(at: dir) }
        let seeded = try seedStore(dir, entries: 10_000)
        let store = try LocalStore(directory: dir)
        let opened = await store.disk
        #expect(opened.snapshots == 1 && opened.snapshotBytes > 1_000_000, "folded in once, as an older store opens")

        for n in 0..<25 {
            let path = "/Copy/._IMG_\(n).JPG"
            try await store.createFile(path)
            _ = try await store.write(path, at: 0, Data(repeating: 0x41, count: 4096))
            try await store.truncate(path, to: 4096)
            await store.setModified(path, to: Date(timeIntervalSince1970: 1_700_000_000))
            await store.move(seeded[n], to: seeded[n] + " 2")
            await store.remove(seeded[n] + " 2")
        }
        let changed = await store.disk
        #expect(changed.snapshots == 1)
        #expect(changed.appends == 150)
        #expect(changed.appendBytes < 150 * 400)

        for path in seeded[100..<150] {
            let real = path.replacingOccurrences(of: "/._", with: "/")
            await store.move(real, to: real + " 2")
            await store.removeAttributes(under: real + " 2")
            await store.remove(real + " 3")
        }
        await store.release(["/Real.mov"])
        #expect(await store.disk == changed, "nothing changed, nothing written")
    }
}

private func logs(in dir: URL) throws -> [URL] {
    try FileManager.default.contentsOfDirectory(atPath: dir.path)
        .filter { $0.hasPrefix(LocalStore.logPrefix) && $0.hasSuffix(".log") }
        .map { dir.appendingPathComponent($0) }
}

@Suite struct StagingAreaTests {
    @Test func writeReadTruncate() async throws {
        let dir = scratch("staging")
        defer { try? FileManager.default.removeItem(at: dir) }
        let staging = try StagingArea(directory: dir)
        try await staging.create(40)
        _ = try await staging.write(40, at: 0, Data("hello".utf8))
        _ = try await staging.write(40, at: 10, Data("world".utf8)) // a hole, as an app may write
        #expect(await staging.size(40) == 15)
        let back = try await staging.read(40, at: 10, count: 5)
        #expect(String(decoding: back, as: UTF8.self) == "world")
        try await staging.truncate(40, to: 5)
        #expect(await staging.size(40) == 5)
        await staging.remove(40)
        #expect(await !staging.contains(40))
        await #expect(throws: StagingArea.Failure.posix(EBADF)) { try await staging.read(40, at: 0, count: 1) }
    }

    @Test func copyOnWriteBringsTheWholeFileInPieces() async throws {
        let dir = scratch("cow")
        defer { try? FileManager.default.removeItem(at: dir) }
        let staging = try StagingArea(directory: dir)
        let source = Data((0..<1000).map { UInt8($0 % 251) })
        let asked = Asked()
        try await staging.materialize(7, size: UInt64(source.count), piece: 300) { offset, count in
            await asked.add(count)
            let start = Int(offset)
            return source.subdata(in: start..<min(source.count, start + count))
        }
        #expect(await asked.counts == [300, 300, 300, 100])
        #expect(try await staging.read(7, at: 0, count: 2000) == source)
    }

    @Test func aFailedCopyLeavesNothingBehind() async throws {
        let dir = scratch("cowfail")
        defer { try? FileManager.default.removeItem(at: dir) }
        let staging = try StagingArea(directory: dir)
        struct Offline: Error {}
        await #expect(throws: Offline.self) {
            try await staging.materialize(9, size: 100) { _, _ in throw Offline() }
        }
        #expect(await !staging.contains(9))
        let left = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(left.isEmpty)
    }

    @Test func leftoversFromAnEarlierRunAreCleared() async throws {
        let dir = scratch("left")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dir.appendingPathComponent("old").path, contents: Data([1]))
        _ = try StagingArea(directory: dir)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
    }
}

private actor Asked {
    var counts: [Int] = []
    func add(_ count: Int) { counts.append(count) }
}
