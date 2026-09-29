import Foundation

/// A picture's size in pixels.
public struct PixelSize: Hashable, Sendable, Codable, CustomStringConvertible {
    public var width: Int
    public var height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    /// Nil unless both are real and positive, as lib/poster.js's `dims`
    /// takes them: a row's metadata may hold anything, or nothing.
    public init?(width: Double?, height: Double?) {
        guard let width, let height, width.isFinite, height.isFinite, width > 0, height > 0 else { return nil }
        self.init(width: Int(width.rounded()), height: Int(height.rounded()))
        guard self.width > 0, self.height > 0 else { return nil }
    }

    public var longEdge: Int { max(width, height) }
    public var description: String { "\(width)x\(height)" }
}

/// How big each of a file's pictures is drawn, and which frame of a video:
/// lib/poster.js, line for line, so a thumbnail made on this Mac is the one
/// a browser would have made — the same sizes under the same keys, which the
/// web, the phone and the grid's srcset all expect.
///
/// The numbers and the reasons for them are the web's; its comments say
/// why each is what it is. What is written here is only where Swift needs
/// saying differently. Arithmetic is in Double and rounded as JavaScript's
/// Math.round rounds a positive number, so every size agrees to the pixel
/// (PosterTests holds a table of them, computed by lib/poster.js itself).
public enum Poster {
    /// The box a grid poster covers: a 384x288 CSS-pixel card at 2x.
    public static let gridBox = PixelSize(width: 768, height: 576)
    /// A panorama covering that box would be very long; it stops here.
    public static let gridMaxEdge = 2048
    /// A video's player poster, on the long edge.
    public static let playerMaxEdge = 1920
    /// The grid poster's smaller siblings: sm covers a card, xs a list row.
    public static let smBox = PixelSize(width: 512, height: 384)
    public static let xsBox = PixelSize(width: 160, height: 120)
    /// An image's large preview, on the long edge.
    public static let imagePreviewMaxEdge = 2400
    /// An original this small and no bigger than a preview is its own preview.
    public static let previewOriginalMaxBytes: Int64 = 1_572_864
    /// The long edge every thumbnail was capped at before sizes were planned.
    public static let legacyThumbMax = 480
    /// No intermediate drawing bigger than this on a side.
    public static let maxIntermediateEdge = 4096
    /// An image original bigger than this is never decoded for a thumbnail
    /// (lib/media.js THUMB_SOURCE_MAX_BYTES): a 60 MB PNG is several hundred
    /// megabytes of pixels.
    public static let thumbSourceMaxBytes: Int64 = 50 << 20

    /// Encoder qualities: the thumbnail and its siblings, and an image's
    /// large preview, in each of the two formats the server accepts.
    public static let webpQuality = 0.82
    public static let jpegQuality = 0.85
    public static let previewWebpQuality = 0.75
    public static let previewJpegQuality = 0.85

    private static func scaled(_ s: PixelSize, _ scale: Double) -> PixelSize {
        PixelSize(width: max(1, Int((Double(s.width) * scale).rounded())),
                  height: max(1, Int((Double(s.height) * scale).rounded())))
    }

    private static func cover(_ s: PixelSize, _ box: PixelSize) -> Double {
        max(Double(box.width) / Double(s.width), Double(box.height) / Double(s.height))
    }

    /// The grid poster: the smallest size that covers `gridBox`, so a 16:9
    /// clip is 1024x576 and a 3:4 photo 768x1024. Never larger than the
    /// source.
    public static func gridSize(_ source: PixelSize?) -> PixelSize? {
        guard let s = source, s.width > 0, s.height > 0 else { return nil }
        return scaled(s, min(1, cover(s, gridBox), Double(gridMaxEdge) / Double(s.longEdge)))
    }

    private static func coverSize(_ source: PixelSize?, _ box: PixelSize) -> PixelSize? {
        guard let s = source, s.width > 0, s.height > 0 else { return nil }
        return scaled(s, min(1, cover(s, box)))
    }

