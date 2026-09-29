import AVFoundation
import Foundation
import Testing
@testable import OnyxKit

/// A heavy clip made into its proxy: H.264 no larger than the spec, sound
/// kept, rotation kept, index first — what an action camera's 4K HEVC needs
/// to stream on an iPhone.
@Suite struct ProxyTranscoderTests {
    static let spec = ProxySpec(height: 1080, maxrateKbps: 6000, audioKbps: 128)

    @Test func a4KHEVCClipBecomesA1080pH264ProxyThatStreams() async throws {
        let dir = try Self.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("GX010042.mp4")
        try await Clip.make(at: source, width: 3840, height: 2160, fps: 60, seconds: 2, codec: .hevc, audio: true)
        let proxy = dir.appendingPathComponent("proxy.mp4")
        let seen = Seen()
        let out = try await ProxyTranscoder.transcode(source, to: proxy, spec: Self.spec) { seen.add($0) }

        #expect(out.width == 1920 && out.height == 1080)
        #expect(abs(out.duration - 2) < 0.1)
        let sourceBytes = try Self.size(source)
        #expect(out.size > 0 && out.size < sourceBytes)
        let asset = AVURLAsset(url: proxy)
        let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
        let format = try #require(try await video.load(.formatDescriptions).first)
        #expect(CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264)
        #expect(try await video.load(.naturalSize) == CGSize(width: 1920, height: 1080))
        #expect(try await asset.loadTracks(withMediaType: .audio).count == 1, "the sound is kept")
        #expect(try Self.indexComesFirst(proxy), "a player can start before the last byte")
        #expect(seen.values.last == 1 && seen.values.contains { $0 > 0 && $0 < 1 }, "progress moves, then ends at 1")
    }

    @Test func aClipShotUprightStays1080Wide() async throws {
        let dir = try Self.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("upright.mov")
        let quarter = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 2160, ty: 0)
        try await Clip.make(at: source, width: 3840, height: 2160, fps: 30, seconds: 1, codec: .h264,
                            transform: quarter, audio: false)
        let proxy = dir.appendingPathComponent("proxy.mp4")
        let out = try await ProxyTranscoder.transcode(source, to: proxy, spec: Self.spec)
        #expect(out.width == 1080 && out.height == 1920, "upright, as it was shot")
        let video = try #require(try await AVURLAsset(url: proxy).loadTracks(withMediaType: .video).first)
        #expect(try await video.load(.preferredTransform) == quarter)
    }

    @Test func aSmallClipIsNeverMadeLarger() async throws {
        let dir = try Self.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("small.mov")
        try await Clip.make(at: source, width: 640, height: 360, fps: 30, seconds: 1, codec: .h264, audio: false)
        let out = try await ProxyTranscoder.transcode(source, to: dir.appendingPathComponent("proxy.mp4"), spec: Self.spec)
        #expect(out.width == 640 && out.height == 360)
    }

    @Test func stoppedItLeavesNothingBehind() async throws {
        let dir = try Self.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("long.mp4")
        try await Clip.make(at: source, width: 1920, height: 1080, fps: 30, seconds: 6, codec: .h264, audio: false)
        let proxy = dir.appendingPathComponent("proxy.mp4")
        let job = Task { try await ProxyTranscoder.transcode(source, to: proxy, spec: Self.spec) }
        try await Task.sleep(nanoseconds: 50_000_000)
        job.cancel()
        await #expect(throws: CancellationError.self) { try await job.value }
        #expect(!FileManager.default.fileExists(atPath: proxy.path))
    }

    @Test func aMasterKeptOfflineIsReadThroughALinkWithItsExtension() async throws {
        // An offline copy is named for its file and version, with no
        // extension, and may be on another disk: the job reads it through a
        // symbolic link named as a download would be (ProxySources.place).
        let dir = try Self.folder()
        defer { try? FileManager.default.removeItem(at: dir) }
        let made = dir.appendingPathComponent("made.mov")
        try await Clip.make(at: made, width: 1280, height: 720, fps: 30, seconds: 1, codec: .h264, audio: true)
        let kept = dir.appendingPathComponent("Pinned", isDirectory: true).appendingPathComponent("f1-0123456789ab")
        try FileManager.default.createDirectory(at: kept.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: made, to: kept)
        let source = dir.appendingPathComponent("source.mov")
        try FileManager.default.createSymbolicLink(at: source, withDestinationURL: kept)
        let out = try await ProxyTranscoder.transcode(source, to: dir.appendingPathComponent("proxy.mp4"), spec: Self.spec)
        #expect(out.width == 1280 && out.height == 720 && abs(out.duration - 1) < 0.1)
    }

    @Test func sizesAreEvenAndTheShortSideIsTheSpecs() {
        #expect(ProxyTranscoder.outputSize(natural: CGSize(width: 3840, height: 2160), shortSide: 1080) == (1920, 1080))
        #expect(ProxyTranscoder.outputSize(natural: CGSize(width: 2704, height: 1520), shortSide: 1080) == (1922, 1080))
        #expect(ProxyTranscoder.outputSize(natural: CGSize(width: 5312, height: 2988), shortSide: 720) == (1280, 720))
        #expect(ProxyTranscoder.outputSize(natural: CGSize(width: 1280, height: 720), shortSide: 1080) == (1280, 720))
        #expect(ProxyTranscoder.outputSize(natural: CGSize(width: 1081, height: 1081), shortSide: 1080) == (1080, 1080))
    }

    @Test func theBitrateFollowsTheFrameAndStopsAtTheCeiling() {
        #expect(ProxyTranscoder.videoBitrate(width: 1920, height: 1080, fps: 30, ceilingKbps: 6000) == 4_354_560)
        #expect(ProxyTranscoder.videoBitrate(width: 1920, height: 1080, fps: 60, ceilingKbps: 6000) == 6_000_000)
        #expect(ProxyTranscoder.videoBitrate(width: 1280, height: 720, fps: .nan, ceilingKbps: 6000) == 1_935_360)
    }

    // MARK: -

    static func folder() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("proxy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func size(_ url: URL) throws -> Int64 {
        (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
    }

    /// The file's top-level atoms in order: `moov` before `mdat`.
    static func indexComesFirst(_ url: URL) throws -> Bool {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        var at = 0
        var order: [String] = []
        while at + 8 <= data.count {
            let size = data[at..<at + 4].reduce(0) { $0 << 8 | Int($1) }
            order.append(String(decoding: data[at + 4..<at + 8], as: UTF8.self))
            guard size >= 8 else { break }
            at += size
        }
        guard let moov = order.firstIndex(of: "moov"), let mdat = order.firstIndex(of: "mdat") else { return false }
        return moov < mdat
    }

    final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [Double] = []
        var values: [Double] { lock.withLock { list } }
        func add(_ v: Double) { lock.withLock { list.append(v) } }
    }
}

