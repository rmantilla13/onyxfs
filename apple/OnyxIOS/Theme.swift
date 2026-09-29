import OnyxKit
import SwiftUI

/// Onyx's look on iPhone and iPad, as the web has it (app/globals.css): a
/// near-black page lit at its top corners by the brand's glows, frosted
/// glass for what floats over it, and the brand gradient — electric blue
/// into neon magenta — on what is primary, chosen or moving.
///
/// Views take their colours from here, and these from the asset catalog,
/// never a hex value: the web is white-label, and so the brand's colours
/// live where a rebrand changes them in one place. The glass is Liquid
/// Glass from iOS 26; before it, a material with the web's hairline edge
/// and sheen (its --glass-* tokens); with Reduce Transparency, solid.
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

    /// The mark's glow, and a spinner's ring: all three hues around.
    static var halo: AngularGradient {
        AngularGradient(colors: [auraBlue, auraMagenta, auraCyan, auraBlue], center: .center)
    }

    // MARK: - The page

    /// Pure black: the media and the aura's accents bring the colour.
    static let page = Color.black
    /// A card on it, and a tile with no picture: near-black grey.
    static var card: Color { surface.opacity(0.82) }

    // MARK: - Shape

    /// A tile's picture: big, continuous corners.
    static let tileCorner: CGFloat = 24
    /// A row's picture.
    static let rowCorner: CGFloat = 14
    /// A card: the Home's cards, the download tray, a sheet's header.
    static let cardCorner: CGFloat = 28

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

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                switch style {
                case .page:
                    Theme.page
                    glow(Theme.auraBlue, 0.26, radii: CGSize(width: 0.60 * w, height: 0.48 * h),
                         at: CGPoint(x: 0.06 * w, y: -0.08 * h), fade: 0.70)
                    glow(Theme.auraMagenta, 0.26, radii: CGSize(width: 0.52 * w, height: 0.44 * h),
                         at: CGPoint(x: 0.98 * w, y: -0.06 * h), fade: 0.70)
                    glow(Theme.auraCyan, 0.15, radii: CGSize(width: 0.70 * w, height: 0.42 * h),
                         at: CGPoint(x: 0.55 * w, y: 1.12 * h), fade: 0.72)
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

    var body: some View {
        ZStack {
            if reduceTransparency { Theme.surface } else { Theme.frost }
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

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background { SolidGlass(shape: shape) }
        } else if Theme.liquidGlass {
            if #available(iOS 26, *) {
                content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
            } else {
                content.background { MaterialGlass(shape: shape) }
            }
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
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
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
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
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
                Capsule().fill(Color.white.opacity(0.12))
                if let fraction {
                    Capsule().fill(Theme.meter)
                        .frame(width: max(height, geo.size.width * min(max(fraction, 0), 1)))
                        .animation(.easeOut(duration: 0.25), value: fraction)
                } else if reduceMotion {
                    Capsule().fill(Theme.meter).opacity(0.6)
                } else {
                    TimelineView(.animation) { timeline in
                        let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
                        Capsule()
                            .fill(LinearGradient(colors: [Theme.auraBlue, Theme.auraMagenta, Theme.auraCyan, Theme.auraBlue],
                                                 startPoint: .leading, endPoint: .trailing))
                            .frame(width: geo.size.width * 0.4)
                            .offset(x: (geo.size.width * 1.4) * phase - geo.size.width * 0.4)
                    }
                    .clipShape(Capsule())
                }
            }
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityLabel("Progress")
        .accessibilityValue(fraction.map { "\(Int(($0 * 100).rounded())) percent" } ?? "In progress")
    }
}

/// A ring that fills in the brand's hues: the tray's summary of everything
/// under way. While nothing says how big it is, the system's spinner.
struct GradientRing: View {
    let fraction: Double?
    var lineWidth: CGFloat = 3

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.14), lineWidth: lineWidth)
            if let fraction {
                Circle()
                    .trim(from: 0, to: max(0.02, min(fraction, 1)))
                    .stroke(AngularGradient(colors: [Theme.auraBlue, Theme.auraMagenta, Theme.auraBlue], center: .center),
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.25), value: fraction)
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

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(chosen ? Theme.onAura : tint)
            .frame(width: size, height: size)
            .background {
                if chosen {
                    BrandFill(shape: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous), glow: false)
                } else {
                    RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
                        .fill(tint.opacity(0.16))
                        .overlay {
                            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
                                .strokeBorder(tint.opacity(0.28), lineWidth: 0.5)
                        }
                }
            }
            .accessibilityHidden(true)
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
/// tight — the folder's own name over its files. Grows with Dynamic Type.
struct EditorialTitle: View {
    let text: String
    var subtitle: String?
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 42

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.system(size: size, weight: .bold))
                .tracking(-size * 0.028)
                .lineLimit(3)
                .minimumScaleFactor(0.7)
                .multilineTextAlignment(.leading)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
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
                .font(.title2.weight(.bold))
                .tracking(-0.4)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let action {
                Button(action.title, action: action.run)
                    .font(.subheadline.weight(.medium))
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
                .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
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

extension ContentUnavailableView {
    /// An empty, failed or searching state on the aura.
    func onyxStyle() -> some View {
        foregroundStyle(.primary)
            .symbolRenderingMode(.hierarchical)
    }
}
