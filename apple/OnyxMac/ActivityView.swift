import SwiftUI
import UniformTypeIdentifiers
import OnyxKit

// MARK: - Activity

/// The foot of the window: what is moving right now, a second at a time over
/// the last minute — fetched from storage, sent to it, read by apps from the
/// disks and written to them (DriveService.transfers, a TransferLog) — and
/// the window's downloads, from the click until they are cleared.
///
/// It is always there, so it must cost nothing while nothing moves: the
/// graphs are redrawn once a second from when bytes start to move until they
/// have scrolled off (ActivityClock), and not at all in between. Settings ›
/// General can hide it (`setting`).
struct ActivityBar: View {
    @ObservedObject var clock: ActivityClock
    @ObservedObject var downloads: WebDownloads

    static let height: CGFloat = 44
    /// How far back the graphs go.
    static let seconds = 60
    /// Whether the window shows it, in UserDefaults: on unless turned off.
    static let setting = "showsActivityBar"

    var body: some View {
        // Read, so each tick redraws the graphs.
        let _ = clock.tick
        let transfers = clock.transfers
        HStack(spacing: 0) {
            ForEach(Meter.all) { meter in
                if meter != Meter.all.first { Divider().padding(.vertical, 10) }
                MeterCell(meter: meter,
                          samples: Sparkline.smoothed(transfers.history(meter.kind, seconds: Self.seconds)),
                          rate: transfers.rate(meter.kind))
            }
            if let item = downloads.shown {
                Divider()
                // Room for a name before the graphs get theirs.
                DownloadsSlot(item: item, downloads: downloads)
                    .frame(minWidth: 240, maxWidth: 340)
                    .layoutPriority(1)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: Self.height)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .top) { Divider() }
        .onAppear { clock.attach() }
        .onDisappear { clock.detach() }
    }
}

/// Redraws what shows activity — the window's bar, the menu bar's panel —
/// once a second from when bytes start to move until the graphs are flat
/// again, and never while nothing that shows them is on screen: the log
/// wakes it (TransferLog.onWake), it stops itself once the log has been
/// quiet for as long as a graph shows, and it stops when the last view
/// showing it goes. One for the app (AppModel.activity): the log has one
/// hook, and one tick redraws every view at once.
@MainActor
final class ActivityClock: ObservableObject {
    @Published private(set) var tick = 0
    let transfers: TransferLog
    private var viewers = 0
    private var loop: Task<Void, Never>?

    init(transfers: TransferLog) {
        self.transfers = transfers
        transfers.onWake = { [weak self] in
            Task { @MainActor in self?.run() }
        }
    }

    /// A view that shows activity came on screen…
    func attach() {
        viewers += 1
        run()
    }

    /// …or went.
    func detach() {
        viewers = max(0, viewers - 1)
        guard viewers == 0 else { return }
        loop?.cancel()
        loop = nil
    }

    private func run() {
        guard viewers > 0, loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                // Just past each whole second, so each redraw moves the
                // graphs one second along.
                let now = Date().timeIntervalSince1970
                try? await Task.sleep(nanoseconds: UInt64((now.rounded(.down) + 1.02 - now) * 1e9))
                guard let self, !Task.isCancelled else { return }
                self.tick &+= 1
                if self.transfers.quiet(for: ActivityBar.seconds) { break }
            }
            self?.loop = nil
        }
    }
}

/// The four as tiles, two by two, for the menu bar's panel: the same
/// figures and graphs as the window's bar, where there is more room above
/// than beside.
struct ActivityTiles: View {
    @ObservedObject var clock: ActivityClock

    var body: some View {
        let _ = clock.tick
        VStack(spacing: 8) {
            HStack(spacing: 8) { tile(Meter.all[0]); tile(Meter.all[1]) }
            HStack(spacing: 8) { tile(Meter.all[2]); tile(Meter.all[3]) }
        }
        .onAppear { clock.attach() }
        .onDisappear { clock.detach() }
    }

    private func tile(_ meter: Meter) -> some View {
        MeterTile(meter: meter,
                  samples: Sparkline.smoothed(clock.transfers.history(meter.kind, seconds: ActivityBar.seconds)),
                  rate: clock.transfers.rate(meter.kind))
    }
}

private struct MeterTile: View {
    let meter: Meter
    let samples: [Double]
    let rate: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Circle().fill(meter.color).frame(width: 6, height: 6)
                Text(meter.title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            }
            Text(ActivityFormat.bitrate(rate))
                .font(.system(size: 14, weight: .semibold).monospacedDigit())
                .lineLimit(1)
            Sparkline(samples: samples, color: meter.color)
                .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.25)],
                                     startPoint: .leading, endPoint: .trailing))
                .frame(height: 24)
                .padding(.top, 3)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(meter.title)
        .accessibilityValue(ActivityFormat.spoken(rate))
    }
}

/// One of the four, as the bar shows it.
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

