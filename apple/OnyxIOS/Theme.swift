import OnyxKit
import SwiftUI

/// Onyx's look on iPhone and iPad, as the web has it (app/globals.css): a
/// near-black page lit at its top corners by the brand's glows, frosted
/// glass for what floats over it, and the brand gradient — electric blue
/// into neon magenta — on what is primary, chosen or moving.
///
/// Views take their colours from here, and these from the asset catalog,
/// never a hex value: the web is white-label, and so the brand's colours
/// live where a rebrand changes them in one place. Their type, corners,
/// spacing and shade come from here too — the ladders the web's --t-*,
/// --radius-*, --s* and --shadow-* tokens are — so a size is a step on one
/// rather than a number typed where it is used. The glass is Liquid Glass
/// from iOS 26; before it, a material with the web's hairline edge and
/// sheen (its --glass-* tokens); with Reduce Transparency, solid.
enum Theme {
    // MARK: - Colours

    /// The page: the brand's near-black (--paper, dark).
    static var paper: Color { Color("Paper") }
    /// A card on it, and glass made solid (--surface).
    static var surface: Color { Color("Surface") }
    /// Hairlines on a solid surface (--line).
    static var line: Color { Color("Line") }
    /// The aura's three hues at full strength, for light rather than paint
    /// (--aura-a, -b, -c).
    static var auraBlue: Color { Color("AuraBlue") }
    static var auraMagenta: Color { Color("AuraMagenta") }
    static var auraCyan: Color { Color("AuraCyan") }
    /// The two deepened far enough to carry a label (--aura-a-deep, -b-deep),
    /// and that label (--on-aura).
    static var auraBlueDeep: Color { Color("AuraBlueDeep") }
    static var auraMagentaDeep: Color { Color("AuraMagentaDeep") }
    static var onAura: Color { Color("OnAura") }
    /// Secondary text and marks (--muted): the system's secondary label,
    /// which is what the app's second lines already are.
    static var muted: Color { .secondary }

    // MARK: - Glass (globals.css --glass-*, dark scheme)

    /// The light across a surface's top (--glass-sheen).
    static let sheen = Color.white.opacity(0.07)
    /// Its hairline (--glass-edge).
    static let edge = Color.white.opacity(0.14)
    /// Its lit top edge (--glass-hi).
    static let highlight = Color.white.opacity(0.13)
    /// The shade under something that floats (--glass-drop).
    static let drop = Color.black.opacity(0.45)
    /// A frosted row, or a well, where a material would be too much.
    static let frost = Color.white.opacity(0.06)

    // MARK: - Gradients

    /// Primary actions and what is chosen: 120° from the deep blue to the
    /// deep magenta (.btn-primary).
    static var brand: LinearGradient {
        LinearGradient(colors: [auraBlueDeep, auraMagentaDeep],
                       startPoint: UnitPoint(x: 0.07, y: 0.25), endPoint: UnitPoint(x: 0.93, y: 0.75))
    }

    /// Meters and progress: left to right, blue into magenta (.meter-fill).
    static var meter: LinearGradient {
        LinearGradient(colors: [auraBlue, auraMagenta], startPoint: .leading, endPoint: .trailing)
    }

    /// Where you are, and what you picked: a tint leaning from blue to
    /// magenta (.filelist-row.is-selected).
    static var selection: LinearGradient {
        LinearGradient(colors: [Color.accentColor.opacity(0.18), auraMagenta.opacity(0.11)],
                       startPoint: .leading, endPoint: .trailing)
    }

    // MARK: - The page

