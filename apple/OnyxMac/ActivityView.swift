import SwiftUI
import OnyxKit

// MARK: - Activity

/// What the drives are moving right now, a second at a time over the last
/// minute: fetched from storage, sent to it, read by apps from the disks and
/// written to them (DriveService.transfers, a TransferLog).
///
/// The log is kept by adding to it and nothing else; this window reads it
/// once a second while it is open, and while it is shut nothing runs at all.
struct ActivityView: View {
    let transfers: TransferLog
    /// How far back the graphs go.
    static let seconds = 60

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            HStack(spacing: 0) {
                ForEach(Meter.all) { meter in
                    if meter != Meter.all.first { Divider() }
                    MeterColumn(meter: meter,
                                samples: Sparkline.smoothed(transfers.history(meter.kind, seconds: Self.seconds)),
                                rate: transfers.rate(meter.kind))
                }
            }
        }
        .frame(minWidth: 640, idealWidth: 780, minHeight: 104, idealHeight: 120)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

/// One of the four, as the window shows it.
struct Meter: Identifiable, Equatable {
    let kind: TransferLog.Kind
    let title: String
    let color: Color

    var id: Int { kind.rawValue }

    static let all = [
        Meter(kind: .download, title: "Download", color: Color(red: 0.39, green: 0.40, blue: 0.95)),
        Meter(kind: .upload, title: "Upload", color: Color(red: 0.13, green: 0.73, blue: 0.87)),
        Meter(kind: .read, title: "Read", color: Color(red: 0.66, green: 0.33, blue: 0.97)),
        Meter(kind: .write, title: "Write", color: Color(red: 0.93, green: 0.29, blue: 0.60)),
    ]
}

private struct MeterColumn: View {
    let meter: Meter
    /// Bytes per second, oldest first.
    let samples: [Double]
    /// Bytes per second, now.
    let rate: Double

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                // The graph: the right of the column, above the figure,
                // fading in at its left end.
                Sparkline(samples: samples, color: meter.color)
                    .frame(width: geometry.size.width * 0.62, height: max(0, geometry.size.height - 48))
                    .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.3)],
                                         startPoint: .leading, endPoint: .trailing))
                    .offset(x: geometry.size.width * 0.38, y: 14)
                VStack(alignment: .leading, spacing: 10) {
                    Text(meter.title)
                        .font(.system(size: 15, weight: .semibold))
                    Text(ActivityFormat.bitrate(rate))
                        .font(.system(size: 14).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, 20)
                .frame(maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(meter.title)
        .accessibilityValue(ActivityFormat.spoken(rate))
    }
}

/// A minute of one kind of traffic: a line over a fill that fades out below
/// it. Flat along the bottom when nothing moves.
struct Sparkline: View {
    let samples: [Double]
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            let points = Self.points(samples, in: geometry.size)
            ZStack {
                Path { path in
                    guard let first = points.first, let last = points.last else { return }
                    // Point by point: addLines would start a subpath of its
                    // own, and the fill would close across the graph.
                    path.move(to: CGPoint(x: first.x, y: geometry.size.height))
                    for point in points { path.addLine(to: point) }
                    path.addLine(to: CGPoint(x: last.x, y: geometry.size.height))
                    path.closeSubpath()
                }
                .fill(LinearGradient(colors: [color.opacity(0.28), color.opacity(0)], startPoint: .top, endPoint: .bottom))
                Path { path in path.addLines(points) }
                    .stroke(color, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
            }
        }
    }

    /// Below this the graph does not rise to the top (bytes per second, one
    /// megabit): a few kilobytes read by Finder is not a full graph.
    static let floor = 125_000.0

    static func points(_ samples: [Double], in size: CGSize) -> [CGPoint] {
        guard samples.count > 1, size.width > 0, size.height > 2 else { return [] }
        let top = max(samples.max() ?? 0, floor) * 1.1
        let step = size.width / CGFloat(samples.count - 1)
        let usable = size.height - 2
        return samples.enumerated().map { i, value in
            CGPoint(x: CGFloat(i) * step, y: size.height - 1 - CGFloat(max(0, value) / top) * usable)
        }
    }

    /// Each second with its neighbours, averaged: a disk reports once a
    /// second, so one second can hold two reports and the next none, and
    /// drawn raw that is a comb, not a rate.
    static func smoothed(_ values: [Int64]) -> [Double] {
        values.indices.map { i in
            let lower = max(0, i - 1), upper = min(values.count - 1, i + 1)
            return Double(values[lower...upper].reduce(0, +)) / Double(upper - lower + 1)
        }
    }
}

enum ActivityFormat {
    /// "47.36 Mbps", as a network is measured; "1.20 Gbps" past a thousand.
    static func bitrate(_ bytesPerSecond: Double) -> String {
        let bits = max(0, bytesPerSecond) * 8
        if bits >= 1e9 { return "\((bits / 1e9).formatted(.number.precision(.fractionLength(2)))) Gbps" }
        let megabits = bits / 1e6
        if megabits < 0.005 { return "0 Mbps" }
        return "\(megabits.formatted(.number.precision(.fractionLength(2)))) Mbps"
    }

    /// For VoiceOver: "47.36 megabits per second".
    static func spoken(_ bytesPerSecond: Double) -> String {
        bitrate(bytesPerSecond).replacingOccurrences(of: "Gbps", with: "gigabits per second")
            .replacingOccurrences(of: "Mbps", with: "megabits per second")
    }
}

#if DEBUG
/// Pretend traffic for the Activity window (`--demo-activity`, debug builds
/// only): a video scrubbed from storage, a copy onto a drive and its upload.
enum ActivityDemo {
    static func start(_ transfers: TransferLog) {
        Task.detached(priority: .utility) {
            var t = 0.0
            while !Task.isCancelled {
                let tick = 0.1
                // Megabits per second, as a person would read them.
                let download = max(0, 46 + 4 * sin(t / 3) + Double.random(in: -2...2))
                let read = t.truncatingRemainder(dividingBy: 40) < 22 ? max(0, 38 + 10 * sin(t / 2)) : 0
                let write = t.truncatingRemainder(dividingBy: 30) > 8 ? max(0, 175 + 12 * sin(t) + Double.random(in: -6...6)) : 0
                let upload = max(0, 92 + 8 * sin(t / 5))
                for (kind, mbps) in [(TransferLog.Kind.download, download), (.read, read), (.write, write), (.upload, upload)] {
                    transfers.add(kind, Int64(mbps * 125_000 * tick))
                }
                t += tick
                try? await Task.sleep(nanoseconds: UInt64(tick * 1e9))
            }
        }
    }
}
#endif
