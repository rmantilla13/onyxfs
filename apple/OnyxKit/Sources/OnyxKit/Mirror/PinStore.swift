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
/// Under `directory`:
///
///     pins.json                       the rules, and each scope's copies
///     <scope>/<fileId>-<etag hash>    one file's bytes, at one version
///     .incoming/                      downloads on their way in
///
/// A copy is named for its version, so a new version is written beside the
/// old and renamed into place: a reader gets the old bytes or the new, never
/// a mix, and a download that fails leaves the old copy serving.
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
        /// fileId: why its download failed. Such a file keeps any copy it had.
        public var failed: [String: String]
        /// Bytes written this pass.
        public var bytes: Int64

        public init(downloaded: Int = 0, removed: Int = 0, failed: [String: String] = [:], bytes: Int64 = 0) {
            self.downloaded = downloaded; self.removed = removed; self.failed = failed; self.bytes = bytes
        }
    }

    public private(set) var directory: URL
    private var state: State
    /// The pass running (or queued) for each scope; see `reconcile`.
    private var passes: [String: Task<ReconcileReport, Never>] = [:]
    private var lastSaved: ContinuousClock.Instant?

    static let maxDownloads = 3
    static let stateFile = "pins.json"
    static let incomingFolder = ".incoming"
    static let saveInterval: Duration = .milliseconds(500)

    /// Opens the store in `directory`, creating it. A missing or unreadable
    /// pins.json starts the store empty: every copy can be fetched again and
    /// the rules set again, which beats a Finder mount that will not start.
    public init(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let state = Self.load(directory)
        self.directory = directory
        self.state = state
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
        let rule = Self.normalized(rule)
        guard !state.rules.contains(where: { Self.same($0, rule) }) else { return }
        state.rules.append(rule)
        save()
    }

    /// Saved at once. The copies go at the next `reconcile`, which does all
    /// of the disk work, so pinning and unpinning never wait on a disk.
    public func unpin(_ rule: PinRule) {
        let before = state.rules.count
        state.rules.removeAll { Self.same($0, rule) }
        if state.rules.count != before { save() }
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
        save()
    }

    // MARK: - Reconcile

    /// Make the scope's copies match its rules against `index`: fetch what is
    /// missing or stale, at most three at a time, and delete what nothing pins.
    ///
    /// `download` returns a temporary file holding the whole of one entry's
    /// bytes; the store takes it from there. A failure is reported and the
    /// others carry on; the file keeps any older copy it had.
    ///
    /// One pass per scope at a time. A call that arrives mid-pass waits, then
    /// runs its own pass against its own index — handing it the running
    /// pass's report instead would miss whatever changed since that pass read
    /// its index.
    public func reconcile(scope: String, index: any PinnableIndex,
                          download: @escaping @Sendable (MirrorEntry) async throws -> URL) async -> ReconcileReport {
        let previous = passes[scope]
        let pass = Task { () async -> ReconcileReport in
            _ = await previous?.value
            return await self.runPass(scope: scope, index: index, download: download)
        }
        passes[scope] = pass
        let report = await pass.value
        if passes[scope] == pass { passes[scope] = nil }
        return report
    }

    private enum Outcome: Sendable {
        case stored(bytes: Int64)
        /// Unpinned while it downloaded; nothing kept.
        case dropped
        case failed(fileId: String, reason: String)
    }

    private func runPass(scope: String, index: any PinnableIndex,
                         download: @escaping @Sendable (MirrorEntry) async throws -> URL) async -> ReconcileReport {
        var report = ReconcileReport()
        let wanted = wanted(scope: scope, index: index)
        let keep = Set(wanted.compactMap(\.fileId))

        // Deletions first: they free the room the downloads may need. The file
        // goes before the record, so a crash between the two re-tries the
        // deletion rather than leaking the file.
        for (fileId, copy) in state.copies[scope] ?? [:] where !keep.contains(fileId) {
            try? FileManager.default.removeItem(at: location(of: copy, in: scope))
            state.copies[scope]?[fileId] = nil
            report.removed += 1
        }
        if state.copies[scope]?.isEmpty == true { state.copies[scope] = nil }
        if report.removed > 0 { save() }

        let needed = wanted.filter { needsDownload($0, scope: scope) }
        await withTaskGroup(of: Outcome.self) { group in
            var queue = needed[...]
            for _ in 0..<Self.maxDownloads {
                guard let entry = queue.popFirst() else { break }
                group.addTask { await self.fetch(entry, scope: scope, download: download) }
            }
            while let outcome = await group.next() {
                switch outcome {
                case let .stored(bytes):
                    report.downloaded += 1
                    report.bytes += bytes
                case .dropped:
                    break
                case let .failed(fileId, reason):
                    report.failed[fileId] = reason
                }
                if let entry = queue.popFirst() {
                    group.addTask { await self.fetch(entry, scope: scope, download: download) }
                }
            }
        }

        if state.copies[scope] == nil { Self.removeIfEmpty(folder(for: scope)) }
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

    /// One download, off the actor until the final rename. Moving the bytes
    /// onto the cache's disk is a full copy when that disk is external, and
    /// the bridge asks this actor for local copies on every read.
    private nonisolated func fetch(_ entry: MirrorEntry, scope: String,
                                   download: @Sendable (MirrorEntry) async throws -> URL) async -> Outcome {
        guard let fileId = entry.fileId else { return .dropped }
        let temp: URL
        do { temp = try await download(entry) } catch {
            return .failed(fileId: fileId, reason: Self.describe(error))
        }
        let staged = await incomingFolder().appendingPathComponent(UUID().uuidString)
        do { try Self.move(temp, to: staged) } catch {
            try? FileManager.default.removeItem(at: temp)
            return .failed(fileId: fileId, reason: Self.describe(error))
        }
        return await place(staged, entry: entry, fileId: fileId, scope: scope)
    }

    /// Rename a staged download into place and record it; then the old
    /// version, if any, goes.
    private func place(_ staged: URL, entry: MirrorEntry, fileId: String, scope: String) -> Outcome {
        let fm = FileManager.default
        guard isPinned(scope: scope, entry: entry) else {
            try? fm.removeItem(at: staged)
            return .dropped
        }
        guard let size = Self.fileSize(at: staged) else {
            return .failed(fileId: fileId, reason: "The download left no file.")
        }
        // A body cut short still arrives as a file. Served offline it would
        // be a corrupt copy nobody notices until they need it.
        if entry.size > 0, size != entry.size {
            try? fm.removeItem(at: staged)
            return .failed(fileId: fileId, reason: "Received \(size) of \(entry.size) bytes.")
        }
        let dir = folder(for: scope)
        let name = Self.storedName(fileId: fileId, etag: entry.etag)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try Self.putInPlace(staged, at: dir.appendingPathComponent(name))
        } catch {
            try? fm.removeItem(at: staged)
            return .failed(fileId: fileId, reason: Self.describe(error))
        }
        // The old version goes before the record changes: a crash in between
        // leaves the record naming a missing file, which the next pass fetches
        // again under the same name, instead of an old file nothing names.
        if let old = state.copies[scope]?[fileId], old.stored != name {
            try? fm.removeItem(at: dir.appendingPathComponent(old.stored))
        }
        state.copies[scope, default: [:]][fileId] = Copy(etag: entry.etag, size: size, stored: name)
        saveSoon()
        return .stored(bytes: size)
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
    /// it copies every byte.
    public func relocate(to newDirectory: URL) throws {
        let fm = FileManager.default
        if Self.sameFolder(directory, newDirectory) { return }
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
        lastSaved = .now
    }

    // MARK: - Saving

    private func save() {
        lastSaved = .now
        try? Self.encode(state).write(to: directory.appendingPathComponent(Self.stateFile), options: .atomic)
    }

    /// After a download, but at most twice a second. pins.json lists every
    /// copy, so writing it per file makes pinning ten thousand photos write
    /// gigabytes. A crash in between loses only the record: the next pass
    /// fetches those files again, into the same names. `runPass` saves at
    /// the end regardless.
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
    static func removeIfEmpty(_ folder: URL) {
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

    public var errorDescription: String? {
        switch self {
        case let .locationInUse(url):
            return "\u{201C}\(url.lastPathComponent)\u{201D} already holds offline files from an earlier use. "
                + "Choose another folder, or empty that one first."
        }
    }
}
