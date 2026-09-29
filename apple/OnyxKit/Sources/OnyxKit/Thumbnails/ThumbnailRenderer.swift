@preconcurrency import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What the pictures are written as: the two formats the presign route
/// takes for a preview.
public enum PreviewFormat: String, Sendable {
    case webp, jpeg

    public var contentType: String { self == .webp ? "image/webp" : "image/jpeg" }

    var typeIdentifier: String { self == .webp ? "org.webmproject.webp" : UTType.jpeg.identifier }

    /// The thumbnail, its siblings, and a video's player poster.
    var quality: Double { self == .webp ? Poster.webpQuality : Poster.jpegQuality }
    /// An image's large preview.
    var previewQuality: Double { self == .webp ? Poster.previewWebpQuality : Poster.previewJpegQuality }
    /// Whether a transparent picture stays transparent.
    var keepsAlpha: Bool { self == .webp }

    /// WebP where this Mac's ImageIO can write it, as the web prefers; else
    /// JPEG, as a browser without a WebP encoder (Safari) sends. Asked of
    /// the system rather than assumed: ImageIO reads WebP but, as of macOS
    /// 27, cannot write it.
    public static let best: PreviewFormat = {
        let writable = (CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? []
        return writable.contains(PreviewFormat.webp.typeIdentifier) ? .webp : .jpeg
    }()
}

/// One picture, encoded, and its size.
public struct EncodedPicture: Sendable, Equatable {
    public let data: Data
    public let size: PixelSize
}

/// What a source is, as the thumbnail PUT records it (lib/media.js
/// mediaFacts): its size as shown, and a video's length in seconds.
public struct MediaFacts: Sendable, Equatable {
    public var width: Int
    public var height: Int
    public var duration: Double?

    public init(width: Int, height: Int, duration: Double? = nil) {
        self.width = width; self.height = height; self.duration = duration
    }

    public var json: [String: Any] {
        var out: [String: Any] = ["width": width, "height": height]
        if let duration { out["duration"] = duration }
        return out
    }
}

/// Every picture of one frame, as lib/thumbnail-client.js's `draw` makes
/// them, and the facts learnt on the way.
public struct PreviewSet: Sendable {
    public let format: PreviewFormat
    public let grid: EncodedPicture
    public let sm: EncodedPicture?
    public let xs: EncodedPicture?
    /// A video's player poster, or an image's preview; nil when the
    /// original serves.
    public let large: EncodedPicture?
    public let media: MediaFacts

    /// The siblings there are, as `thumbSizes` names them, in its order.
    public var sizes: [String] { (sm == nil ? [] : ["sm"]) + (xs == nil ? [] : ["xs"]) }

    public func sibling(_ size: String) -> EncodedPicture? {
        switch size {
        case "sm": return sm
        case "xs": return xs
        default: return nil
        }
    }

    /// Bytes of all of it, for the log.
    public var byteCount: Int { [grid, sm, xs, large].compactMap { $0?.data.count }.reduce(0, +) }
}

/// A frame of a video, or an image, drawn at every size the web makes, the
/// way the browser does (lib/thumbnail-client.js): the size table and the
/// frame choice are Poster's; the decoding is AVFoundation's and ImageIO's.
///
/// Nothing is held beyond the pictures in hand. A video is read where it
/// is — a file here, or a presigned link, from which AVFoundation fetches
/// only the ranges it needs: the index, and the frames tried. The decoder
/// draws the first step of the size chain itself (Poster.downscalePlan's
/// first), so a 4K frame is never held at 4K; each later step is drawn
/// from the one before, at most halving, into an sRGB bitmap.
public enum ThumbnailRenderer {
    public enum Failure: LocalizedError, Equatable {
        /// AVFoundation or ImageIO could not read it.
        case unreadable(String)
        /// No picture in it: no video track, or no size.
        case noPicture
        /// Every frame tried was black, white or flat. As the web, no
        /// thumbnail rather than a blank one, which would be kept for good.
        case blank
        /// It may be transparent, and this Mac can only write JPEG, which
        /// would put it on black. The browser does better, with WebP.
        case mayBeTransparent
        /// More pixels than it is sensible to decode for a thumbnail.
        case tooLarge

        public var errorDescription: String? {
            switch self {
            case let .unreadable(why): return "It could not be read: \(why)"
            case .noPicture: return "It has no picture to draw."
            case .blank: return "Every frame tried was blank."
            case .mayBeTransparent: return "It may be transparent, and this Mac writes JPEG."
            case .tooLarge: return "It is too large to decode for a thumbnail."
            }
        }
    }

    /// An image with more pixels than this is not decoded (16384 x 16384).
    static let maxImagePixels = 268_435_456.0

    // MARK: - Video

