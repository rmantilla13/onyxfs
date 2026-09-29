import AVFoundation
import MediaPlayer
import OnyxKit
import SwiftUI

/// A sound's waveform (OnyxKit Waveform) as bars mirrored about the middle,
/// filling the frame it is given — one bar per level, a gap between. Filled
/// by whoever draws it: the brand gradient on a tile, white in a player.
struct WaveformBars: Shape {
    let levels: [Double]
    var gap: CGFloat = 0.32
    /// The quietest bar still drawn as a sliver, so silence reads as a line.
    var floor: Double = 0.06

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard !levels.isEmpty else { return path }
        let step = rect.width / CGFloat(levels.count)
        let width = max(0.5, step * (1 - gap))
        let corner = min(width / 2, 2)
        for (i, level) in levels.enumerated() {
            let height = max(floor, min(1, level)) * rect.height
            let bar = CGRect(x: rect.minX + CGFloat(i) * step + (step - width) / 2,
                             y: rect.midY - height / 2, width: width, height: height)
            path.addRoundedRect(in: bar, cornerSize: CGSize(width: corner, height: corner))
        }
        return path
    }
}

/// A sound on its tile: its waveform in the brand gradient, where a picture
/// would be — or nil, and the tile keeps its symbol.
struct TileWaveform: View {
    let waveform: Waveform
    let compact: Bool

    var body: some View {
        GeometryReader { geo in
            let count = compact ? 12 : max(16, min(56, Int(geo.size.width / 5)))
            WaveformBars(levels: waveform.levels(count))
                .fill(Theme.meter)
                .frame(width: geo.size.width * (compact ? 0.78 : 0.8), height: geo.size.height * (compact ? 0.56 : 0.44))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - The player

/// A sound, full screen: its waveform as the scrubber — dragged anywhere
/// along it to go there — a play button between two fifteen-second skips,
/// and where it is out of how long. Streams through a link signed as the
/// page comes on screen, as a video does, and stops as it pages away. A
/// sound with no waveform yet has a plain track in its place.
///
/// On the lock screen and in Control Center as the system player would be
/// (NowPlaying): its name, where it is, play, pause and the scrubber.
struct SoundPage: View {
    let file: FileItem
    let active: Bool
    @Environment(Session.self) private var session
    @State private var player: AVPlayer?
    @State private var problem: String?
    @State private var playing = false
    @State private var time: Double = 0
    @State private var length: Double = 0
    /// Where a finger is along the waveform, 0...1, while it drags.
    @State private var scrubbing: Double?
    @State private var nowPlaying = NowPlaying()

    private static let skip: Double = 15

    private var shown: Double { scrubbing.map { $0 * length } ?? time }
    private var progress: Double { length > 0 ? min(1, max(0, shown / length)) : 0 }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            if file.metadata?.waveform == nil {
                KindSymbol(file: file)
                    .padding(.bottom, 36)
            }
            SoundScrubber(waveform: file.metadata?.waveform, progress: progress, active: scrubbing != nil) { fraction, ended in
                if ended {
                    scrubbing = nil
                    seek(to: fraction * length)
                } else {
                    scrubbing = fraction
                }
            } step: { direction in
                seek(to: time + Double(direction) * Self.skip)
            }
            .frame(height: file.metadata?.waveform == nil ? 44 : 160)
            .disabled(player == nil || length <= 0)

            HStack {
                Text(Self.clock(shown))
                Spacer()
                Text("-" + Self.clock(max(0, length - shown)))
            }
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.top, 14)
            .accessibilityHidden(true)

            HStack(spacing: 44) {
                skipButton(-1)
                Button(action: toggle) {
                    Image(systemName: playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(Theme.onAura)
                        .offset(x: playing ? 0 : 2)
                        .frame(width: 78, height: 78)
                        .background { BrandFill(shape: Circle()) }
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(player == nil)
                .accessibilityLabel(playing ? "Pause" : "Play")
                skipButton(1)
            }
            .padding(.top, 34)

            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .symbolRenderingMode(.multicolor)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .glassSurface(Capsule())
                    .padding(.top, 24)
            } else if active, player == nil {
                ProgressView().tint(.white).padding(.top, 24)
            }
            Spacer(minLength: 24)
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: active) { await start() }
        .onDisappear { stop() }
    }

    private func skipButton(_ direction: Int) -> some View {
        Button {
            seek(to: time + Double(direction) * Self.skip)
        } label: {
            Image(systemName: direction < 0 ? "gobackward.15" : "goforward.15")
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(.white.opacity(player == nil ? 0.35 : 0.92))
                .frame(width: 56, height: 56)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(player == nil)
        .accessibilityLabel(direction < 0 ? "Back 15 seconds" : "Forward 15 seconds")
    }

    // MARK: Playing

    private func start() async {
        guard active else {
            stop()
            return
        }
        length = file.metadata?.duration ?? 0
        do {
            let link = try await session.api.contentLink(fileId: file.id)
            guard !Task.isCancelled else { return }
            let item = AVPlayerItem(url: link.url)
            let next = AVPlayer(playerItem: item)
            next.allowsExternalPlayback = true
            nowPlaying.attach(next, title: file.name) { seconds in seek(to: seconds) }
            nowPlaying.onTick = { now, rate, total in
                if scrubbing == nil { time = now }
                playing = rate != 0
                if let total, total > 0 { length = total }
            }
            player = next
            next.play()
            if let total = try? await item.asset.load(.duration).seconds, total.isFinite, total > 0 { length = total }
        } catch {
            if !Session.isCancel(error) { problem = session.explain(error) }
        }
    }

    private func stop() {
        player?.pause()
        nowPlaying.detach()
        player = nil
        playing = false
    }

    private func toggle() {
        guard let player else { return }
        if player.rate != 0 {
            player.pause()
        } else {
            // From the end, again from the start.
            if length > 0, time >= length - 0.25 { seek(to: 0) }
            player.play()
        }
        playing = player.rate != 0
        nowPlaying.publish()
    }

    private func seek(to seconds: Double) {
        guard let player else { return }
        let target = max(0, length > 0 ? min(seconds, length) : seconds)
        time = target
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
            Task { @MainActor in nowPlaying.publish() }
        }
    }

    /// "1:05", "1:02:07".
    static func clock(_ seconds: Double) -> String {
        let total = Int(max(0, seconds.isFinite ? seconds : 0).rounded(.down))
        let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

/// The waveform as a scrubber: the part played in the brand gradient, the
/// rest a quiet white, a playhead between. A finger anywhere on it moves the
/// playhead there — `onScrub(fraction, ended)` as it goes and as it lifts —
/// and holds the page still meanwhile, rather than paging to the next file.
/// VoiceOver adjusts it in fifteen-second steps (`step`).
private struct SoundScrubber: View {
    let waveform: Waveform?
    let progress: Double
    let active: Bool
    let onScrub: (Double, Bool) -> Void
    let step: (Int) -> Void

    var body: some View {
        GeometryReader { geo in
            let width = max(1, geo.size.width)
            let levels = waveform?.levels(Int(width / 4.5)) ?? []
            ZStack(alignment: .leading) {
                if levels.isEmpty {
                    Capsule().fill(.white.opacity(0.2)).frame(height: 5)
                    Capsule().fill(Theme.meter).frame(width: width * progress, height: 5)
                } else {
                    WaveformBars(levels: levels).fill(.white.opacity(0.22))
                    WaveformBars(levels: levels).fill(Theme.meter)
                        .mask(alignment: .leading) { Rectangle().frame(width: width * progress) }
                }
                Capsule()
                    .fill(.white)
                    .frame(width: active ? 3 : 2, height: levels.isEmpty ? 16 : geo.size.height * 0.92)
                    .shadow(color: .black.opacity(0.35), radius: 2)
                    .offset(x: width * progress - (active ? 1.5 : 1))
            }
            .frame(width: width, height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { onScrub(min(1, max(0, $0.location.x / width)), false) }
                    .onEnded { onScrub(min(1, max(0, $0.location.x / width)), true) }
            )
        }
        .accessibilityElement()
        .accessibilityLabel("Position")
        .accessibilityValue("\(Int((progress * 100).rounded())) percent")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(1)
            case .decrement: step(-1)
            @unknown default: break
            }
        }
    }
}

/// The sound on the lock screen and in Control Center: its name, how long,
/// where it is, and the system's play, pause and scrubber answered here.
/// What the page's player says thirty times a second (`onTick`) is what the
/// page shows.
@MainActor
final class NowPlaying {
    var onTick: ((_ time: Double, _ rate: Float, _ length: Double?) -> Void)?
    private weak var player: AVPlayer?
    private var title = ""
    private var observer: Any?
    private var targets: [(MPRemoteCommand, Any)] = []
    private var seek: ((Double) -> Void)?

