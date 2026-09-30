import Foundation

/// A sound's shape, as the server keeps it in a file's `metadata.waveform`
/// (lib/waveform.js): loudness bars, one byte each — the RMS of the samples
/// in that stretch of the file, scaled so the loudest stretch is 255 —
/// stored as "1:<base64>". The "1" is the format; anything else is not read.
///
/// Drawn on this side by WaveformReader (from a file on disk, streamed) and
/// shown by the iOS app's tiles and player; drawn on the web by
/// lib/waveform-client.js. Both must make the same bars from the same sound,
/// so the arithmetic here is lib/waveform.js's, line for line.
public struct Waveform: Sendable, Equatable, Codable {
    /// Loudness, 0 (silence) to 255 (the loudest stretch).
    public let bars: [UInt8]

    /// How many bars one is made with (WAVEFORM_BARS).
    public static let barCount = 256
    static let minBars = 16
    static let maxBars = 1024

    public init?(bars: [UInt8]) {
        guard (Self.minBars...Self.maxBars).contains(bars.count) else { return nil }
        self.bars = bars
    }

    /// The stored string ("1:<base64>"), or nil when it is not one this reads.
    public init?(stored: String) {
        guard stored.hasPrefix("1:"), stored.utf8.count <= 8 + (Self.maxBars + 2) / 3 * 4,
              let data = Data(base64Encoded: String(stored.dropFirst(2))) else { return nil }
        self.init(bars: [UInt8](data))
    }

    /// As the server stores it.
    public var stored: String { "1:" + Data(bars).base64EncodedString() }

    /// Bars from what a reader that never holds the whole sound adds up as
    /// it goes: per bar, the sum of its samples' squares and how many
    /// samples that is (waveformFromEnergy). Nil for fewer than a waveform's
    /// worth of bars.
    public static func fromEnergy(sums: [Double], counts: [Double]) -> Waveform? {
        let n = min(sums.count, counts.count)
        guard n > 0 else { return nil }
        var rms = [Double](repeating: 0, count: n)
        var loudest = 0.0
        for i in 0..<n {
            let v = counts[i] > 0 ? (sums[i] / counts[i]).squareRoot() : 0
            rms[i] = v.isFinite ? v : 0
            loudest = max(loudest, rms[i])
        }
        let bars = rms.map { loudest > 0 ? UInt8(($0 / loudest * 255).rounded()) : 0 }
        return Waveform(bars: bars)
    }

    /// Resampled to `count` for drawing, 0...1 (waveformBars): fewer, each
    /// the loudness of the stretch it covers — the RMS of its bars — scaled
    /// again so the loudest fills the height; more than there are, the bars
    /// as they are.
    public func levels(_ count: Int) -> [Double] {
        let want = max(1, count)
        guard want < bars.count else { return bars.map { Double($0) / 255 } }
        let rms = (0..<want).map { i -> Double in
            let from = i * bars.count / want
            let to = max(from + 1, (i + 1) * bars.count / want)
            let sum = bars[from..<to].reduce(0.0) { $0 + Double($1) * Double($1) }
            return (sum / Double(to - from)).squareRoot()
        }
        let loudest = rms.max() ?? 0
        return rms.map { loudest > 0 ? $0 / loudest : 0 }
    }

    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let waveform = Waveform(stored: text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a waveform"))
        }
        self = waveform
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(stored)
    }
}
