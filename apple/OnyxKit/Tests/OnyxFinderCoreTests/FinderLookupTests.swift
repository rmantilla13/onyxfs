import Testing
import Foundation
@testable import OnyxFinderCore

// MARK: - Fixtures

/// A drive as the app would hand it over.
func drive(_ root: String, scope: String = "drive.d1", name: String = "Footage",
           folders: [String] = [], files: [String] = [], pending: [String] = [],
           pendingLimit: Int = FinderIndex.Drive.pendingLimit) -> FinderIndex.Drive {
    FinderIndex.Drive(root: root, scope: scope, name: name, folders: folders, files: files,
                      pending: pending, pendingLimit: pendingLimit)
}

func lookup(_ drives: FinderIndex.Drive...) -> FinderLookup {
    FinderLookup(FinderIndex(generation: 1, signedIn: true, drives: drives))
}

// MARK: - Paths

/// Paths compare as the disks compare names: whole segments, no case, no
/// Unicode spelling. A slip here marks a neighbour's files, or misses a
/// folder's.
struct FinderPathTests {
    @Test func keysFoldCaseAndSpellingAndSlashes() {
        #expect(FinderPath.key("/Photos//2024/") == "photos/2024")
        // "é" typed as one character, and as "e" and a combining accent.
        #expect(FinderPath.key("Caf\u{E9}") == FinderPath.key("Cafe\u{301}"))
        #expect(FinderPath.key("") == "")
    }

    @Test func ancestorsEndWithTheDrive() {
        #expect(FinderPath.ancestors("a/b/c") == ["a/b", "a", ""])
        #expect(FinderPath.ancestors("a") == [""])
        #expect(FinderPath.ancestors("").isEmpty)
    }

    @Test func aFolderHoldsWholeSegmentsOnly() {
        #expect(FinderPath.isAtOrUnder("photos/a.jpg", "photos"))
        #expect(FinderPath.isAtOrUnder("photos", "photos"))
        #expect(!FinderPath.isAtOrUnder("photos 2025/a.jpg", "photos"))
        #expect(!FinderPath.isAtOrUnder("photo", "photos"))
        #expect(FinderPath.isAtOrUnder("anything/at/all", ""))
    }
}

// MARK: - Where an item is

struct FinderLookupLocationTests {
    @Test func aDiskOfItsOwnAndAFolderMountAreBothFound() {
        let l = lookup(drive("/Volumes/Footage", scope: "drive.d1"),
                       drive("/Users/me/Onyx/Clients", scope: "drive.d2", name: "Clients"))
        let onDisk = l.locate("/Volumes/Footage/Day 1/A001.mov")
        #expect(onDisk?.scope == "drive.d1")
        #expect(onDisk?.path == "Day 1/A001.mov")
        let inFolder = l.locate("/Users/me/Onyx/Clients/Acme/brief.pdf")
        #expect(inFolder?.scope == "drive.d2")
        #expect(inFolder?.path == "Acme/brief.pdf")
    }

    @Test func theDriveItselfIsTheEmptyPath() {
        let l = lookup(drive("/Volumes/Footage"))
        #expect(l.locate("/Volumes/Footage")?.path == "")
        #expect(l.locate("/Volumes/Footage/")?.path == "")
    }

    @Test func caseAndSlashesAreForgivenAndTheItemsOwnSpellingKept() {
        let l = lookup(drive("/Volumes/Footage"))
        #expect(l.locate("/volumes/FOOTAGE//Day 1/")?.path == "Day 1")
    }

    @Test func aNeighbourWhoseNameBeginsTheSameIsNotInside() {
        let l = lookup(drive("/Users/me/Onyx/Footage", scope: "drive.d1"),
                       drive("/Users/me/Onyx/Footage (2)", scope: "drive.d2"))
        #expect(l.locate("/Users/me/Onyx/Footage (2)/a.mov")?.scope == "drive.d2")
        #expect(l.locate("/Users/me/Onyx/Footage/a.mov")?.scope == "drive.d1")
        #expect(l.locate("/Users/me/Onyx/Footage2/a.mov") == nil)
    }

    @Test func somewhereElseIsInNoDrive() {
        let l = lookup(drive("/Volumes/Footage"))
        #expect(l.locate("/Volumes/Other/a.mov") == nil)
        #expect(l.locate("/Volumes") == nil)
        #expect(l.state(of: "/Users/me/Desktop/a.mov") == nil)
        #expect(l.badge(for: "/Users/me/Desktop/a.mov") == nil)
        #expect(FinderLookup.empty.locate("/Volumes/Footage/a.mov") == nil)
    }

    @Test func theDeeperRootWins() {
        // Not a layout the app makes, but the answer must not depend on order.
        let l = lookup(drive("/Users/me/Onyx", scope: "drive.outer"),
                       drive("/Users/me/Onyx/Inner", scope: "drive.inner"))
        #expect(l.locate("/Users/me/Onyx/Inner/a")?.scope == "drive.inner")
        #expect(l.locate("/Users/me/Onyx/Other/a")?.scope == "drive.outer")
    }
}

// MARK: - Kept, and on its way

struct FinderLookupStateTests {
    let root = "/Volumes/Footage"