    func attach(_ player: AVPlayer, title: String, seek: @escaping (Double) -> Void) {
        detach()
        self.player = player
        self.title = title
        self.seek = seek
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] now in
            MainActor.assumeIsolated {
                guard let self, let player = self.player else { return }
                let total = player.currentItem?.duration.seconds
                self.onTick?(now.seconds.isFinite ? now.seconds : 0, player.rate, total?.isFinite == true ? total : nil)
            }
        }
        let center = MPRemoteCommandCenter.shared()
        func on(_ command: MPRemoteCommand, _ handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
            command.isEnabled = true
            targets.append((command, command.addTarget(handler: handler)))
        }
        on(center.playCommand) { [weak self] _ in self?.player?.play(); self?.publish(); return .success }
        on(center.pauseCommand) { [weak self] _ in self?.player?.pause(); self?.publish(); return .success }
        on(center.togglePlayPauseCommand) { [weak self] _ in
            guard let player = self?.player else { return .noActionableNowPlayingItem }
            if player.rate != 0 { player.pause() } else { player.play() }
            self?.publish()
            return .success
        }
        on(center.changePlaybackPositionCommand) { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek?(event.positionTime)
            return .success
        }
        publish()
    }

    func publish() {
        guard let player else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0,
            MPNowPlayingInfoPropertyPlaybackRate: Double(player.rate),
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let total = player.currentItem?.duration.seconds, total.isFinite, total > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = total
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func detach() {
        if let observer, let player { player.removeTimeObserver(observer) }
        observer = nil
        for (command, target) in targets { command.removeTarget(target) }
        targets = []
        if player != nil { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
        player = nil
        seek = nil
    }
}
