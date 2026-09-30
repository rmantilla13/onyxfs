import Foundation

/// Keeps Onyx out of App Nap while it has work in flight, and only then.
///
/// macOS naps an app it cannot see — its window behind others', or the app
/// hidden: its timers are put off, its sockets, CPU and disk come after
/// everyone else's (RunningBoard: `socket disk priority cpu timer:Tier5`).
/// 0.5.17 spent hours like that, its window open behind others, and a test
/// app shaped like Onyx moved a file about five times slower napped than
/// not, on a busy Mac. That is also when a folder copied onto a drive goes
/// up, offline copies come down and videos are made streamable. So while
/// any of that is under way this holds one ProcessInfo activity
/// (`.userInitiatedAllowingIdleSystemSleep`: no nap, and the Mac still
/// sleeps when it would — keeping it awake would be a decision of its own),
/// and lets go of it `linger` after the last of the work ends, so a burst of
/// work begins and ends it once rather than once a file. With nothing under
/// way nothing is held and no timer is set: idle costs what it did.
///
/// The one owner of the activity. Work says here when it starts and ends,
/// from any thread, in one of three ways:
///
///   set    a state that is on or off — "files are waiting to upload"
///   begin  a hold on one piece of work, until its `end`; with a `grace`,
///          only once it has gone on that long, for work that is usually
///          over at once (a sync with nothing new)
///   poke   work seen only by its traces — bytes going by — held until the
///          traces stop, looked for every so often meanwhile
public final class WorkActivity: @unchecked Sendable {
    /// What is under way, as the log names it.
    public enum Reason: String, CaseIterable, Sendable {
        /// Copies onto a drive: coming into the bridge, then going up.
        case uploads
        /// The Onyx window's own uploads, as the page says (window.onyxMac).
        case pageUploads = "uploads from the window"
        /// The window's downloads.
        case downloads
        /// Files being fetched to keep offline.
        case offlineCopies = "offline copies"
        /// A drive's sync that has gone on past its grace: one bringing pages.
        case sync
        /// Bytes going by (TransferLog): what the disks read and write, and
        /// every transfer the app counts.
        case transfers
        case thumbnails
        case waveforms
        case proxies = "streamable versions"
        case transcripts
        /// An update of Onyx itself, downloading or being installed.
        case update
    }

    /// `run` after `delay`, unless the closure returned is called first.
    public typealias Later = @Sendable (_ delay: Duration, _ run: @escaping @Sendable () -> Void) -> (@Sendable () -> Void)

    /// A piece of work under way, from `begin` until `end` — or until the
    /// hold is let go of, so a forgotten one cannot keep the activity for
    /// good.
    public final class Hold: @unchecked Sendable {
        private weak var owner: WorkActivity?
        private let id: Int

        fileprivate init(owner: WorkActivity, id: Int) {
            self.owner = owner
            self.id = id
        }

        /// The work is over. Once is enough; again does nothing.
        public func end() { owner?.release(id) }

        deinit { owner?.release(id) }
    }

    /// How long the activity outlives the last piece of work.
    public let linger: Duration

    /// Told as the activity begins, with what it is for, and as it ends —
    /// on whichever thread made the change, never inside the lock.
    public var onChange: (@Sendable (_ held: Bool, _ reasons: [Reason]) -> Void)? {
        get { lock.withLock { observer } }
        set { lock.withLock { observer = newValue } }
    }

    private let lock = NSLock()
    private let beginActivity: @Sendable (String) -> AnyObject
    private let endActivity: @Sendable (AnyObject) -> Void
    private let later: Later
    private var observer: (@Sendable (Bool, [Reason]) -> Void)?

    private var states: Set<Reason> = []
    private struct Held {
        let reason: Reason
        /// False while the hold waits out its grace.
        var counted: Bool
        var cancelGrace: (@Sendable () -> Void)?
    }
    private var holds: [Int: Held] = [:]
    private var lastHold = 0
    /// Each poked reason's next look, while it is watched.
    private var watches: [Reason: @Sendable () -> Void] = [:]
    /// The activity, while it is held.
    private var token: AnyObject?
    /// The activity's end, set for `linger` after the last work ended.
    private var cancelEnd: (@Sendable () -> Void)?
    /// Moved on by each end set or called off: a timer that fires after
    /// it was called off changes nothing.
    private var endRound = 0

    private struct Change {
        let held: Bool
        let reasons: [Reason]
    }

    /// - Parameters:
    ///   - begin, end: the activity itself; ProcessInfo's unless a test
    ///     says otherwise.
    ///   - later: the timers for `linger`, a grace and a poke's looks.
    public init(linger: Duration = .seconds(5),
                begin: @escaping @Sendable (String) -> AnyObject = WorkActivity.beginProcessActivity,
                end: @escaping @Sendable (AnyObject) -> Void = WorkActivity.endProcessActivity,
                later: @escaping Later = WorkActivity.dispatchLater) {
        self.linger = linger
        beginActivity = begin
        endActivity = end
        self.later = later
    }

    // MARK: - Work in

    /// A state of work: on while it is under way, off once it is not.
    /// Saying the same again changes nothing.
    public func set(_ reason: Reason, _ on: Bool) {
        let change = lock.withLock { () -> Change? in
            if on {
                guard states.insert(reason).inserted else { return nil }
            } else {
                guard states.remove(reason) != nil else { return nil }
            }
            return settle()
        }
        report(change)
    }

