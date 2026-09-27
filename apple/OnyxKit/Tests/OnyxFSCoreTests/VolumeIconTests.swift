import Foundation
import Testing
@testable import OnyxFSCore

private func scratch(_ name: String) -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("onyxfs-tests-\(name)-\(UUID().uuidString)", isDirectory: true)
}

/// The root's `._.`, as the kernel reads it: macOS's own layout, so that the
/// kernel both finds the flag in it and can add the root's other attributes
/// to it later (both tried on a real FSKit volume while this was written).
@Suite struct AppleDoubleTests {
    func uint32(_ d: Data, _ at: Int) -> UInt32 { d[at..<at + 4].reduce(0) { $0 << 8 | UInt32($1) } }
    func uint16(_ d: Data, _ at: Int) -> UInt16 { d[at..<at + 2].reduce(0) { $0 << 8 | UInt16($1) } }

    @Test func aNewFileIsTheOneMacOSWrites() {
        let d = AppleDouble.file(finderFlags: AppleDouble.hasCustomIcon)
        #expect(d.count == 4096)
        #expect(uint32(d, 0) == 0x0005_1607 && uint32(d, 4) == 0x0002_0000)
        #expect(String(decoding: d[8..<24], as: UTF8.self) == "Mac OS X        ")
        #expect(uint16(d, 24) == 2)
        // Finder info at 0x32, to where the resource fork starts; the fork,
        // 286 bytes, ends the file.
        #expect([uint32(d, 26), uint32(d, 30), uint32(d, 34)] == [9, 0x32, 0xEB0])
        #expect([uint32(d, 38), uint32(d, 42), uint32(d, 46)] == [2, 0xEE2, 0x11E])
        #expect(uint16(d, 0x3A) == 0x0400, "kHasCustomIcon")
        #expect(d[0x32..<0x3A].allSatisfy { $0 == 0 } && d[0x3C..<0x54].allSatisfy { $0 == 0 })
        // An attribute header with no attributes, their data starting right after it.
        #expect(String(decoding: d[0x54..<0x58], as: UTF8.self) == "ATTR")
        #expect([uint32(d, 0x5C), uint32(d, 0x60), uint32(d, 0x64)] == [0xEE2, 0x78, 0])
        #expect(uint16(d, 0x76) == 0)
        // The empty resource fork, as the kernel leaves it.
        #expect([uint32(d, 0xEE2), uint32(d, 0xEE6), uint32(d, 0xEEA), uint32(d, 0xEEE)] == [0x100, 0x100, 0, 0x1E])
        #expect(String(decoding: d[0xEF2..<0xF20], as: UTF8.self) == "This resource fork intentionally left blank   ")
        #expect(d.suffix(8) == Data([0x00, 0x00, 0x00, 0x1C, 0x00, 0x1E, 0xFF, 0xFF]))
    }

    @Test func aFlagIsAddedToWhatIsThere() throws {
        // Finder info with flags already set (kIsInvisible), and an attribute
        // the kernel wrote after it.
        var theirs = AppleDouble.file(finderFlags: 0x4000)
        theirs.replaceSubrange(0x78..<0x80, with: Data("elsewise".utf8))
        let flagged = try #require(AppleDouble.settingFinderFlags(AppleDouble.hasCustomIcon, in: theirs))
        #expect(AppleDouble.finderFlags(of: flagged) == 0x4400)
        var expected = theirs
        expected[0x3A] = 0x44
        #expect(flagged == expected, "nothing else moves")
        #expect(AppleDouble.settingFinderFlags(AppleDouble.hasCustomIcon, in: flagged) == flagged)

        for junk in [Data(), Data("not an AppleDouble file".utf8), Data(AppleDouble.file(finderFlags: 0).prefix(40))] {
            #expect(AppleDouble.settingFinderFlags(AppleDouble.hasCustomIcon, in: junk) == nil)
        }
    }
}

/// The drive's icon on the disk: put there as it mounts, kept current as
/// the app's icon changes, and never over the person's own.
@Suite struct VolumeIconPlacementTests {
    let icon = Data("icns-first".utf8)
    let redrawn = Data("icns-second".utf8)

    func files(_ store: LocalStore) async throws -> (icon: Data, flags: UInt16?) {
        let icon = try await store.read(LocalStore.volumeIconPath, at: 0, count: 1 << 20)
        let attributes = try await store.read(LocalStore.rootAttributesPath, at: 0, count: 1 << 20)
        return (icon, AppleDouble.finderFlags(of: attributes))
    }

