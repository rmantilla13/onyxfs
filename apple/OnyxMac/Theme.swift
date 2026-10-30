import AppKit
import SwiftUI

// MARK: - The page's scheme, handed to the window

/// What the page wears, as it last said (WebController's bridge: the page
/// posts its scheme and its own paper colour when either changes, and not
/// otherwise). The window takes it — traffic lights, sheets, the activity
/// bar, the colour under the page while it loads and past its ends — so the
/// window is one scheme with the page, whatever the Mac is set to. The
/// colour is the page's own `--paper`, so a rebrand on the web recolours the
/// window with it.
///
/// Kept across launches: the next window opens in the page's colours before
/// the page has loaded, instead of the system's grey.
struct PageTheme: Equatable {
    var dark: Bool
    var paper: NSColor?

    /// Make `window` wear it: its appearance, and the colour behind the
    /// transparent web view. Only what differs is set: this is asked again
    /// each time the window is resized (WebController.windowChanged).
    @MainActor
    func apply(to window: NSWindow) {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        if window.appearance?.name != appearance?.name { window.appearance = appearance }
        if let paper, window.backgroundColor != paper { window.backgroundColor = paper }
    }
}

@MainActor
enum PageThemeStore {
    private static let darkKey = "pageThemeDark"
    private static let paperKey = "pageThemePaper"

    static var last: PageTheme? = read() {
        didSet { write(last) }
    }

    private static func read() -> PageTheme? {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: darkKey) != nil else { return nil }
        return PageTheme(dark: defaults.bool(forKey: darkKey),
                         paper: defaults.string(forKey: paperKey).flatMap(NSColor.init(css:)))
    }

    private static func write(_ theme: PageTheme?) {
        let defaults = UserDefaults.standard
        guard let theme else {
            defaults.removeObject(forKey: darkKey)
            defaults.removeObject(forKey: paperKey)
            return
        }
        defaults.set(theme.dark, forKey: darkKey)
        defaults.set(theme.paper?.cssHex, forKey: paperKey)
    }
}

// MARK: - Colours

/// The brand's colours for the Mac's own surfaces — the sign-in window, the
/// menu bar's panel, the activity bar — named as OnyxiOS/Theme.swift names
/// them, so a view asks for `Theme.auraBlue` and never writes a hex value.
///
/// TODO: these stand in until scripts/gen-theme.mjs generates BrandData.swift
/// from lib/brand.js, as the iPhone's colorsets are meant to be. Until then
/// the brand's hues resolve to the person's system accent and the surfaces to
/// the system's — nothing here names a colour the web could rebrand — and the
/// page's paper comes from the page itself (PageTheme). Switches, checkboxes
/// and selection keep the system accent either way: that is the Mac's.
enum Theme {
    /// The page: the colour the page paints, when it has said; the window's
    /// own until then.
    @MainActor
    static func paper(for scheme: ColorScheme) -> Color {
        if let last = PageThemeStore.last, last.dark == (scheme == .dark), let paper = last.paper {
            return Color(nsColor: paper)
        }
        return Color(nsColor: .windowBackgroundColor)
    }
    /// A card on it, and glass made solid.
    static var surface: Color { Color(nsColor: .controlBackgroundColor) }
    /// Hairlines.
    static var line: Color { Color(nsColor: .separatorColor) }
    /// Links, progress, the one lit action on a surface.
    static var accent: Color { Color(nsColor: .controlAccentColor) }
    /// The aura's three hues, for light rather than paint (--aura-a, -b, -c).
    static var auraBlue: Color { accent }
    static var auraMagenta: Color { accent }
    static var auraCyan: Color { accent }
    /// Something to look at; something wrong; all well.
    static var warning: Color { Color(nsColor: .systemOrange) }
    static var danger: Color { Color(nsColor: .systemRed) }
    static var success: Color { Color(nsColor: .systemGreen) }
}

// MARK: - Chrome

/// One pixel, whatever the screen's scale: the line between two surfaces.
struct Hairline: View {
    @Environment(\.displayScale) private var scale

    var body: some View {
        Rectangle().fill(Theme.line).frame(height: 1 / scale)
    }
}

extension View {
    /// An inset group in the menu bar's panel — the activity tiles, the
    /// drive list, a note — as the system's own extras set theirs: one
    /// treatment, continuous corners, the system's quaternary fill, which is
    /// vibrant on the panel's material and solid without it.
    func panelGroup() -> some View {
        background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.quaternary.opacity(0.35)))
    }

    /// The one lit action on a surface: the system's prominent button, and
    /// Liquid Glass where the system has it.
    func prominent() -> some View { modifier(Prominent()) }
}

private struct Prominent: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26, *) {
            content.buttonStyle(.glassProminent)
        } else {
            content.buttonStyle(.borderedProminent)
        }
    }
}

/// The panel's material: the vibrancy the system's own menu bar extras have.
/// The WindowServer composites it, so nothing of the panel redraws for it —
/// not once a second as the graphs move — and with Reduce Transparency it
/// is solid, as the system makes every material.
struct VibrantPanel: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .popover
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

// MARK: - The aura

