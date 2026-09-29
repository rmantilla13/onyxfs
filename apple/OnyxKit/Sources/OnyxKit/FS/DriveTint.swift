import Foundation

/// A drive's own colour (`Filespace.color`, the dot beside its name on the
/// web — lib/drive-color.js) as the iPhone paints with it: a symbol or a dot
/// on the near-black page, and a card filled with it.
///
/// Both are the brand's hue, changed only in lightness, as the web changes
/// its colours: lifted toward white until a symbol stands out from the page
/// (3:1), and deepened toward black until white words on the card read at
/// AA (4.5:1) — the rule the web's --aura-*-deep stops follow.
public struct DriveTint: Equatable, Sendable {
    /// For a symbol or a dot on the page, "#RRGGBB".
    public let accent: String
    /// A card's two stops, lit corner to shaded one.
    public let cardTop: String
    public let cardBottom: String

    /// The near-black page (lib/brand.js ink).
    static let page = RGB(0x0C, 0x0D, 0x0F)
    static let white = RGB(255, 255, 255)
    static let black = RGB(0, 0, 0)

    /// Nil for anything that is not "#RRGGBB".
    public init?(hex: String?) {
        guard let hex, let color = RGB(hex: hex) else { return nil }
        accent = Self.lifted(color, until: 3, against: Self.page).hex
        let deep = Self.deepened(color, until: 4.5)
        cardTop = deep.hex
        cardBottom = Self.deepened(deep.mixed(with: Self.black, by: 0.28), until: 4.5).hex
    }

    static func lifted(_ color: RGB, until ratio: Double, against background: RGB) -> RGB {
        var c = color
        var step = 0
        while RGB.contrast(c, background) < ratio, step < 20 {
            step += 1
            c = color.mixed(with: white, by: Double(step) / 20)
        }
        return c
    }

    static func deepened(_ color: RGB, until ratio: Double) -> RGB {
        var c = color
        var step = 0
        while RGB.contrast(white, c) < ratio, step < 20 {
            step += 1
            c = color.mixed(with: black, by: Double(step) / 20)
        }
        return c
    }

    /// The contrast of white words on a card stop.
    public static func whiteContrast(on hex: String) -> Double? {
        RGB(hex: hex).map { RGB.contrast(white, $0) }
    }

    /// The contrast of a colour on the page.
    public static func pageContrast(of hex: String) -> Double? {
        RGB(hex: hex).map { RGB.contrast($0, page) }
    }
}
