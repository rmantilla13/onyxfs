import Foundation
import Testing
@testable import OnyxKit

/// A folder's pictures on a phone: fetched once each, a bounded number at a
/// time, what is on screen first, and a download once started never thrown
/// away — on HTTP/1.1 that would cost the connection it came on.
struct PictureQueueTests {
    // MARK: - Fixtures

    /// Downloads that wait until the test lets each one finish, and a record
    /// of what was asked for, in order.
    final class Held: @unchecked Sendable {
        private let lock = NSLock()
        private var gates: [String: CheckedContinuation<Void, Never>] = [:]
        private var opened: Set<String> = []
        private var startedSoFar: [String] = []
        private var failing: Set<String> = []
        private var concurrent = 0
        private var peak = 0

        var started: [String] { lock.withLock { startedSoFar } }
        var maxAtOnce: Int { lock.withLock { peak } }
        func fail(_ name: String) { lock.withLock { _ = failing.insert(name) } }

        func fetch(_ url: URL) async throws -> Data {
            let name = url.lastPathComponent
            lock.withLock {
                startedSoFar.append(name)
                concurrent += 1
                peak = max(peak, concurrent)
            }
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                let now = lock.withLock { () -> Bool in
                    if opened.contains(name) { return true }
                    gates[name] = c
                    return false
                }
                if now { c.resume() }
            }
            let fails = lock.withLock { () -> Bool in
                concurrent -= 1
                return failing.contains(name)
            }
            if fails { throw URLError(.badServerResponse) }
            return Data("picture \(name)".utf8)
        }

