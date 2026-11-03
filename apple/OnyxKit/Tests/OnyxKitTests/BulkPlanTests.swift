import Foundation
import Testing
@testable import OnyxKit

/// Acting on several folders at once in the iPhone app: which folders a
/// move or a delete acts on, which a destination leaves alone, and what the
/// one confirmation promises — never Trash for a delete that is for good.
@Suite struct BulkPlanTests {
    @Test func eachFolderOnceAndNoneInsideAnother() {
        #expect(BulkPlan.outermost(["Stills", "Footage", "Stills"]) == ["Stills", "Footage"])
        #expect(BulkPlan.outermost(["A/B/C", "A", "D"]) == ["A", "D"])
        #expect(BulkPlan.outermost(["Projects/2024", "Projects/2024 old"]) == ["Projects/2024", "Projects/2024 old"])
        #expect(BulkPlan.outermost(["", "A"]) == ["A"])
    }

    @Test func aMoveGoesWhereNoneOfThemIsAndIntoNoneOfThem() {
        #expect(BulkPlan.planMove(["Work/A", "Work/B"], to: "Archive").move == ["Work/A", "Work/B"])
        let here = BulkPlan.planMove(["Work/A", "Work/B"], to: "Work")
        #expect(here.move.isEmpty && here.here == ["Work/A", "Work/B"])
        #expect(BulkPlan.planMove(["A", "B"], to: "").here == ["A", "B"])
        #expect(BulkPlan.planMove(["Work/A"], to: "").move == ["Work/A"])
        #expect(BulkPlan.planMove(["Work/A", "Work/B"], to: "Work/B/Q1").into == ["Work/B"])
        #expect(BulkPlan.planMove(["Work/A"], to: "Work/A old").move == ["Work/A"])
        #expect(BulkPlan.planMove(["A", "A/B"], to: "C").move == ["A"])
    }

    @Test func summariesAddUpAndToleratePartialAnswers() throws {
        let s = try JSONDecoder().decode(BulkPlan.Summary.self, from: Data(#"{"files":3}"#.utf8))
        #expect(s == BulkPlan.Summary(files: 3))
        #expect(BulkPlan.Summary.sum([.init(files: 3, folders: 1), .init(files: 10, outside: 2)])
                == .init(files: 13, folders: 1, outside: 2))
    }

    @Test func howManyOfWhat() {
        #expect(BulkPlan.describe(folders: 1, files: 0) == "1 folder")
        #expect(BulkPlan.describe(folders: 3, files: 0) == "3 folders")
        #expect(BulkPlan.describe(folders: 0, files: 4) == "4 files")
        #expect(BulkPlan.describe(folders: 2, files: 3) == "5 items")
        #expect(BulkPlan.describe(folders: 2, files: 3, exact: true) == "2 folders and 3 files")
        #expect(BulkPlan.describe(folders: 0, files: 1200) == "1,200 files")
    }

    @Test func theConfirmationSaysWhereTheFilesGo() {
        let trash = BulkPlan.deleteWords(folders: 3, files: 0, inside: .init(files: 40, folders: 5), trash: true)
        #expect(trash.title == "Delete 3 folders?")
        #expect(trash.confirm == "Delete 3 folders")
        #expect(trash.message.hasPrefix("They hold 40 files and 5 subfolders. The files go to Trash"))
        let gone = BulkPlan.deleteWords(folders: 2, files: 0, inside: .init(files: 12), trash: false)
        #expect(gone.message == "They hold 12 files. All 12 files will be permanently deleted. This cannot be undone.")
    }

    @Test func neverPromisesTrashItCannotVouchFor() {
        for trash: Bool? in [false, nil] {
            #expect(!BulkPlan.deleteWords(folders: 2, files: 1, inside: .init(files: 4), trash: trash).message.contains("restored"))
        }
        #expect(!BulkPlan.deleteWords(folders: 2, files: 0, inside: .init(files: 4), trash: true).message.contains("cannot be undone"))
    }

    @Test func emptyFoldersAndPickedFiles() {
        #expect(BulkPlan.deleteWords(folders: 2, files: 0, inside: .init(), trash: true).message == "They are empty.")
        let mixed = BulkPlan.deleteWords(folders: 2, files: 3, inside: .init(files: 10), trash: true)
        #expect(mixed.title == "Delete 2 folders and 3 files?")
        #expect(mixed.confirm == "Delete 5 items")
        #expect(mixed.message.hasPrefix("The folders hold 10 files."))
    }

    @Test func howItWent() {
        #expect(BulkPlan.movedWords(folders: (3, 3), to: "Archive") == "Moved 3 folders to Archive.")
        #expect(BulkPlan.movedWords(folders: (2, 3), files: (1, 1), to: "All Files") == "Moved 2 of 3 folders and 1 file to All Files.")
        #expect(BulkPlan.movedWords(folders: (0, 2), to: "Archive") == nil)
        #expect(BulkPlan.deletedWords(folders: (3, 3), files: 2) == "Deleted 3 folders and 2 files.")
        #expect(BulkPlan.deletedWords(folders: (1, 2)) == "Deleted 1 of 2 folders.")
        #expect(BulkPlan.deletedWords(folders: (0, 2)) == nil)
    }
}
