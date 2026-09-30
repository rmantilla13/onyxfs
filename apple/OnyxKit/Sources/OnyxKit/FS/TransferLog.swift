import Foundation

/// What the drives moved, second by second, for the Activity bar: bytes
/// fetched from storage, sent to it, read by apps from the disks and written
/// by them to the disks.
///
/// The last `span` seconds are kept in a ring of one-second buckets, so
/// adding is a lock and an add, and nothing runs to keep it: the bar reads it
/// once a second while something moves, and `onWake` tells it when something
/// starts to, so while nothing does nothing runs at all.
///
/// Where the bytes come from: each disk's extension reports what it read,
/// fetched and was given about once a second (TransferMeter, over `POST
/// /fs/v1/activity`); the app itself counts what its uploads send, what
/// fetching offline copies receives and what the window's downloads receive.
/// A drive in `~/Onyx` (the rclone mount macOS 26 and older fall back to)
/// reads storage directly, unseen here.
public final class TransferLog: @unchecked Sendable {
    public enum Kind: Int, CaseIterable, Sendable {
        /// From storage to this Mac.
        case download
        /// From this Mac to storage.
        case upload
        /// Read by apps from the disks.
        case read
        /// Written by apps to the disks.
        case write
    }

    /// How many seconds are kept.
    public let span: Int
    private let lock = NSLock()
    /// The second each slot holds (Int64.min for none yet), and its bytes by
    /// kind.
    private var stamps: [Int64]
    private var buckets: [[Int64]]
    private let clock: @Sendable () -> Date
    /// The latest second anything was added in.
    private var lastSecond: Int64?
    private var wake: (@Sendable () -> Void)?

    public init(span: Int = 300, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.span = max(2, span)
        stamps = Array(repeating: .min, count: self.span)
        buckets = Array(repeating: Array(repeating: 0, count: Kind.allCases.count), count: self.span)
        self.clock = clock
    }

    /// Called when bytes arrive after at least a whole second of none — on
    /// whichever thread added them, outside the lock. What shows the log
    /// wakes to this and reads it while things move, rather than polling it
    /// while nothing does.
    public var onWake: (@Sendable () -> Void)? {
        get { lock.withLock { wake } }
        set { lock.withLock { wake = newValue } }
    }

    public func add(_ kind: Kind, _ bytes: Int64) {
        guard bytes > 0 else { return }
        let second = Self.second(clock())
        let slot = slot(second)
        let woken: (@Sendable () -> Void)? = lock.withLock {
            if stamps[slot] != second {
                stamps[slot] = second
                buckets[slot] = Array(repeating: 0, count: Kind.allCases.count)
            }
            buckets[slot][kind.rawValue] &+= bytes
            let quiet = lastSecond.map { second - $0 >= 2 } ?? true
            lastSecond = max(lastSecond ?? second, second)
            return quiet ? wake : nil
        }
        woken?()
    }

    /// Whether nothing was added in the second under way or the `seconds`
    /// before it — once it is, a graph of that many seconds is flat.
    public func quiet(for seconds: Int) -> Bool {
        let now = Self.second(clock())
        return lock.withLock { lastSecond.map { now - $0 > Int64(seconds) } ?? true }
    }

    /// Bytes moved in each of the `seconds` whole seconds before this one,
    /// oldest first; 0 for a quiet second. The second under way is left out:
    /// it is not over, and would always read low.
    public func history(_ kind: Kind, seconds: Int) -> [Int64] {
        let now = Self.second(clock())
        let count = max(0, min(seconds, span - 1))
        guard count > 0 else { return [] }
        return lock.withLock {
            (1...count).reversed().map { back in
                let second = now - Int64(back)
                let slot = slot(second)
                return stamps[slot] == second ? buckets[slot][kind.rawValue] : 0
            }
        }
    }

    /// Bytes per second, over the last `seconds` whole seconds. More than
    /// one: an extension reports once a second, so a second's bucket can
    /// hold two reports and the next none; the average reads steady.
    public func rate(_ kind: Kind, over seconds: Int = 3) -> Double {
        let recent = history(kind, seconds: max(1, seconds))
        guard !recent.isEmpty else { return 0 }
        return Double(recent.reduce(0, +)) / Double(recent.count)
    }

    static func second(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970.rounded(.down)) }

    private func slot(_ second: Int64) -> Int {
        let span = Int64(self.span)
        return Int(((second % span) + span) % span)
    }
}
