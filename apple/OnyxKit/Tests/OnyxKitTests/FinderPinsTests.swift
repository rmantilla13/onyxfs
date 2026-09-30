import Testing
import Foundation
@testable import OnyxKit

// MARK: - Fixtures

private func item(_ id: String, _ name: String, in folder: String = "", etag hash: String? = nil) -> FileItem {
    FileItem(id: id, name: name, folder: folder, kind: "video", mime: "video/quicktime", size: 10, url: nil,
             storageKey: nil, thumbnailUrl: nil, tags: [], notes: nil, caption: nil, visibility: "org",
             version: 1, contentHash: hash, createdBy: nil, createdAt: nil, updatedAt: nil, deletedAt: nil, seq: nil)
}

private func index(_ items: [FileItem], folders: [String]? = nil) -> MirrorIndex {
    var r = Replica()
    r.apply(changed: items, deleted: [], folders: folders)
    return MirrorIndex(r)
}

/// Finder names an item by where it is; a pin names a file by id and a
/// folder by path. A slip between the two pins the wrong thing, or nothing,
/// with no error anywhere.
struct FinderPinsTests {
    let scope = "drive.d1"
    let drive = index([
        item("a1", "A001.mov", in: "Day 1"),
        item("a2", "A002.mov", in: "Day 1/Sub"),
        item("b", "B.mov", in: "Selects"),
        item("x", "x.png", in: "Brand/Logos"),
        item("y", "y.png", in: "brand/logos"),
    ], folders: ["Empty"])

    @Test func aFileIsKeptByItsId() {
        #expect(FinderPins.rule(scope: scope, path: "Day 1/A001.mov", index: drive)
                == PinRule(scope: scope, target: .file(id: "a1")))
        // As Finder may spell it: other case, slashes.
        #expect(FinderPins.rule(scope: scope, path: "/day 1//a001.MOV/", index: drive)
                == PinRule(scope: scope, target: .file(id: "a1")))
    }

    @Test func aFolderIsKeptByTheIndexsPathForIt() {
        #expect(FinderPins.rule(scope: scope, path: "day 1/sub", index: drive)
                == PinRule(scope: scope, target: .folder(path: "Day 1/Sub")))
        #expect(FinderPins.rule(scope: scope, path: "Empty", index: drive)
                == PinRule(scope: scope, target: .folder(path: "Empty")))
        // The folder Finder shows as "brand (2)": its own path, which is what
        // the store looks rules up by, not the server's "brand" — that one
        // is the other folder's.
        #expect(FinderPins.rule(scope: scope, path: "brand (2)", index: drive)
                == PinRule(scope: scope, target: .folder(path: "brand (2)")))
    }

    @Test func theDriveItselfIsTheWholeDrive() {
        #expect(FinderPins.rule(scope: scope, path: "", index: drive) == PinRule(scope: scope, target: .folder(path: "")))
        #expect(FinderPins.rule(scope: scope, path: "/", index: drive) == PinRule(scope: scope, target: .folder(path: "")))
    }

    @Test func whatTheServerDoesNotHaveIsNotPinned() {
        #expect(FinderPins.rule(scope: scope, path: "Day 1/.DS_Store", index: drive) == nil)
        #expect(FinderPins.rule(scope: scope, path: "Day 1/still uploading.mov", index: drive) == nil)
        #expect(FinderPins.rule(scope: scope, path: "Day 1/../Selects", index: drive) == nil)
    }

    @Test func aRuleFromFinderMatchesTheOneTheWebMade() async throws {
        // The web keeps a folder by its path and a file by its id; the store
        // takes Finder's the same, so either one lets go of the other's.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("FinderPins-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try PinStore(directory: folder)
        await store.pin([PinRule(scope: scope, target: .folder(path: "Day 1")), PinRule(scope: scope, target: .file(id: "b"))])
        let fromFinder = [FinderPins.rule(scope: scope, path: "DAY 1", index: drive),
                          FinderPins.rule(scope: scope, path: "Selects/B.mov", index: drive)].compactMap { $0 }
        await store.pin(fromFinder)
        #expect(await store.rules().count == 2, "the same two, not four")
        await store.unpin(fromFinder)
        #expect(await store.rules().isEmpty)
    }

    // MARK: - Show in Onyx

    @Test func showInOnyxOpensTheWebsOwnPage() {
        #expect(FinderPins.webPath(scope: .drive(id: "d1"), path: "Day 1/A001.mov", index: drive) == "/files/a1")
        #expect(FinderPins.webPath(scope: .drive(id: "d1"), path: "Day 1/Sub", index: drive)
                == "/files?filespace=d1&folder=Day%201/Sub")
        #expect(FinderPins.webPath(scope: .drive(id: "d1"), path: "", index: drive) == "/files?filespace=d1")
        #expect(FinderPins.webPath(scope: .library, path: "", index: drive) == "/files")
        #expect(FinderPins.webPath(scope: .library, path: "Selects", index: drive) == "/files?folder=Selects")
        // The server's name for a folder Finder shows under one of its own.
        #expect(FinderPins.webPath(scope: .drive(id: "d1"), path: "brand (2)/logos", index: drive)
                == "/files?filespace=d1&folder=brand/logos")
        #expect(FinderPins.webPath(scope: .drive(id: "d1"), path: "Nowhere", index: drive) == nil)
    }

    @Test func aQueryValueReadsBackAsWritten() throws {
        let odd = index([item("q", "q.mov", in: "Q1+Q2 & more?#")])
        let path = try #require(FinderPins.webPath(scope: .drive(id: "d1"), path: "Q1+Q2 & more?#", index: odd))
        let url = try #require(URL(string: "https://onyx.example" + path))
        let folder = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "folder" }?.value
        #expect(folder == "Q1+Q2 & more?#")
        #expect(path.contains("%2B"), "a + would be a space to the page")
    }

    // MARK: - What a drive keeps, by path

    @Test func keptPathsNameFoldersByRuleFilesWhereTheyAreAndWhatIsOnItsWay() {
        let rules = [PinRule(scope: scope, target: .folder(path: "Day 1")),
                     PinRule(scope: scope, target: .file(id: "b")),
                     PinRule(scope: scope, target: .file(id: "gone"))]
        let wanted = ["a1", "a2", "b"].compactMap { drive.file(id: $0) }
        let kept = KeptPaths.make(rules: rules, index: drive, wanted: wanted, kept: ["a1"])
        #expect(kept.folders == ["Day 1"])
        // A file rule whose file the drive no longer has names nothing.
        #expect(kept.files == ["b": "Selects/B.mov"])
        #expect(kept.pending == ["Day 1/Sub/A002.mov", "Selects/B.mov"])
    }
}
