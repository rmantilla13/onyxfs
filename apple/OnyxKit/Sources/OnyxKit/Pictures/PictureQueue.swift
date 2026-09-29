import Foundation

/// How a phone fetches the small pictures a folder is shown by: each one
/// once however many ask for it, a bounded number at a time, the ones on
/// screen before the ones fetched ahead.
///
/// Storage serves previews over HTTP/1.1 — S3 and B2 both answer h2 with
/// 1.1 — where a connection carries one request at a time. Three things
/// follow, and each was measured on the phone (a folder's first screen took
/// three round trips, and a fast scroll cancelled two requests in three):
///
/// - **What is on screen goes first.** A cell asks with `.visible`; the
///   folder's next screens are planned `.ahead` (`prefetch`), and fill only
///   the slots the visible ones leave, and at most `aheadLimit` of them, so
///   a cell that appears always finds a connection free.
/// - **A started download is finished**, even when nobody waits for it any
///   more. Cancelling a request on HTTP/1.1 closes its connection: the next
///   one pays a new TCP and TLS handshake, which costs more than the few
///   kilobytes still to come. It ends in `store`, so the picture is there
///   when its cell comes back. A download not yet started is simply dropped
///   when the last one asking for it leaves.
/// - **One download per key.** Two cells, or a cell and the plan, asking for
///   the same picture share it; a plan's request that becomes visible moves
///   to the front.
///
/// The bytes are the caller's to keep: `store` is handed every download that
/// arrives, before anyone waiting for it hears, so a picture asked for again
/// the moment it lands is found where the caller keeps them. The last few
/// are also answered from here, for a caller that looked just before.
public actor PictureQueue {
    public enum Priority: Int, Sendable, Comparable {
        /// Planned ahead of the scroll.
        case ahead = 0
        /// On screen now.
        case visible = 1

        public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
    }

    public typealias Fetch = @Sendable (_ url: URL, _ priority: Priority) async throws -> Data
    /// Called on the queue, for every download that arrives, before anyone
    /// waiting for it hears. `wanted` is whether anyone still is.
    public typealias Store = @Sendable (_ key: String, _ data: Data, _ wanted: Bool) -> Void
    public typealias Trace = @Sendable (_ event: String, _ fields: String) -> Void

    /// Downloads at a time, in all.
    public let limit: Int
    /// Of those, how many may be ahead of the scroll.
    public let aheadLimit: Int

    private let fetch: Fetch
    private let store: Store
    private let trace: Trace?

    private final class Job {
        let key: String
        var url: URL
        var waiters: [UInt64: (priority: Priority, continuation: CheckedContinuation<Data, Error>)] = [:]
        /// Its place in the current plan; nil when the plan has left it.
        var planned: Int?
        /// When it was first asked for: first come, first served among equals.
        let order: Int
        var task: Task<Void, Never>?
        /// Whether its slot is one of the `aheadLimit`.
        var runsAhead = false
        var startedAt: UInt64 = 0

        init(key: String, url: URL, order: Int) {
            self.key = key
            self.url = url
            self.order = order
        }

        var priority: Priority {
            waiters.values.contains { $0.priority == .visible } ? .visible : .ahead
        }
        var started: Bool { task != nil }
    }

    private var jobs: [String: Job] = [:]
    private var running = 0
    private var runningAhead = 0
    private var sequence = 0
    private var waiterSequence: UInt64 = 0
    /// Bumped by `cancelAll`, so a download from before it stores nothing.
    private var generation = 0
    /// The last few arrivals, for a caller that looked where they are kept
    /// a moment before one landed there.
    private var recent: [(key: String, data: Data)] = []
    private let recentLimit = 24
    /// Keys whose download failed, and when: not planned again for a while.
    private var failed: [String: Date] = [:]
    public static let failureMemory: TimeInterval = 300

    public init(limit: Int, aheadLimit: Int, fetch: @escaping Fetch, store: @escaping Store, trace: Trace? = nil) {
        precondition(limit > 0 && aheadLimit >= 0 && aheadLimit <= limit)
        self.limit = limit
        self.aheadLimit = aheadLimit
        self.fetch = fetch
        self.store = store
        self.trace = trace
    }

    // MARK: - Asking

    /// The bytes at `url`, known by `key`. Cancelling the asking task stops
    /// the wait; the download stops only if it has not started and nobody
    /// else wants it.
    public func data(key: String, url: URL, priority: Priority = .visible) async throws -> Data {
        if let hit = recent.last(where: { $0.key == key }) { return hit.data }
        waiterSequence += 1
        let id = waiterSequence
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                enqueue(key: key, url: url, priority: priority, id: id, continuation: continuation)
            }
        } onCancel: {
            Task { await self.leave(key: key, id: id) }
        }
    }

    private func enqueue(key: String, url: URL, priority: Priority, id: UInt64,
                         continuation: CheckedContinuation<Data, Error>) {
        if Task.isCancelled {
            continuation.resume(throwing: CancellationError())
            return
        }
        let job: Job
        if let existing = jobs[key] {
            job = existing
            if !job.started { job.url = url }
        } else {
            sequence += 1
            job = Job(key: key, url: url, order: sequence)
            jobs[key] = job
        }
        job.waiters[id] = (priority, continuation)
        // Visible now: its slot, if it was running ahead, is no longer the plan's.
        if job.started, job.runsAhead, priority == .visible {
            job.runsAhead = false
            runningAhead -= 1
        }
        pump()
    }

    /// A waiter gave up: its cell scrolled away.
    private func leave(key: String, id: UInt64) {
        guard let job = jobs[key], let waiter = job.waiters.removeValue(forKey: id) else { return }
        waiter.continuation.resume(throwing: CancellationError())
        if job.waiters.isEmpty, !job.started, job.planned == nil {
            jobs[key] = nil
            trace?("drop", "key=\(key)")
        }
        pump()
    }

    // MARK: - Planning ahead

    /// Fetch these ahead of the scroll, in this order, nearest first. Each
    /// plan replaces the last: a planned download not yet started that the
    /// new plan leaves out is dropped. Keys that failed lately are skipped.
    public func prefetch(_ items: [(key: String, url: URL)]) {
        let now = Date()
        failed = failed.filter { now.timeIntervalSince($0.value) < Self.failureMemory }
        var wanted: [String: Int] = [:]
        for (i, item) in items.enumerated() where wanted[item.key] == nil {
            wanted[item.key] = i
        }
        for (key, job) in jobs where job.planned != nil && wanted[key] == nil {
            job.planned = nil
            if !job.started, job.waiters.isEmpty { jobs[key] = nil }
        }
        for item in items {
            guard let position = wanted[item.key], failed[item.key] == nil,
                  !recent.contains(where: { $0.key == item.key }) else { continue }
            if let job = jobs[item.key] {
                job.planned = position
            } else {
                sequence += 1
                let job = Job(key: item.key, url: item.url, order: sequence)
                job.planned = position
                jobs[item.key] = job
            }
        }
        pump()
    }

    // MARK: - Running

    private func pump() {
        while running < limit, let next = nextToStart() {
            start(next)
        }
    }

    /// The visible job asked for first, else the plan's nearest while the
    /// plan has a slot.
    private func nextToStart() -> Job? {
        var best: Job?
        for job in jobs.values where !job.started && job.priority == .visible {
            if best == nil || job.order < best!.order { best = job }
        }
        if let best { return best }
        guard runningAhead < aheadLimit else { return nil }
        for job in jobs.values where !job.started && job.planned != nil {
            if best == nil || job.planned! < best!.planned! { best = job }
        }
        return best
    }

    private func start(_ job: Job) {
        let priority = job.priority
        running += 1
        if priority == .ahead {
            job.runsAhead = true
            runningAhead += 1
        }
        job.startedAt = DispatchTime.now().uptimeNanoseconds
        let key = job.key, url = job.url, fetch = self.fetch, generation = self.generation
        trace?("start", "key=\(key) why=\(priority == .visible ? "visible" : "ahead") running=\(running) ahead=\(runningAhead) queued=\(jobs.count - running)")
        // On the queue (a task inherits it); only `fetch` runs off it.
        job.task = Task {
            let result: Result<Data, Error>
            do { result = .success(try await fetch(url, priority)) } catch { result = .failure(error) }
            self.finished(key: key, generation: generation, result: result)
        }
    }

    private func finished(key: String, generation: Int, result: Result<Data, Error>) {
        guard generation == self.generation, let job = jobs[key] else { return }
        jobs[key] = nil
        running -= 1
        if job.runsAhead { runningAhead -= 1 }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - job.startedAt) / 1e6
        switch result {
        case let .success(data):
            store(key, data, !job.waiters.isEmpty)
            recent.append((key, data))
            if recent.count > recentLimit { recent.removeFirst(recent.count - recentLimit) }
            trace?("done", "key=\(key) bytes=\(data.count) ms=\(String(format: "%.1f", ms)) waiters=\(job.waiters.count)")
            for waiter in job.waiters.values { waiter.continuation.resume(returning: data) }
        case let .failure(error):
            failed[key] = Date()
            trace?("fail", "key=\(key) ms=\(String(format: "%.1f", ms)) error=\(String(describing: error).prefix(80))")
            for waiter in job.waiters.values { waiter.continuation.resume(throwing: error) }
        }
        pump()
    }

    // MARK: - Stopping

    /// Everything stops: signing out. Nothing in flight is stored.
    public func cancelAll() {
        generation += 1
        for job in jobs.values {
            job.task?.cancel()
            for waiter in job.waiters.values { waiter.continuation.resume(throwing: CancellationError()) }
        }
        jobs = [:]
        running = 0
        runningAhead = 0
        recent = []
        failed = [:]
    }

    // MARK: - For tests and the trace

    public struct Snapshot: Equatable, Sendable {
        /// Jobs waiting for a slot, and of those, the ones a cell waits for.
        public var queued: Int
        public var queuedVisible: Int
        public var running: Int
        public var runningAhead: Int
        /// Everyone waiting, on any job.
        public var waiters: Int

        public init(queued: Int = 0, queuedVisible: Int = 0, running: Int = 0, runningAhead: Int = 0, waiters: Int = 0) {
            self.queued = queued
            self.queuedVisible = queuedVisible
            self.running = running
            self.runningAhead = runningAhead
            self.waiters = waiters
        }
    }

    public var snapshot: Snapshot {
        let waiting = jobs.values.filter { !$0.started }
        return Snapshot(queued: waiting.count, queuedVisible: waiting.filter { $0.priority == .visible }.count,
                        running: running, runningAhead: runningAhead,
                        waiters: jobs.values.reduce(0) { $0 + $1.waiters.count })
    }
}
