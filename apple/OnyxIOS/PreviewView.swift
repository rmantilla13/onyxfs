import AVKit
import OnyxKit
import QuickLook
import SwiftUI

/// A folder's files full screen, one at a time, swiped through: a picture
/// zooms, a video or a song plays (picture in picture, AirPlay), and a
/// document opens in Quick Look. A tap on a picture hides everything else.
///
/// Over it, the least that can be: a white rounded-square close, where it
/// is found at once over any picture, the file's name, and a glass pill to
/// share it — a copy, or a link — save it — to Photos or to Files, and a
/// heavy video's smaller streamable copy beside the original — or see its
/// details.
struct PreviewView: View {
    let files: [FileItem]
    @Environment(\.dismiss) private var dismiss
    @Environment(Session.self) private var session
    @Environment(\.verticalSizeClass) private var verticalSize
    @State private var current: String?
    @State private var chromeHidden = false
    @State private var inspecting: FileItem?
    @State private var linking: LinkSubject?
    /// Each video's streamable copy, once asked about (StreamableCopy.lookup).
    @State private var streamables: [String: StreamableCopy] = [:]

    init(files: [FileItem], startID: String) {
        self.files = files
        _current = State(initialValue: startID)
    }

    private var file: FileItem? { files.first { $0.id == current } }

    /// A phone on its side.
    private var landscape: Bool { verticalSize == .compact }

    /// A video on a phone on its side: the picture alone, the whole screen,
    /// black around it — no bars, no tray — with the player's own controls
    /// a tap away. Turned upright again, everything comes back.
    private var immersive: Bool { landscape && file?.kind == "video" }

    var body: some View {
        ScrollViewReader { pager in
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
            .background(Theme.page.ignoresSafeArea())
            // On its side, each page is the whole screen — the notch's side
            // too — so what it shows is centred on the screen, not on what
            // is left between insets.
            .ignoresSafeArea(edges: landscape ? .all : .bottom)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { _ in
                // A rotation changes every page's width, and a paging scroll
                // view keeps its offset in points: the page on screen would
                // be left part-way off it. Put it back, at once.
                guard let current else { return }
                var still = Transaction()
                still.disablesAnimations = true
                withTransaction(still) { pager.scrollTo(current, anchor: .center) }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if !chromeHidden, !immersive {
                chrome.transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !immersive { DownloadTray() }
        }
        .statusBarHidden(chromeHidden || immersive)
        .persistentSystemOverlays(immersive ? .hidden : .automatic)
        .animation(.easeInOut(duration: 0.2), value: chromeHidden)
        .animation(.easeInOut(duration: 0.25), value: immersive)
        .preferredColorScheme(.dark)
        .sheet(item: $inspecting) { FileInfoView(file: $0, place: nil) }
        .sheet(item: $linking) { ShareLinkSheet(subject: $0) }
        .task(id: current) { await lookUpStreamable() }
        // The pages beside this one: their links fetched now, so a swipe plays at once.
        .task(id: current) { await PreviewLinks.prefetch(around: current, in: files, api: session.api) }
    }

    private var chrome: some View {
        HStack(spacing: 12) {
            WhiteSquareButton(systemName: "xmark", label: "Close") { dismiss() }
            VStack(alignment: .leading, spacing: 1) {
                Text(file?.name ?? "")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(position)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 6)
            actions
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }

    /// "2 of 14 · 4.2 MB".
    private var position: String {
        var parts: [String] = []
        if let index = files.firstIndex(where: { $0.id == current }), files.count > 1 {
            parts.append("\(index + 1) of \(files.count)")
        }
        if let file { parts.append(FileFormat.size(file.size)) }
        return parts.joined(separator: " · ")
    }

    /// Share, Save, Info: one glass pill.
    ///
    /// Share is a menu where the file may be shared by link — Send a Copy
    /// (the file itself, through the share sheet) or Share Link… — rather
    /// than a fourth button: two ways of sharing one file under the one
    /// symbol, and a pill that leaves the file's name its room on a phone.
    /// Where no link is theirs to make or manage it stays the one tap it
    /// always was, since a menu of one would only be in the way.
    private var actions: some View {
        GlassGroup(spacing: 4) {
            HStack(spacing: 0) {
                if let file, session.mayLink(file) {
                    Menu {
                        Button { save(to: .share) } label: { Label("Send a Copy", systemImage: "doc.on.doc") }
                        Button { linking = .file(file) } label: { Label("Share Link…", systemImage: "link") }
                    } label: {
                        pillIcon("square.and.arrow.up")
                    }
                    .accessibilityLabel("Share")
                } else {
                    pillButton("square.and.arrow.up", label: "Send a Copy") { save(to: .share) }
                }
                if let file {
                    Menu {
                        SaveMenuContent(file: file, streamable: streamables[file.id])
                    } label: {
                        pillIcon("arrow.down.to.line")
                    }
                    .accessibilityLabel("Save")
                }
                pillButton("info.circle", label: "Info") { inspecting = file }
            }
            .padding(.horizontal, 4)
            .glassSurface(Capsule(), interactive: true)
        }
    }

    private func pillButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { pillIcon(symbol) }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
    }

    private func pillIcon(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(.primary)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }

    /// The file itself goes to the share sheet, so it is downloaded first:
    /// the tray shows it coming, and the sheet opens once it is here.
    private func save(to destination: SaveDestination) {
        guard let file else { return }
        DownloadCenter.shared.save([file], to: destination, api: session.api)
    }

    /// Whether the video on screen has a smaller copy to offer beside it.
    private func lookUpStreamable() async {
        guard let file, streamables[file.id] == nil, StreamableCopy.mayHave(file) else { return }
        if let copy = await StreamableCopy.lookup(file, api: session.api), !Task.isCancelled {
            streamables[file.id] = copy
        }
    }
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
        case "video":
            MediaPage(file: file, active: active)
        case "audio":
            SoundPage(file: file, active: active)
        default:
            DocumentPage(file: file, active: active)
        }
    }
}