private struct MeterCell: View {
    let meter: Meter
    /// Bytes per second, oldest first.
    let samples: [Double]
    /// Bytes per second, now.
    let rate: Double

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(meter.title)
                    .font(.system(size: 11, weight: .semibold))
                Text(ActivityFormat.bitrate(rate))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            // As wide as the widest figure, so the graph does not shift as
            // the figure changes.
            .frame(width: 74, alignment: .leading)
            Sparkline(samples: samples, color: meter.color)
                .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.3)],
                                     startPoint: .leading, endPoint: .trailing))
                .padding(.vertical, 9)
        }
        .padding(.horizontal, 12)
        .frame(minWidth: 110, maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
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
                    .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
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

// MARK: - Downloads

/// A view's own state. (Not @State: see FormState.)
final class SlotState: ObservableObject {
    @Published var listShown = false
}

/// The bar's end: the download under way — or the last one, done — and the
/// rest behind "+2", in a list.
private struct DownloadsSlot: View {
    let item: WebDownloads.Item
    @ObservedObject var downloads: WebDownloads
    @StateObject private var ui = SlotState()

    var body: some View {
        HStack(spacing: 6) {
            DownloadRow(item: item, downloads: downloads)
            if downloads.items.count > 1 {
                Button { ui.listShown.toggle() } label: {
                    Text("+\(downloads.items.count - 1)")
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                .buttonStyle(.plain)
                .help("All downloads")
                .popover(isPresented: $ui.listShown, arrowEdge: .top) { DownloadsList(downloads: downloads) }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.accentColor.opacity(downloads.flashed == item.id ? 0.22 : 0)))
        .animation(.easeOut(duration: 0.25), value: downloads.flashed)
        .padding(.horizontal, 4)
    }
}

/// Every download the window has, newest first.
private struct DownloadsList: View {
    @ObservedObject var downloads: WebDownloads

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(downloads.items) { item in
                    DownloadRow(item: item, downloads: downloads)
                }
            }
            .padding(14)
            if downloads.items.contains(where: { !$0.isActive }) {
                Divider()
                HStack {
                    Spacer()
                    Button("Clear") { downloads.clearEnded() }
                        .help("Take the downloads that have ended off the list; the files stay where they are")
                }
                .padding(10)
            }
        }
        .frame(width: 360)
    }
}

/// One download: what it is, how far it has got, and what can be done
/// with it — stopped while it runs, found or opened when it is done, asked
/// for again when it did not finish.
struct DownloadRow: View {
    let item: WebDownloads.Item
    let downloads: WebDownloads

    var body: some View {
        HStack(spacing: 8) {
            icon.frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name ?? "Starting download…")
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1).truncationMode(.middle)
                if item.isActive { ProgressLine(fraction: item.fraction) }
                Text(ActivityFormat.status(item))
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundStyle(failed ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
                    .lineLimit(1).truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { downloads.open(item.id) }
            // icons: x search refresh-ccw download
            if item.isActive {
                RowButton(icon: "x", help: "Stop this download") { downloads.cancel(item.id) }
            } else {
                if item.state == .finished {
                    RowButton(icon: "search", help: "Show in Finder") { downloads.showInFinder(item.id) }
                } else if item.canRetry {
                    RowButton(icon: "refresh-ccw", help: "Try again") { downloads.retry(item.id) }
                }
                RowButton(icon: "x", help: "Clear from the list; the file stays where it is") { downloads.dismiss(item.id) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(item.name ?? "Download")
    }

    private var failed: Bool {
        if case .failed = item.state { return true }
        return false
    }

    @ViewBuilder private var icon: some View {
        if let name = item.name {
            let type = UTType(filenameExtension: (name as NSString).pathExtension) ?? .data
            Image(nsImage: NSWorkspace.shared.icon(for: type)).resizable().aspectRatio(contentMode: .fit)
        } else {
            Image(lucide: "download", size: 16).foregroundStyle(.secondary)
        }
    }
}

/// How far a download or upload has got, as a hairline: full width and
/// faint while the server has not said how big it is.
struct ProgressLine: View {
    let fraction: Double?

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                if let fraction {
                    Capsule().fill(Color.accentColor).frame(width: max(3, geometry.size.width * fraction))
                }
            }
        }
        .frame(height: 3)
        .accessibilityHidden(true)
    }
}

private struct RowButton: View {
    let icon: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(lucide: icon, size: 13).foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
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

    /// "97.3 MB of 231.7 MB — 23 s left", "In Downloads — 231.7 MB".
    static func status(_ item: WebDownloads.Item) -> String {
        switch item.state {
        case .starting:
            return "Waiting for the server…"
        case .running:
            guard let expected = item.expected else { return size(item.received) }
            let sofar = "\(size(item.received)) of \(size(expected))"
            guard item.rate > 0, expected > item.received else { return sofar }
            return "\(sofar) — \(left(Double(expected - item.received) / item.rate))"
        case .finished:
            let folder = item.destination?.deletingLastPathComponent().lastPathComponent ?? "Downloads"
            return "In \(folder) — \(size(item.received))"
        case let .failed(why):
            return "Did not finish: \(why)"
        }
    }

    static func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// "23 s left", "4 min left", "1 h 12 min left".
    static func left(_ seconds: Double) -> String {
        let s = Int(seconds.rounded(.up))
        if s < 60 { return "\(max(1, s)) s left" }
        if s < 3600 { return "\(Int((Double(s) / 60).rounded())) min left" }
        return "\(s / 3600) h \((s % 3600) / 60) min left"
    }
}

#if DEBUG
/// Pretend traffic for the Activity bar (`--demo-activity`, debug builds
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