        /// Let `name`'s download finish, now or whenever it starts.
        func open(_ name: String) {
            let gate = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                opened.insert(name)
                return gates.removeValue(forKey: name)
            }
            gate?.resume()
        }

        /// Wait until `names` have all started (or give up after a second).
        func waitForStart(_ names: String...) async {
            for _ in 0..<500 {
                if Set(names).isSubset(of: Set(started)) { return }
                try? await Task.sleep(nanoseconds: 2_000_000)
            }
        }
    }

    final class Stored: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [(String, Bool)] = []
        func add(_ key: String, _ wanted: Bool) { lock.withLock { list.append((key, wanted)) } }
        var keys: [String] { lock.withLock { list.map(\.0) } }
        func wanted(_ key: String) -> Bool? { lock.withLock { list.first { $0.0 == key }?.1 } }
    }

    static func url(_ name: String) -> URL { URL(string: "https://bucket.test/_thumbs/\(name)")! }

    static func queue(limit: Int, ahead: Int, held: Held, stored: Stored = Stored()) -> PictureQueue {
        PictureQueue(limit: limit, aheadLimit: ahead,
                     fetch: { url, _ in try await held.fetch(url) },
                     store: { key, _, wanted in stored.add(key, wanted) })
    }

    /// Settle the queue's own bookkeeping (its jobs start and finish in tasks).
    static func tick() async { try? await Task.sleep(nanoseconds: 20_000_000) }

    /// Wait until `condition` holds (or two seconds pass, and the test's own
    /// expectations then say what did not happen).
    static func until(_ condition: () async -> Bool) async {
        for _ in 0..<1000 {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    // MARK: - One download a picture

    @Test func manyAskingForOnePictureShareOneDownload() async throws {
        let held = Held()
        let queue = Self.queue(limit: 4, ahead: 2, held: held)
        let asks = (0..<10).map { _ in Task { try await queue.data(key: "a", url: Self.url("a")) } }
        await held.waitForStart("a")
        await Self.tick()
        held.open("a")
        for ask in asks { #expect(try await ask.value == Data("picture a".utf8)) }
        #expect(held.started == ["a"])
    }

    // MARK: - How many at once

    @Test func noMoreThanTheLimitAtOnce() async throws {
        let held = Held()
        let queue = Self.queue(limit: 3, ahead: 1, held: held)
        let names = (0..<9).map { "p\($0)" }
        let asks = names.map { name in Task { try await queue.data(key: name, url: Self.url(name)) } }
        await held.waitForStart("p0", "p1", "p2")
        await Self.tick()
        #expect(held.started.count == 3)
        for name in names { held.open(name) }
        for ask in asks { _ = try await ask.value }
        #expect(held.maxAtOnce == 3)
        #expect(held.started.count == 9)
    }

    /// Rounds, exactly: with a limit of four, twelve pictures start four at
    /// a time, each four only once the last four are done.
    @Test func twelvePicturesAtFourAtATimeTakeThreeRounds() async throws {
        let held = Held()
        let queue = Self.queue(limit: 4, ahead: 0, held: held)
        let names = (0..<12).map { "p\($0)" }
        let asks = names.map { name in Task { try await queue.data(key: name, url: Self.url(name)) } }
        var rounds: [[String]] = []
        while held.started.count < 12 {
            let before = held.started.count
            await Self.until { held.started.count == min(before + 4, 12) }
            await Self.tick()
            let round = Array(held.started[before...])
            #expect(round.count == 4, "round \(rounds.count + 1): \(round)")
            rounds.append(round)
            for name in round { held.open(name) }
            if round.isEmpty { break }
        }
        for ask in asks { _ = try await ask.value }
        #expect(rounds.count == 3)
        #expect(held.maxAtOnce == 4)
    }

    /// Through URLSession, as the app fetches: a store that takes 400 ms to
    /// answer, twelve pictures, and a limit of four, take three rounds; a
    /// limit of twelve, one. (The app's own limit, and URLSession's per-host
    /// one, are what made a phone's first screen take three round trips.)
    /// A request's round is one more than that of the latest request the
    /// store had answered when it arrived — cause and effect, not the clock,
    /// so a machine busy with other tests cannot blur the rounds together.
    @Test(arguments: [(4, 3), (6, 2), (12, 1)])
    func twelvePicturesTakeAsManyRoundsAsTheLimitMakes(limit: Int, rounds: Int) async throws {
        let latency = 0.4
        let host = "rounds-\(limit)-\(UUID().uuidString.prefix(8)).latency.test"
        LatencyStub.register(host: host, latency: latency)
        let session = LatencyStub.session()
        let queue = PictureQueue(limit: limit, aheadLimit: 0, fetch: { url, _ in
            let (data, response) = try await session.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            return data
        }, store: { _, _, _ in })
        let clock = ContinuousClock()
        let began = clock.now
        try await withThrowingTaskGroup(of: Data.self) { group in
            for i in 0..<12 {
                let url = URL(string: "https://\(host)/_thumbs/\(i).webp")!
                group.addTask { try await queue.data(key: "\(i)", url: url) }
            }
            for try await data in group { #expect(data.count == 1000) }
        }
        let elapsed = clock.now - began
        let requests = LatencyStub.requests(host).sorted { $0.start < $1.start }
        var round: [Int] = []
        for (i, request) in requests.enumerated() {
            let answeredBefore = requests.indices.filter { $0 < i && requests[$0].end <= request.start }
            round.append(1 + (answeredBefore.map { round[$0] }.max() ?? 0))
        }
        #expect(requests.count == 12)
        #expect(LatencyStub.peak(host) == limit)
        #expect(round.max() == rounds, "rounds: \(round)")
        #expect(elapsed >= .milliseconds(Int(latency * 1000) * rounds - 20), "never faster than the rounds allow")
    }

    // MARK: - What is on screen first

    @Test func aVisiblePictureGoesBeforeThePlan() async throws {
        let held = Held()
        let queue = Self.queue(limit: 1, ahead: 1, held: held)
        await queue.prefetch(["a1", "a2", "a3"].map { ($0, Self.url($0)) })
        await held.waitForStart("a1")
        let visible = Task { try await queue.data(key: "v", url: Self.url("v")) }
        await Self.until { await queue.snapshot.queuedVisible == 1 }
        for name in ["a1", "v", "a2", "a3"] {
            held.open(name)
            await Self.tick()
        }
        _ = try await visible.value
        #expect(held.started == ["a1", "v", "a2", "a3"])
    }

    @Test func thePlanNeverTakesTheSlotsTheScreenNeeds() async throws {
        let held = Held()
        let queue = Self.queue(limit: 4, ahead: 2, held: held)
        await queue.prefetch((0..<10).map { ("a\($0)", Self.url("a\($0)")) })
        await held.waitForStart("a0", "a1")
        await Self.tick()
        #expect(held.started == ["a0", "a1"], "two ahead at most")
        // Two cells appear: they start at once, in the slots left.
        let v1 = Task { try await queue.data(key: "v1", url: Self.url("v1")) }
        let v2 = Task { try await queue.data(key: "v2", url: Self.url("v2")) }
        await held.waitForStart("v1", "v2")
        #expect(await queue.snapshot.running == 4)
        for name in ["v1", "v2"] + (0..<10).map({ "a\($0)" }) { held.open(name) }
        _ = try await (v1.value, v2.value)
    }

    @Test func aPlannedPictureThatComesIntoViewMovesToTheFront() async throws {
        let held = Held()
        let queue = Self.queue(limit: 1, ahead: 1, held: held)
        let blocker = Task { try await queue.data(key: "b", url: Self.url("b")) }
        await held.waitForStart("b")
        await queue.prefetch(["a1", "a2", "a3", "a4"].map { ($0, Self.url($0)) })
        let seen = Task { try await queue.data(key: "a4", url: Self.url("a4")) }
        await Self.until { await queue.snapshot.queuedVisible == 1 }
        for name in ["b", "a4", "a1", "a2", "a3"] {
            held.open(name)
            await Self.tick()
        }
        _ = try await (blocker.value, seen.value)
        #expect(held.started == ["b", "a4", "a1", "a2", "a3"])
    }

    @Test func aNewPlanDropsWhatTheLastOneWantedAndHasNotStarted() async throws {
        let held = Held()
        let queue = Self.queue(limit: 1, ahead: 1, held: held)
        let blocker = Task { try await queue.data(key: "b", url: Self.url("b")) }
        await held.waitForStart("b")
        await queue.prefetch(["a", "b2", "c"].map { ($0, Self.url($0)) })
        await queue.prefetch(["d", "e"].map { ($0, Self.url($0)) })
        for name in ["b", "d", "e"] {
            held.open(name)
            await Self.tick()
        }
        _ = try await blocker.value
        #expect(held.started == ["b", "d", "e"])
        #expect(await queue.snapshot == .init())
    }

    // MARK: - Leaving

    /// On HTTP/1.1 a cancelled request takes its connection with it, and the
    /// picture would be fetched again when its cell came back: so it is
    /// finished, and kept.
    @Test func aStartedDownloadIsFinishedAndKeptWhenItsCellLeaves() async throws {
        let held = Held()
        let stored = Stored()
        let queue = Self.queue(limit: 2, ahead: 1, held: held, stored: stored)
        let ask = Task { try await queue.data(key: "a", url: Self.url("a")) }
        await held.waitForStart("a")
        ask.cancel()
        await #expect(throws: CancellationError.self) { try await ask.value }
        held.open("a")
        await Self.until { !stored.keys.isEmpty }
        #expect(stored.keys == ["a"])
        #expect(stored.wanted("a") == false)
        // Its cell comes back: answered without another download.
        #expect(try await queue.data(key: "a", url: Self.url("a")) == Data("picture a".utf8))
        #expect(held.started == ["a"])
    }

    @Test func aDownloadNotStartedIsDroppedWhenItsCellLeaves() async throws {
        let held = Held()
        let stored = Stored()
        let queue = Self.queue(limit: 1, ahead: 1, held: held, stored: stored)
        let blocker = Task { try await queue.data(key: "b", url: Self.url("b")) }
        await held.waitForStart("b")
        let gone = Task { try await queue.data(key: "gone", url: Self.url("gone")) }
        await Self.until { await queue.snapshot.queuedVisible == 1 }
        gone.cancel()
        await #expect(throws: CancellationError.self) { try await gone.value }
        held.open("b")
        _ = try await blocker.value
        await Self.tick()
        #expect(held.started == ["b"])
        #expect(stored.keys == ["b"])
    }

    @Test func oneCellLeavingDoesNotStopAnotherWaitingForTheSamePicture() async throws {
        let held = Held()
        let queue = Self.queue(limit: 1, ahead: 1, held: held)
        let blocker = Task { try await queue.data(key: "b", url: Self.url("b")) }
        await held.waitForStart("b")
        let first = Task { try await queue.data(key: "a", url: Self.url("a")) }
        let second = Task { try await queue.data(key: "a", url: Self.url("a")) }
        await Self.until { await queue.snapshot.waiters == 3 }
        first.cancel()
        await Self.until { await queue.snapshot.waiters == 2 }
        held.open("b")
        held.open("a")
        #expect(try await second.value == Data("picture a".utf8))
        _ = try? await first.value
        _ = try await blocker.value
        #expect(held.started == ["b", "a"])
    }

    // MARK: - Failures and signing out

    @Test func aFailedPictureIsNotPlannedAgainButIsAskedForAgain() async throws {
        let held = Held()
        held.fail("x")
        held.open("x")
        let queue = Self.queue(limit: 2, ahead: 2, held: held)
        await #expect(throws: URLError.self) { try await queue.data(key: "x", url: Self.url("x")) }
        await queue.prefetch([("x", Self.url("x"))])
        await Self.tick()
        #expect(held.started == ["x"], "the plan leaves it alone")
        await #expect(throws: URLError.self) { try await queue.data(key: "x", url: Self.url("x")) }
        #expect(held.started == ["x", "x"], "a cell on screen tries again")
    }

    /// Signing out cancels the planner, then the queue: a plan the planner
    /// was still sending must not be taken up after.
    @Test func aPlanFromACancelledPlannerIsIgnored() async throws {
        let held = Held()
        let queue = Self.queue(limit: 2, ahead: 2, held: held)
        let planner = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            await queue.prefetch([("late", Self.url("late"))])
        }
        await planner.value
        await Self.tick()
        #expect(held.started.isEmpty)
        #expect(await queue.snapshot == .init())
    }

    @Test func cancellingEverythingKeepsNothingThatArrivesAfter() async throws {
        let held = Held()
        let stored = Stored()
        let queue = Self.queue(limit: 2, ahead: 1, held: held, stored: stored)
        let ask = Task { try await queue.data(key: "a", url: Self.url("a")) }
        await held.waitForStart("a")
        await queue.cancelAll()
        await #expect(throws: CancellationError.self) { try await ask.value }
        held.open("a")
        await Self.tick()
        #expect(stored.keys.isEmpty)
        #expect(await queue.snapshot == .init())
    }
}

/// Where the eye is, and what to have ready around it.
struct PrefetchWindowTests {
    @Test func forwardFetchesAheadFirstThenAFewBehind() {
        let window = PrefetchWindow(ahead: 4, behind: 2, warmAhead: 2, warmBehind: 1)
        let plan = window.plan(around: 10, count: 100, forward: true)
        #expect(plan.fetch == [11, 12, 13, 14, 9, 8])
        #expect(plan.warm == [11, 12, 9])
    }

    @Test func backwardIsTheMirror() {
        let window = PrefetchWindow(ahead: 4, behind: 2, warmAhead: 2, warmBehind: 1)
        let plan = window.plan(around: 10, count: 100, forward: false)
        #expect(plan.fetch == [9, 8, 7, 6, 11, 12])
        #expect(plan.warm == [9, 8, 11])
    }

    @Test func theEndsOfTheFolderClipIt() {
        let window = PrefetchWindow(ahead: 5, behind: 5, warmAhead: 3, warmBehind: 3)
        #expect(window.plan(around: 1, count: 4, forward: true).fetch == [2, 3, 0])
        #expect(window.plan(around: 0, count: 1, forward: true).fetch == [])
        #expect(window.plan(around: 7, count: 0, forward: true) == .init(fetch: [], warm: []))
        #expect(window.plan(around: 99, count: 3, forward: true).fetch == [1, 0], "an index past the end is the last")
    }

    @Test func theDefaultsReachFourScreensOfAPhoneGrid() {
        let plan = PrefetchWindow().plan(around: 14, count: 500, forward: true)
        #expect(plan.fetch.prefix(60) == ArraySlice(15..<75))
        #expect(plan.warm.count == 24)
    }
}

struct ScrollFocusTests {
    @Test func theFirstScreenPlansFromItsLastCell() {
        var focus = ScrollFocus(step: 3)
        for i in [3, 0, 14, 7] { focus.note(i) }
        #expect(focus.settle() == 14)
        #expect(focus.forward)
    }

    @Test func aSmallMoveWaitsARowMovesOn() {
        var focus = ScrollFocus(step: 3)
        focus.note(14)
        _ = focus.settle()
        focus.note(15)
        #expect(focus.settle() == nil)
        focus.note(16); focus.note(17)
        #expect(focus.settle() == 17)
        #expect(focus.anchor == 17)
    }

    @Test func turningBackPlansAtOnce() {
        var focus = ScrollFocus(step: 3)
        focus.note(44)
        _ = focus.settle()
        for i in [27, 28, 29] { focus.note(i) }
        #expect(focus.settle() == 27)
        #expect(!focus.forward)
        focus.note(26)
        #expect(focus.settle() == nil, "a cell further back: the same way, not yet a row")
        focus.note(45)
        #expect(focus.settle() == 45, "forward again")
        #expect(focus.forward)
    }

    @Test func nothingNewPlansNothing() {
        var focus = ScrollFocus()
        #expect(focus.settle() == nil)
        focus.note(5)
        _ = focus.settle()
        focus.note(5)
        #expect(focus.settle() == nil)
        focus.reset()
        focus.note(2)
        #expect(focus.settle() == 2)
    }
}

// MARK: - A store with a round trip

/// Answers every request after `latency`, 1000 bytes, counting how many it
/// is answering at once — per host, so tests in parallel keep apart.
final class LatencyStub: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var latencies: [String: TimeInterval] = [:]
    nonisolated(unsafe) private static var current: [String: Int] = [:]
    nonisolated(unsafe) private static var peaks: [String: Int] = [:]
    nonisolated(unsafe) private static var answered: [String: [(start: TimeInterval, end: TimeInterval)]] = [:]

    static func register(host: String, latency: TimeInterval) {
        lock.withLock { latencies[host] = latency; current[host] = 0; peaks[host] = 0; answered[host] = [] }
    }
    static func peak(_ host: String) -> Int { lock.withLock { peaks[host] ?? 0 } }
    /// When each request reached the store and when it was answered, in
    /// seconds of uptime.
    static func requests(_ host: String) -> [(start: TimeInterval, end: TimeInterval)] {
        lock.withLock { answered[host] ?? [] }
    }

    /// No limit of URLSession's own in the way: the queue's is the one tested.
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LatencyStub.self]
        configuration.httpMaximumConnectionsPerHost = 64
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".latency.test") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private var stopped = false
    override func stopLoading() { Self.lock.withLock { stopped = true } }

    override func startLoading() {
        guard let url = request.url, let host = url.host,
              let latency = Self.lock.withLock({ Self.latencies[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let start = ProcessInfo.processInfo.systemUptime
        Self.lock.withLock {
            Self.current[host, default: 0] += 1
            Self.peaks[host] = max(Self.peaks[host] ?? 0, Self.current[host] ?? 0)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + latency) { [self] in
            Self.lock.withLock {
                Self.current[host, default: 0] -= 1
                Self.answered[host, default: []].append((start, ProcessInfo.processInfo.systemUptime))
            }
            guard !Self.lock.withLock({ stopped }) else { return }
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "image/webp"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(repeating: 7, count: 1000))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}
