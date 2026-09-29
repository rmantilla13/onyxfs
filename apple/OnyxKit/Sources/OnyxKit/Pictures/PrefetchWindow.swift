import Foundation

/// Which of a folder's pictures to have ready before they are scrolled to.
///
/// A cell that comes into view is where the eye is. The pictures past it,
/// the way the folder is moving, are fetched ahead (`fetch`), nearest first,
/// and the nearest of them are decoded as well (`warm`), so a cell scrolled
/// in finds its picture in memory on its first frame. A few are kept ready
/// behind, for a change of direction.
///
/// Counted in cells: a phone's grid shows about fifteen, a list about
/// twelve, so `ahead` is some four screens and `warmAhead` about one.
public struct PrefetchWindow: Equatable, Sendable {
    public var ahead: Int
    public var behind: Int
    public var warmAhead: Int
    public var warmBehind: Int

    public init(ahead: Int = 60, behind: Int = 15, warmAhead: Int = 18, warmBehind: Int = 6) {
        self.ahead = ahead
        self.behind = behind
        self.warmAhead = warmAhead
        self.warmBehind = warmBehind
    }

    public struct Plan: Equatable, Sendable {
        /// Indices to have fetched, nearest first, the way of travel first.
        public var fetch: [Int]
        /// The nearest of those, to have decoded too; in the same order.
        public var warm: [Int]
    }

    /// The plan when the cell at `index` of `count` has just come into view,
    /// the folder moving `forward` (towards its end) or back.
    public func plan(around index: Int, count: Int, forward: Bool) -> Plan {
        guard count > 0 else { return Plan(fetch: [], warm: []) }
        let index = min(max(index, 0), count - 1)
        let step = forward ? 1 : -1
        func run(_ direction: Int, _ n: Int) -> [Int] {
            guard n > 0 else { return [] }
            return (1...n).map { index + $0 * direction }.filter { $0 >= 0 && $0 < count }
        }
        let onward = run(step, ahead)
        let back = run(-step, behind)
        let warm = Array(onward.prefix(warmAhead)) + Array(back.prefix(warmBehind))
        return Plan(fetch: onward + back, warm: warm)
    }
}

/// Where the eye is in a folder, from the cells that come into view: which
/// way the folder is moving, and when that has changed enough to plan again.
///
/// Cells come into view in bursts — a whole screen when a folder opens, a
/// row at a time while scrolling — and in no fixed order within a burst, so
/// a burst is taken whole (`note`, then `settle`): moving forward, the eye
/// is at the furthest cell that appeared; moving back, at the nearest.
public struct ScrollFocus: Equatable, Sendable {
    /// Where the last plan was made.
    public private(set) var anchor: Int?
    public private(set) var forward = true
    private var low: Int?
    private var high: Int?
    /// How far the eye moves before it is worth planning again: a row.
    public var step: Int

    public init(step: Int = 3) {
        self.step = step
    }

    /// A cell at `index` came into view.
    public mutating func note(_ index: Int) {
        low = min(low ?? index, index)
        high = max(high ?? index, index)
    }

    /// The end of a burst: the index to plan around, or nil when the eye has
    /// not moved far enough since the last plan to plan again.
    public mutating func settle() -> Int? {
        defer { low = nil; high = nil }
        guard let low, let high else { return nil }
        guard let anchor else {
            self.anchor = high
            forward = true
            return high
        }
        let movedForward = high > anchor
        let movedBack = low < anchor
        let target: Int
        let direction: Bool
        switch (movedForward, movedBack) {
        case (true, false): (target, direction) = (high, true)
        case (false, true): (target, direction) = (low, false)
        case (true, true):
            // Both ends at once (a jump): the end further from the anchor.
            (target, direction) = high - anchor >= anchor - low ? (high, true) : (low, false)
        case (false, false): return nil
        }
        guard direction != forward || abs(target - anchor) >= step else { return nil }
        self.anchor = target
        forward = direction
        return target
    }

    /// A new listing, or a new order: start again.
    public mutating func reset() {
        anchor = nil
        forward = true
        low = nil
        high = nil
    }
}