    /// The page is the paper (--paper), as the launch screen and the web's
    /// body are — not pure black, which agreed with neither, nor with the
    /// contrast DriveTint works out against the paper.
    static var page: Color { paper }
    /// A card on it, and a tile with no picture: near-black grey.
    static var card: Color { surface.opacity(0.82) }
    /// Footage is looked at on black whatever the scheme (the web's
    /// --stage): a preview's ground, never a page's.
    static let stage = Color.black
    /// The shade a badge sits on over a picture (.filecard-badge): dark
    /// enough for a white label on any picture, in either scheme.
    static let scrim = Color.black.opacity(0.55)
    /// A check not yet chosen, over a picture (SelectionCheck): a lighter
    /// shade than the scrim, so the picture still reads through it.
    static let dim = Color.black.opacity(0.28)
    /// The lit rim of a badge over a picture — a check, a review dot — so it
    /// stands on a light picture and on a dark one (the web's --on-stage).
    static let rim = Color.white.opacity(0.9)

    // MARK: - Shape

    /// Corners, in steps, as the web's --radius ladder: a control, a chip,
    /// a row's picture, a tile's, a card. One inside another takes the
    /// step below, so the corners stay concentric.
    /// A small control, a note (--radius-md).
    static let controlCorner: CGFloat = 10
    /// A chip, a badge's tile (--radius-lg).
    static let chipCorner: CGFloat = 12
    /// A row's picture.
    static let rowCorner: CGFloat = 14
    /// A tile's picture: big, continuous corners.
    static let tileCorner: CGFloat = 24
    /// A card: the Home's cards, the download tray, a sheet's header.
    static let cardCorner: CGFloat = 28
    /// The edge drawn round a picture or a card: half a point, a pixel on
    /// every screen that runs this (the web's 1px).
    static let hairline: CGFloat = 0.5

    /// Spacing, in the web's steps (--s1…--s6) and the screen's gutter. A
    /// nudge between steps — 14 between rows, 3 under a name — is optical,
    /// and typed where it is used.
    enum Space {
        static let s1: CGFloat = 4
        static let s2: CGFloat = 8
        static let s3: CGFloat = 12
        static let s4: CGFloat = 16
        static let s5: CGFloat = 24
        static let s6: CGFloat = 32
        /// The page's side margin on a phone.
        static let gutter: CGFloat = 20
    }

    // MARK: - Type

    /// The type scale (the web's --t-* ladder): every text on a screen is
    /// one of these, so a tile's name and a row's, a headline and a
    /// section's, agree across Home, Browse and Info. System text styles,
    /// so Dynamic Type scales each; the headline through @ScaledMetric.
    enum Text {
        /// The page's headline (EditorialTitle, Home's greeting): bold, set
        /// tight, 40pt before Dynamic Type. `display(at:)` takes the size
        /// Dynamic Type has scaled `displaySize` to.
        static let displaySize: CGFloat = 40
        static func display(at size: CGFloat) -> Font { .system(size: size, weight: .bold) }
        static func displayTracking(at size: CGFloat) -> CGFloat { -size * 0.025 }
        /// A section's name ("Recent Files").
        static let title: Font = .title2.weight(.bold)
        static let titleTracking: CGFloat = -0.4
        /// A card's name: a drive's.
        static let card: Font = .title3.weight(.bold)
        /// A card's heading, a sheet's: the system's headline.
        static let section: Font = .headline
        /// A row's name.
        static let row: Font = .body.weight(.medium)
        /// A tile's name, under its picture.
        static let tile: Font = .subheadline.weight(.medium)
        /// A row's second line: its size, when it came.
        static let detail: Font = .subheadline
        /// A tile's second line, a card's count.
        static let meta: Font = .footnote
        /// A number that changes — a size, a count, a time — in digits of
        /// one width, so it does not jostle as it does.
        static let numeric: Font = .subheadline.monospacedDigit()
    }

    // MARK: - Elevation

    /// How far something floats, as the shade under it (the web's
    /// --shadow-1/-2/-3): a badge just off its picture, a bar or a button
    /// over the page, a tray or a card over everything. Always through
    /// `elevation(_:)`.
    struct Elevation {
        let radius: CGFloat
        let y: CGFloat
        static let low = Elevation(radius: 2, y: 1)
        static let raised = Elevation(radius: 10, y: 4)
        static let floating = Elevation(radius: 18, y: 8)
    }

    // MARK: - Motion

