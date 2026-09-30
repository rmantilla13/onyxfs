import Testing
import Foundation
@testable import OnyxFinderCore

/// What the right-click menu offers, for what is selected: the web's rules
/// (app/files/FilesClient.js), so a file reads the same in Finder as on the
/// page.
struct FinderMenuTests {
    let root = "/Volumes/Footage"

    var kept: FinderLookup {
        lookup(drive(root, name: "Footage", folders: ["Day 1"], files: ["Selects/B.mov", "Selects/C.mov"]))
    }

    @Test func aFileNotKeptIsOfferedKeepOffline() {
        let plan = FinderMenuPlan.make(for: ["\(root)/Selects/A.mov"], in: kept)
        #expect(plan.keep == ["\(root)/Selects/A.mov"])
        #expect(plan.remove.isEmpty)
        #expect(plan.note == nil)
        #expect(plan.show == "\(root)/Selects/A.mov")
    }

    @Test func aFileKeptByItsOwnRuleIsOfferedRemove() {
        let plan = FinderMenuPlan.make(for: ["\(root)/Selects/B.mov"], in: kept)
        #expect(plan.keep.isEmpty)
        #expect(plan.remove == ["\(root)/Selects/B.mov"])
        #expect(plan.removeTitle == "Remove Offline Copy")
    }

    @Test func aKeptFolderLetsGoOfCopies() {
        let plan = FinderMenuPlan.make(for: ["\(root)/Day 1"], in: kept)
        #expect(plan.remove == ["\(root)/Day 1"])
        #expect(plan.removeTitle == "Remove Offline Copies")
    }

    @Test func somethingAKeptFolderKeepsSaysSoInstead() {
        let plan = FinderMenuPlan.make(for: ["\(root)/Day 1/A001.mov"], in: kept)
        #expect(plan.keep.isEmpty)
        #expect(plan.remove.isEmpty)
        #expect(plan.note == "Kept Offline with \u{201C}Day 1\u{201D}")
        #expect(plan.show == "\(root)/Day 1/A001.mov")
    }

    @Test func theWholeDriveIsNamedByTheDrive() {
        let l = lookup(drive(root, name: "Footage", folders: [""]))
        #expect(FinderMenuPlan.make(for: ["\(root)/a/b.mov"], in: l).note == "Kept Offline with \u{201C}Footage\u{201D}")
        // The drive itself, right-clicked where it is shown.
        let plan = FinderMenuPlan.make(for: [root], in: l)
        #expect(plan.remove == [root])
        #expect(plan.removeTitle == "Remove Offline Copies")
    }

    @Test func aMixedSelectionIsOfferedBothEachForItsOwn() {
        let items = ["\(root)/Selects/A.mov", "\(root)/Selects/B.mov", "\(root)/Day 1/A001.mov", "\(root)/Other"]
        let plan = FinderMenuPlan.make(for: items, in: kept)
        #expect(plan.keep == ["\(root)/Selects/A.mov", "\(root)/Other"])
        #expect(plan.remove == ["\(root)/Selects/B.mov"])
        // What the folder keeps is the folder's to let go of: in neither list.
        #expect(plan.note == nil)
        // Show in Onyx is for one item.
        #expect(plan.show == nil)
    }

    @Test func severalOwnCopiesAreCopies() {
        let plan = FinderMenuPlan.make(for: ["\(root)/Selects/B.mov", "\(root)/Selects/C.mov"], in: kept)
        #expect(plan.removeTitle == "Remove Offline Copies")
    }

    @Test func itemsKeptWithDifferentFoldersSayTheirFolders() {
        let l = lookup(drive(root, folders: ["Day 1", "Day 2"]))
        let plan = FinderMenuPlan.make(for: ["\(root)/Day 1/a", "\(root)/Day 2/b"], in: l)
        #expect(plan.note == "Kept Offline with Their Folders")
        let same = FinderMenuPlan.make(for: ["\(root)/Day 1/a", "\(root)/day 1/b"], in: l)
        #expect(same.note == "Kept Offline with \u{201C}Day 1\u{201D}")
    }

    @Test func nothingOutsideADriveIsOffered() {
        let plan = FinderMenuPlan.make(for: ["/Users/me/Desktop/a.mov"], in: kept)
        #expect(plan.isEmpty)
        #expect(FinderMenuPlan.make(for: [], in: kept).isEmpty)
        // Mixed with something inside: only that is acted on.
        let mixed = FinderMenuPlan.make(for: ["/Users/me/Desktop/a.mov", "\(root)/Selects/A.mov"], in: kept)
        #expect(mixed.keep == ["\(root)/Selects/A.mov"])
        #expect(mixed.show == "\(root)/Selects/A.mov")
    }

    @Test func twoDrivesAtOnce() {
        let l = lookup(drive(root, scope: "drive.d1", folders: ["Day 1"]),
                       drive("/Users/me/Onyx/Clients", scope: "drive.d2", name: "Clients"))
        let plan = FinderMenuPlan.make(for: ["\(root)/Day 1", "/Users/me/Onyx/Clients/brief.pdf"], in: l)
        #expect(plan.remove == ["\(root)/Day 1"])
        #expect(plan.keep == ["/Users/me/Onyx/Clients/brief.pdf"])
    }
}

/// The names both sides derive, and the requests the app will read.
struct FinderWireTests {
    @Test func namesComeFromTheAppsIdentifier() {
        #expect(FinderWire.app(forExtension: "io.onyxfs.app.findersync") == "io.onyxfs.app")
        #expect(FinderWire.app(forExtension: "io.onyxfs.app.dev.findersync") == "io.onyxfs.app.dev")
        #expect(FinderWire.app(forExtension: "io.onyxfs.app.fs") == nil)
        #expect(FinderWire.app(forExtension: ".findersync") == nil)
        #expect(FinderWire.portName(app: "io.onyxfs.app") == "io.onyxfs.app.finder")
        #expect(FinderWire.portName(app: "io.onyxfs.app.dev") != FinderWire.portName(app: "io.onyxfs.app"))
        #expect(FinderWire.changedNotification(app: "io.onyxfs.app") == "io.onyxfs.app.finder.changed")
    }

    @Test func requestsRoundTripAndTooManyAreRefused() {
        let request = FinderWire.Request(paths: ["/Volumes/Footage/a.mov"])
        #expect(FinderWire.Request.decode(request.encoded()) == request)
        let tooMany = FinderWire.Request(paths: Array(repeating: "/a", count: FinderWire.maxPaths + 1))
        #expect(FinderWire.Request.decode(tooMany.encoded()) == nil)
        #expect(FinderWire.Request.decode(Data("{}".utf8)) == nil)
        let reply = FinderWire.Reply(ok: false, message: "Sign in to Onyx.")
        #expect(FinderWire.Reply.decode(reply.encoded()) == reply)
    }
}
