import Testing
import Foundation
@testable import OnyxKit

/// The Activity window's history: bytes per second by kind, in a ring of
/// one-second buckets, read only when asked.
@Suite struct TransferLogTests {
    /// A clock the test moves.
    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var now: Date
        init(_ start: TimeInterval) { now = Date(timeIntervalSince1970: start) }
        func read() -> Date { lock.withLock { now } }
        func advance(_ seconds: TimeInterval) { lock.withLock { now += seconds } }
    }

    @Test func eachSecondKeepsWhatMovedInItByKind() {
        let clock = Clock(1_000.2)
        let log = TransferLog(span: 60, clock: { clock.read() })
        log.add(.download, 100)
        log.add(.download, 50)
        log.add(.read, 7)
        clock.advance(1)          // 1001.2
        log.add(.upload, 30)
        clock.advance(2)          // 1003.2: 1002 was quiet
        log.add(.write, 9)
        clock.advance(1)          // 1004.2: 1003 is over, 1004 is under way
        #expect(log.history(.download, seconds: 4) == [150, 0, 0, 0])
        #expect(log.history(.read, seconds: 4) == [7, 0, 0, 0])
        #expect(log.history(.upload, seconds: 4) == [0, 30, 0, 0])
        #expect(log.history(.write, seconds: 4) == [0, 0, 0, 9])
    }

    @Test func theSecondUnderWayIsLeftOut() {
        let clock = Clock(2_000)
        let log = TransferLog(span: 60, clock: { clock.read() })
        log.add(.read, 1_000)
        #expect(log.history(.read, seconds: 3) == [0, 0, 0])
        #expect(log.rate(.read) == 0)
        clock.advance(1)
        #expect(log.history(.read, seconds: 3) == [0, 0, 1_000])
    }

    @Test func aSlotIsForgottenOnceItsSecondComesRoundAgain() {
        let clock = Clock(3_000)
        let log = TransferLog(span: 10, clock: { clock.read() })
        log.add(.download, 5)
        clock.advance(10)         // the same slot, ten seconds on
        log.add(.download, 2)
        clock.advance(1)
        #expect(log.history(.download, seconds: 9) == [0, 0, 0, 0, 0, 0, 0, 0, 2])
    }

    @Test func historyGoesBackNoFurtherThanItKeeps() {
        let clock = Clock(4_000)
        let log = TransferLog(span: 5, clock: { clock.read() })
        #expect(log.history(.read, seconds: 50).count == 4)
        #expect(log.history(.read, seconds: 0).isEmpty)
    }

    @Test func aRateIsTheAverageOfTheLastWholeSeconds() {
        let clock = Clock(5_000)
        let log = TransferLog(span: 60, clock: { clock.read() })
        // A disk reports once a second: one second holds two reports, the
        // next none. Averaged, it reads steady.
        log.add(.read, 2_000_000)
        clock.advance(1)
        clock.advance(1)
        log.add(.read, 1_000_000)
        clock.advance(1)
        #expect(log.rate(.read, over: 3) == 1_000_000)
        #expect(log.rate(.read, over: 1) == 1_000_000)
    }

    @Test func nothingIsANoOp() {
        let clock = Clock(6_000)
        let log = TransferLog(span: 60, clock: { clock.read() })
        log.add(.write, 0)
        log.add(.write, -5)
        clock.advance(1)
        #expect(log.history(.write, seconds: 2) == [0, 0])
        #expect(log.quiet(for: 60))
    }

    /// What shows the log sleeps while nothing moves: it is woken by the
    /// first bytes after a quiet second, and not by every add while things
    /// keep moving.
    @Test func bytesAfterAQuietSecondWakeWhatShowsTheLog() {
        let clock = Clock(7_000.5)
        let log = TransferLog(span: 60, clock: { clock.read() })
        let wakes = Counter()
        log.onWake = { wakes.bump() }
        log.add(.download, 10)              // the first bytes ever
        #expect(wakes.value == 1)
        log.add(.download, 10)              // the same second
        clock.advance(1)
        log.add(.read, 10)                  // the next: still moving
        #expect(wakes.value == 1)
        clock.advance(2)                    // 7002 was quiet
        log.add(.write, 10)
        #expect(wakes.value == 2)
        log.add(.write, 0)                  // nothing is not a wake
        clock.advance(5)
        log.add(.write, 0)
        #expect(wakes.value == 2)
        log.onWake = nil
        log.add(.upload, 10)
        #expect(wakes.value == 2)
    }

    /// Quiet for a graph's length is when the graph is flat and can stop
    /// being redrawn.
    @Test func quietIsNothingInTheSecondUnderWayOrThoseBeforeIt() {
        let clock = Clock(8_000.5)
        let log = TransferLog(span: 120, clock: { clock.read() })
        #expect(log.quiet(for: 60))
        log.add(.upload, 1)
        #expect(!log.quiet(for: 60))
        clock.advance(60)                   // 8060: 8000 is the oldest second a graph of 60 shows
        #expect(!log.quiet(for: 60))
        #expect(log.history(.upload, seconds: 60).first == 1)
        clock.advance(1)                    // 8061: it has scrolled off
        #expect(log.quiet(for: 60))
        #expect(log.history(.upload, seconds: 60).allSatisfy { $0 == 0 })
    }

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func bump() { lock.withLock { count += 1 } }
    }
}
