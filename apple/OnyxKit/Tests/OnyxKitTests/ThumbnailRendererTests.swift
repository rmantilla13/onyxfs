import Testing
import Foundation
@preconcurrency import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import OnyxKit

/// Clips and pictures written for a test, in a folder of its own.
enum Samples {
    static func folder() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("onyxkit-thumbs-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Eight colour bars, shifted by `frame`: a picture anyone would know
    /// the clip by, never blank.
    static func bars(_ context: CGContext, width: Int, height: Int, frame: Int) {
        let colours: [(CGFloat, CGFloat, CGFloat)] = [(1, 1, 1), (1, 1, 0), (0, 1, 1), (0, 1, 0),
                                                      (1, 0, 1), (1, 0, 0), (0, 0, 1), (0.1, 0.1, 0.1)]
        let bar = CGFloat(width) / 8
        for (i, c) in colours.enumerated() {
            context.setFillColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
            let x = (CGFloat(i) * bar + CGFloat(frame * 7)).truncatingRemainder(dividingBy: CGFloat(width))
            context.fill(CGRect(x: x, y: 0, width: bar, height: CGFloat(height)))
        }
    }

    /// A clip `seconds` long, black for the first `blackFor` seconds and
    /// bars after, in `codec` (nil when this Mac cannot write it).
    static func video(in folder: URL, name: String = "clip.mov", width: Int, height: Int, codec: AVVideoCodecType = .h264,
                      fps: Int32 = 24, seconds: Double, blackFor: Double = 0,
                      transform: CGAffineTransform = .identity) async throws -> URL? {
        let url = folder.appendingPathComponent(name)
        let writer = try AVAssetWriter(outputURL: url, fileType: name.lowercased().hasSuffix(".mp4") ? .mp4 : .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: codec, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
        input.transform = transform
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        guard writer.canAdd(input) else { return nil }
        writer.add(input)
        guard writer.startWriting() else { return nil }
        writer.startSession(atSourceTime: .zero)
        let frames = Int((seconds * Double(fps)).rounded())
        for frame in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
            guard let pool = adaptor.pixelBufferPool else { return nil }
            var made: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made)
            guard let buffer = made else { return nil }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
                                       bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                       space: CGColorSpaceCreateDeviceRGB(),
                                       bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                if Double(frame) / Double(fps) < blackFor {
                    context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
                    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
                } else {
                    bars(context, width: width, height: height, frame: frame)
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps))
        }
        input.markAsFinished()
        await writer.finishWriting()
        return writer.status == .completed ? url : nil
    }

    /// A picture of bars, `width` x `height` as stored, with an EXIF
    /// orientation, and a transparent corner when `transparent`.
    static func image(in folder: URL, name: String, type: UTType, width: Int, height: Int, orientation: Int? = nil,
                      alpha: Bool = false, transparent: Bool = false) throws -> URL {
        let info = alpha ? CGImageAlphaInfo.premultipliedLast : .noneSkipLast
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info.rawValue)!
        bars(context, width: width, height: height, frame: 0)
        if transparent { context.clear(CGRect(x: 0, y: 0, width: width / 3, height: height / 3)) }
        let url = folder.appendingPathComponent(name)
        let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
        var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.9]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        CGImageDestinationAddImage(destination, context.makeImage()!, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return url
    }

    /// A picture's size and mean luma, decoded as a browser would.
    static func look(_ picture: EncodedPicture?) -> (size: PixelSize, mean: Double)? {
        guard let picture, let source = CGImageSourceCreateWithData(picture.data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let stats = ThumbnailRenderer.stats(of: image)
        return (PixelSize(width: image.width, height: image.height), stats.mean)
    }

    /// ffmpeg, when there is one: on PATH, or named by ONYX_FFMPEG.
    static let ffmpeg: String? = {
        let named = ProcessInfo.processInfo.environment["ONYX_FFMPEG"]
        let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { "\($0)/ffmpeg" }
        return ([named].compactMap { $0 } + path).first { FileManager.default.isExecutableFile(atPath: $0) }
    }()

    static func run(_ tool: String, _ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
}

/// The drawing, end to end, on clips and pictures written for it: every
/// size the web makes, decodable, upright, and from a frame someone would
/// recognise. One at a time: writing 4K video is work, and the suites
/// beside these time their long-polls.
@Suite(.serialized)
struct ThumbnailRendererTests {
    @Test func aFormatIsOneTheServerTakes() {
        #expect([PreviewFormat.webp, .jpeg].contains(PreviewFormat.best))
        let writable = (CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? []
        #expect((PreviewFormat.best == .webp) == writable.contains("org.webmproject.webp"), "WebP only where ImageIO writes it")
    }

    @Test func a4KHEVCClipGetsEverySizeTheWebMakes() async throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        guard let clip = try await Samples.video(in: folder, name: "GX010042.MP4", width: 3840, height: 2160,
                                                 codec: .hevc, fps: 12, seconds: 2) else {
            // No HEVC encoder here (an old Intel Mac): the H.264 test stands.
            return
        }
        let set = try await ThumbnailRenderer.video(clip, format: .jpeg)
        #expect(set.format == .jpeg)
        #expect(set.media == MediaFacts(width: 3840, height: 2160, duration: set.media.duration))
        #expect(abs((set.media.duration ?? 0) - 2) < 0.1)
        #expect(Samples.look(set.large)?.size == PixelSize(width: 1920, height: 1080))
        #expect(Samples.look(set.grid)?.size == PixelSize(width: 1024, height: 576))
        #expect(Samples.look(set.sm)?.size == PixelSize(width: 683, height: 384))
        #expect(Samples.look(set.xs)?.size == PixelSize(width: 213, height: 120))
        #expect(set.sizes == ["sm", "xs"])
        #expect((Samples.look(set.grid)?.mean ?? 0) > 20, "bars, not black")
        // Small enough to be what a grid shows: tens of kilobytes.
        #expect(set.grid.data.count < 200_000 && set.xs!.data.count < 30_000)
    }

    @Test func aBlackOpeningIsPassedOverForALaterFrame() async throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        // 4 s: posterTimes are 1 s and 2 s; black until 1.5 s.
        let clip = try #require(try await Samples.video(in: folder, width: 1280, height: 720, fps: 12, seconds: 4,
                                                        blackFor: 1.5))
        let set = try await ThumbnailRenderer.video(clip, format: .jpeg)
        #expect((Samples.look(set.grid)?.mean ?? 0) > 20)
        #expect(set.large != nil && Samples.look(set.large)?.size == PixelSize(width: 1280, height: 720))
        #expect(Samples.look(set.grid)?.size == PixelSize(width: 1024, height: 576))
        // And its placeholder, from the xs (213x120), of the same frame.
        let placeholder = try #require(set.placeholder)
        let tiny = Samples.look(EncodedPicture(data: placeholder.data, size: PixelSize(width: 24, height: 14)))
        #expect(tiny?.size == PixelSize(width: 24, height: 14))
        #expect((tiny?.mean ?? 0) > 20, "bars, not the black opening")
    }

    @Test func aClipThatIsBlackThroughoutHasNoPoster() async throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let clip = try #require(try await Samples.video(in: folder, width: 640, height: 360, fps: 12, seconds: 3, blackFor: 99))
        await #expect(throws: ThumbnailRenderer.Failure.blank) {
            _ = try await ThumbnailRenderer.video(clip, format: .jpeg)
        }
    }

    @Test func aPortraitClipIsDrawnUpright() async throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        // As a phone stores one: landscape pixels, turned a quarter.
        let turned = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 720, ty: 0)
        let clip = try #require(try await Samples.video(in: folder, width: 1280, height: 720, fps: 12, seconds: 2,
                                                        transform: turned))
        let set = try await ThumbnailRenderer.video(clip, format: .jpeg)
        #expect(set.media.width == 720 && set.media.height == 1280)
        #expect(Samples.look(set.grid)?.size == PixelSize(width: 720, height: 1280), "never enlarged, and upright")
        #expect(set.large == nil, "no player poster barely bigger than the grid's")
        #expect(Samples.look(set.sm)?.size == PixelSize(width: 512, height: 910))
        #expect(Samples.look(set.xs)?.size == PixelSize(width: 160, height: 284))
    }

    @Test func somethingThatIsNotAVideoSaysSo() async throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let junk = folder.appendingPathComponent("junk.mov")
        try Data((0..<4096).map { UInt8($0 % 251) }).write(to: junk)
        await #expect(throws: ThumbnailRenderer.Failure.self) {
            _ = try await ThumbnailRenderer.video(junk, format: .jpeg)
        }
    }

    @Test func aLinkThatCannotBeReadIsNotTakenForABadFile() async throws {
        // Nothing listens there: the network's failure, to try again later —
        // not the file's, which would be left alone for a week.
        let nowhere = URL(string: "http://127.0.0.1:9/GX010042.MP4?X-Amz-Signature=x")!
        do {
            _ = try await ThumbnailRenderer.video(nowhere, mime: "video/mp4", format: .jpeg)
            Issue.record("nothing was there to read")
        } catch {
            #expect(!(error is ThumbnailRenderer.Failure), "\(error)")
        }
    }

    @Test func aPhotoIsTurnedUprightAndGetsItsPreview() throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        // Stored 3000x2000, shown turned a quarter: 2000x3000.
        let photo = try Samples.image(in: folder, name: "IMG_0001.jpg", type: .jpeg, width: 3000, height: 2000, orientation: 6)
        let set = try ThumbnailRenderer.image(photo, bytes: 10_000_000, mime: "image/jpeg", name: "IMG_0001.jpg", format: .jpeg)
        #expect(set.media == MediaFacts(width: 2000, height: 3000, duration: nil))
        #expect(Samples.look(set.large)?.size == PixelSize(width: 1600, height: 2400))
        #expect(Samples.look(set.grid)?.size == PixelSize(width: 768, height: 1152))
        #expect(Samples.look(set.sm)?.size == PixelSize(width: 512, height: 768))
        #expect(Samples.look(set.xs)?.size == PixelSize(width: 160, height: 240))
        // Within the preview's size and light already: the original is its
        // own preview.
        let small = try Samples.image(in: folder, name: "small.jpg", type: .jpeg, width: 2000, height: 1500)
        let light = try ThumbnailRenderer.image(small, bytes: 900_000, mime: "image/jpeg", name: "small.jpg", format: .jpeg)
        #expect(light.large == nil)
        #expect(Samples.look(light.grid)?.size == PixelSize(width: 768, height: 576))
    }

    @Test func aHEICIsDrawnAsABrowserWouldIfItCould() throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let writable = (CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? []
        guard writable.contains(UTType.heic.identifier) else { return }
        let photo = try Samples.image(in: folder, name: "IMG_0002.HEIC", type: .heic, width: 4032, height: 3024)
        let set = try ThumbnailRenderer.image(photo, bytes: 3_000_000, mime: "image/heic", name: "IMG_0002.HEIC", format: .jpeg)
        #expect(Samples.look(set.grid)?.size == PixelSize(width: 768, height: 576))
        #expect(Samples.look(set.large)?.size == PixelSize(width: 2400, height: 1800))
    }

    @Test func aTransparentPictureIsLeftForABrowserThatWritesWebP() throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let clear = try Samples.image(in: folder, name: "logo.png", type: .png, width: 1200, height: 800, alpha: true, transparent: true)
        #expect(throws: ThumbnailRenderer.Failure.mayBeTransparent) {
            _ = try ThumbnailRenderer.image(clear, bytes: 400_000, mime: "image/png", name: "logo.png", format: .jpeg)
        }
        // An alpha channel with nothing see-through in it is drawn as usual.
        let opaque = try Samples.image(in: folder, name: "shot.png", type: .png, width: 1200, height: 800, alpha: true)
        let set = try ThumbnailRenderer.image(opaque, bytes: 400_000, mime: "image/png", name: "shot.png", format: .jpeg)
        #expect(Samples.look(set.grid)?.size == PixelSize(width: 864, height: 576))
    }

    @Test(.enabled(if: Samples.ffmpeg != nil, "no ffmpeg on PATH (or ONYX_FFMPEG)"))
    func anFFmpegTestSourceClipIsDrawnToo() async throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let tool = try #require(Samples.ffmpeg)
        // HEVC where this ffmpeg has an encoder for it, else H.264.
        let hevc = folder.appendingPathComponent("testsrc-hevc.mp4")
        let status = try Samples.run(tool, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=60:duration=3",
                                            "-c:v", "hevc_videotoolbox", "-b:v", "40M", "-tag:v", "hvc1", hevc.path])
        let clip: URL
        if status == 0 {
            clip = hevc
        } else {
            clip = folder.appendingPathComponent("testsrc-h264.mp4")
            #expect(try Samples.run(tool, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=3",
                                           "-c:v", "libx264", "-pix_fmt", "yuv420p", clip.path]) == 0)
        }
        let set = try await ThumbnailRenderer.video(clip, mime: "video/mp4", format: .jpeg)
        #expect(Samples.look(set.grid)?.size == PixelSize(width: 1024, height: 576))
        #expect(Samples.look(set.large)?.size == PixelSize(width: 1920, height: 1080))
        #expect(abs((set.media.duration ?? 0) - 3) < 0.1)
    }
}