/// The web's sign-in page behind the Mac's: the page's paper lit at its top
/// corners by the brand's glows, blue from the left, magenta from the right,
/// a faint cyan at the foot (body::before, and OnyxiOS's AuraBackground).
/// Drawn once as gradients — no blur, no timer, nothing moves — and a flat
/// surface with Reduce Transparency, as the web's reduced-transparency rule
/// leaves it.
struct AuraBackground: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            // The web's --aura-strength and --aura-soft, per scheme: the
            // light page takes less.
            let strong = scheme == .dark ? 0.26 : 0.20
            let soft = scheme == .dark ? 0.15 : 0.12
            ZStack {
                Theme.paper(for: scheme)
                if !reduceTransparency {
                    glow(Theme.auraBlue, strong, radii: CGSize(width: 0.60 * w, height: 0.48 * h),
                         at: CGPoint(x: 0.06 * w, y: -0.08 * h), fade: 0.70)
                    glow(Theme.auraMagenta, strong, radii: CGSize(width: 0.52 * w, height: 0.44 * h),
                         at: CGPoint(x: 0.98 * w, y: -0.06 * h), fade: 0.70)
                    glow(Theme.auraCyan, soft, radii: CGSize(width: 0.70 * w, height: 0.42 * h),
                         at: CGPoint(x: 0.55 * w, y: 1.12 * h), fade: 0.72)
                }
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }

    /// CSS's radial-gradient(rx ry at x y, colour strength, transparent fade).
    private func glow(_ color: Color, _ strength: Double, radii: CGSize, at center: CGPoint, fade: CGFloat) -> some View {
        EllipticalGradient(colors: [color.opacity(strength), color.opacity(0)],
                           center: .center, startRadiusFraction: 0, endRadiusFraction: fade / 2)
            .frame(width: radii.width * 2, height: radii.height * 2)
            .position(center)
    }
}

/// The app's icon over a halo of the brand's second hue: the mark as the
/// iPhone's sign-in shows it. The halo is a gradient drawn once, not a blur.
struct AppMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            EllipticalGradient(colors: [Theme.auraMagenta.opacity(0.35), .clear], center: .center)
                .frame(width: size * 1.5, height: size * 1.5)
            Image(nsImage: NSApp.applicationIconImage)
                .resizable().interpolation(.high)
                .frame(width: size, height: size)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - CSS colours

extension NSColor {
    /// A colour as a page computes one — `rgb(12, 13, 15)`, `rgba(…, 0.5)`,
    /// `rgb(12 13 15 / 50%)`, `color(srgb 0.05 0.05 0.06)` or `#0C0D0F` —
    /// as an sRGB colour. Nil for anything else, and for a transparent one:
    /// a page that has not painted yet computes `rgba(0, 0, 0, 0)`.
    convenience init?(css: String) {
        let text = css.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var r = 0.0, g = 0.0, b = 0.0, a = 1.0
        if text.hasPrefix("#") {
            let hex = text.dropFirst()
            guard let v = UInt64(hex, radix: 16) else { return nil }
            switch hex.count {
            case 3:
                r = Double((v >> 8) & 0xF) / 15; g = Double((v >> 4) & 0xF) / 15; b = Double(v & 0xF) / 15
            case 6:
                r = Double((v >> 16) & 0xFF) / 255; g = Double((v >> 8) & 0xFF) / 255; b = Double(v & 0xFF) / 255
            case 8:
                r = Double((v >> 24) & 0xFF) / 255; g = Double((v >> 16) & 0xFF) / 255
                b = Double((v >> 8) & 0xFF) / 255; a = Double(v & 0xFF) / 255
            default:
                return nil
            }
        } else if let open = text.firstIndex(of: "("), text.hasSuffix(")") {
            let head = text[..<open]
            let inner = String(text[text.index(after: open)..<text.index(before: text.endIndex)])
            var parts = inner.replacingOccurrences(of: ",", with: " ").replacingOccurrences(of: "/", with: " ")
                .split(separator: " ").map(String.init)
            let unit: Double
            if head == "color" {
                guard parts.first == "srgb" else { return nil }
                parts.removeFirst()
                unit = 1
            } else if head == "rgb" || head == "rgba" {
                unit = 255
            } else {
                return nil
            }
            guard parts.count == 3 || parts.count == 4 else { return nil }
            func channel(_ p: String, of scale: Double) -> Double? {
                p.hasSuffix("%") ? Double(p.dropLast()).map { $0 / 100 } : Double(p).map { $0 / scale }
            }
            guard let rr = channel(parts[0], of: unit), let gg = channel(parts[1], of: unit),
                  let bb = channel(parts[2], of: unit) else { return nil }
            r = rr; g = gg; b = bb
            if parts.count == 4, let aa = channel(parts[3], of: 1) { a = aa }
        } else {
            return nil
        }
        guard a > 0 else { return nil }
        self.init(srgbRed: min(max(r, 0), 1), green: min(max(g, 0), 1), blue: min(max(b, 0), 1), alpha: 1)
    }

    /// `#RRGGBB`, for keeping a colour in UserDefaults.
    var cssHex: String? {
        guard let c = usingColorSpace(.sRGB) else { return nil }
        let byte = { (v: CGFloat) in Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(c.redComponent), byte(c.greenComponent), byte(c.blueComponent))
    }
}