    @Test func aFileKeptByItsOwnRule() throws {
        let l = lookup(drive(root, files: ["Day 1/A001.mov"]))
        let state = try #require(l.state(of: "\(root)/Day 1/A001.mov"))
        #expect(state.kept == .own)
        #expect(!state.isKeptFolder)
        #expect(l.badge(for: "\(root)/Day 1/A001.mov") == .kept)
        #expect(l.state(of: "\(root)/Day 1/A002.mov")?.kept == FinderLookup.Kept.no)
        #expect(l.badge(for: "\(root)/Day 1/A002.mov") == nil)
        // The folder holding it is not kept for it.
        #expect(l.badge(for: "\(root)/Day 1") == nil)
    }

    @Test func aKeptFolderKeepsEverythingInIt() throws {
        let l = lookup(drive(root, folders: ["Day 1"]))
        #expect(l.state(of: "\(root)/Day 1")?.kept == .own)
        #expect(l.state(of: "\(root)/Day 1")?.isKeptFolder == true)
        #expect(l.state(of: "\(root)/day 1/Sub/A001.mov")?.kept == .with(folder: "Day 1"))
        #expect(l.badge(for: "\(root)/Day 1/Sub") == .kept)
        #expect(l.state(of: "\(root)/Day 10/A001.mov")?.kept == FinderLookup.Kept.no)
        #expect(l.state(of: "\(root)")?.kept == FinderLookup.Kept.no)
    }

    @Test func theNearestKeptFolderIsTheOneNamed() {
        let l = lookup(drive(root, folders: ["", "Day 1"]))
        #expect(l.state(of: "\(root)/Day 1/A001.mov")?.kept == .with(folder: "Day 1"))
        #expect(l.state(of: "\(root)/Day 2/A001.mov")?.kept == .with(folder: ""))
        #expect(l.state(of: root)?.kept == .own)
        #expect(l.state(of: root)?.isKeptFolder == true)
    }

    @Test func aFileOfItsOwnInAKeptFolderIsItsOwn() {
        let l = lookup(drive(root, folders: ["Day 1"], files: ["Day 1/A001.mov"]))
        #expect(l.state(of: "\(root)/Day 1/A001.mov")?.kept == .own)
        #expect(l.state(of: "\(root)/Day 1/A002.mov")?.kept == .with(folder: "Day 1"))
    }

    @Test func whatIsOnItsWayIsMarkedSo() {
        let l = lookup(drive(root, folders: ["Day 1"], files: ["Selects/B.mov"],
                             pending: ["Day 1/Sub/A002.mov", "Selects/B.mov"]))
        #expect(l.badge(for: "\(root)/Day 1/Sub/A002.mov") == .pending)
        #expect(l.badge(for: "\(root)/Day 1/Sub/A001.mov") == .kept)
        // A folder with something on its way beneath it is on its way.
        #expect(l.badge(for: "\(root)/Day 1/Sub") == .pending)
        #expect(l.badge(for: "\(root)/Day 1") == .pending)
        #expect(l.badge(for: "\(root)/Selects/B.mov") == .pending)
        // Not kept: no mark, whatever lies beneath.
        #expect(l.badge(for: "\(root)/Selects") == nil)
        #expect(l.badge(for: root) == nil)
    }

    @Test func tooManyOnTheirWayMarkTheirWholeFolder() {
        let pending = (0..<10).map { "Day 1/A\($0).mov" } + ["Selects/B.mov"]
        let d = drive(root, folders: ["Day 1"], files: ["Selects/B.mov"], pending: pending, pendingLimit: 5)
        #expect(d.pendingIn == ["Day 1"])
        #expect(d.pending == ["Selects/B.mov"])
        let l = lookup(d)
        // Everything in the folder counts as on its way, until the rest fit.
        #expect(l.badge(for: "\(root)/Day 1/anything.mov") == .pending)
        #expect(l.badge(for: "\(root)/Day 1") == .pending)
        #expect(l.badge(for: "\(root)/Selects/B.mov") == .pending)
    }

    @Test func namesAreComparedAsTheDiskComparesThem() {
        let l = lookup(drive(root, folders: ["Caf\u{E9}"]))
        #expect(l.badge(for: "\(root)/CAFE\u{301}/menu.pdf") == .kept)
    }
}

// MARK: - The index itself

struct FinderIndexTests {
    @Test func aRoundTripKeepsEverything() throws {
        let index = FinderIndex(generation: 7, signedIn: true, drives: [
            drive("/Volumes/Footage", folders: ["", "Day 1"], files: ["a.mov"], pending: ["a.mov"]),
        ])
        #expect(FinderIndex.decode(index.encoded()) == index)
        #expect(FinderIndex.decode(Data("not json".utf8)) == nil)
    }

    @Test func pendingWithinTheLimitIsListedAsIs() {
        let d = drive("/Volumes/Footage", folders: ["Day 1"], pending: ["Day 1/a", "Day 1/b"], pendingLimit: 2)
        #expect(d.pending == ["Day 1/a", "Day 1/b"])
        #expect(d.pendingIn.isEmpty)
    }

    @Test func pendingPastTheLimitGoesToTheOutermostKeptFolder() {
        let pending = ["Day 1/Sub/a", "Day 1/b", "Day 2/c", "loose1", "loose2", "loose3"]
        let d = drive("/Volumes/Footage", folders: ["Day 1/Sub", "Day 1", "Day 2"], files: ["loose1", "loose2", "loose3"],
                      pending: pending, pendingLimit: 2)
        #expect(d.pendingIn == ["Day 1", "Day 2"])
        // Files kept on their own are still named, up to the limit.
        #expect(d.pending == ["loose1", "loose2"])
    }
}
