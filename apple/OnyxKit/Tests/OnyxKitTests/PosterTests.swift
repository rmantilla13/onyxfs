import Testing
import Foundation
@testable import OnyxKit

private func size(_ width: Int, _ height: Int) -> PixelSize { PixelSize(width: width, height: height) }

private func size(_ text: String) -> PixelSize? {
    let parts = text.split(separator: "x").compactMap { Int($0) }
    return parts.count == 2 ? PixelSize(width: parts[0], height: parts[1]) : nil
}

/// Poster is lib/poster.js in Swift: a thumbnail this Mac makes is the one a
/// browser would have, under the same keys, at the same sizes. These are
/// test/poster.test.js's cases, and a table lib/poster.js itself computed.
struct PosterTests {
    // MARK: - The web's own cases

    @Test func aGridPosterCoversTheCardAndNeverEnlarges() {
        #expect(Poster.gridSize(size(1920, 1080)) == size(1024, 576))
        #expect(Poster.gridSize(size(3840, 2160)) == size(1024, 576))
        #expect(Poster.gridSize(size(3024, 4032)) == size(768, 1024))
        #expect(Poster.gridSize(size(1080, 1920)) == size(768, 1365))
        #expect(Poster.gridSize(size(640, 480)) == size(640, 480))
        #expect(Poster.gridSize(size(64, 64)) == size(64, 64))
        let panorama = Poster.gridSize(size(12000, 2000))
        #expect(panorama?.width == Poster.gridMaxEdge)
        #expect(panorama?.height == Int((2000.0 * 2048 / 12000).rounded()))
        #expect(Poster.gridSize(nil) == nil)
        // A row's metadata may hold anything: no usable size, no size.
        func stored(_ width: Double?, _ height: Double?) -> PixelSize? { PixelSize(width: width, height: height) }
        #expect(stored(0, 10) == nil && stored(-5, 5) == nil && stored(.nan, 5) == nil && stored(nil, 5) == nil)
        #expect(stored(1920, 1080) == size(1920, 1080))
    }

    @Test func aPlayerPosterIs1920OnTheLongEdgeAndOnlyWhenWorthIt() {
        #expect(Poster.playerSize(size(3840, 2160)) == size(1920, 1080))
        #expect(Poster.playerSize(size(2160, 3840)) == size(1080, 1920))
        #expect(Poster.playerSize(size(4096, 2160))?.longEdge == Poster.playerMaxEdge)
        #expect(Poster.playerSize(size(1280, 720)) == size(1280, 720))
        #expect(Poster.playerPoster(for: size(3840, 2160)) == size(1920, 1080))
        #expect(Poster.playerPoster(for: size(1280, 720)) == size(1280, 720))
        #expect(Poster.playerPoster(for: size(1080, 1920)) == size(1080, 1920))
        #expect(Poster.playerPoster(for: size(640, 360)) == nil, "its grid poster is the whole frame already")
        #expect(Poster.playerPoster(for: size(800, 450)) == nil)
        #expect(Poster.playerPoster(for: nil) == nil)
    }

    @Test func anOld480pxThumbnailIsUndersizedAndANewOneIsNot() {
        #expect(Poster.isUndersized(size(480, 270), source: size(1920, 1080)))
        #expect(Poster.isUndersized(size(480, 253), source: size(4096, 2160)))
        #expect(Poster.isUndersized(size(360, 480), source: size(3024, 4032)))
        #expect(Poster.isUndersized(size(270, 480), source: size(1080, 1920)))
        for source in [size(1920, 1080), size(3024, 4032), size(12000, 2000)] {
            let made = Poster.gridSize(source)!
            #expect(!Poster.isUndersized(made, source: source))
            #expect(!Poster.isUndersized(size(made.width - 1, made.height - 1), source: source), "nor a pixel off it")
        }
        #expect(!Poster.isUndersized(size(400, 300), source: size(400, 300)))
        #expect(!Poster.isUndersized(size(480, 384), source: size(500, 400)))
        // No source size on record: only a thumbnail within the old cap.
        #expect(Poster.isUndersized(size(480, 270), source: nil))
        #expect(Poster.isUndersized(size(200, 150), source: nil))
        #expect(!Poster.isUndersized(size(1024, 576), source: nil))
        #expect(!Poster.isUndersized(nil, source: size(1920, 1080)))
    }

