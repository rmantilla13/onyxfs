import Foundation

/// How fast uploads are going, and so how long what is left will take: read
/// from UploadQueue.Summary.movedBytes, which only ever goes up, a few times
/// a second (the menu's summary loop).
///
/// The rate is over the last `window`: long enough that one slow part or a
/// pause between files does not swing it, short enough that it follows a
/// network that got faster or slower. No estimate until it has seen
/// `warmUp` of sending — a first second says little — and none while
/// nothing moves: "about 4 hours" from a stall would be wrong for most of
/// those hours.
public struct UploadPace: Sendable, Equatable {
    public struct Estimate: Sendable, Equatable {
        public let bytesPerSecond: Double
        public let secondsLeft: Double
    }

    private var samples: [(at: Double, moved: Int64)] = []
    let window: Double
    let warmUp: Double

    public init(window: Double = 20, warmUp: Double = 3) {
        self.window = window
        self.warmUp = warmUp
    }

    public static func == (a: UploadPace, b: UploadPace) -> Bool {
        a.samples.count == b.samples.count && zip(a.samples, b.samples).allSatisfy { $0.at == $1.at && $0.moved == $1.moved }
            && a.window == b.window && a.warmUp == b.warmUp
    }

    /// `moved` (Summary.movedBytes) as it stood at `at` seconds, any clock
    /// that only goes forward.
    public mutating func note(moved: Int64, at: Double) {
        if let last = samples.last, moved < last.moved || at < last.at { samples.removeAll() } // a new run
        samples.append((at, moved))
        // The oldest kept is the last one at or before the window's start, so
        // the rate always spans the whole window once there is that much.
        while samples.count > 2, samples[1].at <= at - window { samples.removeFirst() }
    }

    /// Nothing is uploading: the next run starts afresh.
    public mutating func reset() { samples.removeAll() }

    /// Bytes per second over the window, once there is enough to tell.
    public var bytesPerSecond: Double? {
        guard let first = samples.first, let last = samples.last else { return nil }
        let span = last.at - first.at
        guard span >= warmUp, last.moved > first.moved else { return nil }
        return Double(last.moved - first.moved) / span
    }

    /// What is left, at the current rate.
    public func estimate(remaining: Int64) -> Estimate? {
        guard remaining > 0, let rate = bytesPerSecond, rate > 0 else { return nil }
        return Estimate(bytesPerSecond: rate, secondsLeft: Double(remaining) / rate)
    }
}