// MARK: - Pictures

/// The picture at up to 2400 pixels — its preview, made at upload — which
/// fills any phone or iPad screen; the original only for a picture that has
/// none, and then decoded down to the screen's size, off the main actor
/// (Originals), and not at all once the page has been swiped away or the
/// preview closed.
///
/// Until it comes, the tile's picture, stretched; or, when that is not in
/// memory either, the placeholder from the file's row (PlaceholderImages),
/// soft already — asked for on its own, so it never holds up the preview.
private struct ImagePage: View {
    let file: FileItem
    @Environment(Session.self) private var session
    @State private var image: UIImage?
    @State private var failed = false
    @State private var still: UIImage?

    init(file: FileItem) {
        self.file = file
        _still = State(initialValue: PlaceholderImages.shared.cached(file))
    }

    var body: some View {
        ZStack {
            if let image {
                ZoomableImage(image: image)
            } else if let small = file.thumbnail(.card).flatMap({ ThumbnailStore.shared.cached($0) }) {
                // The tile's picture, stretched, until the sharp one comes.
                Image(uiImage: small).resizable().scaledToFit().blur(radius: 6)
                ProgressView().tint(.white)
            } else if let still, !failed {
                Image(uiImage: still).resizable().scaledToFit().accessibilityHidden(true)
                ProgressView().tint(.white)
            } else if failed {
                KindSymbol(file: file)
            } else {
                ProgressView().tint(.white)
            }
        }
        .task(id: file.id) { await load() }
        .task(id: file.id) {
            guard still == nil, image == nil, let tiny = await PlaceholderImages.shared.image(for: file) else { return }
            if !Task.isCancelled, image == nil { still = tiny }
        }
    }

    private func load() async {
        if let poster = file.posterSource, let picture = await ThumbnailStore.shared.image(poster) {
            image = picture
            return
        }
        // No preview: the original, if it is small enough to be worth it,
        // kept through any trim of the previews until it is decoded.
        guard (file.size ?? .max) <= 60 << 20 else {
            failed = true
            return
        }
        PreviewFiles.hold(file)
        defer { PreviewFiles.release(file) }
        guard let url = try? await PreviewFiles.local(for: file, api: session.api),
              let picture = await Originals.shared.picture(at: url, maxPixels: Self.screenPixels) else {
            if !Task.isCancelled { failed = true }
            return
        }
        // Swiped away while it was decoded: not kept by a page off screen.
        guard !Task.isCancelled else { return }
        image = picture
    }

    /// The longest side of the screen, in pixels: an original decoded any
    /// larger would only be scaled down to be seen.
    private static var screenPixels: Int {
        let screen = UIApplication.shared.connectedScenes.lazy.compactMap { ($0 as? UIWindowScene)?.screen }.first
        guard let size = screen?.nativeBounds.size else { return 2400 }
        return Int(max(size.width, size.height))
    }
}