    /// How things move, in three lengths — the web's --dur-1/--dur-2 and its
    /// ease — so every cue is one of these and none is typed by hand. Always
    /// through `motion(_:)`, which is where Reduce Motion turns them all off.
    enum Motion {
        /// A press, a label swapping: felt, not watched.
        case quick
        /// Something arriving or leaving — a bar, a chip, a ring on a tile.
        case arrive
        /// A sheet or a tray opening: more travel, a little more give.
        case sheet

        var animation: Animation {
            switch self {
            case .quick: .easeOut(duration: 0.12)
            case .arrive: .spring(duration: 0.3, bounce: 0.15)
            case .sheet: .spring(duration: 0.35, bounce: 0.18)
            }
        }
    }

    /// The animation to run — or none, with Reduce Motion on: the state
    /// still changes, it just does not travel.
    @MainActor static func motion(_ motion: Motion) -> Animation? {
        Self.motion(motion.animation)
    }

    @MainActor static func motion(_ animation: Animation) -> Animation? {
        UIAccessibility.isReduceMotionEnabled ? nil : animation
    }

    // MARK: - Which glass

    /// Liquid Glass, where the system has it.
    static var liquidGlass: Bool {
        if #available(iOS 26, *) { return !legacyGlass }
        return false
    }

    /// Debug builds launched with `-OnyxLegacyGlass YES` draw the iOS 18–25
    /// glass on any system, so it can be looked at on a simulator that only
    /// runs the newest iOS.
    static let legacyGlass: Bool = {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "OnyxLegacyGlass")
        #else
        return false
        #endif
    }()
}

// MARK: - The page

/// Near-black, lit by soft glows of the brand's hues: the web's page aura
/// (body::before) — blue from the top left, magenta from the top right,
/// and a faint cyan at the foot — or, behind a sheet, a dialog's two
/// softer ones (dialog.palette) over a card.
///
/// Where an auraCanvas is set — Browse side by side, on an iPad or an open
/// iPhone Duo — a page is its part of one aura lit across it, so the list
/// and the folder meet without a seam.
struct AuraBackground: View {
    enum Style {
        /// The page: near-black, three glows.
        case page
        /// A dialog: the card, two soft glows at its top.
        case sheet
        /// A dialog's two glows alone, over a sheet's own glass.
        case glow
    }
    var style: Style = .page
    @Environment(\.auraCanvas) private var canvas

