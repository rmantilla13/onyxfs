import Foundation

/// The files kept on this Mac for offline use, in a folder the user chooses
/// (which may be on an external disk).
///
/// The Finder mount streams by default: the bridge redirects each read to
/// storage, so a drive of any size costs no disk. Pinning is the exception the
/// user asks for — one file, or a folder and whatever lands in it later — and
/// this is its bookkeeping: the rules, the copies on disk, and `reconcile`,
/// which makes the second match the first. The bridge asks `localCopy` before
/// redirecting, so a pinned file opens with the network gone.
///
/// Under `directory` — one store per account on one server (AccountFolder),
/// so another account on this Mac never inherits these rules or deletes
/// these copies:
///
///     pins.json                       the rules, and each scope's copies
///     <scope>/<fileId>-<etag hash>    one file's bytes, at one version
///     .incoming/                      downloads on their way in
///
/// A copy is named for its version, so a new version is written beside the
/// old and renamed into place: a reader gets the old bytes or the new, never
/// a mix, and a download that fails leaves the old copy serving. Downloads
/// are written into .incoming, on the store's own disk: an external cache
/// needs no room on the startup disk for them.
///
/// The folder may be on a disk that is not always there. A pass checks first,
/// and while the folder is gone or cannot be written it does nothing at all —
/// deletes nothing, fetches nothing — and says so (`problem`). It fetches a
/// file only when the disk has room for it, and a download that fails is
/// tried again after a wait that doubles each time, not on every pass.
///
/// The folder is the user's choice and may hold their own files, so the store
/// deletes and moves only the copies it recorded, never a folder's contents
/// wholesale. One store per folder: two would clear each other's downloads.
public actor PinStore {
    public struct ReconcileReport: Sendable, Equatable {
        /// Copies written this pass: files new to this Mac, and new versions.
        public var downloaded: Int
        /// Copies deleted because nothing pins them now, or the drive no
        /// longer has them. A replaced version is not counted.
        public var removed: Int
        /// fileId: why its download failed, or why it was not tried (no
        /// room). Such a file keeps any copy it had.
        public var failed: [String: String]
        /// Bytes written this pass.
        public var bytes: Int64
        /// Files not tried this pass: an earlier attempt failed, and its
        /// retry is not due yet.
        public var waiting: Int
        /// Folder rules naming no folder in the drive now: renamed or deleted
        /// on the web. What their files had stays while the drive still has
        /// the files, wherever they went.
        public var unresolved: [PinRule]
        /// Why the pass could not do all of its work; nil when it could.
        public var problem: Problem?

        public init(downloaded: Int = 0, removed: Int = 0, failed: [String: String] = [:], bytes: Int64 = 0,
                    waiting: Int = 0, unresolved: [PinRule] = [], problem: Problem? = nil) {
            self.downloaded = downloaded; self.removed = removed; self.failed = failed; self.bytes = bytes
            self.waiting = waiting; self.unresolved = unresolved; self.problem = problem
        }
    }

    /// Why files cannot be kept offline right now.
    public enum Problem: Sendable, Equatable {
        /// The folder is not there — its disk is not connected — or cannot
        /// be written to. Nothing was fetched or deleted.
        case unavailable
        /// Its disk has no room for some of what is pinned. Those were not
        /// fetched; the rest were.
        case full
    }

    /// Writes the whole of one entry's bytes to the file given, which is in
    /// the store's folder, on its disk. On a throw the store removes
    /// whatever was written.
    public typealias Download = @Sendable (MirrorEntry, URL) async throws -> Void

    public private(set) var directory: URL
    /// From the last pass: why it could not do all of its work, or nil.
    public private(set) var problem: Problem?
    private var state: State
    /// `state` has changes pins.json does not. A pass that changes nothing
    /// writes nothing: at a hundred thousand pinned files pins.json is some
    /// twenty megabytes, and a pass runs every fifteen seconds.
    private var dirty = false
    private var lastSaved: ContinuousClock.Instant?
    /// The disk `directory` was on when the store opened it. A folder by the
    /// same path on another disk — the cache's disk unplugged, and the path
    /// made again — is not this store's.
    private var device: dev_t?
    /// Each scope's pass, and the one queued behind it; see `reconcile`.
    private var lines: [String: Line] = [:]
    /// "<scope>\n<fileId>": downloads that failed, and when to try again.
    private var failures: [String: Failure] = [:]
    /// Bytes of the downloads under way, across passes: room the disk must
    /// keep for them.
    private var reserved: Int64 = 0
    /// The last answer from `freeSpace`, and when. Asking macOS what it could
    /// free can take a moment, and a pass of ten thousand small files asks
    /// before each; within a pass, an answer holds for a couple of seconds.
    private var lastFree: (bytes: Int64?, at: ContinuousClock.Instant)?
    private let retryAfter: Duration
    private let freeSpace: @Sendable (URL) -> Int64?

    static let maxDownloads = 3
    static let stateFile = "pins.json"
    static let incomingFolder = ".incoming"
    static let saveInterval: Duration = .milliseconds(500)
    /// Left free on the store's disk. Filled to the last byte, everything
    /// else on it stalls — on the startup disk, the whole Mac.
    static let spareSpace: Int64 = 1 << 30
    /// A failed download's wait before it is tried again doubles up to this.
    static let longestWait: Duration = .seconds(3600)

    private struct Line {
        var running: Task<ReconcileReport, Never>
        /// Starts when `running` ends, with the latest call's index.
        var queued: Task<ReconcileReport, Never>?
        var latest: Input?
    }

    private struct Input {
        let index: any PinnableIndex
        let download: Download
    }

    private struct Failure {
        let etag: String?
        let count: Int
        let retryAt: ContinuousClock.Instant
    }

    /// Opens the store in `directory`, creating it — but not on a disk that
    /// is not connected (PinStoreError.unavailable). A missing or unreadable
    /// pins.json starts the store empty: every copy can be fetched again and
    /// the rules set again, which beats a Finder mount that will not start.
    ///
    /// `retryAfter`: the first wait before a failed download is tried
    /// again. `freeSpace`: the bytes free on the disk holding a folder.
    public init(directory: URL, retryAfter: Duration = .seconds(30),
                freeSpace: @escaping @Sendable (URL) -> Int64? = { PinStore.availableCapacity($0) }) throws {
        if Self.isOnMissingVolume(directory) { throw PinStoreError.unavailable(directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let state = Self.load(directory)
        self.directory = directory
        self.state = state
        self.device = Self.device(of: directory)
        self.retryAfter = retryAfter
        self.freeSpace = freeSpace
        // Downloads a quit or a crash interrupted: never recorded, never served.
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(Self.incomingFolder))
        Self.sweepOldVersions(state, in: directory)
    }

    // MARK: - Rules

    public func rules() -> [PinRule] { state.rules }

    public func rules(scope: String) -> [PinRule] { state.rules.filter { $0.scope == scope } }

    /// Saved at once. Pinning what is already pinned — the same file, or the
    /// same folder spelled with other case or slashes — changes nothing.
    public func pin(_ rule: PinRule) {
        pin([rule])
    }

    /// Many at once — five thousand photos chosen in the window — saved once.
    public func pin(_ rules: [PinRule]) {
        var files = Set(state.rules.compactMap(Self.fileKey))
        for rule in rules.map(Self.normalized) {
            if let key = Self.fileKey(rule) {
                guard files.insert(key).inserted else { continue }
            } else if state.rules.contains(where: { Self.same($0, rule) }) {
                continue
            }
            state.rules.append(rule)
            dirty = true
        }
        save()
    }

    /// Saved at once. The copies go at the next `reconcile`, which does all
    /// of the disk work, so pinning and unpinning never wait on a disk.
    public func unpin(_ rule: PinRule) {
        unpin([rule])
    }

    public func unpin(_ rules: [PinRule]) {
        let files = Set(rules.compactMap(Self.fileKey))
        let folders = rules.filter { Self.fileKey($0) == nil }
        let before = state.rules.count
        state.rules.removeAll { rule in
            if let key = Self.fileKey(rule) { return files.contains(key) }
            return folders.contains { Self.same(rule, $0) }
        }
        if state.rules.count != before { dirty = true }
        save()
    }

    /// A file rule as one string, so thousands compare by hashing.
    private static func fileKey(_ rule: PinRule) -> String? {
        if case let .file(id) = rule.target { return rule.scope + "\n" + id }
        return nil
    }

    /// The scope's folder rules that name no folder in `index` — renamed or
    /// deleted on the web — to show as not found. Only an index that holds
    /// the whole drive can say a folder is not there.
    public func unresolved(scope: String, index: any PinnableIndex) -> [PinRule] {
        guard index.isAuthoritative else { return [] }
        return rules(scope: scope).filter { rule in
            if case let .folder(path) = rule.target { return !index.hasFolder(at: path) }
            return false
        }
    }

    /// A file: pinned itself, or at or under a pinned folder. A folder: it or
    /// an ancestor is pinned. Paths compare by whole segment and ignore case,
    /// as the mount does: pinning "Photos" pins "photos/a.jpg" but not
    /// "Photos 2025/a.jpg".
    public func isPinned(scope: String, entry: MirrorEntry) -> Bool {
        state.rules.contains { rule in
            guard rule.scope == scope else { return false }
            switch rule.target {
            case let .file(id): return !entry.isFolder && entry.fileId == id
            case let .folder(path): return Self.path(entry.path, isAtOrUnder: path)
            }
        }
    }

    /// Every file the scope's rules reach in `index`, each once, in rule order.
    public func wanted(scope: String, index: any PinnableIndex) -> [MirrorEntry] {
        var seen = Set<String>()
        var out: [MirrorEntry] = []
        func add(_ entry: MirrorEntry) {
            guard !entry.isFolder, let id = entry.fileId, seen.insert(id).inserted else { return }
            out.append(entry)
        }
        for rule in rules(scope: scope) {
            switch rule.target {
            case let .file(id): if let entry = index.file(id: id) { add(entry) }
            case let .folder(path): index.files(under: path).forEach(add)
            }
        }
        return out
    }

    // MARK: - Copies

    /// The copy to serve, or nil to stream instead. It must be on disk at the
    /// size recorded — a copy deleted by hand, or a disk that went away, is
    /// not served — and at `etag` when one is given.
    public func localCopy(scope: String, fileId: String, etag: String?) -> URL? {
        guard let copy = state.copies[scope]?[fileId] else { return nil }
        if let etag, copy.etag != etag { return nil }
        let url = location(of: copy, in: scope)
        return Self.fileSize(at: url) == copy.size ? url : nil
    }

    /// Bytes on disk: the recorded copies, each checked with one stat.
    public func usage() -> Int64 {
        state.copies.keys.reduce(0) { $0 + usage(scope: $1) }
    }

    public func usage(scope: String) -> Int64 {
        (state.copies[scope] ?? [:]).values.reduce(0) { $0 + (Self.fileSize(at: location(of: $1, in: scope)) ?? 0) }
    }

    /// Forget a scope: its rules and its copies. For a drive the user left or
    /// turned off.
    public func removeAll(scope: String) {
        state.rules.removeAll { $0.scope == scope }
        for copy in (state.copies[scope] ?? [:]).values {
            try? FileManager.default.removeItem(at: location(of: copy, in: scope))
        }
        state.copies[scope] = nil
        Self.removeIfEmpty(folder(for: scope))
        dirty = true
        save()
    }

    // MARK: - Reconcile

    /// Make the scope's copies match its rules against `index`: fetch what is
    /// missing or stale, at most three at a time, and delete what nothing pins.
    /// Deletes only when `index.isAuthoritative`: a drive still being fetched
    /// lacks files it has, and their copies are what someone offline has.
    /// Nothing at all while the store's folder is not there to write to.
    ///
    /// `download` writes one entry's bytes to a file in the store's folder;
    /// the store takes it from there. A failure is reported and the others
    /// carry on; the file keeps any older copy it had, and is tried again
    /// after a wait (`retryNow` skips it).
    ///
    /// One pass per scope at a time, and at most one waiting behind it. A
    /// call that arrives mid-pass waits, then gets a pass against its own
    /// index — the running pass's report would miss whatever changed since
    /// that pass read its index. Calls that arrive while one already waits
    /// share its pass, which takes the latest of their indexes: ten calls
    /// during a long download cost one more pass, not ten.
    public func reconcile(scope: String, index: any PinnableIndex,
                          download: @escaping Download) async -> ReconcileReport {
        let input = Input(index: index, download: download)
        let task: Task<ReconcileReport, Never>
        if var line = lines[scope] {
            line.latest = input
            if let queued = line.queued {
                task = queued
            } else {
                let running = line.running
                task = Task { _ = await running.value; return await self.runQueued(scope) }
                line.queued = task
            }
            lines[scope] = line
        } else {
            task = Task { await self.runPass(scope: scope, input: input) }
            lines[scope] = Line(running: task)
        }
        let report = await task.value
        if let line = lines[scope], line.running == task, line.queued == nil { lines[scope] = nil }
        return report
    }

    private func runQueued(_ scope: String) async -> ReconcileReport {
        guard !Task.isCancelled, var line = lines[scope], let queued = line.queued, let input = line.latest else {
            return ReconcileReport()
        }
        line.running = queued
        line.queued = nil
        line.latest = nil
        lines[scope] = line
        return await runPass(scope: scope, input: input)
    }

    /// Stop the passes under way: no download starts after this, and those
    /// running are cancelled. For a sign-out: the account's passes must not
    /// go on fetching — with the next account's sign-in — after it.
    public func cancelPasses() {
        for (scope, line) in lines {
            line.running.cancel()
            line.queued?.cancel()
            lines[scope]?.queued = nil
            lines[scope]?.latest = nil
        }
    }

    /// Try every failed download again at the next pass, without waiting:
    /// the network is back, or someone asked.
    public func retryNow() {
        failures = [:]
    }

    private enum Outcome: Sendable {
        case stored(bytes: Int64)
        /// Unpinned while it downloaded, or the pass was stopped; nothing kept.
        case dropped
        case failed(fileId: String, reason: String)
    }

    private struct Done: Sendable {
        let outcome: Outcome
        /// What was set aside on the disk for it.
        let reserved: Int64
    }

    private func runPass(scope: String, input: Input) async -> ReconcileReport {
        var report = ReconcileReport()
        let index = input.index
        // The disk it is on is not connected (or the folder is read-only):
        // fetching would throw every file away, and deleting would drop the
        // records of copies that are still on that disk.
        guard checkFolder() else {
            problem = .unavailable
            report.problem = .unavailable
            return report
        }
        let wanted = wanted(scope: scope, index: index)
        var keep = Set(wanted.compactMap(\.fileId))
        report.unresolved = unresolved(scope: scope, index: index)
        if !report.unresolved.isEmpty {
            // A pinned folder not in the drive now was most likely renamed on
            // the web. Its files' copies are not known apart from the rest, so
            // every copy of a file the drive still has stays — and is served
            // at the file's new path — until the rule is removed or found.
            // Copies of files gone from the drive go as usual.
            for fileId in (state.copies[scope] ?? [:]).keys where index.file(id: fileId) != nil {
                keep.insert(fileId)
            }
        }
        if Task.isCancelled { return report }

        // Deletions first: they free the room the downloads may need. The file
        // goes before the record, so a crash between the two re-tries the
        // deletion rather than leaking the file. None at all against an index
        // that may just not have everything yet.
        for (fileId, copy) in state.copies[scope] ?? [:] where index.isAuthoritative && !keep.contains(fileId) {
            try? FileManager.default.removeItem(at: location(of: copy, in: scope))
            state.copies[scope]?[fileId] = nil
            report.removed += 1
            dirty = true
        }
        if state.copies[scope]?.isEmpty == true { state.copies[scope] = nil }
        if report.removed > 0 { save() }
        // A wait owed by a file nothing pins now is forgotten.
        let prefix = scope + "\n"
        failures = failures.filter { key, _ in
            !key.hasPrefix(prefix) || keep.contains(String(key.dropFirst(prefix.count)))
        }

        lastFree = nil
        var needed: [MirrorEntry] = []
        for entry in wanted where needsDownload(entry, scope: scope) {
            if isWaiting(entry, scope: scope) { report.waiting += 1 } else { needed.append(entry) }
        }
        var full = false, unavailable = false
        await withTaskGroup(of: Done.self) { group in
            var queue = needed[...]
            /// The next file there is room for, its room set aside; nil when
            /// there is none, or the pass is to stop.
            func next() -> MirrorEntry? {
                while let entry = queue.popFirst() {
                    if Task.isCancelled { return nil }
                    // The disk unplugged mid-pass: stop, rather than fail
                    // every file left and make each wait to be tried again.
                    guard checkFolder() else { unavailable = true; return nil }
                    guard hasRoom(for: entry) else {
                        // Not fetched only to fail at the end. A smaller file
                        // further on may still fit.
                        full = true
                        if let id = entry.fileId { report.failed[id] = "Not enough free space for it." }
                        continue
                    }
                    reserved += entry.size
                    return entry
                }
                return nil
            }
            for _ in 0..<Self.maxDownloads {
                guard let entry = next() else { break }
                group.addTask { await self.fetch(entry, scope: scope, download: input.download) }
            }
            while let done = await group.next() {
                reserved -= done.reserved
                switch done.outcome {
                case let .stored(bytes):
                    report.downloaded += 1
                    report.bytes += bytes
                case .dropped:
                    break
                case let .failed(fileId, reason):
                    report.failed[fileId] = reason
                }
                if !unavailable, let entry = next() {
                    group.addTask { await self.fetch(entry, scope: scope, download: input.download) }
                }
            }
        }

        if state.copies[scope] == nil { Self.removeIfEmpty(folder(for: scope)) }
        report.problem = unavailable ? .unavailable : full ? .full : nil
        problem = report.problem
        save()
        return report
    }

    private func needsDownload(_ entry: MirrorEntry, scope: String) -> Bool {
        guard let fileId = entry.fileId else { return false }
        guard let copy = state.copies[scope]?[fileId] else { return true }
        // A file with no etag cannot be shown stale; the copy stands.
        if let etag = entry.etag, copy.etag != etag { return true }
        return Self.fileSize(at: location(of: copy, in: scope)) != copy.size
    }

    /// One download, off the actor until the final rename: the bridge asks
    /// this actor for local copies on every read. Written straight into
    /// .incoming, on the store's own disk, so the rename is all that is left.
    private nonisolated func fetch(_ entry: MirrorEntry, scope: String, download: Download) async -> Done {
        guard let fileId = entry.fileId else { return Done(outcome: .dropped, reserved: entry.size) }
        let staged = await incomingFolder().appendingPathComponent(UUID().uuidString)
        do { try await download(entry, staged) } catch {
            try? FileManager.default.removeItem(at: staged)
            // Stopped (a sign-out), not failed: nothing to wait out.
            if Task.isCancelled { return Done(outcome: .dropped, reserved: entry.size) }
            await failed(entry, fileId: fileId, scope: scope)
            return Done(outcome: .failed(fileId: fileId, reason: Self.describe(error)), reserved: entry.size)
        }
        return Done(outcome: await place(staged, entry: entry, fileId: fileId, scope: scope), reserved: entry.size)
    }

    /// Rename a staged download into place and record it; then the old
    /// version, if any, goes.
    private func place(_ staged: URL, entry: MirrorEntry, fileId: String, scope: String) -> Outcome {
        let fm = FileManager.default
        guard isPinned(scope: scope, entry: entry) else {
            try? fm.removeItem(at: staged)
            failures[Self.key(scope, fileId)] = nil
            return .dropped
        }
        guard let size = Self.fileSize(at: staged) else {
            failed(entry, fileId: fileId, scope: scope)
            return .failed(fileId: fileId, reason: "The download left no file.")
        }
        // A body cut short still arrives as a file. Served offline it would
        // be a corrupt copy nobody notices until they need it.
        if entry.size > 0, size != entry.size {
            try? fm.removeItem(at: staged)
            failed(entry, fileId: fileId, scope: scope)
            return .failed(fileId: fileId, reason: "Received \(size) of \(entry.size) bytes.")
        }
        let dir = folder(for: scope)
        let name = Self.storedName(fileId: fileId, etag: entry.etag)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try Self.putInPlace(staged, at: dir.appendingPathComponent(name))
        } catch {
            try? fm.removeItem(at: staged)
            failed(entry, fileId: fileId, scope: scope)
            return .failed(fileId: fileId, reason: Self.describe(error))
        }
        // The old version goes before the record changes: a crash in between
        // leaves the record naming a missing file, which the next pass fetches
        // again under the same name, instead of an old file nothing names.
        if let old = state.copies[scope]?[fileId], old.stored != name {
            try? fm.removeItem(at: dir.appendingPathComponent(old.stored))
        }
        state.copies[scope, default: [:]][fileId] = Copy(etag: entry.etag, size: size, stored: name)
        failures[Self.key(scope, fileId)] = nil
        dirty = true
        saveSoon()
        return .stored(bytes: size)
    }

    // MARK: - Trying again

    private static func key(_ scope: String, _ fileId: String) -> String { scope + "\n" + fileId }

    /// Waits 30 s, then 1, 2, 4… minutes, up to an hour. A new version of
    /// the file starts the count again.
    private func failed(_ entry: MirrorEntry, fileId: String, scope: String) {
        let key = Self.key(scope, fileId)
        let count = failures[key].map { $0.etag == entry.etag ? $0.count + 1 : 1 } ?? 1
        let wait = min(retryAfter * (1 << min(count - 1, 16)), Self.longestWait)
        failures[key] = Failure(etag: entry.etag, count: count, retryAt: .now + wait)
    }

    private func isWaiting(_ entry: MirrorEntry, scope: String) -> Bool {
        guard let fileId = entry.fileId, let failure = failures[Self.key(scope, fileId)],
              failure.etag == entry.etag else { return false }
        return ContinuousClock.now < failure.retryAt
    }

    // MARK: - The disk

    /// Whether the store's folder is there to write to. One deleted by hand,
    /// on a disk that is still here, is made again. One whose disk has gone
    /// is not made anywhere else: under /Volumes that would be a folder
    /// taking the disk's name, and macOS would mount the disk beside it.
    private func checkFolder() -> Bool {
        if let now = Self.device(of: directory) {
            if let device, now != device { return false }
        } else {
            if Self.isOnMissingVolume(directory) { return false }
            var parent = directory.deletingLastPathComponent()
            while Self.device(of: parent) == nil, parent.pathComponents.count > 1 {
                parent = parent.deletingLastPathComponent()
            }
            if let device, Self.device(of: parent) != device { return false }
            guard (try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)) != nil
            else { return false }
            device = Self.device(of: directory)
        }
        return access(directory.path, W_OK) == 0
    }

    /// Room for `entry` with the downloads under way, keeping `spareSpace`
    /// free. Unknown free space is not taken for none.
    private func hasRoom(for entry: MirrorEntry) -> Bool {
        guard entry.size > 0 else { return true }
        if lastFree == nil || ContinuousClock.now - lastFree!.at > .seconds(2) {
            lastFree = (freeSpace(directory), .now)
        }
        guard let free = lastFree?.bytes else { return true }
        return free - reserved - Self.spareSpace >= entry.size
    }

    /// Free bytes on the disk holding `url`: what macOS would make room for
    /// (purgeable space counts), or what is plainly free when it will not
    /// say. Nil when neither is known.
    public static func availableCapacity(_ url: URL) -> Int64? {
        // A URL made afresh: one that has been asked before may answer from
        // what it cached then.
        let values = try? URL(fileURLWithPath: url.path).resourceValues(
            forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey])
        let important = values?.volumeAvailableCapacityForImportantUsage.flatMap { $0 > 0 ? $0 : nil }
        let plain = values?.volumeAvailableCapacity.map(Int64.init)
        switch (important, plain) {
        case let (a?, b?): return max(a, b)
        case let (a, b): return a ?? b
        }
    }

    /// Whether `url` names a disk that is not connected: a path under
    /// /Volumes, where macOS mounts disks, whose disk's folder is not there.
    public static func isOnMissingVolume(_ url: URL) -> Bool {
        let parts = url.standardizedFileURL.pathComponents
        guard parts.count >= 3, parts[1] == "Volumes" else { return false }
        return !FileManager.default.fileExists(atPath: "/Volumes/" + parts[2])
    }

    static func device(of url: URL) -> dev_t? {
        var info = stat()
        let found = url.withUnsafeFileSystemRepresentation { path in path.map { stat($0, &info) == 0 } ?? false }
        return found ? info.st_dev : nil
    }

    private func incomingFolder() -> URL {
        let url = directory.appendingPathComponent(Self.incomingFolder, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    // MARK: - Relocating

    /// Move pins.json and every copy to `newDirectory`, and use it from now
    /// on. It may be on another disk. A folder that already has a pins.json
    /// belongs to another store (or an earlier one); it is refused rather
    /// than merged, since its copies and ours would each name files the other
    /// does not know. On failure, whatever moved is moved back.
    ///
    /// Runs on the actor, so reads of local copies wait for it: across disks
    /// it copies every byte. Refused while the store's folder is not there
    /// (PinStoreError.unavailable): its copies could not come along, and its
    /// pins.json would be left behind to be found by nothing.
    public func relocate(to newDirectory: URL) throws {
        let fm = FileManager.default
        if Self.sameFolder(directory, newDirectory) { return }
        guard checkFolder() else { throw PinStoreError.unavailable(directory) }
        if Self.isOnMissingVolume(newDirectory) { throw PinStoreError.unavailable(newDirectory) }
        let newState = newDirectory.appendingPathComponent(Self.stateFile)
        if fm.fileExists(atPath: newState.path) { throw PinStoreError.locationInUse(newDirectory) }
        try fm.createDirectory(at: newDirectory, withIntermediateDirectories: true)

        var moved: [(from: URL, to: URL)] = []
        do {
            for (scope, copies) in state.copies {
                let target = newDirectory.appendingPathComponent(Self.safeName(scope), isDirectory: true)
                try fm.createDirectory(at: target, withIntermediateDirectories: true)
                for copy in copies.values {
                    let from = location(of: copy, in: scope)
                    // Gone already: the next pass fetches it into the new place.
                    guard fm.fileExists(atPath: from.path) else { continue }
                    let to = target.appendingPathComponent(copy.stored)
                    // Same name, same file at the same version: an earlier
                    // store's copy of these very bytes.
                    try? fm.removeItem(at: to)
                    try Self.move(from, to: to)
                    moved.append((from, to))
                }
            }
            try Self.encode(state).write(to: newState, options: .atomic)
        } catch {
            for m in moved.reversed() { try? Self.move(m.to, to: m.from) }
            for scope in state.copies.keys {
                Self.removeIfEmpty(newDirectory.appendingPathComponent(Self.safeName(scope)))
            }
            throw error
        }

        // The old folder itself stays: the user chose it, and it may be theirs.
        try? fm.removeItem(at: directory.appendingPathComponent(Self.stateFile))
        for scope in state.copies.keys { Self.removeIfEmpty(folder(for: scope)) }
        Self.removeIfEmpty(directory.appendingPathComponent(Self.incomingFolder))
        directory = newDirectory
        device = Self.device(of: newDirectory)
        dirty = false
        lastSaved = .now
    }

    /// The stores kept in `folder`, one per account (AccountFolder names,
    /// each with a pins.json), for moving them all when the cache moves.
    public static func stores(in folder: URL) -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.filter { name in
            AccountFolder.isName(name) && FileManager.default.fileExists(
                atPath: folder.appendingPathComponent(name).appendingPathComponent(stateFile).path)
        }.sorted()
    }

    // MARK: - Saving

    /// Only when something changed since pins.json was last written. A write
    /// that fails leaves the change owed, for the next save.
    private func save() {
        guard dirty else { return }
        lastSaved = .now
        do {
            try Self.encode(state).write(to: directory.appendingPathComponent(Self.stateFile), options: .atomic)
            dirty = false
        } catch {
            // The disk may be back, or have room, by the next one.
        }
    }

    /// After a download, but at most twice a second. pins.json lists every
    /// copy, so writing it per file makes pinning ten thousand photos write
    /// gigabytes. A crash in between loses only the record: the next pass
    /// fetches those files again, into the same names. `runPass` saves at
    /// the end, if anything is owed.
    private func saveSoon() {
        if let lastSaved, ContinuousClock.now - lastSaved < Self.saveInterval { return }
        save()
    }

    // MARK: - Layout

    struct State: Codable, Equatable {
        var rules: [PinRule] = []
        /// scope → fileId → its copy.
        var copies: [String: [String: Copy]] = [:]

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            rules = try c.decodeIfPresent([PinRule].self, forKey: .rules) ?? []
            copies = try c.decodeIfPresent([String: [String: Copy]].self, forKey: .copies) ?? [:]
        }
    }

    struct Copy: Codable, Equatable, Sendable {
        let etag: String?
        let size: Int64
        /// The file name within the scope's folder.
        let stored: String
    }

    static func load(_ directory: URL) -> State {
        let url = directory.appendingPathComponent(stateFile)
        guard let data = try? Data(contentsOf: url) else { return State() }
        guard var state = try? JSONDecoder().decode(State.self, from: data) else {
            // Kept aside for a person to look at; the next save would
            // otherwise overwrite it.
            let aside = directory.appendingPathComponent("pins.corrupt.json")
            try? FileManager.default.removeItem(at: aside)
            try? FileManager.default.moveItem(at: url, to: aside)
            return State()
        }
        var rules: [PinRule] = []
        for rule in state.rules.map(normalized) where !rules.contains(where: { same($0, rule) }) {
            rules.append(rule)
        }
        state.rules = rules
        // pins.json sits in a folder anyone may edit, and a stored name is
        // later deleted: one that is not a plain file name is not trusted.
        state.copies = state.copies.mapValues { $0.filter { isPlainName($0.value.stored) } }.filter { !$0.value.isEmpty }
        return state
    }

    static func encode(_ state: State) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(state)
    }

    private func folder(for scope: String) -> URL {
        directory.appendingPathComponent(Self.safeName(scope), isDirectory: true)
    }

    private func location(of copy: Copy, in scope: String) -> URL {
        folder(for: scope).appendingPathComponent(copy.stored)
    }

    static let hashLength = 12

    /// "<fileId>-<first 12 hex of SHA-256(etag)>": stable across launches,
    /// unlike Swift's Hasher, and different for each version.
    static func storedName(fileId: String, etag: String?) -> String {
        safeName(fileId) + "-" + SigV4.sha256Hex(etag ?? "").prefix(hashLength)
    }

    private static let plainCharacters = CharacterSet(
        charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")

    static func isPlainName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= 128 && !name.hasPrefix(".")
            && name.unicodeScalars.allSatisfy(plainCharacters.contains)
    }

    /// A scope or file id as one path component. Server ids (UUIDs) and
    /// scopes ("drive.<id>", "library") pass through; anything else — a "/",
    /// "..", a leading dot — is hashed rather than trusted.
    static func safeName(_ s: String) -> String {
        isPlainName(s) ? s : "h" + SigV4.sha256Hex(s).prefix(32)
    }

    /// Versions a crash left behind between renaming a new one in and
    /// deleting the old: files named for a recorded file id at an etag it no
    /// longer has. Only such names, since the folder may hold the user's own
    /// files.
    static func sweepOldVersions(_ state: State, in directory: URL) {
        let fm = FileManager.default
        for (scope, copies) in state.copies {
            let folder = directory.appendingPathComponent(safeName(scope), isDirectory: true)
            let current = Set(copies.values.map(\.stored))
            let ids = Set(copies.keys.map(safeName))
            guard let names = try? fm.contentsOfDirectory(atPath: folder.path) else { continue }
            for name in names where !current.contains(name) {
                let cut = name.index(name.endIndex, offsetBy: -(hashLength + 1), limitedBy: name.startIndex)
                guard let cut, name[cut] == "-", ids.contains(String(name[..<cut])),
                      name[name.index(after: cut)...].allSatisfy({ "0123456789abcdef".contains($0) }) else { continue }
                try? fm.removeItem(at: folder.appendingPathComponent(name))
            }
        }
    }

    // MARK: - Paths and files

    static func normalized(_ rule: PinRule) -> PinRule {
        guard case let .folder(path) = rule.target else { return rule }
        return PinRule(scope: rule.scope, target: .folder(path: Replica.clean(path)))
    }

    static func same(_ a: PinRule, _ b: PinRule) -> Bool {
        guard a.scope == b.scope else { return false }
        switch (a.target, b.target) {
        case let (.file(x), .file(y)): return x == y
        case let (.folder(x), .folder(y)): return path(x, isAtOrUnder: y) && path(y, isAtOrUnder: x)
        default: return false
        }
    }

    /// By whole segments, ignoring case: "Photos" holds "photos/a.jpg" but
    /// not "Photos 2025/a.jpg". "" holds everything.
    static func path(_ path: String, isAtOrUnder folder: String) -> Bool {
        let outer = folder.split(separator: "/"), inner = path.split(separator: "/")
        guard inner.count >= outer.count else { return false }
        return zip(outer, inner).allSatisfy { $0.caseInsensitiveCompare($1) == .orderedSame }
    }

    static func sameFolder(_ a: URL, _ b: URL) -> Bool {
        if a.standardizedFileURL.resolvingSymlinksInPath() == b.standardizedFileURL.resolvingSymlinksInPath() {
            return true
        }
        let key: Set<URLResourceKey> = [.fileResourceIdentifierKey]
        guard let x = try? a.resourceValues(forKeys: key).fileResourceIdentifier,
              let y = try? b.resourceValues(forKeys: key).fileResourceIdentifier else { return false }
        return x.isEqual(y)
    }

    /// A regular file's size, from one stat; nil for anything else.
    static func fileSize(at url: URL) -> Int64? {
        var info = stat()
        let found = url.withUnsafeFileSystemRepresentation { path in path.map { stat($0, &info) == 0 } ?? false }
        guard found, info.st_mode & S_IFMT == S_IFREG else { return nil }
        return Int64(info.st_size)
    }

    /// rename(2): atomic within one disk, replacing whatever `target` was. If
    /// the store was relocated to another disk mid-download, the staged file
    /// is on the old one and is moved across instead.
    static func putInPlace(_ staged: URL, at target: URL) throws {
        let result = staged.withUnsafeFileSystemRepresentation { from in
            target.withUnsafeFileSystemRepresentation { to in rename(from!, to!) }
        }
        if result == 0 { return }
        let code = errno
        guard code == EXDEV else { throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO) }
        try? FileManager.default.removeItem(at: target)
        try move(staged, to: target)
    }

    /// A move that also works across disks: copy, then delete the original,
    /// when a rename cannot. `target` must not exist.
    static func move(_ source: URL, to target: URL) throws {
        let fm = FileManager.default
        do { try fm.moveItem(at: source, to: target) } catch {
            guard fm.fileExists(atPath: source.path) else { throw error }
            try? fm.removeItem(at: target) // what a failed move may have half-written
            do { try fm.copyItem(at: source, to: target) } catch {
                try? fm.removeItem(at: target)
                throw error
            }
            try? fm.removeItem(at: source)
        }
    }

    /// Only when nothing but Finder's .DS_Store is left in it.
    public static func removeIfEmpty(_ folder: URL) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path),
              names.allSatisfy({ $0 == ".DS_Store" }) else { return }
        try? FileManager.default.removeItem(at: folder)
    }

    static func describe(_ error: any Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

public enum PinStoreError: LocalizedError, Equatable {
    /// The chosen folder already has a pins.json.
    case locationInUse(URL)
    /// The folder is on a disk that is not connected, or cannot be written.
    case unavailable(URL)

    public var errorDescription: String? {
        switch self {
        case let .locationInUse(url):
            return "\u{201C}\(url.lastPathComponent)\u{201D} already holds offline files from an earlier use. "
                + "Choose another folder, or empty that one first."
        case let .unavailable(url):
            return "\(url.path) is not available. Connect the disk it is on."
        }
    }
}
