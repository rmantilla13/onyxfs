import CryptoKit
import Foundation

/// What an onyxfs volume keeps on this Mac only: the bytes of local-only
/// files (LocalOnly — .DS_Store and the like) and every item's extended
/// attributes (Finder tags and comments, quarantine flags, where a download
/// came from). Neither reaches the web. Kept on disk, keyed by the path
/// within the drive, so a Finder window's layout and a file's tags survive
/// the drive being ejected and mounted again.
///
/// Extended attributes live here rather than nowhere because a volume that
/// has none makes macOS write them as `._name` files beside every file
/// copied onto it (AppleDouble) — here, at least, those would never be
/// uploaded, but they would be written for every file.
///
/// Layout: `index.json` (paths → blobs, folders, dates; attribute names →
/// values or blobs), `index-<generation>.log` (every change since it was
/// written) and `blobs/<uuid>` for file contents and large values.
///
/// Every change is on disk before the call returns, as one line added to
/// the log: what each path the call touched holds now, a few hundred bytes
/// however much the store holds. index.json is written whole only once the
/// log has outgrown it, and as the store opens. Written whole on every
/// change, a copy onto a drive whose store held 10,000 `._` files spent
/// 20–30 ms on each of the four changes Finder makes to each new one.
public actor LocalStore {
    public enum Failure: Error, Equatable {
        /// errno, as the file system hands it to the kernel.
        case posix(Int32)
    }

    /// One attribute value may be this large; a resource fork is the only
    /// thing that comes near it.
    public static let maximumAttributeSize = 8 << 20
    /// Values up to this size stay inside the index.
    static let inlineLimit = 4096
    /// The log is folded into index.json once it has outgrown the index it
    /// describes: past what index.json last took, and past this. So what is
    /// written whole is of the order of what was added since, never the
    /// whole index again for each change — and what an open reads back is
    /// at most about as much again as index.json.
    static let logFloor = 256 << 10
    /// And not more often than this, however fast things change.
    static let compactInterval: Duration = .seconds(1)
    static let indexFile = "index.json"

    struct Entry: Codable {
        var blob: String?
        var directory: Bool
        var modified: Double
    }

    struct Attribute: Codable {
        var inline: Data?
        var blob: String?
    }

    struct Index: Codable {
        /// Names the log that goes on from this index.json. A log beside an
        /// index.json written since — by an Onyx from before logs, which
        /// writes it without one, or as the log was being folded in — is
        /// not its log, and says nothing.
        var generation: String?
        var files: [String: Entry] = [:]
        var attributes: [String: [String: Attribute]] = [:]
        /// The SHA-256 of the drive's icon as last placed (placeVolumeIcon):
        /// an icon at the root with other bytes is the person's own.
        var volumeIcon: String?
        /// The paths directly in each folder — local items, items with
        /// attributes, and the folders on the way to them — so what is in a
        /// folder, or under a path, is found without looking at every path.
        /// Not saved: made again as the index is read.
        var children: [String: Set<String>] = [:]

        enum CodingKeys: String, CodingKey { case generation, files, attributes, volumeIcon }
    }

    /// One change, as the log has it: what one path holds now.
    enum Change: Codable {
        /// A local file or folder; nil: none there now.
        case file(path: String, entry: Entry?)
        /// An item's attributes; nil: none now.
        case attributes(path: String, values: [String: Attribute]?)
        case volumeIcon(digest: String?)
    }

    private let root: URL
    private let blobs: URL
    private var index = Index()
    /// What the call under way has changed, for one line of the log, and
    /// the blobs nothing points at once that line is written.
    private var pending: [Change] = []
    private var unused: [String] = []
    /// The log, open for adding to while the store lives; -1 until first used.
    private var log: Int32 = -1
    /// Bytes of whole lines in the log.
    private var logBytes = 0
    /// What index.json took when last written.
    private var snapshotBytes = 0
    private var compactedAt: ContinuousClock.Instant?

    /// What the store has written, for tests and the bench.
    struct DiskWrites: Sendable, Equatable {
        /// index.json written whole.
        var snapshots = 0
        var snapshotBytes = 0
        /// Lines added to the log.
        var appends = 0
        var appendBytes = 0
    }
    private(set) var disk = DiskWrites()

    public init(directory: URL) throws {
        root = directory
        blobs = directory.appendingPathComponent("blobs", isDirectory: true)
        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true)
        let saved = Self.load(directory)
        var index = saved.index
        var snapshotBytes = saved.bytes, logBytes = 0
        var disk = DiskWrites()
        if saved.logged != nil || index.generation == nil {
            // Folded in now, so the log starts empty and stays short; and a
            // store that is new, or from before logs, gets a generation for
            // its log to go by.
            if let written = Self.snapshot(&index, in: directory) {
                snapshotBytes = written
                disk.snapshots = 1
                disk.snapshotBytes = written
            } else if let whole = saved.logged, let generation = index.generation {
                // Kept, to be added to: it holds what index.json lacks. A line
                // a crash cut short goes first, or the next would join it.
                _ = Self.logURL(generation, in: directory).withUnsafeFileSystemRepresentation {
                    $0.map { Darwin.truncate($0, off_t(whole)) }
                }
                logBytes = whole
            }
        }
        // Logs that index.json does not go by: left by a crash as one was
        // folded in, or beside one an Onyx from before logs wrote.
        let current = index.generation.map(Self.logName)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        where name.hasPrefix(Self.logPrefix) && name.hasSuffix(".log") && name != current {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
        self.index = index
        self.snapshotBytes = snapshotBytes
        self.logBytes = logBytes
        self.disk = disk
    }

    deinit {
        if log >= 0 { close(log) }
    }

    // MARK: - Local-only files

    public func exists(_ path: String) -> Bool { index.files[path] != nil }

    public func isDirectory(_ path: String) -> Bool { index.files[path]?.directory ?? false }

    /// The names directly inside a folder.
    public func names(in directory: String) -> [String] {
        (index.children[directory] ?? []).compactMap { path -> String? in
            guard index.files[path] != nil else { return nil }
            let name = Index.name(of: path)
            return name.isEmpty ? nil : name
        }.sorted()
    }

    public func size(_ path: String) -> UInt64 {
        guard let blob = index.files[path]?.blob else { return 0 }
        let attributes = try? FileManager.default.attributesOfItem(atPath: blobURL(blob).path)
        return (attributes?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    public func modified(_ path: String) -> Date {
        Date(timeIntervalSince1970: index.files[path]?.modified ?? 0)
    }

    public func createFile(_ path: String) throws {
        guard index.files[path] == nil else { throw Failure.posix(EEXIST) }
        let blob = UUID().uuidString
        guard FileManager.default.createFile(atPath: blobURL(blob).path, contents: nil) else { throw Failure.posix(EIO) }
        change(.file(path: path, entry: Entry(blob: blob, directory: false, modified: Date().timeIntervalSince1970)))
        save()
    }

    public func createDirectory(_ path: String) throws {
        guard index.files[path] == nil else { throw Failure.posix(EEXIST) }
        change(.file(path: path, entry: Entry(blob: nil, directory: true, modified: Date().timeIntervalSince1970)))
        save()
    }

    public func read(_ path: String, at offset: Int64, count: Int) throws -> Data {
        let handle = try open(path, writing: false)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(max(0, offset)))
        return try handle.read(upToCount: count) ?? Data()
    }

    public func write(_ path: String, at offset: Int64, _ data: Data) throws -> Int {
        let handle = try open(path, writing: true)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(max(0, offset)))
        try handle.write(contentsOf: data)
        touch(path)
        return data.count
    }

    public func truncate(_ path: String, to size: UInt64) throws {
        let handle = try open(path, writing: true)
        defer { try? handle.close() }
        try handle.truncate(atOffset: size)
        touch(path)
    }

    public func setModified(_ path: String, to date: Date) {
        guard var entry = index.files[path] else { return }
        entry.modified = date.timeIntervalSince1970
        change(.file(path: path, entry: entry))
        save()
    }

    /// The item and everything under it: its bytes and its attributes.
    public func remove(_ path: String) {
        removing(path)
        save()
    }

    /// A rename or move: the item and everything under it, bytes and
    /// attributes, now answer to the new path. What was at the new path is
    /// replaced.
    public func move(_ from: String, to: String) {
        guard from != to else { return }
        if index.files[from] != nil { removing(to) }
        let under = index.walk(from)
        let files = under.compactMap { key in index.files[key].map { (key, $0) } }
        let attributes = under.compactMap { key in index.attributes[key].map { (key, $0) } }
        for (key, _) in files { change(.file(path: key, entry: nil)) }
        for (key, entry) in files { change(.file(path: to + key.dropFirst(from.count), entry: entry)) }
        for (key, _) in attributes { change(.attributes(path: key, values: nil)) }
        for (key, values) in attributes { change(.attributes(path: to + key.dropFirst(from.count), values: values)) }
        save()
    }

    /// The item at `path` and everything under it, parents first, by path
    /// relative to it ("" is the item itself).
    public func subtree(_ path: String) -> [(relative: String, directory: Bool, modified: Date)] {
        index.walk(path)
            .compactMap { key -> (relative: String, directory: Bool, modified: Date)? in
                guard let entry = index.files[key] else { return nil }
                let relative = key == path ? "" : String(key.dropFirst(path.count + 1))
                return (relative, entry.directory, Date(timeIntervalSince1970: entry.modified))
            }
            .sorted { $0.relative.split(separator: "/").count < $1.relative.split(separator: "/").count
                || ($0.relative.split(separator: "/").count == $1.relative.split(separator: "/").count && $0.relative < $1.relative) }
    }

    /// Where a local file's bytes are, for them to be handed over whole.
    public func fileURL(_ path: String) -> URL? {
        guard let entry = index.files[path], !entry.directory, let blob = entry.blob else { return nil }
        return blobURL(blob)
    }

    /// These items are this Mac's own no more — they went up as the
    /// drive's: their entries and bytes go. Their attributes stay, as any
    /// item's do, and so does anything else under them.
    public func release(_ paths: [String]) {
        for path in paths {
            guard let entry = index.files[path] else { continue }
            if let blob = entry.blob { unused.append(blob) }
            change(.file(path: path, entry: nil))
        }
        save()
    }

    // MARK: - Extended attributes (any item's, local or not)

    public func attribute(_ name: String, of path: String) throws -> Data {
        guard let stored = index.attributes[path]?[name] else { throw Failure.posix(ENOATTR) }
        if let inline = stored.inline { return inline }
        guard let blob = stored.blob, let data = try? Data(contentsOf: blobURL(blob)) else { throw Failure.posix(ENOATTR) }
        return data
    }

    /// `value` nil removes it. createOnly / replaceOnly are XATTR_CREATE and
    /// XATTR_REPLACE.
    public func setAttribute(_ name: String, of path: String, to value: Data?, createOnly: Bool = false, replaceOnly: Bool = false) throws {
        var values = index.attributes[path] ?? [:]
        let existing = values[name]
        if let value {
            if createOnly, existing != nil { throw Failure.posix(EEXIST) }
            if replaceOnly, existing == nil { throw Failure.posix(ENOATTR) }
            guard value.count <= Self.maximumAttributeSize else { throw Failure.posix(E2BIG) }
            var stored = Attribute(inline: nil, blob: nil)
            if value.count <= Self.inlineLimit {
                stored.inline = value
            } else {
                let blob = UUID().uuidString
                do { try value.write(to: blobURL(blob), options: .atomic) } catch { throw Failure.posix(EIO) }
                stored.blob = blob
            }
            values[name] = stored
        } else {
            guard existing != nil else { throw Failure.posix(ENOATTR) }
            values[name] = nil
        }
        // The value it had keeps its blob until the change is on disk.
        if let blob = existing?.blob { unused.append(blob) }
        change(.attributes(path: path, values: values))
        save()
    }

    public func attributeNames(of path: String) -> [String] {
        (index.attributes[path]?.keys).map { $0.sorted() } ?? []
    }

    /// An item gone from the drive (deleted on the web, or here) takes its
    /// attributes with it.
    public func removeAttributes(under path: String) {
        removingAttributes(index.walk(path))
        save()
    }

    // MARK: - The drive's icon

    static let volumeIconPath = "/.VolumeIcon.icns"
    static let rootAttributesPath = "/" + AppleDouble.rootName

    /// The drive's icon on its disk, where macOS looks for a disk's own:
    /// `.VolumeIcon.icns` at the root, and Finder's custom-icon flag in the
    /// root's Finder info, which on this volume is in `._.` (AppleDouble).
    /// Both are macOS's files, so they live here, never on the web.
    ///
    /// Placed as the disk mounts, before Finder first looks at it, and again
    /// whenever the app draws the drive a new one. An icon the person gave
    /// the disk themselves (Get Info) is theirs, and stays; one removed
    /// comes back at the next mount, as the disk's own.
    public func placeVolumeIcon(_ icon: Data) throws {
        let digest = Self.digest(icon)
        let path = Self.volumeIconPath
        if let current = try? contents(path) {
            // Bytes this store did not put there: the person's icon. Our
            // own are ours even with no record of them (an older Onyx saved
            // the index without it).
            guard current == icon || Self.digest(current) == index.volumeIcon else { return }
            if current != icon { try rewrite(path, with: icon) }
        } else {
            if exists(path) { remove(path) } // there, but unreadable
            try createFile(path)
            try rewrite(path, with: icon)
        }
        if index.volumeIcon != digest {
            change(.volumeIcon(digest: digest))
            save()
        }

        let attributes = Self.rootAttributesPath
        if let current = try? contents(attributes) {
            // Finder may keep more of the root's here: only the flag changes.
            if let flagged = AppleDouble.settingFinderFlags(AppleDouble.hasCustomIcon, in: current), flagged != current {
                try rewrite(attributes, with: flagged)
            }
        } else {
            if exists(attributes) { remove(attributes) }
            try createFile(attributes)
            try rewrite(attributes, with: AppleDouble.file(finderFlags: AppleDouble.hasCustomIcon))
        }
    }

    // MARK: -

    /// A local file's bytes, whole.
    private func contents(_ path: String) throws -> Data {
        guard let blob = index.files[path]?.blob, let data = try? Data(contentsOf: blobURL(blob)) else {
            throw Failure.posix(ENOENT)
        }
        return data
    }

    private func rewrite(_ path: String, with data: Data) throws {
        try truncate(path, to: 0)
        _ = try write(path, at: 0, data)
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func blobURL(_ blob: String) -> URL { blobs.appendingPathComponent(blob) }

    private func open(_ path: String, writing: Bool) throws -> FileHandle {
        guard let entry = index.files[path] else { throw Failure.posix(ENOENT) }
        guard !entry.directory, let blob = entry.blob else { throw Failure.posix(EISDIR) }
        let url = blobURL(blob)
        do {
            return writing ? try FileHandle(forUpdating: url) : try FileHandle(forReadingFrom: url)
        } catch {
            throw Failure.posix(EIO)
        }
    }

    private func touch(_ path: String) { setModified(path, to: Date()) }

    /// What `remove` does, saved by the caller.
    private func removing(_ path: String) {
        let under = index.walk(path)
        for key in under {
            guard let entry = index.files[key] else { continue }
            if let blob = entry.blob { unused.append(blob) }
            change(.file(path: key, entry: nil))
        }
        removingAttributes(under)
    }

    private func removingAttributes(_ paths: [String]) {
        for path in paths {
            guard let values = index.attributes[path] else { continue }
            unused += values.values.compactMap(\.blob)
            change(.attributes(path: path, values: nil))
        }
    }

    // MARK: - On disk

    static let logPrefix = "index-"

    static func logName(_ generation: String) -> String { logPrefix + generation + ".log" }

    static func logURL(_ generation: String, in directory: URL) -> URL {
        directory.appendingPathComponent(logName(generation))
    }

    /// A change, made to the index now and saved as the call ends (`save`).
    private func change(_ change: Change) {
        index.apply(change)
        pending.append(change)
    }

    /// What the call changed, on disk before it returns: one line added to
    /// the log, so a crash leaves all of it or none. Then the blobs it left
    /// unused go, and index.json is written if it is time (`compactIfDue`).
    private func save() {
        defer {
            pending = []
            unused = []
        }
        guard !pending.isEmpty, var line = try? JSONEncoder().encode(pending) else { return }
        line.append(0x0A)
        if append(line) {
            logBytes += line.count
            disk.appends += 1
            disk.appendBytes += line.count
        } else {
            // Not added (the disk full, say): the log goes back to its whole
            // lines, and the index is written whole instead. Should that
            // fail too, what is on disk may still point at the blobs: they
            // stay.
            if log >= 0 { ftruncate(log, off_t(logBytes)) }
            guard compact() else { return }
        }
        for blob in unused { try? FileManager.default.removeItem(at: blobURL(blob)) }
        compactIfDue()
    }

    private func append(_ line: Data) -> Bool {
        if log < 0 {
            guard let generation = index.generation else { return false }
            log = Darwin.open(Self.logURL(generation, in: root).path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
            guard log >= 0 else { return false }
        }
        let written = line.withUnsafeBytes { Darwin.write(log, $0.baseAddress, $0.count) }
        return written == line.count
    }

    /// How long the log may grow beside an index.json of `snapshotBytes`.
    static func logLimit(_ snapshotBytes: Int) -> Int { max(logFloor, snapshotBytes) }

    /// When the log has grown past the index it describes (`logLimit`), at
    /// most once a `compactInterval`. A log left longer is no harm: it holds
    /// every change, and the next open folds it in.
    private func compactIfDue() {
        guard logBytes > Self.logLimit(snapshotBytes) else { return }
        if let compactedAt, ContinuousClock.now - compactedAt < Self.compactInterval { return }
        compact()
    }

    /// index.json, written whole, and the log let go of, all of it being in
    /// index.json now. If index.json cannot be written the log stays as it
    /// is: nothing is lost.
    @discardableResult
    func compact() -> Bool {
        guard let written = Self.snapshot(&index, in: root) else { return false }
        if log >= 0 {
            close(log)
            log = -1
        }
        logBytes = 0
        snapshotBytes = written
        compactedAt = .now
        disk.snapshots += 1
        disk.snapshotBytes += written
        return true
    }

    /// index.json written whole, under a generation of its own, and the log
    /// that went on from the one before removed: all of it is in this one.
    /// → what it took; nil, and `index` as it was, if it could not be written.
    static func snapshot(_ index: inout Index, in directory: URL) -> Int? {
        let previous = index.generation
        index.generation = UUID().uuidString
        guard let data = try? JSONEncoder().encode(index),
              (try? data.write(to: directory.appendingPathComponent(indexFile), options: .atomic)) != nil else {
            index.generation = previous
            return nil
        }
        if let previous { try? FileManager.default.removeItem(at: logURL(previous, in: directory)) }
        return data.count
    }

    /// index.json, then each change its log holds, in order; what index.json
    /// took; and, when it has a log, how much of that is whole lines. A line
    /// cut short — a crash as it was written — says nothing, and is passed
    /// over.
    static func load(_ directory: URL) -> (index: Index, bytes: Int, logged: Int?) {
        var index = Index()
        var bytes = 0
        if let data = try? Data(contentsOf: directory.appendingPathComponent(indexFile)),
           let saved = try? JSONDecoder().decode(Index.self, from: data) {
            index = saved
            bytes = data.count
        }
        index.linkAll()
        guard let generation = index.generation,
              let log = try? Data(contentsOf: logURL(generation, in: directory)) else { return (index, bytes, nil) }
        let whole = log.lastIndex(of: 0x0A).map { log.distance(from: log.startIndex, to: $0) + 1 } ?? 0
        guard whole > 0 else { return (index, bytes, whole) }
        // The whole lines read as one array, "[line,line]": a decoder for
        // each line took half as long again. Should that not read — a line
        // spoilt, though a crash leaves one only at the end, past the last
        // whole line — each is read alone, and what does not read is
        // passed over.
        var all = Data([0x5B])
        all.append(log.prefix(whole))
        all.withUnsafeMutableBytes { bytes in
            for at in bytes.indices where bytes[at] == 0x0A { bytes[at] = 0x2C }
            bytes[bytes.count - 1] = 0x5D
        }
        let decoder = JSONDecoder()
        let calls = (try? decoder.decode([[Change]].self, from: all))
            ?? log.prefix(whole).split(separator: 0x0A).compactMap { try? decoder.decode([Change].self, from: Data($0)) }
        for changes in calls {
            for change in changes { index.apply(change) }
        }
        return (index, bytes, whole)
    }
}

extension LocalStore.Index {
    /// A change, made here: as a call makes it, or as the log is read back.
    mutating func apply(_ change: LocalStore.Change) {
        switch change {
        case let .file(path, entry):
            let had = files[path] != nil
            files[path] = entry
            if had, entry == nil { unlink(path) } else if !had, entry != nil { link(path) }
        case let .attributes(path, values):
            let had = attributes[path] != nil
            attributes[path] = values?.isEmpty == false ? values : nil
            let has = attributes[path] != nil
            if had, !has { unlink(path) } else if !had, has { link(path) }
        case let .volumeIcon(digest):
            volumeIcon = digest
        }
    }

    /// `children`, for every path.
    mutating func linkAll() {
        children = [:]
        for path in files.keys { link(path) }
        for path in attributes.keys { link(path) }
    }

    /// `path` is here: it is in its folder, and that folder in its own, up
    /// to one that had something in it already (and so is in its own).
    mutating func link(_ path: String) {
        var path = path
        while let folder = Self.folder(of: path), children[folder]?.insert(path) == nil {
            children[folder] = [path]
            path = folder
        }
    }

    /// `path` is gone from `files` or `attributes`. Unless it is still in
    /// the other, or has something in it, it goes from its folder — and so
    /// does each folder up from it that is left with nothing in it and is
    /// no item itself.
    mutating func unlink(_ path: String) {
        var path = path
        while files[path] == nil, attributes[path] == nil, children[path] == nil, let folder = Self.folder(of: path) {
            children[folder]?.remove(path)
            guard children[folder]?.isEmpty == true else { return }
            children[folder] = nil
            path = folder
        }
    }

    /// `path` and every path under it, each folder before what is in it.
    func walk(_ path: String) -> [String] {
        var found = [path]
        var next = 0
        while next < found.count {
            if let inside = children[found[next]] { found += inside }
            next += 1
        }
        return found
    }

    /// The folder a path is in; nil for the root.
    static func folder(of path: String) -> String? {
        guard path != "/", let slash = path.lastIndex(of: "/") else { return nil }
        return slash == path.startIndex ? "/" : String(path[..<slash])
    }

    static func name(of path: String) -> String {
        path.lastIndex(of: "/").map { String(path[path.index(after: $0)...]) } ?? path
    }
}
