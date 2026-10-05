import CryptoKit
import ImageIO
import OnyxKit
import UIKit

/// Where a picture comes from, and what it is kept as.
struct ThumbnailSource: Hashable, Sendable {
    /// Presigned: new on every listing, so never what anything is kept by.
    /// A frame of a video with no picture of its own is drawn here instead
    /// (`LocalFrames`), and its URL says so.
    let url: URL
    /// What the picture is: its key in storage, which a thumbnail never
    /// changes under, and which of its sizes.
    let key: String
    /// The longest side it is decoded to — the size it is shown at, on the
    /// sharpest screen — so memory holds no more pixels than are seen.
    let maxPixels: Int

    fileprivate var memoryKey: NSString { "\(key)@\(maxPixels)" as NSString }
}

/// The pictures files are shown by — thumbnails and posters — fetched once
/// and kept.
///
/// In memory, decoded at the size they are shown, within a budget the
/// system may take back; on disk, as the bytes storage sent (a few KB of
/// WebP each), so a folder opened again draws at once, offline too.
/// Decoding is ImageIO's thumbnailing, off the main thread: a 2400-pixel
/// poster never passes through memory whole to fill a 44-point row.
///
/// Fetching is a `PictureQueue`'s: the cells on screen first, then the
/// folder's next screens (`prefetch`), each picture once. Storage answers
/// HTTP/1.1, a request a connection, so the session opens as many as the
/// queue runs — a phone's grid shows fifteen pictures at once, an iPad's
/// more — where URLSession's own limit of four to six a host took three
/// round trips to fill a phone's first screen.
final class ThumbnailStore: @unchecked Sendable {
    static let shared = ThumbnailStore()

    /// Downloads at a time, and how many of them may be ahead of the scroll:
    /// the rest are always free for a cell that has just appeared.
    static let connections = 16
    static let aheadConnections = 10

    private let memory = PictureMemory()
    private let disk: ThumbnailDisk
    private let network: PictureQueue
    private let frames: PictureQueue
    /// Pictures planned near the eye: decoded into memory as they arrive.
    private let warm: WarmSet
    private let planning = PlanSlot()

    /// On disk, trimmed back to 200 MB once past 300 MB, the least recently
    /// shown first.
    static let kept = CacheFolder("Thumbnails", cap: CacheTrim(limit: 300 << 20, trimTo: 200 << 20))

    private init() {
        let configuration = URLSessionConfiguration.default
        // Kept here, by key: a URL cache would key them by the signed link.
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.httpMaximumConnectionsPerHost = Self.connections
        let session = URLSession(configuration: configuration)
        let disk = ThumbnailDisk(kept: Self.kept)
        let warm = WarmSet()
        let memory = self.memory
        self.disk = disk
        self.warm = warm

        // Every download lands on disk; one the plan wants near the eye, and
        // no cell is waiting for (a cell decodes its own), is decoded too.
        let store: PictureQueue.Store = { key, data, wanted in
            disk.write(key, data)
            guard !wanted, let pixels = warm.pixels(for: key) else { return }
            Task.detached(priority: .utility) {
                guard let image = Self.decode(data, maxPixels: pixels) else { return }
                memory.remember(image, as: "\(key)@\(pixels)" as NSString)
            }
        }
        var trace: PictureQueue.Trace?
        if ThumbnailTrace.enabled {
            trace = { (name: String, fields: String) in ThumbnailTrace.event(name, fields) }
        }
        network = PictureQueue(limit: Self.connections, aheadLimit: Self.aheadConnections, fetch: { url, priority in
            var request = URLRequest(url: url)
            // Ahead of the scroll only when data is not being saved (Low Data Mode).
            request.allowsConstrainedNetworkAccess = priority == .visible
            let (data, response) = try await session.data(for: request, delegate: ThumbnailTrace.metrics(for: url))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            return data
        }, store: store, trace: trace)
        // Drawing a frame reads a megabyte or so of the video: two at a
        // time, for cells on screen only.
        frames = PictureQueue(limit: 2, aheadLimit: 0, fetch: { url, _ in
            try await LocalFrames.draw(url)
        }, store: store, trace: trace)
    }

    /// The picture if it is in memory now: for the first frame of a cell.
    func cached(_ source: ThumbnailSource) -> UIImage? {
        memory.image(source.memoryKey)
    }

    /// The picture, from memory, from disk or from storage; nil when there
    /// is none to be had (a link expired, offline with nothing kept). Stops
    /// waiting when the asking task is cancelled — a cell scrolled away —
    /// though a download already under way is finished and kept.
    /// `api` finds a video's streamable copy, to draw a frame of.
    func image(_ source: ThumbnailSource, api: OnyxAPI? = nil) async -> UIImage? {
        if let hit = cached(source) { return hit }
        let started = ThumbnailTrace.now
        if let data = disk.read(source.key), let image = Self.decode(data, maxPixels: source.maxPixels) {
            memory.remember(image, as: source.memoryKey)
            ThumbnailTrace.event("hit-disk", "key=\(source.key) ms=\(ThumbnailTrace.ms(since: started))")
            return image
        }
        guard !Task.isCancelled else { return nil }
        ThumbnailTrace.event("request", "key=\(source.key) why=visible")
        let queue: PictureQueue
        if LocalFrames.isFrame(source.url) {
            LocalFrames.use(api)
            queue = frames
        } else {
            queue = network
        }
        do {
            let data = try await queue.data(key: source.key, url: source.url, priority: .visible)
            guard let image = Self.decode(data, maxPixels: source.maxPixels) else { return nil }
            memory.remember(image, as: source.memoryKey)
            ThumbnailTrace.event("shown", "key=\(source.key) ms=\(ThumbnailTrace.ms(since: started))")
            return image
        } catch {
            ThumbnailTrace.event(error is CancellationError ? "cancel" : "failed",
                                 "key=\(source.key) ms=\(ThumbnailTrace.ms(since: started))")
            return nil
        }
    }