    @Test func eachStepAtMostHalvesAndLandsOnTheTarget() {
        #expect(Poster.downscalePlan(from: size(4096, 2160), to: size(1024, 540)) == [size(2048, 1080), size(1024, 540)])
        #expect(Poster.downscalePlan(from: size(7680, 4320), to: size(1024, 576))
                == [size(3840, 2160), size(1920, 1080), size(1024, 576)])
        #expect(Poster.downscalePlan(from: size(1920, 1080), to: size(1024, 576)) == [size(1024, 576)])
        #expect(Poster.downscalePlan(from: size(640, 480), to: size(640, 480)) == [size(640, 480)])
        #expect(Poster.downscalePlan(from: nil, to: size(10, 10)) == [])
        // Past the largest intermediate, one larger first step.
        #expect(Poster.downscalePlan(from: size(12000, 9000), to: size(768, 576))
                == [size(3000, 2250), size(1500, 1125), size(768, 576)])
        for (from, to) in [(size(6000, 4000), size(864, 576)), (size(4032, 3024), size(768, 576)),
                           (size(1080, 1920), size(768, 1365)), (size(7680, 4320), size(1920, 1080))] {
            var before = from
            for step in Poster.downscalePlan(from: from, to: to) {
                #expect(Double(before.width) / Double(step.width) <= 2 && Double(before.height) / Double(step.height) <= 2)
                before = step
            }
            #expect(before == to)
        }
    }

    @Test func posterTimesAreATenthThenAQuarterAndHalfway() {
        #expect(Poster.posterTimes(20) == [2, 5, 10])
        #expect(Poster.posterTimes(3600) == [360, 900, 1800])
        #expect(Poster.posterTimes(8).first == 1)
        #expect(Poster.posterTimes(12) == [1.2, 3, 6])
        #expect(Poster.posterTimes(2) == [1])
        #expect(Poster.posterTimes(0.5) == [0.25])
        for unknown in [0, Double.nan, .infinity, -3] { #expect(Poster.posterTimes(unknown) == [0.1]) }
        #expect(Poster.posterTimes(nil) == [0.1])
        for d in [0.4, 1, 1.5, 2, 3, 5, 9.9, 60, 7200] {
            let times = Poster.posterTimes(d) + Poster.laterPosterTimes(d)
            for (i, t) in times.enumerated() {
                #expect(t > 0 && t < d)
                if i > 0 { #expect(t > times[i - 1]) }
            }
            for t in Poster.posterTimes(d) { #expect(t <= d / 2 + 1e-9) }
        }
        #expect(Poster.laterPosterTimes(60) == [42, 54])
        #expect(Poster.laterPosterTimes(3600) == [2520, 3240])
        #expect(Poster.laterPosterTimes(nil) == [] && Poster.laterPosterTimes(0) == [])
    }

    @Test func blackWhiteAndFlatFramesAreBlankAndANightShotIsNot() {
        func pixels(_ values: [UInt8]) -> [UInt8] { values.flatMap { [$0, $0, $0, 255] } }
        #expect(Poster.frameStats(pixels([0, 0, 0, 0])) == .init(mean: 0, spread: 0))
        let half = Poster.frameStats(pixels([0, 255, 0, 255]))
        #expect(abs(half.mean - 127.5) < 0.01 && abs(half.spread - 127.5) < 0.01)
        #expect(Poster.frameStats([]) == .init(mean: 0, spread: 0))
        #expect(Poster.isBlank(Poster.frameStats(pixels(Array(repeating: 3, count: 64)))), "a black leader")
        #expect(Poster.isBlank(Poster.frameStats(pixels(Array(repeating: 252, count: 64)))), "a white flash")
        #expect(Poster.isBlank(Poster.frameStats(pixels(Array(repeating: 120, count: 64)))), "a grey slate")
        let night = (0..<64).map { UInt8($0 % 8 == 0 ? 180 : 15) }
        #expect(!Poster.isBlank(Poster.frameStats(pixels(night))), "city lights")
        #expect(Poster.isBlank(Poster.frameStats([UInt8](repeating: 0, count: 64 * 4))), "transparent")
    }

    @Test func siblingsAndTheImagePreviewAsTheWebMakesThem() {
        #expect(Poster.smSize(size(6000, 4000)) == size(576, 384))
        #expect(Poster.xsSize(size(6000, 4000)) == size(180, 120))
        #expect(Poster.smSize(size(3024, 4032)) == size(512, 683))
        #expect(Poster.smSize(size(300, 200)) == size(300, 200))
        #expect(Poster.siblingSizes(size(6000, 4000)).sm != nil && Poster.siblingSizes(size(6000, 4000)).xs != nil)
        #expect(Poster.siblingSizes(size(600, 400)).sm == nil && Poster.siblingSizes(size(600, 400)).xs != nil)
        #expect(Poster.siblingSizes(size(150, 100)).sm == nil && Poster.siblingSizes(size(150, 100)).xs == nil)
        #expect(Poster.imagePreviewSize(size(6000, 4000)) == size(2400, 1600))
        #expect(Poster.imagePreview(for: size(6000, 4000), bytes: 10_000_000, mime: "image/jpeg") == size(2400, 1600))
        #expect(Poster.imagePreview(for: size(4000, 3000), bytes: 10_000_000, mime: "image/gif") == nil, "a GIF animates")
        #expect(Poster.imagePreview(for: size(1000, 667), bytes: 10_000_000, mime: nil) == nil, "barely bigger than its grid poster")
        #expect(Poster.imagePreview(for: size(2400, 1600), bytes: 1_200_000, mime: nil) == nil, "small already")
        #expect(Poster.imagePreview(for: size(2400, 1600), bytes: 6_000_000, mime: nil) == size(2400, 1600))
        #expect(Poster.imagePreview(for: nil, bytes: nil, mime: nil) == nil)
    }

    // MARK: - Against lib/poster.js

    /// Computed by lib/poster.js (node, from the repository's own module):
    /// source, grid poster, sm, xs, player poster, an image's preview (10 MB,
    /// JPEG), and the plan from the source to the video's largest picture.
    static let table: [(Int, Int, String, String, String, String, String, String)] = [
        (3840, 2160, "1024x576", "683x384", "213x120", "1920x1080", "2400x1350", "1920x1080"),
        (1920, 1080, "1024x576", "683x384", "213x120", "1920x1080", "1920x1080", "1920x1080"),
        (1280, 720, "1024x576", "683x384", "213x120", "1280x720", "-", "1280x720"),
        (640, 360, "640x360", "-", "213x120", "-", "-", "640x360"),
        (2160, 3840, "768x1365", "512x910", "160x284", "1080x1920", "1350x2400", "1080x1920"),
        (1080, 1920, "768x1365", "512x910", "160x284", "1080x1920", "1080x1920", "1080x1920"),
        (4096, 2160, "1092x576", "728x384", "228x120", "1920x1013", "2400x1266", "2048x1080>1920x1013"),
        (2704, 1520, "1025x576", "683x384", "213x120", "1920x1079", "2400x1349", "1920x1079"),
        (5312, 2988, "1024x576", "683x384", "213x120", "1920x1080", "2400x1350", "2656x1494>1920x1080"),
        (7680, 4320, "1024x576", "683x384", "213x120", "1920x1080", "2400x1350", "3840x2160>1920x1080"),
        (4000, 3000, "768x576", "512x384", "160x120", "1920x1440", "2400x1800", "2000x1500>1920x1440"),
        (3024, 4032, "768x1024", "512x683", "160x213", "1440x1920", "1800x2400", "1512x2016>1440x1920"),
        (6000, 4000, "864x576", "576x384", "180x120", "1920x1280", "2400x1600", "3000x2000>1920x1280"),
        (600, 400, "600x400", "-", "180x120", "-", "-", "600x400"),
        (150, 100, "150x100", "-", "-", "-", "-", "150x100"),
        (12000, 2000, "2048x341", "-", "720x120", "-", "2400x400", "3000x500>2048x341"),
        (1000, 667, "864x576", "576x384", "180x120", "-", "-", "864x576"),
        (2400, 1600, "864x576", "576x384", "180x120", "1920x1280", "2400x1600", "1920x1280"),
        (1440, 1080, "768x576", "512x384", "160x120", "1440x1080", "1440x1080", "1440x1080"),
        (960, 720, "768x576", "512x384", "160x120", "960x720", "-", "960x720"),
    ]

    @Test func everySizeMatchesTheWebToThePixel() {
        for (w, h, grid, sm, xs, player, preview, plan) in Self.table {
            let source = size(w, h)
            let siblings = Poster.siblingSizes(source)
            #expect(Poster.gridSize(source) == size(grid), "\(source) grid")
            #expect(siblings.sm == size(sm), "\(source) sm")
            #expect(siblings.xs == size(xs), "\(source) xs")
            #expect(Poster.playerPoster(for: source) == size(player), "\(source) player")
            #expect(Poster.imagePreview(for: source, bytes: 10_000_000, mime: "image/jpeg") == size(preview), "\(source) preview")
            let steps = Poster.downscalePlan(from: source, to: Poster.playerPoster(for: source) ?? Poster.gridSize(source))
            #expect(steps.map(\.description).joined(separator: ">") == plan, "\(source) plan")
        }
    }

    @Test func theTimesMatchTheWebToTheMillisecond() {
        let table: [(Double, [Double], [Double])] = [
            (0.5, [0.25], []), (2, [1], [1.4, 1.8]), (3, [1, 1.5], [2.1, 2.7]), (7.3, [1, 1.825, 3.65], [5.11, 6.57]),
            (12, [1.2, 3, 6], [8.4, 10.8]), (20, [2, 5, 10], [14, 18]), (61.7, [6.17, 15.425, 30.85], [43.19, 55.53]),
            (600, [60, 150, 300], [420, 540]), (3600, [360, 900, 1800], [2520, 3240]),
        ]
        for (d, first, later) in table {
            #expect(Poster.posterTimes(d) == first, "\(d)")
            #expect(Poster.laterPosterTimes(d) == later, "\(d)")
        }
    }

    @Test func aPlanIsTheWebsDrawOfOneFrame() throws {
        let video = try #require(Poster.plan(for: size(3840, 2160), kind: .video))
        #expect(video.large == size(1920, 1080) && video.grid == size(1024, 576))
        #expect(video.sm == size(683, 384) && video.xs == size(213, 120) && video.sizes == ["sm", "xs"])
        let small = try #require(Poster.plan(for: size(640, 360), kind: .video))
        #expect(small.large == nil && small.grid == size(640, 360) && small.sizes == ["xs"])
        let photo = try #require(Poster.plan(for: size(6000, 4000), kind: .image, bytes: 8_000_000, mime: "image/jpeg"))
        #expect(photo.large == size(2400, 1600) && photo.grid == size(864, 576))
        let light = try #require(Poster.plan(for: size(2000, 1500), kind: .image, bytes: 900_000, mime: "image/jpeg"))
        #expect(light.large == nil, "an original this light is its own preview")
        let gif = try #require(Poster.plan(for: size(4000, 3000), kind: .image, bytes: 9_000_000, mime: "image/gif"))
        #expect(gif.large == nil)
    }
}