/// Originals decoded for pictures that have no preview: off the main actor,
/// and one at a time — a big PNG is decoded whole before it is scaled, and a
/// few at once on a quick swipe would be hundreds of megabytes. One whose
/// page has gone before its turn comes is never decoded; one under way when
/// it goes is finished, ImageIO having no way to stop, and dropped.
private actor Originals {
    static let shared = Originals()

    func picture(at url: URL, maxPixels: Int) -> UIImage? {
        guard !Task.isCancelled else { return nil }
        return ThumbnailStore.decode(contentsOf: url, maxPixels: maxPixels)
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

/// Streams from storage, and starts at once from a link that is here
/// already (PreviewLinks): one kept from before, or fetched while the page
/// beside it was on screen, or — for a file with no streamable copy to
/// prefer — the listing's own, which is good for six hours, not one. The
/// server is asked only when none of those will do. A link storage refuses
/// gives way to a fresh one, and play goes on from where it was. Paged away,
/// the player goes, and with it its buffers.
private struct MediaPage: View {
    let file: FileItem
    let active: Bool
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
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .symbolRenderingMode(.multicolor)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .glassSurface(Capsule())
                    .padding(24)
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
            await play()
        }
    }

    /// Plays until the page goes. A link that storage refuses — it expired,
    /// paused past its hours, or the file moved — gives way to a fresh one;
    /// a fresh one refused at once is the player's to show.
    private func play() async {
        var link = await PreviewLinks.ready(for: file)
        var fetched: Date?
        // The streamable copy for a video big enough to have one by its size
        // (StreamableCopy.mayHave). A smaller one has a copy only because
        // some browser will not play how it is encoded — HEVC, HDR — which
        // this iPhone plays as it is, at its own size and in its own
        // colours: the original, then, and the copy only if that fails.
        var copy = StreamableCopy.mayHave(file)
        while !Task.isCancelled {
            if link == nil {
                do {
                    link = try await PreviewLinks.link(for: file, api: session.api)
                    fetched = Date()
                } catch {
                    if !Session.isCancel(error) { problem = session.explain(error) }
                    return
                }
            }
            guard let current = link, !Task.isCancelled else { return }
            // The streamable copy when there is one: an action camera's 4K
            // master runs at 60–120 Mbps, more than a phone's connection
            // carries, and stalls; its 1080p copy does not.
            let item = AVPlayerItem(url: copy ? current.playable : current.url)
            if let player {
                let at = player.currentTime()
                player.replaceCurrentItem(with: item)
                if at.seconds > 0, await PreviewLinks.readyToPlay(item) { await player.seek(to: at) }
                player.play()
            } else {
                let next = AVPlayer(playerItem: item)
                next.allowsExternalPlayback = true
                player = next
                next.play()
            }
            if current.proxyUrl == nil { PreviewLinks.askForCopy(of: file, api: session.api) }
            guard await PreviewLinks.failure(of: item) != nil, !Task.isCancelled else { return }
            // An original this iPhone will not decode after all: its copy,
            // from where it was.
            if !copy, current.proxyUrl != nil {
                copy = true
                continue
            }
            if let fetched, Date().timeIntervalSince(fetched) < 60 { return }
            await PreviewLinks.refused(file)
            link = nil
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
                        .frame(width: 112, height: 112)
                        .background {
                            RoundedRectangle(cornerRadius: 28, style: .continuous)
                                .fill(Theme.frost)
                                .overlay {
                                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                                        .strokeBorder(Theme.edge, lineWidth: 0.5)
                                }
                        }
                        .padding(.bottom, 10)
                    Text(file.name)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                    Text(FileFormat.size(file.size))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let progress {
                        GradientProgressBar(fraction: progress)
                            .frame(maxWidth: 220)
                            .padding(.top, 6)
                    } else if let problem {
                        Text(problem).font(.footnote).foregroundStyle(.orange).multilineTextAlignment(.center)
                        Button("Try Again") { asked = true; Task { await download() } }
                            .glassButtonStyle()
                    } else if !wantsDownload {
                        Button("Download to Preview") { asked = true; Task { await download() } }
                            .buttonStyle(BrandButtonStyle())
                            .padding(.top, 6)
                    }
                }
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background { AuraBackground() }
            }
        }
        .task(id: active) {
            if active, local == nil, wantsDownload { await download() }
        }
        // Quick Look reads the file as long as it shows it: no trim of the
        // previews takes it meanwhile, however long ago it was opened.
        .onAppear { PreviewFiles.hold(file) }
        .onDisappear { PreviewFiles.release(file) }
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
