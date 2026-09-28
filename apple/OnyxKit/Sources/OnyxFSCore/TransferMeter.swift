import Foundation

/// What one drive's disk moved — bytes apps read from it, bytes fetched from
/// storage for it, bytes apps wrote to it — told to the app about once a
/// second while anything moves, for its Activity window.
///
/// Counting is a lock and an add, on the read path. Nothing runs while the
/// disk is idle: the first bytes after a quiet spell start one report loop,
/// and the loop ends by itself once a second has passed with nothing new.
/// A report the app does not answer is dropped, not retried — this is a
/// picture of what is happening now, and a late one shows nothing.
public final class TransferMeter: @unchecked Sendable {
    public enum Kind: Sendable {
        /// Bytes an app read from the disk (from the cache, a copy kept
        /// offline, or storage).
        case read
        /// Bytes fetched from storage.
        case download
        /// Bytes an app wrote to the disk.
        case write
    }

    public struct Counts: Codable, Sendable, Equatable {
        public var read: Int64
        public var download: Int64
        public var write: Int64

        public init(read: Int64 = 0, download: Int64 = 0, write: Int64 = 0) {
            self.read = read; self.download = download; self.write = write
        }

        public var isEmpty: Bool { read == 0 && download == 0 && write == 0 }
    }

    private let lock = NSLock()
    private var counts = Counts()
    private var reporting = false
    private let interval: Duration
    private let report: @Sendable (Counts) async -> Void

    /// `report` is handed what moved since the last one; it is never called
    /// with nothing, and never twice at once.
    public init(interval: Duration = .seconds(1), report: @escaping @Sendable (Counts) async -> Void) {
        self.interval = interval
        self.report = report
    }

    public func add(_ kind: Kind, _ bytes: Int) {
        guard bytes > 0 else { return }
        let start: Bool = lock.withLock {
            switch kind {
            case .read: counts.read += Int64(bytes)
            case .download: counts.download += Int64(bytes)
            case .write: counts.write += Int64(bytes)
            }
            if reporting { return false }
            reporting = true
            return true
        }
        if start { Task { await self.run() } }
    }

    private func run() async {
        while true {
            try? await Task.sleep(for: interval)
            let batch: Counts? = lock.withLock {
                let batch = counts
                counts = Counts()
                if batch.isEmpty {
                    reporting = false
                    return nil
                }
                return batch
            }
            guard let batch else { return }
            await report(batch)
        }
    }
}
