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
    }
}