    var body: some View {
        GeometryReader { geo in
            let frame = geo.frame(in: .global)
            // A page partly outside it — a pager's next page, mid-swipe —
            // is lit in its own frame, as everything else is.
            let whole = canvas.flatMap { $0.insetBy(dx: -1, dy: -1).contains(frame) ? $0 : nil }
            let lit = style == .page ? whole ?? frame : frame
            let w = lit.width, h = lit.height
            ZStack {
                switch style {
                case .page:
                    Theme.page
                    Group {
                        glow(Theme.auraBlue, 0.26, radii: CGSize(width: 0.60 * w, height: 0.48 * h),
                             at: CGPoint(x: 0.06 * w, y: -0.08 * h), fade: 0.70)
                        glow(Theme.auraMagenta, 0.26, radii: CGSize(width: 0.52 * w, height: 0.44 * h),
                             at: CGPoint(x: 0.98 * w, y: -0.06 * h), fade: 0.70)
                        glow(Theme.auraCyan, 0.15, radii: CGSize(width: 0.70 * w, height: 0.42 * h),
                             at: CGPoint(x: 0.55 * w, y: 1.12 * h), fade: 0.72)
                    }
                    // Lit across the window, seen from where this page is.
                    .offset(x: lit.minX - frame.minX, y: lit.minY - frame.minY)
                case .sheet, .glow:
                    if style == .sheet { Theme.surface }
                    glow(Theme.auraBlue, 0.15, radii: CGSize(width: 0.90 * w, height: 0.60 * min(h, 700)),
                         at: CGPoint(x: 0.12 * w, y: -0.20 * min(h, 700)), fade: 0.64)
                    glow(Theme.auraMagenta, 0.15, radii: CGSize(width: 0.80 * w, height: 0.60 * min(h, 700)),
                         at: CGPoint(x: 1.00 * w, y: -0.20 * min(h, 700)), fade: 0.62)
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

extension EnvironmentValues {
    /// The area, in global coordinates, whose one aura every page in it
    /// shows its part of. Unset, a page is lit in its own frame.
    @Entry var auraCanvas: CGRect? = nil
}

extension View {
    /// The aura behind this screen. A list or a form lets it through.
    func auraBackground(_ style: AuraBackground.Style = .page) -> some View {
        scrollContentBackground(.hidden)
            .background { AuraBackground(style: style) }
    }

    /// A row of a list or a form on the aura: frosted, or solid with Reduce
    /// Transparency.
    func glassRow(selected: Bool = false) -> some View {
        listRowBackground(GlassRowBackground(selected: selected))
    }

    /// A sheet's background: on iOS 26 the system's own glass, with a
    /// dialog's two glows caught in it; before it, the card they light
    /// (dialog.palette). Solid with Reduce Transparency either way.
    func sheetBackground() -> some View {
        scrollContentBackground(.hidden)
            .modifier(SheetBackground())
    }
}

// MARK: - Symbols

extension View {
    /// The symbol bounces when `value` changes — a star starred, a check
    /// checked. Not with Reduce Motion: symbol effects do not turn
    /// themselves off, so this does.
    func bounce<V: Equatable>(on value: V) -> some View {
        modifier(SymbolBounce(value: value))
    }

    /// One symbol becoming the next — play into pause — rather than the
    /// next in its place. Plain with Reduce Motion.
    func replaceSymbol() -> some View {
        modifier(SymbolReplace())
    }
}

// MARK: - Type, shade, edges

extension View {
    /// Set as the page's headline, at the size Dynamic Type gave it.
    func displayText(size: CGFloat) -> some View {
        font(Theme.Text.display(at: size))
            .tracking(Theme.Text.displayTracking(at: size))
    }

    /// The shade under this view at `depth`: --glass-drop's black, or a
    /// colour of the view's own (a drive's card, in its tint).
    func elevation(_ depth: Theme.Elevation, color: Color = Theme.drop) -> some View {
        shadow(color: color, radius: depth.radius, y: depth.y)
    }

    /// Under a bar on iOS 26, the content fades into it as it scrolls
    /// rather than meeting a hard line: the system's scroll-edge effect,
    /// soft. Nothing before 26, which has no such edge.
    @ViewBuilder func softScrollEdge() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }
}

private struct SymbolBounce<V: Equatable>: ViewModifier {
    let value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.symbolEffect(.bounce, value: value)
        }
    }
}

private struct SymbolReplace: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
    }
}

private struct SheetBackground: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.presentationBackground(Theme.surface)
        } else if Theme.liquidGlass {
            content.background { AuraBackground(style: .glow) }
        } else {
            content.presentationBackground { AuraBackground(style: .sheet) }
        }
    }
}

private struct GlassRowBackground: View {
    var selected = false
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        ZStack {
            // Solid with Reduce Transparency, and with Increase Contrast: a
            // frost the page shows through is the one thing it asks not for.
            if reduceTransparency || contrast == .increased { Theme.surface } else { Theme.frost }
            if selected { Rectangle().fill(Theme.selection) }
        }
    }
}

// MARK: - Glass

extension View {
    /// Glass behind this view, in `shape`: Liquid Glass on iOS 26; before it
    /// a material with a hairline edge lit at the top and a sheen, as the
    /// web draws its glass; a solid surface with Reduce Transparency.
    /// `interactive` glass answers a touch, as a control's does.
    func glassSurface<S: InsettableShape>(_ shape: S, interactive: Bool = false) -> some View {
        modifier(GlassSurface(shape: shape, interactive: interactive))
    }
}

