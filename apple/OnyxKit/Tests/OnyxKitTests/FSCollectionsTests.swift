import Testing
import Foundation
@testable import OnyxKit

/// The read-only Collections folder on a drive's disk (FSCollections): how it
/// is laid out, how the bridge answers for it, and that no write gets past it
/// to the drive's writer — a move out of a collection would move the real
/// file, a folder made in one would be made on the server.
extension FSBridgeTests {
    /// The fixture drive's entries for some of its files.
    static func entries(_ ids: [String]) -> [MirrorEntry] {
        let index = index(drive, folders: folders)
        return ids.compactMap { index.file(id: $0) }
    }

    static let spring = FSCollections([
        .init(id: "c1", name: "Spring picks", entries: entries(["a", "deep", "readme"])),
        .init(id: "c2", name: "Long/Name", entries: entries(["stream"])),
    ])

    @Test func theFolderSitsAtTheTopAndHoldsOneFolderPerCollection() async throws {
        let rig = try await rig()
        defer { rig.remove() }
        await rig.source.showCollections(Self.spring)

        let top = try json(await ask(rig, "list", ["path": "/"]))
        let entries = try #require(top["entries"] as? [[String: Any]])
        let folder = try #require(entries.first { $0["name"] as? String == "Collections" })
        #expect(folder["type"] as? String == "dir" && folder["readOnly"] as? Bool == true)
        // Every other entry reads as it always did: no readOnly at all.
        #expect(entries.filter { $0["name"] as? String != "Collections" }.allSatisfy { $0["readOnly"] == nil })

        let inside = try json(await ask(rig, "list", ["path": "/Collections"]))
        let names = (inside["entries"] as? [[String: Any]])?.compactMap { $0["name"] as? String }
        #expect(names == ["Long:Name", "Spring picks"], "a name safe on a disk, in Finder's order")

        let picks = try json(await ask(rig, "list", ["path": "/Collections/Spring picks"]))
        let files = try #require(picks["entries"] as? [[String: Any]])
        #expect(Set(files.compactMap { $0["id"] as? String }) == ["a", "deep", "readme"])
        #expect(files.allSatisfy { $0["readOnly"] as? Bool == true })
        // The bridge was told each listing, so the app can fetch what is looked at.
        #expect(await rig.source.looked == ["", "Collections", "Collections/Spring picks"])
    }

    @Test func aCollectionsFileIsTheRealFileReadTheSameWay() async throws {
        let rig = try await rig()
        defer { rig.remove() }
        await rig.source.showCollections(Self.spring)
        let real = try json(await ask(rig, "stat", ["path": "/Campaigns/a b.png"]))
        let shown = try json(await ask(rig, "stat", ["path": "/Collections/Spring picks/a b.png"]))
        let a = try #require(real["entry"] as? [String: Any]), b = try #require(shown["entry"] as? [String: Any])
        #expect(a["id"] as? String == b["id"] as? String)
        // Same version: the extension's cached chunks serve both.
        #expect(a["version"] as? String == b["version"] as? String)
        #expect(await ask(rig, "source", ["id": "a"]).status == 200)
    }

    @Test func aFileOnlyACollectionHoldsIsStillReadable() async throws {
        // An All Files collection gathers a file this drive's own tree lacks.
        let rig = try await rig()
        defer { rig.remove() }
        let other = Self.index([Self.item("far", "far.png", in: "Elsewhere", hash: "h-far")])
        let entry = try #require(other.file(id: "far"))
        await rig.source.showCollections(FSCollections([.init(id: "c", name: "All", entries: [entry])]))
        let r = await ask(rig, "source", ["id": "far"])
        #expect(r.status == 200)
        #expect(try json(r)["kind"] as? String == "remote")
    }

    @Test func noWriteGetsPastItToTheWriter() async throws {
        let (rig, writer) = try await writeRig()
        defer { rig.remove() }
        await rig.source.showCollections(Self.spring)

        let (put, body) = try await put(rig, "/Collections/Spring picks/new.txt", Data([1]))
        #expect(put.status == 403)
        #expect(!FileManager.default.fileExists(atPath: body.path), "the body that was never taken is not left behind")
        #expect(try await post(rig, "mkdir", ["path": "/Collections/New"]).status == 403)
        #expect(try await post(rig, "mkdir", ["path": "/Collections/Spring picks/Sub"]).status == 403)
        // Out of a collection: it would move the real file.
        #expect(try await post(rig, "rename", ["from": "/Collections/Spring picks/a b.png", "to": "/a b 2.png"]).status == 403)
        // Into one, or over its folder.
        #expect(try await post(rig, "rename", ["from": "/Readme.md", "to": "/Collections/Spring picks/R.md"]).status == 403)
        #expect(try await post(rig, "rename", ["from": "/Collections", "to": "/Gone"]).status == 403)
        #expect(await ask(rig, "item", ["path": "/Collections/Spring picks/a b.png"], method: "DELETE").status == 403)
        #expect(await ask(rig, "item", ["path": "/Collections"], method: "DELETE").status == 403)
        #expect(await writer.calls.isEmpty)
        // The rest of the drive is as writable as it was.
        #expect(try await post(rig, "mkdir", ["path": "/Selects"]).status == 200)
    }

