import Testing
import Foundation
@testable import OnyxKit

/// Onyx out of App Nap while it has work in flight: the activity begins with
/// the first work, ends `linger` after the last, is held once however much
/// work there is, and nothing is held — no timer set — while there is none.
@Suite struct WorkActivityTests {
    /// Time the test moves, and the timers set against it.
    final class Timers: @unchecked Sendable {
        private let lock = NSLock()
        private var now: Duration = .zero
        private var pending: [(id: Int, at: Duration, run: @Sendable () -> Void)] = []
        private var lastID = 0
        /// A timer called off fires all the same: one that went off just as
        /// it was called off, its callback already on its way.
        private let firesWhenCalledOff: Bool

        init(firesWhenCalledOff: Bool = false) { self.firesWhenCalledOff = firesWhenCalledOff }

        var later: WorkActivity.Later {
            { [self] delay, run in
                let id = lock.withLock { () -> Int in
                    lastID += 1
                    pending.append((lastID, now + delay, run))
                    return lastID
                }
                return { [self] in
                    guard !firesWhenCalledOff else { return }
                    lock.withLock { pending.removeAll { $0.id == id } }
                }
            }
        }

        /// Timers set and not yet fired or called off.
        var count: Int { lock.withLock { pending.count } }

        /// Moves time on, firing what falls due, in order.
        func advance(_ by: Duration) {
            let end = lock.withLock { now + by }
            while let due = lock.withLock({ () -> (@Sendable () -> Void)? in
                guard let next = pending.filter({ $0.at <= end }).min(by: { $0.at < $1.at }) else { return nil }
                pending.removeAll { $0.id == next.id }
                now = next.at
                return next.run
            }) {
                due()
            }
            lock.withLock { now = end }
        }
    }

    /// The activity as ProcessInfo would hold it.
    final class Activity: @unchecked Sendable {
        final class Token {}
        private let lock = NSLock()
        private var begun: [String] = []
        private var endings = 0

        var begin: @Sendable (String) -> AnyObject {
            { [self] reason in
                lock.withLock { begun.append(reason) }
                return Token()
            }
        }
        var end: @Sendable (AnyObject) -> Void { { [self] _ in lock.withLock { endings += 1 } } }
        var began: Int { lock.withLock { begun.count } }
        var ended: Int { lock.withLock { endings } }
        var reasons: [String] { lock.withLock { begun } }
    }

