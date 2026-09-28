import Foundation
import Testing
@testable import OnyxFSCore

/// What a disk moved, told to the app about once a second while it moves —
/// and nothing at all while it does not.
@Suite(.serialized) struct TransferMeterTests {
    typealias Counts = TransferMeter.Counts

    actor Reports {
        var all: [Counts] = []
        var running = 0
        var mostAtOnce = 0
        let delay: Duration
        init(delay: Duration = .zero) { self.delay = delay }

        func take(_ counts: Counts) async {
            running += 1
            mostAtOnce = max(mostAtOnce, running)
            if delay > .zero { try? await Task.sleep(for: delay) }
            all.append(counts)
            running -= 1
        }

        var total: Counts {
            all.reduce(into: Counts()) { sum, c in
                sum.read += c.read; sum.download += c.download; sum.write += c.write
            }
        }
    }

    @Test func whatMovesIsToldTogetherOnceTheIntervalIsUp() async throws {
        let reports = Reports()
        let meter = TransferMeter(interval: .milliseconds(100)) { await reports.take($0) }
        meter.add(.read, 1_000)
        meter.add(.download, 600)
        meter.add(.write, 5)
        meter.add(.read, 24)
        #expect(await reports.all.isEmpty, "not before the interval is up")
        try await Task.sleep(for: .milliseconds(450))
        #expect(await reports.all == [Counts(read: 1_024, download: 600, write: 5)])
    }

    @Test func nothingIsToldWhileNothingMoves() async throws {
        let reports = Reports()
        let meter = TransferMeter(interval: .milliseconds(50)) { await reports.take($0) }
        meter.add(.read, 0)
        meter.add(.write, -3)
        try await Task.sleep(for: .milliseconds(250))
        #expect(await reports.all.isEmpty)
        withExtendedLifetime(meter) {}
    }

    @Test func aBurstAfterAQuietSpellIsToldAgain() async throws {
        let reports = Reports()
        let meter = TransferMeter(interval: .milliseconds(50)) { await reports.take($0) }
        meter.add(.read, 1)
        try await Task.sleep(for: .milliseconds(300))
        meter.add(.write, 2)
        try await Task.sleep(for: .milliseconds(300))
        #expect(await reports.all == [Counts(read: 1), Counts(write: 2)])
    }

    @Test func aSlowAnswerIsNeverOverlappedAndNothingIsLost() async throws {
        let reports = Reports(delay: .milliseconds(120))
        let meter = TransferMeter(interval: .milliseconds(30)) { await reports.take($0) }
        for _ in 0..<20 {
            meter.add(.download, 1_000)
            try await Task.sleep(for: .milliseconds(15))
        }
        try await Task.sleep(for: .milliseconds(800))
        #expect(await reports.mostAtOnce == 1)
        #expect(await reports.total == Counts(download: 20_000))
    }
}
