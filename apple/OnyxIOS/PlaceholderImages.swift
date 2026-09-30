import Accelerate
import ImageIO
import OnyxKit
import UIKit

/// The tiny copies of thumbnails (Placeholder) that tiles show until their
/// picture has come, as pictures ready to draw.
///
/// A placeholder is a few hundred bytes in its file's row, so nothing is
/// fetched: each is decoded once, off the main thread — a tenth of a
/// millisecond or so with its softening — and kept by its file and the
/// thumbnail it copies, a new thumbnail having a new one. Decoded ahead where the eye is going
/// (`warm`: a folder's first screen, and the prefetch's window around the
/// scroll), a tile usually finds its placeholder on its first frame; when it
/// does not, it asks (`image(for:)`) beside its thumbnail, never before it,
/// and shows the placeholder only if the thumbnail has not come first.
///
/// Softened here, once — drawn at `scale` times its size and blurred about a
/// pixel of its own wide, as the web blurs it — so a tile draws a plain
/// picture: a live blur would be an offscreen pass per tile on every frame
/// of a scroll, for exactly the tiles still loading. That is some 16 KB a
/// placeholder in memory, and a few megabytes for the whole cache, which
/// the system may take back.
final class PlaceholderImages: @unchecked Sendable {
    static let shared = PlaceholderImages()

    /// How many times its size a placeholder is drawn at, and how wide its
    /// blur is, in those pixels: about a pixel of its own either way.
    static let scale = 3
    static let blur: UInt32 = 9
    /// A picture bigger than this on a side is not a placeholder, and is
    /// not decoded: the server checks a placeholder's first bytes, not the
    /// size its header claims.
    static let maxEdge = 128

    private let memory: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 4 << 20
        return cache
    }()
    private let lock = NSLock()
    /// Decodes under way, by key: whoever else asks waits on the same one.
    private var decoding: [NSString: Task<UIImage?, Never>] = [:]
    /// Placeholders that could not be decoded, which are not tried again.
    private var unreadable: Set<NSString> = []
    /// Moves on sign-out, so nothing decoded before it lands after.
    private var generation = 0

    /// What a file's placeholder is kept by: the file, and the thumbnail it
    /// is a copy of.
    static func key(_ file: FileItem) -> NSString {
        "\(file.id)#\(file.thumbnailKey ?? "v\(file.version)")" as NSString
    }

    /// The placeholder if it is ready now, for a tile's first frame. Never
    /// decodes.
    func cached(_ file: FileItem) -> UIImage? {
        guard file.metadata?.placeholder != nil else { return nil }
        return memory.object(forKey: Self.key(file))
    }

    /// The placeholder, decoded off the main thread — once: asked for again
    /// while it is being decoded, the same decode is waited on. Nil when the
    /// file has none, or it cannot be read.
    func image(for file: FileItem) async -> UIImage? {
        guard let placeholder = file.metadata?.placeholder else { return nil }
        let key = Self.key(file)
        if let ready = memory.object(forKey: key) { return ready }
        return await decode(placeholder, as: key, priority: .userInitiated)?.value
    }

    /// Decode these ahead, nearest first, off the main thread: the files
    /// about to be shown.
    func warm(_ files: some Sequence<FileItem>, priority: TaskPriority = .utility) {
        for file in files {
            guard let placeholder = file.metadata?.placeholder else { continue }
            let key = Self.key(file)
            if memory.object(forKey: key) == nil { _ = decode(placeholder, as: key, priority: priority) }
        }
    }

    /// Signing out: nothing of the account's is kept.
    func removeAll() {
        lock.withLock {
            generation += 1
            decoding = [:]
            unreadable = []
        }
        memory.removeAllObjects()
    }

    private func decode(_ placeholder: Placeholder, as key: NSString, priority: TaskPriority) -> Task<UIImage?, Never>? {
        lock.withLock {
            if unreadable.contains(key) { return nil }
            if let running = decoding[key] { return running }
            let started = generation
            let task = Task.detached(priority: priority) { [weak self] () -> UIImage? in
                let image = Self.softened(placeholder)
                self?.finished(key, image, generation: started)
                return image
            }
            decoding[key] = task
            return task
        }
    }

    private func finished(_ key: NSString, _ image: UIImage?, generation started: Int) {
        lock.withLock {
            guard started == generation else { return }
            decoding[key] = nil
            if let image {
                let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
                memory.setObject(image, forKey: key, cost: cost)
            } else {
                unreadable.insert(key)
            }
        }
    }

    private static let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

    /// A placeholder decoded and softened, into a bitmap that draws as it
    /// is: `scale` times its size, drawn as smoothly as Core Graphics draws,
    /// then a tent blur `blur` pixels wide, its edges kept rather than faded
    /// (the web scales its blurred copy past the tile's edges for the same
    /// reason). Nil for anything that is not a small picture.
    static func softened(_ placeholder: Placeholder) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(placeholder.data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              (1...maxEdge).contains(width), (1...maxEdge).contains(height),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return nil }
        let drawnWidth = image.width * scale, drawnHeight = image.height * scale
        let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        guard let drawn = CGContext(data: nil, width: drawnWidth, height: drawnHeight, bitsPerComponent: 8, bytesPerRow: 0,
                                    space: sRGB, bitmapInfo: info),
              let soft = CGContext(data: nil, width: drawnWidth, height: drawnHeight, bitsPerComponent: 8, bytesPerRow: 0,
                                   space: sRGB, bitmapInfo: info),
              let from = drawn.data, let to = soft.data else { return nil }
        drawn.interpolationQuality = .high
        drawn.draw(image, in: CGRect(x: 0, y: 0, width: drawnWidth, height: drawnHeight))
        var input = vImage_Buffer(data: from, height: vImagePixelCount(drawnHeight), width: vImagePixelCount(drawnWidth),
                                  rowBytes: drawn.bytesPerRow)
        var output = vImage_Buffer(data: to, height: vImagePixelCount(drawnHeight), width: vImagePixelCount(drawnWidth),
                                   rowBytes: soft.bytesPerRow)
        guard vImageTentConvolve_ARGB8888(&input, &output, nil, 0, 0, blur, blur, nil,
                                          vImage_Flags(kvImageEdgeExtend)) == kvImageNoError,
              let picture = soft.makeImage() else { return nil }
        return UIImage(cgImage: picture)
    }
}
