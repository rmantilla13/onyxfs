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
