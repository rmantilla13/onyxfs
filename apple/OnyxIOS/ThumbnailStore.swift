import CryptoKit
import ImageIO
import OnyxKit
import UIKit

/// Where a picture comes from, and what it is kept as.
struct ThumbnailSource: Hashable, Sendable {
    /// Presigned: new on every listing, so never what anything is kept by.
    let url: URL
    /// What the picture is: its key in storage, which a thumbnail never
    /// changes under, and which of its sizes.
    let key: String
    /// The longest side it is decoded to — the size it is shown at, on the
    /// sharpest screen — so memory holds no more pixels than are seen.
    let maxPixels: Int

    fileprivate var memoryKey: NSString { "\(key)@\(maxPixels)" as NSString }

    fileprivate var fileName: String {
        SHA256.hash(data: Data(key.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}

/// The pictures files are shown by — thumbnails and posters — fetched once
/// and kept.
///
/// In memory, decoded at the size they are shown, within a budget the
/// system may take back; on disk, as the bytes storage sent (a few KB of
/// WebP each), so a folder opened again draws at once, offline too.
/// Decoding is ImageIO's thumbnailing, off the main thread: a 2400-pixel
/// poster never passes through memory whole to fill a 44-point row.
final class ThumbnailStore: @unchecked Sendable {
    static let shared = ThumbnailStore()

    private let memory: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 80 << 20
        return cache
    }()
    private let session: URLSession
    private let directory: URL

    /// On disk, trimmed back to `trimTo` once past `limit`, the least
    /// recently shown first.
    static let limit: Int64 = 300 << 20
    static let trimTo: Int64 = 200 << 20

    private init() {
        let configuration = URLSessionConfiguration.default
        // Kept here, by key: a URL cache would key them by the signed link.
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
        directory = Self.folder
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private static var folder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Thumbnails", isDirectory: true)
    }

    /// The picture if it is in memory now: for the first frame of a cell.
    func cached(_ source: ThumbnailSource) -> UIImage? {
        memory.object(forKey: source.memoryKey)
    }

    /// The picture, from memory, from disk or from storage; nil when there
    /// is none to be had (a link expired, offline with nothing kept). Stops
    /// when the asking task is cancelled — a cell scrolled away.
    func image(_ source: ThumbnailSource) async -> UIImage? {
        if let hit = cached(source) { return hit }
        let file = directory.appendingPathComponent(source.fileName)
        var decoded: UIImage?
        if let data = try? Data(contentsOf: file) {
            decoded = Self.decode(data, maxPixels: source.maxPixels)
            // Touched, so trimming keeps what is still being looked at.
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        }
        if decoded == nil {
            guard let (data, response) = try? await session.data(from: source.url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = Self.decode(data, maxPixels: source.maxPixels) else { return nil }
            try? data.write(to: file, options: .atomic)
            decoded = image
        }
        guard let decoded else { return nil }
        let cost = Int(decoded.size.width * decoded.size.height * decoded.scale * decoded.scale * 4)
        memory.setObject(decoded, forKey: source.memoryKey, cost: cost)
        return decoded
    }

    /// `data` decoded no larger than `maxPixels` on its longest side, and
    /// decoded now rather than when first drawn — on the main thread.
    static func decode(_ data: Data, maxPixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    /// Signing out: nothing of the account's is kept.
    func removeAll() async {
        memory.removeAllObjects()
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// What is on disk now, for Settings.
    static func bytesOnDisk() -> Int64 {
        let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
        return files.reduce(0) { $0 + Int64((try? $1.resourceValues(forKeys: Set(keys)).totalFileAllocatedSize) ?? 0) }
    }

    /// Past `limit`, the least recently shown go until `trimTo` is left. At
    /// launch, in the background, where nothing waits on it.
    static func trimInBackground() {
        Task.detached(priority: .background) {
            let keys: [URLResourceKey] = [.contentModificationDateKey, .totalFileAllocatedSizeKey]
            guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)
            else { return }
            var entries = files.compactMap { url -> (URL, Date, Int64)? in
                guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
                return (url, values.contentModificationDate ?? .distantPast, Int64(values.totalFileAllocatedSize ?? 0))
            }
            var total = entries.reduce(0) { $0 + $1.2 }
            guard total > limit else { return }
            entries.sort { $0.1 < $1.1 }
            for (url, _, size) in entries where total > trimTo {
                try? FileManager.default.removeItem(at: url)
                total -= size
            }
        }
    }
}