    public static func smSize(_ source: PixelSize?) -> PixelSize? { coverSize(source, smBox) }
    public static func xsSize(_ source: PixelSize?) -> PixelSize? { coverSize(source, xsBox) }

    /// The siblings worth making, each only when it is materially smaller
    /// (under 0.8x the width) than the one it would be drawn from.
    public static func siblingSizes(_ source: PixelSize?) -> (sm: PixelSize?, xs: PixelSize?) {
        guard let grid = gridSize(source) else { return (nil, nil) }
        var sm: PixelSize?
        var xs: PixelSize?
        if let s = smSize(source), Double(s.width) < Double(grid.width) * 0.8 { sm = s }
        if let x = xsSize(source), Double(x.width) < Double((sm ?? grid).width) * 0.8 { xs = x }
        return (sm, xs)
    }

    /// An image's large preview: `imagePreviewMaxEdge` on the long edge,
    /// never enlarged.
    public static func imagePreviewSize(_ source: PixelSize?) -> PixelSize? {
        guard let s = source, s.width > 0, s.height > 0 else { return nil }
        return scaled(s, min(1, Double(imagePreviewMaxEdge) / Double(s.longEdge)))
    }

    /// The preview worth making for an image, or nil when the original
    /// serves: a GIF (it animates), a picture barely bigger than its grid
    /// poster, or one within the preview size and light already.
    public static func imagePreview(for source: PixelSize?, bytes: Int64?, mime: String?) -> PixelSize? {
        guard let s = source, let grid = gridSize(s) else { return nil }
        if (mime ?? "").range(of: "gif", options: .caseInsensitive) != nil { return nil }
        let long = Double(s.longEdge)
        if long <= Double(grid.longEdge) * 1.25 { return nil }
        if long <= Double(imagePreviewMaxEdge), let bytes, bytes > 0, bytes <= previewOriginalMaxBytes { return nil }
        return imagePreviewSize(s)
    }

    /// A video's player poster: `playerMaxEdge` on the long edge, never
    /// enlarged.
    public static func playerSize(_ source: PixelSize?) -> PixelSize? {
        guard let s = source, s.width > 0, s.height > 0 else { return nil }
        return scaled(s, min(1, Double(playerMaxEdge) / Double(s.longEdge)))
    }

    /// The player poster worth making, or nil when it would be barely bigger
    /// (under 1.25x the width) than the grid poster.
    public static func playerPoster(for source: PixelSize?) -> PixelSize? {
        guard let player = playerSize(source), let grid = gridSize(source) else { return nil }
        return Double(player.width) >= Double(grid.width) * 1.25 ? player : nil
    }

    /// Whether a stored thumbnail of `poster` size is materially smaller —
    /// both edges short by more than 10% — than what `gridSize` makes for
    /// `source`: how one of the old 480px thumbnails is recognised, with no
    /// marker stored anywhere. With no source size on record, only one
    /// within the old cap is suspect.
    public static func isUndersized(_ poster: PixelSize?, source: PixelSize?) -> Bool {
        guard let p = poster, p.width > 0, p.height > 0 else { return false }
        guard let want = gridSize(source) else { return p.longEdge <= legacyThumbMax }
        return Double(p.width) < Double(want.width) * 0.9 && Double(p.height) < Double(want.height) * 0.9
    }

    /// The sizes to draw through on the way from `from` down to `to`, ending
    /// with `to`. Each step at most halves, since one draw that shrinks by
    /// more samples too few pixels and aliases; and no intermediate is over
    /// `maxIntermediateEdge` on a side, so a huge source takes one larger
    /// first step instead.
    public static func downscalePlan(from: PixelSize?, to: PixelSize?) -> [PixelSize] {
        guard let f = from, let t = to, f.width > 0, f.height > 0, t.width > 0, t.height > 0 else { return [] }
        var steps: [PixelSize] = []
        var w = f.width
        var h = f.height
        while Double(w) / 2 > Double(t.width) && Double(h) / 2 > Double(t.height) {
            w = (w + 1) / 2
            h = (h + 1) / 2
            if max(w, h) <= maxIntermediateEdge { steps.append(PixelSize(width: w, height: h)) }
        }
        steps.append(t)
        return steps
    }

