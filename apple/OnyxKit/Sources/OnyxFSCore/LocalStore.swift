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
/// values or blobs) and `blobs/<uuid>` for file contents and large values.
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
        var files: [String: Entry] = [:]
        var attributes: [String: [String: Attribute]] = [:]
        /// The SHA-256 of the drive's icon as last placed (placeVolumeIcon):
        /// an icon at the root with other bytes is the person's own.
        var volumeIcon: String?
    }

    private let root: URL
    private let blobs: URL
    private var index = Index()

    public init(directory: URL) throws {
        root = directory
        blobs = directory.appendingPathComponent("blobs", isDirectory: true)
        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: directory.appendingPathComponent("index.json")),
           let saved = try? JSONDecoder().decode(Index.self, from: data) {
            index = saved
        }
    }

    // MARK: - Local-only files

    public func exists(_ path: String) -> Bool { index.files[path] != nil }

    public func isDirectory(_ path: String) -> Bool { index.files[path]?.directory ?? false }

    /// The names directly inside a folder.
    public func names(in directory: String) -> [String] {
        let prefix = directory == "/" ? "/" : directory + "/"
        return index.files.keys.compactMap { path in
            guard path.hasPrefix(prefix) else { return nil }
            let rest = path.dropFirst(prefix.count)
            return rest.isEmpty || rest.contains("/") ? nil : String(rest)
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
        index.files[path] = Entry(blob: blob, directory: false, modified: Date().timeIntervalSince1970)
        save()
    }

    public func createDirectory(_ path: String) throws {
        guard index.files[path] == nil else { throw Failure.posix(EEXIST) }
        index.files[path] = Entry(blob: nil, directory: true, modified: Date().timeIntervalSince1970)
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
        guard index.files[path] != nil else { return }
        index.files[path]?.modified = date.timeIntervalSince1970
        save()
    }

    /// The item and everything under it: its bytes and its attributes.
    public func remove(_ path: String) {
        for key in index.files.keys where key == path || key.hasPrefix(path + "/") {
            if let blob = index.files[key]?.blob { try? FileManager.default.removeItem(at: blobURL(blob)) }
            index.files[key] = nil
        }
        removeAttributes(under: path)
        save()
    }

    /// A rename or move: the item and everything under it, bytes and
    /// attributes, now answer to the new path. What was at the new path is
    /// replaced.
    public func move(_ from: String, to: String) {
        guard from != to else { return }
        if index.files[from] != nil { remove(to) }
        for key in index.files.keys where key == from || key.hasPrefix(from + "/") {
            index.files[to + key.dropFirst(from.count)] = index.files.removeValue(forKey: key)
        }
        for key in index.attributes.keys where key == from || key.hasPrefix(from + "/") {
            index.attributes[to + key.dropFirst(from.count)] = index.attributes.removeValue(forKey: key)
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
        let existing = index.attributes[path]?[name]
        guard let value else {
            guard let existing else { throw Failure.posix(ENOATTR) }
            discard(existing)
            index.attributes[path]?[name] = nil
            if index.attributes[path]?.isEmpty == true { index.attributes[path] = nil }
            save()
            return
        }
        if createOnly, existing != nil { throw Failure.posix(EEXIST) }
        if replaceOnly, existing == nil { throw Failure.posix(ENOATTR) }
        guard value.count <= Self.maximumAttributeSize else { throw Failure.posix(E2BIG) }
        if let existing { discard(existing) }
        var stored = Attribute(inline: nil, blob: nil)
        if value.count <= Self.inlineLimit {
            stored.inline = value
        } else {
            let blob = UUID().uuidString
            do { try value.write(to: blobURL(blob), options: .atomic) } catch { throw Failure.posix(EIO) }
            stored.blob = blob
        }
        index.attributes[path, default: [:]][name] = stored
        save()
    }

    public func attributeNames(of path: String) -> [String] {
        (index.attributes[path]?.keys).map { $0.sorted() } ?? []
    }

    /// An item gone from the drive (deleted on the web, or here) takes its
    /// attributes with it.
    public func removeAttributes(under path: String) {
        for key in index.attributes.keys where key == path || key.hasPrefix(path + "/") {
            for value in (index.attributes[key] ?? [:]).values { discard(value) }
            index.attributes[key] = nil
        }
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
            index.volumeIcon = digest
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

    private func touch(_ path: String) {
        index.files[path]?.modified = Date().timeIntervalSince1970
        save()
    }

    private func discard(_ attribute: Attribute) {
        if let blob = attribute.blob { try? FileManager.default.removeItem(at: blobURL(blob)) }
    }

    /// Small (names and dates, values up to 4 KB), so written whole each
    /// time; atomically, so a crash leaves the last good index.
    private func save() {
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? data.write(to: root.appendingPathComponent("index.json"), options: .atomic)
    }
}