    @Test func placedAtTheRootWithTheFlagThatShowsIt() async throws {
        let dir = scratch("icon")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.placeVolumeIcon(icon)
        #expect(await store.names(in: "/") == [".VolumeIcon.icns", "._."])
        #expect(LocalOnly.isLocalOnly(".VolumeIcon.icns") && LocalOnly.isLocalOnly("._."), "never uploaded")
        let placed = try await files(store)
        #expect(placed.icon == icon && placed.flags == AppleDouble.hasCustomIcon)

        // Mounted again, nothing to do: nothing is written.
        let before = await store.modified(LocalStore.volumeIconPath)
        try await Task.sleep(for: .milliseconds(20))
        try await store.placeVolumeIcon(icon)
        #expect(await store.modified(LocalStore.volumeIconPath) == before)

        // Drawn anew (a new colour, a new design): the disk gets it, even
        // in a store opened afresh, as at the next mount.
        let again = try LocalStore(directory: dir)
        try await again.placeVolumeIcon(redrawn)
        #expect(try await files(again).icon == redrawn)
    }

    @Test func thePersonsOwnIconStays() async throws {
        let dir = scratch("theirs")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.placeVolumeIcon(icon)

        // Get Info › paste: Finder writes the disk an icon of its own.
        let theirs = Data("their own icns".utf8)
        try await store.truncate(LocalStore.volumeIconPath, to: 0)
        _ = try await store.write(LocalStore.volumeIconPath, at: 0, theirs)
        try await store.placeVolumeIcon(redrawn)
        #expect(try await files(store).icon == theirs)
        #expect(try await files(try LocalStore(directory: dir)).icon == theirs, "and at every mount after")

        // An icon the disk had before Onyx drew one is theirs too.
        let other = scratch("before")
        defer { try? FileManager.default.removeItem(at: other) }
        let earlier = try LocalStore(directory: other)
        try await earlier.createFile(LocalStore.volumeIconPath)
        _ = try await earlier.write(LocalStore.volumeIconPath, at: 0, theirs)
        try await earlier.placeVolumeIcon(icon)
        #expect(try await earlier.read(LocalStore.volumeIconPath, at: 0, count: 100) == theirs)
        #expect(!(await earlier.exists(LocalStore.rootAttributesPath)), "their flag is theirs to set")
    }

    @Test func ourOwnBytesAreOursWithoutTheRecord() async throws {
        // An older Onyx saved the store's index without the record.
        let dir = scratch("lost")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.createFile(LocalStore.volumeIconPath)
        _ = try await store.write(LocalStore.volumeIconPath, at: 0, icon)
        try await store.placeVolumeIcon(icon)
        #expect(try await files(store).flags == AppleDouble.hasCustomIcon)
        try await store.placeVolumeIcon(redrawn)
        #expect(try await files(store).icon == redrawn, "and redrawn from then on")
    }

    @Test func removedItComesBackAsTheDisksOwn() async throws {
        let dir = scratch("removed")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        try await store.placeVolumeIcon(icon)
        // Get Info › Delete: the icon file goes, and Finder clears the flag.
        await store.remove(LocalStore.volumeIconPath)
        try await store.truncate(LocalStore.rootAttributesPath, to: 0)
        _ = try await store.write(LocalStore.rootAttributesPath, at: 0, AppleDouble.file(finderFlags: 0))
        try await store.placeVolumeIcon(icon)
        let placed = try await files(store)
        #expect(placed.icon == icon && placed.flags == AppleDouble.hasCustomIcon)
    }

    @Test func theRootsOtherFinderInfoIsKept() async throws {
        let dir = scratch("root")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStore(directory: dir)
        var finders = AppleDouble.file(finderFlags: 0x0010)
        finders.replaceSubrange(0x32..<0x3A, with: Data([0, 10, 0, 20, 1, 44, 2, 88])) // a window's bounds
        try await store.createFile(LocalStore.rootAttributesPath)
        _ = try await store.write(LocalStore.rootAttributesPath, at: 0, finders)
        try await store.placeVolumeIcon(icon)
        let attributes = try await store.read(LocalStore.rootAttributesPath, at: 0, count: 1 << 20)
        #expect(AppleDouble.finderFlags(of: attributes) == 0x0410)
        #expect(attributes[0x32..<0x3A] == Data([0, 10, 0, 20, 1, 44, 2, 88]))
    }
}