private struct GlassSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    let interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background { SolidGlass(shape: shape) }
        } else if Theme.liquidGlass {
            if #available(iOS 26, *) {
                // Liquid Glass answers Increase Contrast on its own.
                content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
            } else {
                content.background { MaterialGlass(shape: shape) }
            }
        } else if contrast == .increased {
            // The glass we draw ourselves does not: solid, its edge drawn.
            content.background { SolidGlass(shape: shape) }
        } else {
            content.background { MaterialGlass(shape: shape) }
        }
    }
}

/// The web's glass before Liquid Glass: frost the page shows through, a
/// sheen across the top third, a hairline edge brighter where the light
/// catches it.
private struct MaterialGlass<S: InsettableShape>: View {
    let shape: S

    var body: some View {
        shape.fill(.ultraThinMaterial)
            .overlay {
                shape.fill(LinearGradient(colors: [Theme.sheen, .clear],
                                          startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.55)))
            }
            .overlay {
                shape.strokeBorder(LinearGradient(colors: [Theme.highlight.opacity(1.6), Theme.edge.opacity(0.55)],
                                                  startPoint: .top, endPoint: .bottom), lineWidth: 1)
            }
    }
}

/// Glass, with Reduce Transparency: a surface you cannot see through.
private struct SolidGlass<S: InsettableShape>: View {
    let shape: S

    var body: some View {
        shape.fill(Theme.surface)
            .overlay { shape.strokeBorder(Theme.line, lineWidth: 1) }
    }
}

/// A group of glass shapes that blend into each other as they move, on
/// iOS 26; a plain stack of them before.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: Content

    var body: some View {
        if Theme.liquidGlass, #available(iOS 26, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

// MARK: - Buttons

/// The primary action: the brand gradient, glazed — a sheen that stops
/// above the label, a lit rim, and the magenta's glow beneath
/// (.btn-primary). The label is --on-aura, which the deepened stops carry
/// at AA.
struct BrandButtonStyle: ButtonStyle {
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        BrandButton(configuration: configuration, fullWidth: fullWidth)
    }

    private struct BrandButton: View {
        let configuration: ButtonStyleConfiguration
        let fullWidth: Bool
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize

        var body: some View {
            configuration.label
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.onAura)
                .lineLimit(1)
                .padding(.horizontal, controlSize == .small ? 14 : 20)
                .padding(.vertical, controlSize == .large ? 14 : (controlSize == .small ? 7 : 11))
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .background { BrandFill(pressed: configuration.isPressed) }
                .contentShape(Capsule())
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .opacity(isEnabled ? 1 : 0.45)
                .animation(Theme.motion(.quick), value: configuration.isPressed)
        }
    }
}

/// The brand gradient in a capsule, glazed as the web's primary button is.
struct BrandFill<S: InsettableShape>: View {
    var shape: S
    var pressed = false
    var glow = true

    var body: some View {
        shape.fill(Theme.brand)
            .overlay {
                shape.fill(LinearGradient(colors: [.white.opacity(0.20), .white.opacity(0)],
                                          startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.36)))
            }
            .overlay {
                shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.38), .white.opacity(0.10), .black.opacity(0.18)],
                                                  startPoint: .top, endPoint: .bottom), lineWidth: 1)
            }
            .brightness(pressed ? -0.06 : 0)
            .shadow(color: glow ? Theme.auraMagenta.opacity(0.40) : .clear, radius: 12, y: 7)
    }
}

extension BrandFill where S == Capsule {
    init(pressed: Bool = false, glow: Bool = true) {
        self.init(shape: Capsule(), pressed: pressed, glow: glow)
    }
}

/// A secondary control: glass. The system's glass button on iOS 26.
struct GlassButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        GlassButton(configuration: configuration)
    }

    private struct GlassButton: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize

        var body: some View {
            configuration.label
                .font(.body.weight(.medium))
                .lineLimit(1)
                .padding(.horizontal, controlSize == .small ? 12 : 16)
                .padding(.vertical, controlSize == .large ? 13 : (controlSize == .small ? 7 : 10))
                .glassSurface(Capsule())
                .contentShape(Capsule())
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .opacity(isEnabled ? 1 : 0.45)
                .animation(Theme.motion(.quick), value: configuration.isPressed)
        }
    }
}

