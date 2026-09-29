import AVFoundation
import ImageIO
import OnyxKit
import UniformTypeIdentifiers

/// A picture for a video that has none: a frame drawn on this phone.
///
/// Footage from an action camera often arrives with no thumbnail — from a
/// Mac, or from a browser that cannot decode 4K HEVC — and its cell showed
/// a symbol until something else made one. Drawn here instead, it takes
/// about a second and a megabyte (measured at a 120 ms round trip: 1.2 s
/// and 1 MB from the streamable copy, 1.5 s and 1.4 MB from the 4K master),
/// and is kept with the thumbnails, so it is drawn once.
///
/// From the video's streamable copy when it has one (lib/proxies.js: H.264
/// with its index first, so a frame is two short reads away), else from the
/// original. For a cell on screen only, two at a time (ThumbnailStore's
/// `frames` queue), never in Low Data Mode, and never uploaded: the frame
/// is this phone's alone, and one made on a Mac, recorded on the server,
/// takes its place as soon as the listing has it.
enum LocalFrames {
    static let scheme = "onyx-frame"
    /// Frames are drawn to this size and decoded down for a row.
    static let maxPixels = 640
    static let timeout: Duration = .seconds(20)

    private static let lock = NSLock()
    nonisolated(unsafe) private static var api: OnyxAPI?
    nonisolated(unsafe) private static var playableExtensions: [String: Bool] = [:]
    /// Videos a frame could not be drawn of, and when: not tried again for
    /// a while, rather than every time their cell comes into view.
    nonisolated(unsafe) private static var failed: [String: Date] = [:]
    static let failureMemory: TimeInterval = 300

    /// The session's API, to find a video's streamable copy with.
    static func use(_ api: OnyxAPI?) {
        guard let api else { return }
        lock.withLock { Self.api = api }
    }

    static func forget() {
        lock.withLock {
            api = nil
            failed = [:]
        }
    }

    private static func failedLately(_ id: String) -> Bool {
        lock.withLock {
            guard let at = failed[id] else { return false }
            if Date().timeIntervalSince(at) < failureMemory { return true }
            failed[id] = nil
            return false
        }
    }

    static func isFrame(_ url: URL) -> Bool { url.scheme == scheme }

    /// Where a frame of `file` would come from, for a file it can be drawn
    /// of: a video in a container this phone plays, with a stored original.
    static func source(for file: FileItem, maxPixels: Int) -> ThumbnailSource? {
        guard file.kind == "video", let original = file.url, playable(file.name), !failedLately(file.id) else { return nil }
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = "frame"
        parts.path = "/" + file.id
        // Escaped whole: the original's own query holds & and =, which a
        // query item would otherwise pass through and split on.
        let strict = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        parts.percentEncodedQueryItems = [
            .init(name: "at", value: String(format: "%.3f", time(in: file.metadata?.duration))),
            .init(name: "original", value: original.addingPercentEncoding(withAllowedCharacters: strict)),
        ]
        guard let url = parts.url else { return nil }
        return ThumbnailSource(url: url, key: "\(file.id)@\(file.version)#frame", maxPixels: maxPixels)
    }

    /// Which moment: the web's first choice for a poster (lib/poster.js
    /// posterTimes), a tenth of the way in, at least a second and no
    /// further than halfway — past a black first frame or a fade.
    static func time(in duration: Double?) -> Double {
        guard let duration, duration.isFinite, duration > 0 else { return 1 }
        return min(max(1, duration * 0.1), duration / 2)
    }

    /// Whether AVFoundation opens files of this name's type.
    static func playable(_ name: String) -> Bool {
        let ext = (name as NSString).pathExtension.lowercased()
        guard !ext.isEmpty else { return false }
        return lock.withLock {
            if let known = playableExtensions[ext] { return known }
            let types = Set(AVURLAsset.audiovisualTypes().map(\.rawValue))
            let playable = UTType(filenameExtension: ext).map { types.contains($0.identifier) } ?? false
            playableExtensions[ext] = playable
            return playable
        }
    }

    /// The frame `url` names, as JPEG bytes.
    static func draw(_ url: URL) async throws -> Data {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              case let id = String(parts.path.dropFirst()), !id.isEmpty,
              let at = parts.queryItems?.first(where: { $0.name == "at" })?.value.flatMap(Double.init),
              let original = parts.queryItems?.first(where: { $0.name == "original" })?.value.flatMap(URL.init(string:))
        else { throw URLError(.badURL) }
        // The streamable copy when there is one; a link fresh from the server
        // either way, the listing's being older.
        var video = original
        if let api = lock.withLock({ api }), let link = try? await api.contentLink(fileId: id) {
            video = link.proxyUrl ?? link.url
        }
        do {
            return try await withThrowingTaskGroup(of: Data.self) { group in
                group.addTask { try await frame(of: video, at: at) }
                group.addTask {
                    try await Task.sleep(for: timeout)
                    throw URLError(.timedOut)
                }
                defer { group.cancelAll() }
                guard let data = try await group.next() else { throw URLError(.cannotDecodeContentData) }
                return data
            }
        } catch {
            if !Task.isCancelled { lock.withLock { failed[id] = Date() } }
            throw error
        }
    }

    private static func frame(of video: URL, at seconds: Double) async throws -> Data {
        let asset = AVURLAsset(url: video, options: [AVURLAssetAllowsConstrainedNetworkAccessKey: false])
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxPixels, height: maxPixels)
        generator.dynamicRangePolicy = .forceSDR
        // The nearest keyframe will do: no frames decoded to reach the exact one.
        let near = CMTime(seconds: 1, preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = near
        generator.requestedTimeToleranceAfter = near
        let (image, _) = try await withTaskCancellationHandler {
            try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
        } onCancel: {
            generator.cancelAllCGImageGeneration()
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw URLError(.cannotDecodeContentData)
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw URLError(.cannotDecodeContentData) }
        return data as Data
    }
}

extension FileItem {
    /// What this file is shown by at a size: its thumbnail, or for a video
    /// with none, a frame drawn here (LocalFrames).
    func picture(_ size: ThumbnailSize) -> ThumbnailSource? {
        thumbnail(size) ?? LocalFrames.source(for: self, maxPixels: size == .row ? 180 : 600)
    }
}