    // MARK: - Which frame

    /// To the millisecond, as the web keeps a time.
    private static func ms(_ t: Double) -> Double { (t * 1000).rounded() / 1000 }

    /// The moments of a clip worth trying as its poster, in order: a tenth
    /// of the way in (at least a second, at most halfway), then a quarter
    /// and halfway. Unknown length: just past the start.
    public static func posterTimes(_ duration: Double?) -> [Double] {
        guard let d = duration, d.isFinite, d > 0 else { return [0.1] }
        var times = [ms(min(max(1, d * 0.1), d / 2))]
        for f in [0.25, 0.5] {
            let t = ms(d * f)
            if t > times[times.count - 1] + 0.25 { times.append(t) }
        }
        return times
    }

    /// Where to look when every one of `posterTimes` is blank: well into
    /// the second half.
    public static func laterPosterTimes(_ duration: Double?) -> [Double] {
        guard let d = duration, d.isFinite, d > 0 else { return [] }
        let last = posterTimes(d).last ?? 0
        return [0.7, 0.9].map { ms(d * $0) }.filter { $0 > last + 0.25 }
    }

    /// Mean and standard deviation of luma (Rec. 601, 0–255) over RGBA
    /// pixels: a frame drawn a few dozen pixels wide.
    public struct FrameStats: Equatable, Sendable {
        public var mean: Double
        public var spread: Double
    }

    public static func frameStats(_ rgba: [UInt8]) -> FrameStats {
        let n = rgba.count / 4
        guard n > 0 else { return FrameStats(mean: 0, spread: 0) }
        var sum = 0.0
        var squares = 0.0
        for i in stride(from: 0, to: n * 4, by: 4) {
            let y = 0.299 * Double(rgba[i]) + 0.587 * Double(rgba[i + 1]) + 0.114 * Double(rgba[i + 2])
            sum += y
            squares += y * y
        }
        let mean = sum / Double(n)
        return FrameStats(mean: mean, spread: max(0, squares / Double(n) - mean * mean).squareRoot())
    }

    /// Black, white or flat: a frame nobody would recognise the clip by.
    /// Dark is not blank — a night shot has a low mean and plenty of spread.
    public static func isBlank(_ stats: FrameStats) -> Bool {
        stats.spread < 6 || stats.mean < 12 || stats.mean > 245
    }

    // MARK: - What to draw

    /// Every picture of one frame, as the web's `draw` makes them:
    ///   large   a video's player poster, or an image's preview — none when
    ///           the original serves
    ///   grid    the thumbnail
    ///   sm, xs  its smaller siblings
    /// The large picture is drawn from the source, the grid poster from the
    /// large one (or the source), each sibling from the one before it.
    public struct Plan: Equatable, Sendable {
        public var source: PixelSize
        public var large: PixelSize?
        public var grid: PixelSize
        public var sm: PixelSize?
        public var xs: PixelSize?

        /// Which siblings there are, as `thumbSizes` names them.
        public var sizes: [String] { (sm == nil ? [] : ["sm"]) + (xs == nil ? [] : ["xs"]) }
    }

    public enum Kind: String, Sendable, Codable {
        case video, image
    }

    public static func plan(for source: PixelSize, kind: Kind, bytes: Int64? = nil, mime: String? = nil) -> Plan? {
        guard let grid = gridSize(source) else { return nil }
        let large = kind == .video ? playerPoster(for: source) : imagePreview(for: source, bytes: bytes, mime: mime)
        let siblings = siblingSizes(source)
        return Plan(source: source, large: large, grid: grid, sm: siblings.sm, xs: siblings.xs)
    }
}
