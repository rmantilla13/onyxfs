import AVFoundation
import Foundation

/// A sound file's Waveform, read from disk with AVFoundation — every format
/// it plays (AAC, MP3, WAV, AIFF, ALAC, FLAC), of any length.
///
/// The file is decoded as it is read, mixed down to one channel at 8 kHz
/// (loudness needs no treble), and only each window's sum of squares is
/// kept, never the samples: a ten-hour recording holds what ten seconds do.
/// Windows start at 10 ms; past `maxWindows` neighbours are folded together
/// and the windows double, so the tally stays small however long it runs.
/// At the end the windows are shared out across the bars.
public enum WaveformReader {
    public struct Failure: LocalizedError {
        public let errorDescription: String?
    }

    static let sampleRate = 8000
    static let firstWindow = 80
    static let maxWindows = 1 << 16

    /// Nil for a file with no sound in it, or too short to have a shape.
    public static func waveform(of url: URL, bars: Int = Waveform.barCount) async throws -> Waveform? {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return nil }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw Failure(errorDescription: "This sound cannot be read.") }
        reader.add(output)
        guard reader.startReading() else {
            throw reader.error ?? Failure(errorDescription: "This sound cannot be read.")
        }
        defer { if reader.status == .reading { reader.cancelReading() } }

        var tally = Tally()
        var scratch = [Float]()
        while let buffer = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            let count = length / MemoryLayout<Float>.size
            guard count > 0 else { continue }
            if scratch.count < count { scratch = [Float](repeating: 0, count: count) }
            let copied = scratch.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * MemoryLayout<Float>.size,
                                           destination: raw.baseAddress!)
            }
            guard copied == kCMBlockBufferNoErr else { continue }
            scratch.withUnsafeBufferPointer { tally.add($0.prefix(count)) }
        }
        if reader.status == .failed { throw reader.error ?? Failure(errorDescription: "This sound cannot be read.") }
        return tally.waveform(bars: bars)
    }

    /// Windows of squared samples, folded in pairs as they grow.
    struct Tally {
        var window = WaveformReader.firstWindow
        var sums: [Double] = []
        var counts: [Double] = []
        var sum = 0.0
        var count = 0

        mutating func add<S: Sequence>(_ samples: S) where S.Element == Float {
            for sample in samples {
                let v = Double(sample)
                sum += v * v
                count += 1
                if count == window { close() }
            }
        }

        private mutating func close() {
            sums.append(sum)
            counts.append(Double(count))
            sum = 0
            count = 0
            if sums.count >= WaveformReader.maxWindows { fold() }
        }

        /// Every two neighbouring windows as one, twice as long.
        mutating func fold() {
            var folded: [Double] = []
            var foldedCounts: [Double] = []
            folded.reserveCapacity(sums.count / 2 + 1)
            foldedCounts.reserveCapacity(sums.count / 2 + 1)
            var i = 0
            while i < sums.count {
                let j = min(i + 1, sums.count - 1)
                folded.append(i == j ? sums[i] : sums[i] + sums[j])
                foldedCounts.append(i == j ? counts[i] : counts[i] + counts[j])
                i += 2
            }
            sums = folded
            counts = foldedCounts
            window *= 2
        }

        /// The windows shared out across `bars` bars (fewer when there are fewer windows).
        func waveform(bars: Int) -> Waveform? {
            var sums = self.sums
            var counts = self.counts
            if count > 0 {
                sums.append(sum)
                counts.append(Double(count))
            }
            let n = min(bars, sums.count)
            guard n > 0 else { return nil }
            var barSums = [Double](repeating: 0, count: n)
            var barCounts = [Double](repeating: 0, count: n)
            for i in 0..<sums.count {
                let bar = min(n - 1, i * n / sums.count)
                barSums[bar] += sums[i]
                barCounts[bar] += counts[i]
            }
            return Waveform.fromEnergy(sums: barSums, counts: barCounts)
        }
    }
}
