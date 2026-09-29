import AVFoundation
import Foundation

/// A heavy video made into its proxy: H.264 in an MP4 with its index first,
/// no larger than the server's spec, which any browser and any iPhone plays
/// and seeks as it arrives (lib/proxies.js says why a 4K master does not).
///
/// AVFoundation's own reader and writer: the decode and the encode are the
/// Mac's media engine, so an action camera's 4K HEVC runs several times
/// faster than real time without the CPU. Frames are taken in the pixel
/// format H.264 plays everywhere (8-bit 4:2:0 — a 10-bit or 4:2:2 master
/// would otherwise make a file that encodes and then will not play), and
/// scaled on the way in to the writer.
public enum ProxyTranscoder {
    public struct Output: Sendable, Equatable {
        /// As a player shows it: after the clip's rotation.
        public let width: Int
        public let height: Int
        public let duration: Double
        public let size: Int64
    }

    public enum Failure: LocalizedError {
        case noVideo
        case unreadable(String)
        case writing(String)

        public var errorDescription: String? {
            switch self {
            case .noVideo: return "This file has no video to make a streamable version of."
            case let .unreadable(why): return "The video could not be read: \(why)"
            case let .writing(why): return "The streamable version could not be written: \(why)"
            }
        }
    }

    /// `source`, a local file, as a proxy at `destination`. `progress` goes
    /// 0…1 by how much of the clip has been encoded.
    public static func transcode(_ source: URL, to destination: URL, spec: ProxySpec,
                                 progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> Output {
        let asset = AVURLAsset(url: source)
        guard let video = try await asset.loadTracks(withMediaType: .video).first else { throw Failure.noVideo }
        let audio = try await asset.loadTracks(withMediaType: .audio).first
        let (natural, transform, fps) = try await video.load(.naturalSize, .preferredTransform, .nominalFrameRate)
        let duration = try await asset.load(.duration).seconds
        let size = outputSize(natural: natural, shortSide: spec.height)
        let bitrate = videoBitrate(width: size.width, height: size.height, fps: Double(fps), ceilingKbps: spec.maxrateKbps)

        try? FileManager.default.removeItem(at: destination)
        let reader: AVAssetReader
        let writer: AVAssetWriter
        do {
            reader = try AVAssetReader(asset: asset)
            writer = try AVAssetWriter(outputURL: destination, fileType: .mp4)
        } catch {
            throw Failure.unreadable(error.localizedDescription)
        }
        // The index at the front, so a player starts before the last byte.
        writer.shouldOptimizeForNetworkUse = true

        let videoOut = AVAssetReaderTrackOutput(track: video, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        videoOut.alwaysCopiesSampleData = false
        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: size.width,
            AVVideoHeightKey: size.height,
            AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                // A key frame every two seconds: a seek lands near where it
                // was asked for, rather than decoding up to ten seconds in.
                AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                AVVideoExpectedSourceFrameRateKey: max(1, Int(fps.rounded())),
            ] as [String: Any],
        ])
        videoIn.transform = transform
        videoIn.expectsMediaDataInRealTime = false
        guard reader.canAdd(videoOut), writer.canAdd(videoIn) else { throw Failure.writing("the video track is not one this Mac can re-encode") }
        reader.add(videoOut)
        writer.add(videoIn)