extension View {
    /// Styles a button as secondary glass: the system's Liquid Glass button
    /// on iOS 26, the web's glass before it and with Reduce Transparency.
    func glassButtonStyle() -> some View {
        modifier(GlassButtonChoice())
    }
}

private struct GlassButtonChoice: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if Theme.liquidGlass, !reduceTransparency, #available(iOS 26, *) {
            content.buttonStyle(.glass)
        } else {
            content.buttonStyle(GlassButtonStyle())
        }
    }
}

// MARK: - Progress

/// How far along, in the brand's gradient (.upbar-fill): a bar that fills,
/// or — while the size is unknown — the gradient running along it.
struct GradientProgressBar: View {
    /// 0…1, or nil while unknown.
    let fraction: Double?
    var height: CGFloat = 4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                // The track: the glass edge's white, so it sits on glass too.
                Capsule().fill(Theme.edge)
                if let fraction {
                    Capsule().fill(Theme.meter)
                        .frame(width: max(height, geo.size.width * min(max(fraction, 0), 1)))
                        .animation(Theme.motion(.easeOut(duration: 0.25)), value: fraction)
                } else if reduceMotion {
                    Capsule().fill(Theme.meter).opacity(0.6)
                } else {
                    SlidingGradient(width: geo.size.width)
                }
            }
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityLabel("Progress")
        .accessibilityValue(fraction.map { "\(Int(($0 * 100).rounded())) percent" } ?? "In progress")
    }
}

/// The gradient running along a bar whose end is unknown. Core Animation
/// moves it — one offset, repeated, the view drawn once — rather than a
/// timeline that would have SwiftUI redraw the tray every frame for as long
/// as a download is preparing.
private struct SlidingGradient: View {
    let width: CGFloat
    @State private var slid = false

    var body: some View {
        Capsule()
            .fill(LinearGradient(colors: [Theme.auraBlue, Theme.auraMagenta, Theme.auraCyan, Theme.auraBlue],
                                 startPoint: .leading, endPoint: .trailing))
            .frame(width: width * 0.4)
            .offset(x: slid ? width : -width * 0.4)
            .frame(width: width, alignment: .leading)
            .clipShape(Capsule())
            .onAppear {
                withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { slid = true }
            }
            .onDisappear {
                // Stopped, not left running on a layer nobody draws.
                var still = Transaction()
                still.disablesAnimations = true
                withTransaction(still) { slid = false }
            }
    }
}

/// A ring that fills in the brand's hues: the tray's summary of everything
/// under way. While nothing says how big it is, the system's spinner.
struct GradientRing: View {
    let fraction: Double?
    var lineWidth: CGFloat = 3