    @Test func aRealFolderOfThatNameKeepsIt() async throws {
        let rig = try await rig()
        defer { rig.remove() }
        // Built again for a drive that has its own: under another name.
        let index = Self.index(Self.drive, folders: Self.folders + ["collections"])
        let root = FSCollections.rootName { index.entry(at: $0) != nil }
        #expect(root == "Collections (Onyx)", "case-insensitively, as Finder compares")
        // Until then, the real one is shown, and writable.
        await rig.source.show(index)
        await rig.source.showCollections(Self.spring)
        let top = try json(await ask(rig, "list", ["path": "/"]))
        let names = (top["entries"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
        #expect(names.filter { $0.lowercased() == "collections" } == ["collections"])
    }

    @Test func aChangeToACollectionReachesTheExtension() async throws {
        let rig = try await rig()
        defer { rig.remove() }
        let start = try #require(try json(await ask(rig, "list", ["path": "/"]))["generation"] as? Int)
        await rig.source.showCollections(Self.spring)
        let changes = try json(await ask(rig, "changes", ["since": String(start), "wait": "1"]))
        let paths = Set((changes["paths"] as? [String]) ?? [])
        #expect(paths.isSuperset(of: ["/", "/Collections", "/Collections/Spring picks"]))
    }

    @Test func namesInACollectionAreUniqueAndStable() {
        let one = Self.item("x1", "Clip.mov", in: "A", updated: Self.t0 - 10)
        let two = Self.item("x2", "clip.mov", in: "B", updated: Self.t0)
        let index = Self.index([one, two])
        let folders = FSCollections([.init(id: "c", name: "Clips", entries: [index.file(id: "x2")!, index.file(id: "x1")!])])
        let names = folders.children(of: "Collections/Clips")?.map(\.name)
        #expect(Set(names ?? []) == ["Clip.mov", "clip (2).mov"], "the older keeps its name, whatever order they came in")
        #expect(FSCollections([]).isEmpty, "no collections, no folder")
    }
}

/// CollectionsFolder: what it builds from what it holds.
struct CollectionsFolderTests {
    static func collection(_ id: String, _ name: String, drive: String = "d1") -> FileCollection {
        let json = #"{ "id": "\#(id)", "driveId": "\#(drive)", "name": "\#(name)", "match": "all", "rules": [] }"#
        return try! JSONDecoder().decode(FileCollection.self, from: Data(json.utf8))
    }

    @Test func itShowsThisDrivesCollectionsWithTheFilesTheMirrorsHold() async {
        let index = FSBridgeTests.index(FSBridgeTests.drive, folders: FSBridgeTests.folders)
        let far = FSBridgeTests.index([FSBridgeTests.item("far", "far.png")]).file(id: "far")!
        let folder = CollectionsFolder(scope: .drive(id: "d1"), api: { OnyxAPI() },
                                       elsewhere: { ids in ids.contains("far") ? ["far": far] : [:] })
        await folder.setForTesting([Self.collection("c1", "Picks"), Self.collection("c9", "Not here", drive: "d2")],
                                   files: ["c1": ["a", "far", "gone"]])
        let built = await folder.folders(index: index, mirrorRevision: 1)
        #expect(built.children(of: "Collections")?.map(\.name) == ["Picks"], "only this drive's")
        // A file neither mirror holds yet (still syncing) is left out.
        #expect(Set(built.children(of: "Collections/Picks")?.compactMap(\.fileId) ?? []) == ["a", "far"])
        let again = await folder.folders(index: index, mirrorRevision: 1)
        #expect(again == built)
    }

    @Test func aWaitEndsOnAChangeOrItsTimeout() async {
        let folder = CollectionsFolder(scope: .library, api: { OnyxAPI() })
        let start = ContinuousClock.now
        await folder.waitForChange(after: 0, timeout: .milliseconds(50))
        #expect(ContinuousClock.now - start < .seconds(2))
        async let waited: Void = folder.waitForChange(after: 0, timeout: .seconds(10))
        try? await Task.sleep(for: .milliseconds(20))
        await folder.setForTesting([], files: [:])
        await waited
        #expect(ContinuousClock.now - start < .seconds(5), "the change ended it, not the timeout")
    }
}