    /// Have these ready ahead of the scroll, nearest the eye first: `fetch`
    /// on disk, and `warm` decoded in memory too, so a cell scrolled to
    /// finds its picture on its first frame. Each call replaces the last.
    func prefetch(fetch: [ThumbnailSource], warm near: [ThumbnailSource]) {
        let memory = self.memory, disk = self.disk, network = self.network, warm = self.warm
        planning.replace(Task.detached(priority: .utility) {
            warm.replace(near.map { ($0.key, $0.maxPixels) })
            var wanted: [(key: String, url: URL)] = []
            for source in fetch where memory.image(source.memoryKey) == nil && !disk.contains(source.key) {
                wanted.append((source.key, source.url))
            }
            if Task.isCancelled { return }
            ThumbnailTrace.event("plan", "fetch=\(wanted.count) of=\(fetch.count) warm=\(near.count)")
            await network.prefetch(wanted)
            // What is kept already, decoded now, off the main thread.
            for source in near where memory.image(source.memoryKey) == nil {
                if Task.isCancelled { return }
                guard let data = disk.read(source.key, touch: false),
                      let image = Self.decode(data, maxPixels: source.maxPixels) else { continue }
                memory.remember(image, as: source.memoryKey)
            }
        })
    }

    /// `data` decoded no larger than `maxPixels` on its longest side, and
    /// decoded now rather than when first drawn — on the main thread.
    static func decode(_ data: Data, maxPixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        return decode(source, maxPixels: maxPixels)
    }

    /// The same for a file, read as ImageIO needs it rather than whole first:
    /// an original of tens of megabytes, for a preview.
    static func decode(contentsOf url: URL, maxPixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        return decode(source, maxPixels: maxPixels)
    }

    private static func decode(_ source: CGImageSource, maxPixels: Int) -> UIImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    /// Signing out: nothing of the account's is kept, and nothing on its
    /// way lands after — its placeholders' pictures included.
    func removeAll() async {
        planning.replace(nil)
        await network.cancelAll()
        await frames.cancelAll()
        warm.replace([])
        memory.removeAll()
        disk.removeAll()
        LocalFrames.forget()
        PlaceholderImages.shared.removeAll()
    }

    /// What is on disk now, for Settings.
    static func bytesOnDisk() -> Int64 {
        let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: kept.url, includingPropertiesForKeys: keys)) ?? []
        return files.reduce(0) { $0 + Int64((try? $1.resourceValues(forKeys: Set(keys)).totalFileAllocatedSize) ?? 0) }
    }
}

/// The pictures on disk: the bytes as they came, a file a key, in a folder
/// held under its cap.
final class ThumbnailDisk: @unchecked Sendable {
    let directory: URL
    private let kept: CacheFolder

    init(kept: CacheFolder) {
        self.kept = kept
        directory = kept.url
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func file(_ key: String) -> URL {
        directory.appendingPathComponent(SHA256.hash(data: Data(key.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined())
    }

    func contains(_ key: String) -> Bool {
        FileManager.default.fileExists(atPath: file(key).path)
    }

    /// Its bytes; `touch` marks it seen, so trimming keeps what is still
    /// being looked at.
    func read(_ key: String, touch: Bool = true) -> Data? {
        let url = file(key)
        guard let data = try? Data(contentsOf: url) else { return nil }
        if touch { try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path) }
        return data
    }

    func write(_ key: String, _ data: Data) {
        guard (try? data.write(to: file(key), options: .atomic)) != nil else { return }
        kept.wrote(Int64(data.count))
    }

    func removeAll() {
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        kept.emptied()
    }
}

/// The pictures decoded, at the size they are shown, within a budget the
/// system may take back. NSCache is safe to use from any thread.
private final class PictureMemory: @unchecked Sendable {
    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 80 << 20
        return cache
    }()

    func image(_ key: NSString) -> UIImage? {
        cache.object(forKey: key)
    }

    func remember(_ image: UIImage, as key: NSString) {
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        cache.setObject(image, forKey: key, cost: cost)
    }

    func removeAll() {
        cache.removeAllObjects()
    }
}

/// The keys the latest plan wants decoded, and at what size.
private final class WarmSet: @unchecked Sendable {
    private let lock = NSLock()
    private var pixels: [String: Int] = [:]

    func replace(_ entries: [(String, Int)]) {
        lock.withLock { pixels = Dictionary(entries, uniquingKeysWith: max) }
    }

    func pixels(for key: String) -> Int? {
        lock.withLock { pixels[key] }
    }
}

/// The plan being worked out: a newer one cancels it.
private final class PlanSlot: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    func replace(_ next: Task<Void, Never>?) {
        let previous = lock.withLock { () -> Task<Void, Never>? in
            defer { task = next }
            return task
        }
        previous?.cancel()
    }
}