    var body: some View {
        ZStack {
            Circle().stroke(Theme.edge, lineWidth: lineWidth)
            if let fraction {
                Circle()
                    .trim(from: 0, to: max(0.02, min(fraction, 1)))
                    .stroke(AngularGradient(colors: [Theme.auraBlue, Theme.auraMagenta, Theme.auraBlue], center: .center),
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(Theme.motion(.easeOut(duration: 0.25)), value: fraction)
            } else {
                ProgressView().controlSize(.mini).tint(.white)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Bits

/// A symbol on a small chip: glass, or the brand gradient when it marks
/// what is chosen (the web's .drive-row.is-active .drive-icon).
struct SymbolChip: View {
    let systemName: String
    var tint: Color = .accentColor
    var chosen = false
    var size: CGFloat = 30
    /// On glass, rather than on the tint's own wash: an empty state's tile.
    var glass = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        let symbol = Image(systemName: systemName)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(chosen ? Theme.onAura : tint)
            .frame(width: size, height: size)
        Group {
            if glass, !chosen {
                symbol.glassSurface(shape)
            } else {
                symbol.background {
                    if chosen {
                        BrandFill(shape: shape, glow: false)
                    } else {
                        shape.fill(tint.opacity(0.16))
                            .overlay { shape.strokeBorder(tint.opacity(0.28), lineWidth: Theme.hairline) }
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// Nothing here, nothing found, nothing could be loaded: a symbol on a glass
/// tile, a title, the line that says what would change it, and — where
/// there is one — the one thing to do about it. One shape on every screen,
/// as the web's .empty is.
struct EmptyState: View {
    let symbol: String
    let title: String
    var message: String? = nil
    var action: (title: String, run: () -> Void)? = nil

    var body: some View {
        VStack(spacing: Theme.Space.s4) {
            SymbolChip(systemName: symbol, tint: Theme.auraBlueDeep, size: 56, glass: true)
                .symbolRenderingMode(.hierarchical)
            VStack(spacing: 6) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                if let message {
                    Text(message)
                        .font(Theme.Text.detail)
                        .foregroundStyle(.secondary)
                }
            }
            .multilineTextAlignment(.center)
            if let action {
                Button(action.title, action: action.run)
                    .buttonStyle(BrandButtonStyle())
                    .padding(.top, Theme.Space.s1)
            }
        }
        .frame(maxWidth: 320)
        .padding(.horizontal, Theme.Space.s5)
        .padding(.vertical, 28)
        .frame(maxWidth: .infinity)
    }
}

/// A count on the brand gradient (.count-badge).
struct CountBadge: View {
    let text: String
    var systemImage: String?

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage) }
            Text(text)
        }
        .font(.caption2.weight(.semibold).monospacedDigit())
        .foregroundStyle(Theme.onAura)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Theme.brand, in: Capsule())
    }
}

extension Color {
    /// "#RRGGBB", as DriveTint hands its colours over. Nil for anything else.
    init?(rgbHex hex: String) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(.sRGB, red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
                  blue: Double(value & 0xFF) / 255)
    }
}

// MARK: - Editorial

/// A screen's name as the page's headline: huge, bold, left-aligned, set
/// tight (Theme.Text.display) — the folder's own name over its files, in
/// the same type as Home's greeting. Grows with Dynamic Type.
struct EditorialTitle: View {
    let text: String
    var subtitle: String?
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = Theme.Text.displaySize

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .displayText(size: size)
                .lineLimit(3)
                .minimumScaleFactor(0.7)
                .multilineTextAlignment(.leading)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle)
                    .font(Theme.Text.detail)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "Recent Files … See All": a section's name, and where to see the rest.
struct SectionHeading: View {
    let title: String
    var action: (title: String, run: () -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(Theme.Text.title)
                .tracking(Theme.Text.titleTracking)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let action {
                Button(action.title, action: action.run)
                    .font(Theme.Text.detail.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A round glass button with a symbol: the Home's header, a tray's controls.
struct RoundIconButton: View {
    let systemName: String
    let label: String
    var size: CGFloat = 46
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .glassSurface(Circle(), interactive: true)
        .accessibilityLabel(label)
    }
}

/// The preview's close: a white rounded square, the one bright thing over a
/// dark picture, found at once.
struct WhiteSquareButton: View {
    let systemName: String
    let label: String
    let action: () -> Void
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 46

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size * 0.38, weight: .bold))
                .foregroundStyle(.black)
                .frame(width: size, height: size)
                .background(.white, in: RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
                .elevation(.raised)
                .contentShape(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

extension Place {
    /// The drive's own colour, made legible (DriveTint): the accent for a
    /// symbol or a dot on the page, and a card's two stops. All Files is
    /// the brand's own blue into magenta, as the web's library is its accent.
    var driveTint: DriveTint? { DriveTint(hex: color) }

    var tint: Color {
        driveTint.flatMap { Color(rgbHex: $0.accent) } ?? .accentColor
    }

    var cardFill: LinearGradient {
        if let tint = driveTint, let top = Color(rgbHex: tint.cardTop), let bottom = Color(rgbHex: tint.cardBottom) {
            return LinearGradient(colors: [top, bottom], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
        return Theme.brand
    }
}
