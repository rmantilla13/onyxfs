import Foundation

/// Masters this Mac already has, kept for the proxies it will be asked for.
///
/// The server asks for a proxy of each large video as it is uploaded
/// (lib/proxies.js), and the Mac that uploaded it is usually the one that
/// takes the job, moments later (ProxyService). It used to download the
/// master first: a 40 GB master copied onto a drive in Finder went up, then
/// came straight back down, for bytes still on this disk. Now, as an upload
/// finishes, the bytes the upload queue staged are kept here under a hard
/// link of the store's own (`hold`), so they outlive the queue's copy, and
/// the claim that comes for the file is checked against them (`master(for:)`):
/// the same file, uploaded to the very object the claim reads, at the size
/// it says, still whole on disk. Anything else is downloaded, as before.
///
/// A link costs nothing while the queue still has its copy, and the file's
/// whole size once the queue lets go. So what is held is bounded. A master
/// goes when its job ends (`release`); when a look at the whole queue shows
/// no job for it (`queueSeen`), as when the server makes no proxies; and a
/// day after it was held, whatever happens (`maxAge`). All that is held stays
/// under `maxBytes`, and the disk keeps `spareSpace` free: a master that
/// would go past either is not held, and while the disk has less free the
/// newest held go first (`prune`), since the queue takes the oldest first.
/// Nothing outlives the app: the folder is emptied as the store opens.
public actor ProxySources {
    public struct Held: Sendable, Equatable {
        public let fileId: String
        /// The object the bytes were uploaded to.
        public let key: String
        public let size: Int64
        public let heldAt: Date
        public let url: URL
    }

    public static let maxAge: TimeInterval = 24 * 3600
    public static let maxBytes: Int64 = 100 << 30
    public static let spareSpace: Int64 = 20 << 30

    public nonisolated let folder: URL
    private let maxAge: TimeInterval
    private let maxBytes: Int64
    private let spareSpace: Int64
    private let freeSpace: @Sendable (URL) -> Int64?
    private let now: @Sendable () -> Date
    private var held: [String: Held] = [:]

    /// The store in `folder`, which is emptied: what an earlier run held
    /// was for jobs it never got to.
    public init(folder: URL) {
        self.init(folder: folder, maxAge: Self.maxAge, maxBytes: Self.maxBytes, spareSpace: Self.spareSpace,
                  freeSpace: { PinStore.availableCapacity($0) }, now: { Date() })
    }

    init(folder: URL, maxAge: TimeInterval, maxBytes: Int64, spareSpace: Int64,
         freeSpace: @escaping @Sendable (URL) -> Int64?, now: @escaping @Sendable () -> Date) {
        self.folder = folder
        self.maxAge = maxAge
        self.maxBytes = maxBytes
        self.spareSpace = spareSpace
        self.freeSpace = freeSpace
        self.now = now
        try? FileManager.default.removeItem(at: folder)
    }

    /// What is held now, by file.
    public var all: [String: Held] { held }

    /// Bytes held, counted whole: the disk they will take once the upload
    /// queue lets go of its copies.
    public var bytes: Int64 { held.values.reduce(0) { $0 + $1.size } }

    /// A hard link to the bytes at `file`, made at once in the store's
    /// folder, for `hold` to keep or let go of: whoever has `file` may be
    /// about to delete it. `name` gives the link its extension, which
    /// AVFoundation reads a file's kind by. Nil when no link can be made:
    /// `file` is gone already, or on another disk (a hard link cannot cross
    /// one).
    public nonisolated func link(_ file: URL, name: String) -> URL? {
        let link = folder.appendingPathComponent(UUID().uuidString + ThumbnailWorker.suffix(for: name))
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.linkItem(at: file, to: link)
            return link
        } catch {
            return nil
        }
    }

    /// Keeps `link` — from `link(_:name:)`: the bytes of `fileId`, uploaded
    /// to `key` — for its proxy; whether it is kept. Not kept, and deleted:
    /// there is no room for it (above), or it is not the `size` bytes the
    /// upload was. A newer upload of the same file takes the place of what
    /// was held for it.
    @discardableResult
    public func hold(_ link: URL, fileId: String, key: String, size: Int64) -> Bool {
        release(fileId)
        prune()
        var room = size > 0 && !key.isEmpty && bytes + size <= maxBytes && PinStore.fileSize(at: link) == size
        if room, let free = freeSpace(link), free < spareSpace { room = false }
        guard room else {
            try? FileManager.default.removeItem(at: link)
            return false
        }
        held[fileId] = Held(fileId: fileId, key: key, size: size, heldAt: now(), url: link)
        return true
    }

    /// The master held for the file `claim` is for, if it is that file's
    /// bytes as the claim has them: uploaded to the object the claim reads
    /// (`sourceKey`), at the size it says, and still that size on disk. Nil
    /// otherwise. A held copy the claim shows is not the master — the file
    /// has new contents, or moved to another object — is let go of, since no
    /// claim will match it again.
    public func master(for claim: ProxyClaim) -> URL? {
        prune()
        guard let copy = held[claim.fileId] else { return nil }
        guard let size = claim.size, size == copy.size, let key = claim.sourceKey, key == copy.key,
              PinStore.fileSize(at: copy.url) == copy.size else {
            release(claim.fileId)
            return nil
        }
        return copy.url
    }

    /// The job for `fileId` has ended, however it ended.
    public func release(_ fileId: String) {
        guard let copy = held.removeValue(forKey: fileId) else { return }
        try? FileManager.default.removeItem(at: copy.url)
    }

    /// The whole queue, as it was when asked at `askedAt`: a master held
    /// before then whose file is not in it has no job coming — the server
    /// makes no proxies, or another Mac has taken it — and goes. One held
    /// since may have been asked for after the queue answered, and stays.
    public func queueSeen(_ fileIds: Set<String>, askedAt: Date) {
        for copy in held.values where copy.heldAt < askedAt && !fileIds.contains(copy.fileId) {
            release(copy.fileId)
        }
    }

    /// Lets go of what has been held `maxAge`, and, while the disk has less
    /// than `spareSpace` free, of the newest held.
    public func prune() {
        let expired = now().addingTimeInterval(-maxAge)
        for copy in held.values where copy.heldAt <= expired { release(copy.fileId) }
        while !held.isEmpty, let free = freeSpace(folder), free < spareSpace,
              let newest = held.values.max(by: { $0.heldAt < $1.heldAt }) {
            release(newest.fileId)
        }
    }

    /// Sign-out, or proxies turned off here: nothing held is wanted.
    public func clear() {
        for fileId in held.keys { release(fileId) }
        try? FileManager.default.removeItem(at: folder)
    }

    /// `master` at `destination`, for the transcode to read under a name of
    /// its own: a hard link, which keeps the bytes whatever happens to the
    /// original meanwhile, or — the original on another disk, as an offline
    /// copy may be — a symbolic link. Then checked once more, as the
    /// transcode will find it: `size` bytes, or it is taken away again.
    /// False when that fails, or no link can be made (nothing is put over
    /// what is at `destination` already).
    public nonisolated static func place(_ master: URL, at destination: URL, size: Int64) -> Bool {
        let files = FileManager.default
        guard (try? files.linkItem(at: master, to: destination)) != nil
                || (try? files.createSymbolicLink(at: destination, withDestinationURL: master)) != nil else { return false }
        guard PinStore.fileSize(at: destination) == size else {
            try? files.removeItem(at: destination)
            return false
        }
        return true
    }
}