    /// A piece of work begins; the hold returned ends it. With a `grace`
    /// it counts only once it has gone on that long: over sooner, it never
    /// touches the activity, and its timer is called off unfired.
    public func begin(_ reason: Reason, grace: Duration = .zero) -> Hold {
        let (hold, change) = lock.withLock { () -> (Hold, Change?) in
            lastHold += 1
            let id = lastHold
            let hold = Hold(owner: self, id: id)
            guard grace > .zero else {
                holds[id] = Held(reason: reason, counted: true)
                return (hold, settle())
            }
            let cancel = later(grace) { [weak self] in self?.graceOver(id) }
            holds[id] = Held(reason: reason, counted: false, cancelGrace: cancel)
            return (hold, nil)
        }
        report(change)
        return hold
    }

    /// Work seen going by: held from now until `quiet` says it has
    /// stopped, which is asked `every` so often while it is held, and not
    /// at all otherwise. A poke while it is held already changes nothing.
    ///
    /// `quiet` is asked inside this object's lock, so a poke never slips
    /// in between the look that finds all quiet and the end of the watch;
    /// it must not call back into this object.
    public func poke(_ reason: Reason, every: Duration, quiet: @escaping @Sendable () -> Bool) {
        let change = lock.withLock { () -> Change? in
            guard watches[reason] == nil else { return nil }
            watches[reason] = later(every) { [weak self] in self?.look(reason, every: every, quiet: quiet) }
            guard states.insert(reason).inserted else { return nil }
            return settle()
        }
        report(change)
    }

    // MARK: - Now

    /// Whether the activity is held now.
    public var isHeld: Bool { lock.withLock { token != nil } }

    /// What is under way now, in `Reason`'s order.
    public var reasons: [Reason] { lock.withLock { current } }

    // MARK: - Inside

    private var isBusy: Bool { !states.isEmpty || holds.values.contains(where: \.counted) }

    private var current: [Reason] {
        Reason.allCases.filter { reason in
            states.contains(reason) || holds.values.contains { $0.counted && $0.reason == reason }
        }
    }

    /// Inside the lock, after any change: begins the activity for work that
    /// has started, or sets its end for `linger` from now once the last of
    /// the work is over. The change to report, if the activity began.
    private func settle() -> Change? {
        if isBusy {
            // Work again before the linger ran out: the same activity goes on.
            if let cancel = cancelEnd {
                cancel()
                cancelEnd = nil
                endRound += 1
            }
            guard token == nil else { return nil }
            let reasons = current
            token = beginActivity("Onyx: " + reasons.map(\.rawValue).joined(separator: ", "))
            return Change(held: true, reasons: reasons)
        }
        guard token != nil, cancelEnd == nil else { return nil }
        endRound += 1
        let round = endRound
        cancelEnd = later(linger) { [weak self] in self?.lingered(round) }
        return nil
    }

    private func lingered(_ round: Int) {
        let change = lock.withLock { () -> Change? in
            guard round == endRound, !isBusy, let held = token else { return nil }
            cancelEnd = nil
            token = nil
            endActivity(held)
            return Change(held: false, reasons: [])
        }
        report(change)
    }

    private func graceOver(_ id: Int) {
        let change = lock.withLock { () -> Change? in
            guard var held = holds[id], !held.counted else { return nil }
            held.counted = true
            held.cancelGrace = nil
            holds[id] = held
            return settle()
        }
        report(change)
    }

    fileprivate func release(_ id: Int) {
        let change = lock.withLock { () -> Change? in
            guard let held = holds.removeValue(forKey: id) else { return nil }
            held.cancelGrace?()
            return held.counted ? settle() : nil
        }
        report(change)
    }

    private func look(_ reason: Reason, every: Duration, quiet: @escaping @Sendable () -> Bool) {
        let change = lock.withLock { () -> Change? in
            guard watches[reason] != nil else { return nil }
            guard quiet() else {
                watches[reason] = later(every) { [weak self] in self?.look(reason, every: every, quiet: quiet) }
                return nil
            }
            watches[reason] = nil
            guard states.remove(reason) != nil else { return nil }
            return settle()
        }
        report(change)
    }

    private func report(_ change: Change?) {
        guard let change, let observer = onChange else { return }
        observer(change.held, change.reasons)
    }

    // MARK: - The real thing

    /// No App Nap while held; the Mac still sleeps as it would.
    public static let beginProcessActivity: @Sendable (String) -> AnyObject = { reason in
        ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: reason)
    }

    public static let endProcessActivity: @Sendable (AnyObject) -> Void = { token in
        guard let activity = token as? NSObjectProtocol else { return }
        ProcessInfo.processInfo.endActivity(activity)
    }

    private static let timerQueue = DispatchQueue(label: "io.onyxfs.work-activity", qos: .utility)

    /// One dispatch timer, given a tenth of its wait as leeway so macOS may
    /// fold it in with other work. Called off, it never fires.
    public static let dispatchLater: Later = { delay, run in
        let timer = DispatchSource.makeTimerSource(queue: WorkActivity.timerQueue)
        let parts = delay.components
        let nanoseconds = max(0, Int(parts.seconds) * 1_000_000_000 + Int(parts.attoseconds / 1_000_000_000))
        timer.schedule(deadline: .now() + .nanoseconds(nanoseconds), leeway: .nanoseconds(max(1_000_000, nanoseconds / 10)))
        timer.setEventHandler { [weak timer] in
            timer?.cancel()
            run()
        }
        timer.resume()
        return { timer.cancel() }
    }
}
