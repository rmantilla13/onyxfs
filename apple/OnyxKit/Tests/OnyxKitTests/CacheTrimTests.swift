import Foundation
import Testing
@testable import OnyxKit

/// The phone's caches on disk, held under their caps: the least recently
/// used go first, what is on screen never does, and the folder is listed
/// only when it may be past its cap.
struct CacheTrimTests {
    typealias Entry = CacheTrim.Entry<String>

    static func at(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: seconds) }

    @Test func withinTheCapNothingGoes() {
        let trim = CacheTrim(limit: 100, trimTo: 60)
        let entries = [Entry(id: "a", bytes: 50, lastUse: Self.at(1)), Entry(id: "b", bytes: 50, lastUse: Self.at(2))]
        #expect(trim.plan(entries) == .init(delete: [], left: 100), "at the cap is within it")
        #expect(trim.plan([Entry]()) == .init(delete: [], left: 0))
    }

    @Test func pastTheCapTheLeastRecentlyUsedGoDownToTheMargin() {
        let trim = CacheTrim(limit: 100, trimTo: 60)
        let entries = [
            Entry(id: "newest", bytes: 30, lastUse: Self.at(40)),
            Entry(id: "oldest", bytes: 30, lastUse: Self.at(10)),
            Entry(id: "middle", bytes: 30, lastUse: Self.at(30)),
            Entry(id: "older", bytes: 30, lastUse: Self.at(20)),
        ]
        let plan = trim.plan(entries)
        #expect(plan.delete == ["oldest", "older"])
        #expect(plan.left == 60)
    }

    @Test func ofTwoUsedTogetherTheBiggerGoesFirst() {
        let trim = CacheTrim(limit: 100, trimTo: 80)
        let entries = [
            Entry(id: "small", bytes: 10, lastUse: Self.at(5)),
            Entry(id: "big", bytes: 40, lastUse: Self.at(5)),
            Entry(id: "recent", bytes: 60, lastUse: Self.at(9)),
        ]
        #expect(trim.plan(entries) == .init(delete: ["big"], left: 70))
    }

    @Test func whatIsHeldStaysHoweverOld() {
        let trim = CacheTrim(limit: 100, trimTo: 50)
        let entries = [
            Entry(id: "open", bytes: 80, lastUse: Self.at(1)),
            Entry(id: "a", bytes: 20, lastUse: Self.at(2)),
            Entry(id: "b", bytes: 20, lastUse: Self.at(3)),
        ]
        let plan = trim.plan(entries, held: ["open"])
        #expect(plan.delete == ["a", "b"], "everything else goes, and still more than the margin is left")
        #expect(plan.left == 80)
        #expect(trim.plan(entries).delete == ["open"], "not held, the oldest goes and is enough")
    }

    @Test func theMarginIsNeverAboveTheCap() {
        #expect(CacheTrim(limit: 100, trimTo: 500).trimTo == 100)
    }

    @Test func aFolderNeverCountedIsCounted() {
        var tally = CacheTally()
        #expect(tally.mayExceed(100))
        let first = tally.beginCount(over: 100)
        let again = tally.beginCount(over: 100)
        #expect(first)
        #expect(!again, "not twice at once")
        tally.endCount(left: 40)
        #expect(!tally.mayExceed(100))
        let later = tally.beginCount(over: 100)
        #expect(!later, "nothing written since: no listing")
    }

    @Test func writesAddUpToAnotherCount() {
        var tally = CacheTally()
        _ = tally.beginCount(over: 100)
        tally.endCount(left: 40)
        tally.wrote(30)
        tally.wrote(30)
        let within = tally.beginCount(over: 100)
        #expect(!within, "70 is within 100")
        tally.wrote(31)
        let past = tally.beginCount(over: 100)
        #expect(past)
        #expect(tally.written == 0, "what came before is in this count")
    }

    @Test func whatIsWrittenDuringACountIsTalliedAfterIt() {
        var tally = CacheTally()
        _ = tally.beginCount(over: 100)
        tally.wrote(70)
        tally.endCount(left: 40)
        #expect(tally.mayExceed(100), "the count may have missed it: tallied again")
    }

    @Test func aFolderThatCouldNotBeReadIsCountedAgain() {
        var tally = CacheTally()
        _ = tally.beginCount(over: 100)
        tally.endCount(left: nil)
        let again = tally.beginCount(over: 100)
        #expect(again)
    }

    @Test func emptiedIsZero() {
        var tally = CacheTally()
        tally.wrote(500)
        tally.emptied()
        #expect(tally.counted == 0)
        #expect(!tally.mayExceed(100))
        tally.wrote(-5)
        #expect(tally.written == 0, "nothing is ever written back")
    }
}