/// A clip made for a test: frames that change, and a tone.
enum Clip {
    static func make(at url: URL, width: Int, height: Int, fps: Int32, seconds: Double, codec: AVVideoCodecType,
                     transform: CGAffineTransform = .identity, audio: Bool) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: url.pathExtension == "mov" ? .mov : .mp4)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: codec, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
        video.transform = transform
        video.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(video)
        var tone: AVAssetWriterInput?
        if audio {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128_000,
            ])
            input.expectsMediaDataInRealTime = false
            writer.add(input)
            tone = input
        }
        guard writer.startWriting() else { throw writer.error ?? CancellationError() }
        writer.startSession(atSourceTime: .zero)

        // Sound written alongside the frames, as a camera writes them: the
        // writer interleaves, and holds one track back while the other is
        // too far behind — all the video first would wait forever.
        let frames = Int(seconds * Double(fps))
        let rate = 48_000, chunk = 1024
        var sound = 0
        func soundUpTo(_ sample: Int) async throws {
            guard let tone else { return }
            while sound < min(sample, Int(seconds * Double(rate))) {
                while !tone.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
                tone.append(try pcm(start: sound, count: chunk, rate: rate))
                sound += chunk
            }
        }
        for frame in 0..<frames {
            try await soundUpTo((frame + 1) * rate / Int(fps))
            while !video.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            guard let pool = adaptor.pixelBufferPool else { throw CancellationError() }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { throw CancellationError() }
            fill(buffer, shade: UInt8(frame * 255 / max(1, frames - 1)))
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps))
        }
        video.markAsFinished()
        try await soundUpTo(Int(seconds * Double(rate)))
        tone?.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? CancellationError() }
    }

    private static func fill(_ buffer: CVPixelBuffer, shade: UInt8) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        let rows = CVPixelBufferGetHeight(buffer), stride = CVPixelBufferGetBytesPerRow(buffer)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        for y in 0..<rows {
            let row = bytes + y * stride
            let value = UInt8((Int(shade) + y / 8) % 256)
            memset(row, Int32(value), stride)
        }
    }

    /// Interleaved 16-bit stereo: a 440 Hz tone.
    private static func pcm(start: Int, count: Int, rate: Int) throws -> CMSampleBuffer {
        var samples = [Int16](repeating: 0, count: count * 2)
        for i in 0..<count {
            let v = Int16(8000 * sin(2 * Double.pi * 440 * Double(start + i) / Double(rate)))
            samples[2 * i] = v
            samples[2 * i + 1] = v
        }
        var asbd = AudioStreamBasicDescription(mSampleRate: Float64(rate), mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                               mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
                                               mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
        var format: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                       magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
        let length = samples.count * 2
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: length, blockAllocator: nil,
                                           customBlockSource: nil, offsetToData: 0, dataLength: length, flags: 0,
                                           blockBufferOut: &block)
        guard let block, let format else { throw CancellationError() }
        samples.withUnsafeBytes { raw in
            _ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: length)
        }
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: format,
                                                             sampleCount: count,
                                                             presentationTimeStamp: CMTime(value: CMTimeValue(start), timescale: CMTimeScale(rate)),
                                                             packetDescriptions: nil, sampleBufferOut: &sample)
        guard let sample else { throw CancellationError() }
        return sample
    }
}
