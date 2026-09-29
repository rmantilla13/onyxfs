import AVKit
import OnyxKit
import QuickLook
import SwiftUI

/// A folder's files full screen, one at a time, swiped through: a picture
/// zooms, a video or a song plays (picture in picture, AirPlay), and a
/// document opens in Quick Look. A tap on a picture hides everything else.
struct PreviewView: View {
    let files: [FileItem]
    @Environment(\.dismiss) private var dismiss
    @Environment(Session.self) private var session
    @State private var current: String?
    @State private var chromeHidden = false
    @State private var inspecting: FileItem?
    @State private var sharing: ShareItem?
    @State private var shareProgress: Double?
    @State private var shareProblem: String?

    init(files: [FileItem], startID: String) {
        self.files = files
        _current = State(initialValue: startID)
    }

    private var file: FileItem? { files.first { $0.id == current } }

    var body: some View {
        NavigationStack {
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(files) { file in
                        PreviewPage(file: file, active: current == file.id, chromeHidden: $chromeHidden)
                            .containerRelativeFrame([.horizontal, .vertical])
                            .clipped()
                            .id(file.id)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $current)
            .scrollIndicators(.hidden)
            .background(Color.black.ignoresSafeArea())
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle(file?.name ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button { share() } label: {
                        if let shareProgress {
                            ProgressView(value: shareProgress).progressViewStyle(.circular).controlSize(.small)
                        } else {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                    .disabled(shareProgress != nil)
                    .accessibilityLabel("Share")
                    Spacer()
                    if let index = files.firstIndex(where: { $0.id == current }), files.count > 1 {
                        Text("\(index + 1) of \(files.count)")
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { inspecting = file } label: { Image(systemName: "info.circle") }
                        .accessibilityLabel("Info")
                }
            }
            .toolbar(chromeHidden ? .hidden : .visible, for: .navigationBar, .bottomBar)
            .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
            .statusBarHidden(chromeHidden)
            .animation(.easeInOut(duration: 0.2), value: chromeHidden)
        }
        .preferredColorScheme(.dark)
        .sheet(item: $inspecting) { FileInfoView(file: $0, place: nil) }
        .sheet(item: $sharing) { ShareSheet(items: [$0.url]).presentationDetents([.medium, .large]) }
        .alert("Can't Share", isPresented: Binding(get: { shareProblem != nil }, set: { if !$0 { shareProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(shareProblem ?? "")
        }
    }

    /// The file itself goes to the share sheet, so it is downloaded first
    /// (once: it is kept for a Quick Look or a second share).
    private func share() {
        guard let file, shareProgress == nil else { return }
        shareProgress = 0
        Task {
            defer { shareProgress = nil }
            do {
                let url = try await PreviewFiles.local(for: file, api: session.api) { fraction in
                    Task { @MainActor in if shareProgress != nil { shareProgress = fraction } }
                }
                sharing = ShareItem(url: url)
            } catch {
                if !Session.isCancel(error) { shareProblem = session.explain(error) }
            }
        }
    }
}

private struct ShareItem: Identifiable {
    let url: URL
    var id: URL { url }
}

/// One file, full screen.
private struct PreviewPage: View {
    let file: FileItem
    /// The page on screen: only it plays, and only it downloads.
    let active: Bool
    @Binding var chromeHidden: Bool

    var body: some View {
        switch file.kind {
        case "image":
            ImagePage(file: file)
                .onTapGesture { chromeHidden.toggle() }
        case "video", "audio":
            MediaPage(file: file, active: active)
        default:
            DocumentPage(file: file, active: active)
        }
    }
}

// MARK: - Pictures

/// The picture at up to 2400 pixels — its preview, made at upload — which
/// fills any phone or iPad screen; the original only for a picture that has
/// none, and then decoded down to that size.
private struct ImagePage: View {
    let file: FileItem
    @Environment(Session.self) private var session
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            if let image {
                ZoomableImage(image: image)
            } else if let small = file.thumbnail(.card).flatMap({ ThumbnailStore.shared.cached($0) }) {
                // The tile's picture, stretched, until the sharp one comes.
                Image(uiImage: small).resizable().scaledToFit().blur(radius: 6)
                ProgressView().tint(.white)
            } else if failed {
                KindSymbol(file: file)
            } else {
                ProgressView().tint(.white)
            }
        }
        .task(id: file.id) { await load() }
    }

    private func load() async {
        if let poster = file.posterSource, let picture = await ThumbnailStore.shared.image(poster) {
            image = picture
            return
        }
        // No preview: the original, if it is small enough to be worth it.
        guard (file.size ?? .max) <= 60 << 20,
              let url = try? await PreviewFiles.local(for: file, api: session.api),
              let data = try? Data(contentsOf: url, options: .mappedIfSafe),
              let picture = ThumbnailStore.decode(data, maxPixels: 2400) else {
            if !Task.isCancelled { failed = true }
            return
        }
        image = picture
    }
}

/// Pinch and double-tap to zoom, as in Photos.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> ZoomView { ZoomView() }

    func updateUIView(_ view: ZoomView, context: Context) { view.show(image) }
}

private final class ZoomView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()

    init() {
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 5
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        decelerationRate = .fast
        imageView.contentMode = .scaleAspectFit
        addSubview(imageView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ image: UIImage) {
        guard imageView.image !== image else { return }
        imageView.image = image
        zoomScale = 1
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if zoomScale == minimumZoomScale {
            imageView.frame = bounds
            contentSize = bounds.size
        }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale {
            setZoomScale(minimumZoomScale, animated: true)
        } else {
            let point = gesture.location(in: imageView)
            let size = CGSize(width: bounds.width / 2.5, height: bounds.height / 2.5)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                            width: size.width, height: size.height), animated: true)
        }
    }
}