        var pairs = [Track(output: videoOut, input: videoIn, isVideo: true)]
        if let audio {
            let channels = min(2, max(1, try await channelCount(audio)))
            let pcm: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: channels,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
            var layout = AudioChannelLayout()
            layout.mChannelLayoutTag = channels == 1 ? kAudioChannelLayoutTag_Mono : kAudioChannelLayoutTag_Stereo
            let audioOut = AVAssetReaderTrackOutput(track: audio, outputSettings: pcm)
            let audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: spec.audioKbps * 1000,
                AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
            ])
            audioIn.expectsMediaDataInRealTime = false
            // A clip whose sound cannot be decoded still gets a silent proxy.
            if reader.canAdd(audioOut), writer.canAdd(audioIn) {
                reader.add(audioOut)
                writer.add(audioIn)
                pairs.append(Track(output: audioOut, input: audioIn, isVideo: false))
            }
        }

        guard reader.startReading() else { throw Failure.unreadable(reader.error?.localizedDescription ?? "it would not open") }
        guard writer.startWriting() else { throw Failure.writing(writer.error?.localizedDescription ?? "it would not start") }
        writer.startSession(atSourceTime: .zero)

        let stop = StopFlag()
        await withTaskCancellationHandler {
            await pump(pairs, duration: duration, stop: stop, progress: progress)
        } onCancel: {
            stop.set()
        }
        if stop.isSet || Task.isCancelled {
            reader.cancelReading()
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: destination)
            throw CancellationError()
        }
        if reader.status == .failed {
            writer.cancelWriting()
            throw Failure.unreadable(reader.error?.localizedDescription ?? "reading stopped")
        }
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw Failure.writing(writer.error?.localizedDescription ?? "it did not finish")
        }
        progress(1)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value ?? 0
        let shown = CGSize(width: size.width, height: size.height).applying(transform)
        return Output(width: Int(abs(shown.width).rounded()), height: Int(abs(shown.height).rounded()),
                      duration: duration.isFinite ? duration : 0, size: bytes)
    }

    /// Each track's samples from the reader to the writer, until every one
    /// is done or the job is stopped. The video's times give the progress.
    private static func pump(_ tracks: [Track], duration: Double, stop: StopFlag,
                             progress: @escaping @Sendable (Double) -> Void) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let group = DispatchGroup()
            for (index, track) in tracks.enumerated() {
                group.enter()
                let queue = DispatchQueue(label: "io.onyxfs.proxy.\(index)")
                let finished = StopFlag()
                track.input.requestMediaDataWhenReady(on: queue) {
                    let input = track.input, output = track.output
                    guard !finished.isSet else { return }
                    while input.isReadyForMoreMediaData {
                        guard !stop.isSet, let sample = output.copyNextSampleBuffer() else {
                            input.markAsFinished()
                            finished.set()
                            group.leave()
                            return
                        }
                        if track.isVideo, duration > 0 {
                            let at = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                            if at.isFinite { progress(min(0.999, max(0, at / duration))) }
                        }
                        if !input.append(sample) {
                            // The writer failed: its error is read after.
                            stop.set()
                        }
                    }
                }
            }
            group.notify(queue: .global()) { done.resume() }
        }
    }

    /// The source's frame, its short side at `shortSide` (or smaller, never
    /// larger than the source), both sides even as H.264 needs. The short
    /// side, not the height: a clip shot upright is 1080 wide, not 1080
    /// tall and 608 wide.
    static func outputSize(natural: CGSize, shortSide: Int) -> (width: Int, height: Int) {
        let w = max(2, abs(natural.width)), h = max(2, abs(natural.height))
        let scale = min(1, CGFloat(max(2, shortSide)) / min(w, h))
        func even(_ v: CGFloat) -> Int { max(2, Int((v * scale / 2).rounded()) * 2) }
        return (even(w), even(h))
    }

    /// Bits a second for the video: about 0.07 bits a pixel a frame — clean
    /// 1080p at 30 frames is about 4.4 Mbps — and never past the ceiling.
    static func videoBitrate(width: Int, height: Int, fps: Double, ceilingKbps: Int) -> Int {
        let rate = fps.isFinite && fps > 0 ? min(fps, 120) : 30
        let wanted = Double(width * height) * rate * 0.07
        return Int(min(wanted, Double(max(500, ceilingKbps)) * 1000))
    }

    private static func channelCount(_ track: AVAssetTrack) async throws -> Int {
        let descriptions = try await track.load(.formatDescriptions)
        guard let first = descriptions.first,
              let basic = CMAudioFormatDescriptionGetStreamBasicDescription(first)?.pointee else { return 2 }
        return Int(basic.mChannelsPerFrame)
    }
}

/// One track's reader output and writer input. Each is used only from the
/// queue its input asks for data on, which is how AVFoundation means them to
/// be used; hence unchecked.
private struct Track: @unchecked Sendable {
    let output: AVAssetReaderTrackOutput
    let input: AVAssetWriterInput
    let isVideo: Bool
}

/// Set once, read from any thread.
private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
}