    /// The poster frame of a video — the first of Poster.posterTimes, then
    /// of laterPosterTimes, that is not blank — at every size.
    ///
    /// `url` is a file, or a presigned link (`mime` then tells AVFoundation
    /// what it is, where the link's own name may not). Each moment is taken
    /// at the nearest keyframe within half a second, so a try is one frame
    /// read and decoded, not a run of them up to the exact time.
    public static func video(_ url: URL, mime: String? = nil, format: PreviewFormat = .best) async throws -> PreviewSet {
        var options: [String: Any] = [:]
        if !url.isFileURL, let mime, mime.lowercased().hasPrefix("video/") {
            if #available(macOS 14, iOS 17, *) { options[AVURLAssetOverrideMIMETypeKey] = mime }
        }
        let asset = AVURLAsset(url: url, options: options)
        let track: AVAssetTrack
        do {
            guard let first = try await asset.loadTracks(withMediaType: .video).first else { throw Failure.noPicture }
            track = first
        } catch let failure as Failure {
            throw failure
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw unreadable(error, at: url)
        }
        let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
        // As shown: a phone's portrait clip is stored on its side.
        let shown = CGRect(origin: .zero, size: natural).applying(transform)
        guard let source = PixelSize(width: abs(shown.width), height: abs(shown.height)),
              let plan = Poster.plan(for: source, kind: .video) else { throw Failure.noPicture }
        let seconds = (try? await asset.load(.duration))?.seconds
        let duration = seconds.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        // A square box: the long edge of the first step, whichever way up
        // the frame turns out.
        let first = Poster.downscalePlan(from: source, to: plan.large ?? plan.grid).first ?? plan.grid
        generator.maximumSize = CGSize(width: first.longEdge, height: first.longEdge)
        let tolerance = CMTime(seconds: min(0.5, (duration ?? 10) * 0.05), preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = tolerance
        generator.requestedTimeToleranceAfter = tolerance

        var frame: CGImage?
        var drewAny = false
        var lastError: Error?
        for time in Poster.posterTimes(duration) + Poster.laterPosterTimes(duration) {
            try Task.checkCancellation()
            let image: CGImage
            do {
                image = try await withTaskCancellationHandler {
                    try await generator.image(at: CMTime(seconds: time, preferredTimescale: 600)).image
                } onCancel: {
                    generator.cancelAllCGImageGeneration()
                }
            } catch {
                try Task.checkCancellation()
                lastError = error
                continue
            }
            drewAny = true
            if !Poster.isBlank(stats(of: image)) {
                frame = image
                break
            }
        }
        guard let frame else {
            if !drewAny, let lastError { throw unreadable(lastError, at: url) }
            if !drewAny { throw Failure.unreadable("no frame could be decoded") }
            throw Failure.blank
        }
        return try draw(frame, plan: plan, kind: .video, format: format, alpha: false,
                        media: MediaFacts(width: source.width, height: source.height, duration: duration))
    }

    /// What AVFoundation's error comes to. One about the file itself — its
    /// format, its codec — is Failure.unreadable, and it will not do better
    /// tomorrow; so is anything at all about a file on this disk. Reading a
    /// link failing otherwise — the network, a link run out — is passed on
    /// as it came, to be tried again.
    static func unreadable(_ error: Error, at url: URL) -> Error {
        let code = (error as NSError).domain == AVFoundationErrorDomain ? AVError.Code(rawValue: (error as NSError).code) : nil
        let aboutTheFile: Set<AVError.Code> = [.fileFormatNotRecognized, .fileFailedToParse, .decoderNotFound, .decodeFailed,
                                               .invalidSourceMedia, .contentIsProtected, .noImageAtTime,
                                               .operationNotSupportedForAsset]
        if url.isFileURL || code.map(aboutTheFile.contains) == true {
            return Failure.unreadable(error.localizedDescription)
        }
        return error
    }

    // MARK: - Image

    /// An image file at every size, and its large preview when one is
    /// worth making (Poster.imagePreview). Turned upright by its EXIF
    /// orientation, as a browser shows it. `bytes` and `mime` decide the
    /// preview as the web does; `typeHint` helps ImageIO with a camera
    /// RAW, which it would otherwise read as the TIFF it is built on.
    public static func image(_ file: URL, bytes: Int64? = nil, mime: String? = nil, name: String = "",
                             typeHint: String? = nil, format: PreviewFormat = .best) throws -> PreviewSet {
        var sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        if let typeHint { sourceOptions[kCGImageSourceTypeIdentifierHint] = typeHint }
        guard let source = CGImageSourceCreateWithURL(file as CFURL, sourceOptions as CFDictionary),
              CGImageSourceGetCount(source) > 0 else {
            throw Failure.unreadable("it is not a picture this Mac reads")
        }
        let index = CGImageSourceGetPrimaryImageIndex(source)
        let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any] ?? [:]
        let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue
        let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue
        guard let stored = PixelSize(width: width, height: height) else { throw Failure.noPicture }
        guard Double(stored.width) * Double(stored.height) <= maxImagePixels else { throw Failure.tooLarge }
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        let upright = (5...8).contains(orientation) ? PixelSize(width: stored.height, height: stored.width) : stored
        let gif = name.lowercased().hasSuffix(".gif") ? "image/gif" : nil
        let type = (mime?.isEmpty == false ? mime : nil) ?? gif
        guard let plan = Poster.plan(for: upright, kind: .image, bytes: bytes, mime: type) else { throw Failure.noPicture }

        let first = Poster.downscalePlan(from: upright, to: plan.large ?? plan.grid).first ?? plan.grid
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: first.longEdge,
        ]
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) else {
            throw Failure.unreadable("it could not be decoded")
        }
        var alpha = (properties[kCGImagePropertyHasAlpha] as? Bool) ?? false
        // An alpha channel is often all opaque (a screenshot, most GIFs):
        // only a picture with transparency in it needs a format that keeps it.
        if alpha, isOpaque(decoded) { alpha = false }
        if alpha, !format.keepsAlpha { throw Failure.mayBeTransparent }
        return try draw(decoded, plan: plan, kind: .image, format: format, alpha: alpha,
                        media: MediaFacts(width: upright.width, height: upright.height, duration: nil))
    }

    // MARK: - Drawing

    /// From a first step's picture to all of them: the large picture, the
    /// grid poster from it, and each sibling from the one before.
    static func draw(_ frame: CGImage, plan: Poster.Plan, kind: Poster.Kind, format: PreviewFormat, alpha: Bool,
                     media: MediaFacts) throws -> PreviewSet {
        let top = try scale(frame, to: plan.large ?? plan.grid, alpha: alpha)
        let grid = plan.large == nil ? top : try scale(top, to: plan.grid, alpha: alpha)
        let sm = try plan.sm.map { try scale(grid, to: $0, alpha: alpha) }
        let xs = try plan.xs.map { try scale(sm ?? grid, to: $0, alpha: alpha) }
        let large = try plan.large.map { _ in
            try encode(top, as: format, quality: kind == .image ? format.previewQuality : format.quality)
        }
        return PreviewSet(format: format,
                          grid: try encode(grid, as: format, quality: format.quality),
                          sm: try sm.map { try encode($0, as: format, quality: format.quality) },
                          xs: try xs.map { try encode($0, as: format, quality: format.quality) },
                          large: large, media: media)
    }

    /// `image` at exactly `size`, through Poster.downscalePlan's steps.
    static func scale(_ image: CGImage, to size: PixelSize, alpha: Bool) throws -> CGImage {
        let from = PixelSize(width: image.width, height: image.height)
        guard from != size else { return image }
        var current = image
        for step in Poster.downscalePlan(from: from, to: size) {
            current = try redraw(current, at: step, alpha: alpha)
        }
        return current
    }

    static let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

    /// One draw, with the best interpolation Core Graphics has — the
    /// canvas's imageSmoothingQuality 'high' — into sRGB, as a canvas is.
    static func redraw(_ image: CGImage, at size: PixelSize, alpha: Bool) throws -> CGImage {
        let info = alpha ? CGImageAlphaInfo.premultipliedLast : .noneSkipLast
        guard let context = CGContext(data: nil, width: size.width, height: size.height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: sRGB, bitmapInfo: info.rawValue) else {
            throw Failure.unreadable("no room to draw \(size)")
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        guard let out = context.makeImage() else { throw Failure.unreadable("the drawing failed") }
        return out
    }

    static func encode(_ image: CGImage, as format: PreviewFormat, quality: Double) throws -> EncodedPicture {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, format.typeIdentifier as CFString, 1, nil) else {
            throw Failure.unreadable("this Mac cannot write \(format.rawValue)")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Failure.unreadable("encoding failed") }
        return EncodedPicture(data: data as Data, size: PixelSize(width: image.width, height: image.height))
    }

    /// Luma statistics of a frame drawn 48 pixels wide, as the web samples
    /// one (thumbnail-client.js sampleFrame).
    static func stats(of image: CGImage) -> Poster.FrameStats {
        let width = 48
        let height = max(1, Int((48 * Double(image.height) / Double(max(1, image.width))).rounded()))
        guard let pixels = rgba(of: image, width: width, height: height, interpolation: .medium) else {
            // Nothing read is no reason to refuse the frame.
            return Poster.FrameStats(mean: 128, spread: 64)
        }
        return Poster.frameStats(pixels)
    }

    /// Whether a picture has no transparency, from a copy sampled up to 256
    /// pixels on a side: nearest-neighbour, so an opaque pixel reads 255
    /// exactly and nothing is averaged away.
    static func isOpaque(_ image: CGImage) -> Bool {
        let scale = min(1, 256 / Double(max(image.width, image.height)))
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        guard let pixels = rgba(of: image, width: width, height: height, interpolation: .none) else { return false }
        return stride(from: 3, to: pixels.count, by: 4).allSatisfy { pixels[$0] == 255 }
    }

    /// `image` drawn into an RGBA bitmap of that size, its bytes.
    private static func rgba(of image: CGImage, width: Int, height: Int, interpolation: CGInterpolationQuality) -> [UInt8]? {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: sRGB,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.interpolationQuality = interpolation
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? pixels : nil
    }
}