// MARK: - Video and sound

/// Streams from storage through a link signed as the page comes on screen
/// — the listing's may be an hour old — and plays at once. Paged away, the
/// player goes, and with it its buffers.
private struct MediaPage: View {
    let file: FileItem
    let active: Bool
    /// The server's line for a video worth a streamable copy
    /// (lib/proxies.js PROXY_MIN_BYTES): under it, the original streams fine.
    static let proxyWorthy: Int64 = 200 * 1024 * 1024
    @Environment(Session.self) private var session
    @State private var player: AVPlayer?
    @State private var problem: String?

    var body: some View {
        ZStack {
            if let poster = file.posterSource ?? file.thumbnail(.card) {
                PosterImage(source: poster)
            } else {
                KindSymbol(file: file)
            }
            if let player {
                PlayerView(player: player)
            } else if let problem {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.white)
                    .padding(12)
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
            } else if active {
                ProgressView().tint(.white)
            }
        }
        .task(id: active) {
            guard active else {
                player?.pause()
                player = nil
                return
            }
            do {
                let link = try await session.api.contentLink(fileId: file.id)
                // The streamable copy when there is one: an action camera's
                // 4K master runs at 60–120 Mbps, more than a phone's
                // connection carries, and stalls; its 1080p copy does not.
                let item = AVPlayerItem(url: link.proxyUrl ?? link.url)
                // None yet, of a video this large: ask for one, so the next
                // time it plays, it plays smoothly. Uploads since proxies
                // came ask for their own; this catches the ones before.
                if link.proxyUrl == nil, (file.size ?? 0) >= Self.proxyWorthy {
                    let api = session.api, id = file.id
                    Task.detached(priority: .utility) { try? await api.requestProxy(fileId: id) }
                }
                let next = AVPlayer(playerItem: item)
                next.allowsExternalPlayback = true
                player = next
                next.play()
            } catch {
                if !Session.isCancel(error) { problem = session.explain(error) }
            }
        }
    }
}

/// A poster or a thumbnail, fitted, behind a player until it plays.
private struct PosterImage: View {
    let source: ThumbnailSource
    @State private var image: UIImage?

    init(source: ThumbnailSource) {
        self.source = source
        _image = State(initialValue: ThumbnailStore.shared.cached(source))
    }

    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() } else { Color.black }
        }
        .task(id: source) { if image == nil { image = await ThumbnailStore.shared.image(source) } }
    }
}

/// The system player: its controls, picture in picture, AirPlay.
private struct PlayerView: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.updatesNowPlayingInfoCenter = true
        controller.videoGravity = .resizeAspect
        controller.view.backgroundColor = .clear
        controller.player = player
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
    }
}

// MARK: - Documents

/// Quick Look, after the file is downloaded. A large one waits to be asked
/// for rather than use someone's data on a swipe.
private struct DocumentPage: View {
    let file: FileItem
    let active: Bool
    @Environment(Session.self) private var session
    @State private var local: URL?
    @State private var progress: Double?
    @State private var problem: String?
    @State private var asked = false

    /// Downloaded without asking below this.
    static let automatic: Int64 = 50 << 20

    var body: some View {
        Group {
            if let local {
                QuickLookView(url: local)
            } else {
                VStack(spacing: 14) {
                    KindSymbol(file: file)
                        .scaleEffect(1.6)
                        .padding(.bottom, 12)
                    Text(file.name)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                    Text(FileFormat.size(file.size))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let progress {
                        ProgressView(value: progress)
                            .frame(maxWidth: 220)
                    } else if let problem {
                        Text(problem).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                        Button("Try Again") { asked = true; Task { await download() } }
                    } else if !wantsDownload {
                        Button("Download to Preview") { asked = true; Task { await download() } }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .padding(32)
                .foregroundStyle(.white)
            }
        }
        .task(id: active) {
            if active, local == nil, wantsDownload { await download() }
        }
    }

    private var wantsDownload: Bool { asked || (file.size ?? .max) <= Self.automatic }

    private func download() async {
        guard progress == nil else { return }
        problem = nil
        progress = 0
        defer { progress = nil }
        do {
            local = try await PreviewFiles.local(for: file, api: session.api) { fraction in
                Task { @MainActor in if progress != nil { progress = fraction } }
            }
        } catch {
            if !Session.isCancel(error) { problem = session.explain(error) }
        }
    }
}

private struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Source { Source(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.url != url {
            context.coordinator.url = url
            controller.reloadData()
        }
    }

    final class Source: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}

/// The system share sheet, for a file on this device.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
