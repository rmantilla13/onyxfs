import AppKit
import SwiftUI
import WebKit

/// The workspace window with no toolbar of its own: the web's top bar is the
/// title bar. The page is drawn under a transparent title bar, the traffic
/// lights sit at the left of the web's bar, and the window keeps the rounded
/// corners and shadow of any other.
///
/// An empty unified toolbar is kept for one reason: it makes the title bar as
/// tall as the web's bar and centres the traffic lights in it. It has no
/// items, draws nothing and takes no clicks — unlike the toolbar SwiftUI
/// makes for a `.navigationTitle`, whose title view sits over the middle of
/// the bar and swallows every click there. So the window has no SwiftUI
/// title; `title(_:)` names it for Mission Control and the Window menu.
///
/// Dragging: the page covers the title bar, and a web view never moves its
/// window. So the page reports its bar and the controls on it (`bar` from
/// window.onyxMac), and a strip over the bar (`TitlebarStrip`) takes the
/// clicks that land between the controls — a drag moves the window, a double
/// click does what System Settings says a title bar's double click does.
@MainActor
enum WindowChrome {
    private static let toolbarID = "io.onyxfs.window"

    static func apply(to window: NSWindow) {
        window.styleMask.insert(.fullSizeContentView)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        if window.toolbar?.identifier != toolbarID {
            let toolbar = NSToolbar(identifier: toolbarID)
            toolbar.allowsUserCustomization = false
            toolbar.displayMode = .iconOnly
            window.toolbar = toolbar
        }
        if window.toolbarStyle != .unified { window.toolbarStyle = .unified }
    }

    /// What the page needs to lay its bar out as the title bar, in points
    /// from the window's top left: where the traffic lights end, and how tall
    /// the title bar is. In full screen there are no traffic lights to clear.
    struct Metrics: Equatable {
        var left: CGFloat
        var height: CGFloat
        var fullScreen: Bool

        var json: [String: Any] { ["left": Double(left), "height": Double(height), "fullScreen": fullScreen] }
    }

    static func metrics(of window: NSWindow) -> Metrics {
        let fullScreen = window.styleMask.contains(.fullScreen)
        // The bar is as tall as twice the traffic lights' centre: they sit in
        // its middle. (The content layout rect is no guide — an untitled
        // unified toolbar reports it lower than it draws.)
        var height: CGFloat = 52
        var left: CGFloat = 78
        if !fullScreen, let close = window.standardWindowButton(.closeButton), close.superview != nil,
           let zoom = window.standardWindowButton(.zoomButton) {
            height = 2 * (window.frame.height - close.convert(close.bounds, to: nil).midY)
            left = zoom.convert(zoom.bounds, to: nil).maxX + 10
        }
        return Metrics(left: fullScreen ? 0 : left.rounded(), height: max(40, height.rounded()), fullScreen: fullScreen)
    }

    /// What a double click on a title bar does, as System Settings › Desktop
    /// & Dock has it: zoom (the default), fill (zoom is the nearest a window
    /// can ask for), minimize, or nothing.
    static func titlebarDoubleClick(_ window: NSWindow) {
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default: window.performZoom(nil)
        }
    }
}

/// Finds the window a SwiftUI view is in, and follows it into and out of
/// full screen, which moves the traffic lights.
struct WindowReader: NSViewRepresentable {
    var changed: (NSWindow) -> Void

    func makeNSView(context: Context) -> ReaderView { ReaderView(changed: changed) }
    func updateNSView(_ view: ReaderView, context: Context) { view.changed = changed }

    final class ReaderView: NSView {
        var changed: (NSWindow) -> Void
        private var observers: [NSObjectProtocol] = []

        init(changed: @escaping (NSWindow) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError() }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { return }
            changed(window)
            let names: [NSNotification.Name] = [
                NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification,
                NSWindow.didResizeNotification, NSWindow.didChangeBackingPropertiesNotification,
            ]
            for name in names {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, let window = self.window else { return }
                        self.changed(window)
                    }
                })
            }
        }
    }
}

/// The workspace's web view, with the strip that lets its top bar move the
/// window.
final class OnyxWebView: WKWebView {
    /// The page's bar and the controls on it, in CSS pixels from the top
    /// left of the page, as the page last reported them. Nil until a page
    /// with a bar has said so; the strip then covers the bare title bar.
    var bar: CGRect? { didSet { needsLayout = true } }
    var holes: [CGRect] = [] { didSet { needsLayout = true } }
    var titlebarHeight: CGFloat = 52 { didSet { needsLayout = true } }

    private lazy var strip: TitlebarStrip = {
        let strip = TitlebarStrip()
        strip.web = self
        addSubview(strip)
        return strip
    }()

    /// Points per CSS pixel.
    var scale: CGFloat { pageZoom * magnification }

    override func layout() {
        super.layout()
        let height = bar.map { $0.maxY * scale } ?? titlebarHeight
        strip.frame = NSRect(x: 0, y: isFlipped ? 0 : bounds.height - height, width: bounds.width, height: height)
        strip.isHidden = window?.styleMask.contains(.fullScreen) ?? false
        // Kept above whatever WebKit adds to itself.
        if subviews.last !== strip { addSubview(strip, positioned: .above, relativeTo: nil) }
    }
}

/// The part of the page's bar that is not a control: a drag there moves the
/// window, and a click anywhere else in the bar goes to the page untouched
/// (the strip is not hit there at all).
final class TitlebarStrip: NSView {
    weak var web: OnyxWebView?

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, let web, let superview else { return nil }
        let local = convert(point, from: superview)
        guard bounds.contains(local) else { return nil }
        let css = CGPoint(x: local.x / web.scale, y: local.y / web.scale)
        if let bar = web.bar, !bar.contains(css) { return nil }
        return web.holes.contains { $0.contains(css) } ? nil : self
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            WindowChrome.titlebarDoubleClick(window)
        } else {
            window.performDrag(with: event)
        }
    }

    // Scrolling over the bar still scrolls the page.
    override func scrollWheel(with event: NSEvent) { web?.scrollWheel(with: event) }
}

/// A title bar to drag by, for the views with no web page under it (signing
/// in): the whole strip moves the window.
struct TitlebarDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ view: DragView, context: Context) {}

    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            if event.clickCount == 2 { WindowChrome.titlebarDoubleClick(window) } else { window.performDrag(with: event) }
        }
    }
}