    final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var on: Bool
        init(_ on: Bool) { self.on = on }
        var value: Bool {
            get { lock.withLock { on } }
            set { lock.withLock { on = newValue } }
        }
    }

    final class Lines: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [String] = []
        func add(_ line: String) { lock.withLock { all.append(line) } }
        var lines: [String] { lock.withLock { all } }
    }

    private func make(_ timers: Timers, _ activity: Activity) -> WorkActivity {
        WorkActivity(linger: .seconds(5), begin: activity.begin, end: activity.end, later: timers.later)
    }

    @Test func idleHoldsNothingAndSetsNoTimer() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        work.set(.uploads, false)
        work.set(.thumbnails, false)
        #expect(!work.isHeld)
        #expect(work.reasons.isEmpty)
        #expect(activity.began == 0)
        #expect(timers.count == 0)
    }

    @Test func workBeginsTheActivityAtOnceAndOnlyOnce() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        work.set(.uploads, true)
        #expect(work.isHeld)
        #expect(activity.began == 1)
        #expect(activity.reasons == ["Onyx: uploads"])
        work.set(.uploads, true)
        work.set(.thumbnails, true)
        let hold = work.begin(.offlineCopies)
        #expect(activity.began == 1)
        #expect(work.reasons == [.uploads, .offlineCopies, .thumbnails])
        hold.end()
        // Still busy: no end is set.
        #expect(timers.count == 0)
        #expect(work.reasons == [.uploads, .thumbnails])
    }

    @Test func itEndsALingerAfterTheLastWork() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        work.set(.uploads, true)
        work.set(.thumbnails, true)
        work.set(.uploads, false)
        #expect(timers.count == 0)
        work.set(.thumbnails, false)
        // Lingering.
        #expect(work.isHeld)
        #expect(timers.count == 1)
        timers.advance(.milliseconds(4_900))
        #expect(work.isHeld)
        timers.advance(.milliseconds(100))
        #expect(!work.isHeld)
        #expect(activity.ended == 1)
        #expect(timers.count == 0)
    }

    @Test func workWithinTheLingerKeepsTheSameActivity() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        work.set(.uploads, true)
        work.set(.uploads, false)
        timers.advance(.seconds(3))
        let hold = work.begin(.proxies)
        // The end is called off, not left to fire.
        #expect(timers.count == 0)
        timers.advance(.seconds(30))
        #expect(work.isHeld)
        #expect(activity.began == 1)
        #expect(activity.ended == 0)
        hold.end()
        timers.advance(.seconds(5))
        #expect(!work.isHeld)
        #expect(activity.began == 1)
        #expect(activity.ended == 1)
    }

    @Test func aBurstOfWorkBeginsAndEndsItOnce() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        // A folder of photos: each up in half a second, a second apart.
        for _ in 0..<100 {
            let hold = work.begin(.uploads)
            timers.advance(.milliseconds(500))
            hold.end()
            timers.advance(.seconds(1))
        }
        #expect(work.isHeld)
        timers.advance(.seconds(5))
        #expect(!work.isHeld)
        #expect(activity.began == 1)
        #expect(activity.ended == 1)
    }

    @Test func holdsAreCountedAndEachEndsOnce() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        let first = work.begin(.offlineCopies)
        let second = work.begin(.offlineCopies)
        first.end()
        first.end()
        #expect(work.reasons == [.offlineCopies])
        #expect(timers.count == 0)
        second.end()
        timers.advance(.seconds(5))
        #expect(!work.isHeld)
        #expect(activity.ended == 1)
    }

    @Test func aHoldLetGoOfEndsItsWork() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        var hold: WorkActivity.Hold? = work.begin(.uploads)
        #expect(hold != nil)
        #expect(work.isHeld)
        hold = nil
        #expect(work.reasons.isEmpty)
        timers.advance(.seconds(5))
        #expect(!work.isHeld)
        #expect(activity.ended == 1)
    }

    @Test func workOverWithinItsGraceNeverTouchesTheActivity() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        // A sync with nothing new: a few hundred bytes, over at once.
        let hold = work.begin(.sync, grace: .seconds(2))
        #expect(!work.isHeld)
        #expect(work.reasons.isEmpty)
        #expect(timers.count == 1)
        timers.advance(.milliseconds(1_900))
        hold.end()
        // Its grace is called off, unfired.
        #expect(timers.count == 0)
        timers.advance(.seconds(60))
        #expect(activity.began == 0)
    }

    @Test func workPastItsGraceHoldsUntilItEnds() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        let hold = work.begin(.sync, grace: .seconds(2))
        timers.advance(.seconds(2))
        #expect(work.isHeld)
        #expect(work.reasons == [.sync])
        timers.advance(.seconds(20))
        hold.end()
        timers.advance(.seconds(5))
        #expect(!work.isHeld)
        #expect(activity.began == 1)
        #expect(activity.ended == 1)
    }

    @Test func bytesGoingByAreHeldUntilTheyStop() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        let quiet = Flag(false)
        work.poke(.transfers, every: .seconds(2)) { quiet.value }
        work.poke(.transfers, every: .seconds(2)) { quiet.value }
        #expect(work.isHeld)
        #expect(timers.count == 1)
        // Still moving: looked at every two seconds, one timer at a time.
        timers.advance(.seconds(10))
        #expect(work.reasons == [.transfers])
        #expect(timers.count == 1)
        quiet.value = true
        timers.advance(.seconds(2))
        #expect(work.reasons.isEmpty)
        #expect(work.isHeld)
        timers.advance(.seconds(5))
        #expect(!work.isHeld)
        #expect(timers.count == 0)
        // Bytes again, after the end: watched afresh.
        quiet.value = false
        work.poke(.transfers, every: .seconds(2)) { quiet.value }
        #expect(work.isHeld)
        #expect(activity.began == 2)
    }

    @Test func anEndThatFiresAfterItWasCalledOffChangesNothing() {
        let timers = Timers(firesWhenCalledOff: true), activity = Activity()
        let work = make(timers, activity)
        work.set(.uploads, true)
        work.set(.uploads, false)
        // Work again: the end is called off, but fires anyway.
        work.set(.uploads, true)
        timers.advance(.seconds(10))
        #expect(work.isHeld)
        #expect(activity.ended == 0)
        work.set(.uploads, false)
        timers.advance(.seconds(5))
        #expect(!work.isHeld)
        #expect(activity.ended == 1)
    }

    @Test func itSaysWhenItBeginsAndEnds() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        let seen = Lines()
        work.onChange = { held, reasons in seen.add("\(held) \(reasons.map(\.rawValue).joined(separator: ", "))") }
        work.set(.proxies, true)
        work.set(.transcripts, true)
        work.set(.proxies, false)
        work.set(.transcripts, false)
        timers.advance(.seconds(5))
        #expect(seen.lines == ["true streamable versions", "false "])
    }

    @Test func manyThreadsAtOnceLeaveItBalanced() {
        let timers = Timers(), activity = Activity()
        let work = make(timers, activity)
        let reasons = WorkActivity.Reason.allCases
        DispatchQueue.concurrentPerform(iterations: 400) { i in
            let reason = reasons[i % reasons.count]
            let hold = work.begin(reason, grace: i % 3 == 0 ? .seconds(1) : .zero)
            work.set(reason, true)
            work.set(reason, false)
            hold.end()
        }
        #expect(work.reasons.isEmpty)
        timers.advance(.seconds(10))
        #expect(!work.isHeld)
        #expect(activity.began == 1)
        #expect(activity.ended == 1)
        #expect(timers.count == 0)
    }

    /// ProcessInfo's own activity and dispatch timers, briefly.
    @Test func theRealActivityComesAndGoes() async throws {
        let work = WorkActivity(linger: .milliseconds(50))
        // Over within its grace: nothing held, then or later.
        work.begin(.sync, grace: .milliseconds(100)).end()
        try await Task.sleep(for: .milliseconds(200))
        #expect(!work.isHeld)
        let hold = work.begin(.sync, grace: .milliseconds(30))
        for _ in 0..<100 where !work.isHeld { try await Task.sleep(for: .milliseconds(10)) }
        #expect(work.isHeld)
        hold.end()
        #expect(work.isHeld)
        for _ in 0..<100 where work.isHeld { try await Task.sleep(for: .milliseconds(10)) }
        #expect(!work.isHeld)
    }
}
