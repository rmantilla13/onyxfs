import CoreGraphics
import CoreText
import Foundation
import ImageIO

/// A drive's disk icon, in the logo's style. It is the near-black tile of the
/// ONYX FS icon (public/onyx-mark.svg) with the drive's initial on it. The
/// initial is set the way the logo sets its letters, thin and wide, in the
/// drive's own colour: the dot beside its name on the web, as the logo's "FS"
/// is in its cyan. Colour alone would not do: the web has seven, so drives
/// share them, and two disks of one colour would look the same on the
/// Desktop. The library, all files, is the app's own icon.
///
/// The app hands it to the file system extension (`GET /fs/v1/icon`), which
/// puts it where macOS looks for a disk's own icon (LocalStore.placeVolumeIcon
/// in OnyxFSCore). An .icns of PNGs from 16 to 1024 pixels, each drawn at its
/// own size, on the tile macOS gives every icon (824 of 1024, centred), so it
/// sits among other disks at their size.
public enum DriveIcon {
    /// The icon's tile, and the logo's cyan: the letter's colour for a drive
    /// the server gave none.
    static let tile = RGB(0x09, 0x0B, 0x0E)
    static let cyan = RGB(0x94, 0xE0, 0xF7)

    /// The icon for a drive: `name`'s initial in `color` ("#RRGGBB"), or in
    /// the logo's cyan for none (a server too old to say). No name is the
    /// library's disk: `mark`, the app's own icon, drawn on the same grid, or
    /// the bare tile without one. Nil only if the images could not be
    /// encoded. Each colour and initial is drawn once.
    public static func icns(color: String?, name: String?, mark: CGImage? = nil) -> Data? {
        let (key, face) = appearance(color: color, name: name, mark: mark)
        if let made = lock.withLock({ cache[key] }) { return made }
        guard let data = make(face) else { return nil }
        lock.withLock { cache[key] = data }
        return data
    }

    /// One size of the same icon, `pixels` square: a drive beside its name
    /// in the app — the menu bar's panel, Settings — as Finder shows its
    /// disk, without drawing every size an .icns holds.
    public static func image(color: String?, name: String?, mark: CGImage? = nil, pixels: Int) -> CGImage? {
        draw(appearance(color: color, name: name, mark: mark).face, pixels: pixels)
    }

    private static func appearance(color: String?, name: String?, mark: CGImage?) -> (key: String, face: Face) {
        guard let name else { return (mark == nil ? "tile" : "mark", .mark(mark)) }
        let rgb = legible(color.flatMap(RGB.init(hex:)) ?? cyan)
        let letter = initial(of: name)
        return ("\(rgb.hex)/\(letter ?? "")", .letter(letter, rgb))
    }

    enum Face {
        case letter(String?, RGB)
        case mark(CGImage?)
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: Data] = [:]

    /// What goes on the tile: the name's first letter or digit, in capitals.
    /// A name with neither has its first character that is not a space or a
    /// mark of punctuation instead (an emoji), and a name with none of those
    /// a bare tile.
    static func initial(of name: String?) -> String? {
        guard let name else { return nil }
        if let first = name.first(where: { $0.isLetter || $0.isNumber }) {
            return first.uppercased().first.map(String.init)
        }
        return name.first { !$0.isWhitespace && !$0.isPunctuation }.map(String.init)
    }

    /// Each size an .icns holds (iconutil's set), by its type: 16-point to
    /// 512-point, and each of them at 2x.
    static let entries: [(type: String, pixels: Int)] = [
        ("icp4", 16), ("ic11", 32), ("icp5", 32), ("ic12", 64), ("ic07", 128),
        ("ic13", 256), ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024),
    ]

    static func make(_ face: Face) -> Data? {
        var pngs: [Int: Data] = [:]
        for pixels in Set(entries.map(\.pixels)) {
            guard let image = draw(face, pixels: pixels), let png = png(image) else { return nil }
            pngs[pixels] = png
        }
        return pack(entries.map { ($0.type, pngs[$0.pixels]!) })
    }

    // MARK: - Drawing

    /// The letter's capitals are this tall on the 512-point tile, and it
    /// stays this far from the tile's edges however wide it is.
    static let capHeight: CGFloat = 250
    static let margin: CGFloat = 48

    /// The logo's letters are thin. A thin stroke drawn a few pixels tall
    /// is lost, so smaller sizes are drawn heavier: light at 256 pixels and
    /// up, semibold at 32 and below. (Weights are CoreText's, -1 to 1.)
    static func weight(pixels: Int) -> CGFloat {
        switch pixels {
        case ...32: return 0.3
        case ...64: return 0
        case ...128: return -0.2
        default: return -0.4
        }
    }

    static func draw(_ face: Face, pixels: Int) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        let unit = CGFloat(pixels) / 1024
        ctx.interpolationQuality = .high
        ctx.setAllowsAntialiasing(true)

        // macOS's icon grid: the tile is 824 of 1024, centred, in a 512-point
        // box of its own (y up), with a soft shadow under it. Shadows are in
        // pixels, whatever the transform.
        ctx.translateBy(x: 100 * unit, y: 100 * unit)
        ctx.scaleBy(x: 824 / 512 * unit, y: 824 / 512 * unit)
        let box = CGRect(x: 0, y: 0, width: 512, height: 512)

        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10 * unit), blur: 20 * unit,
                      color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.3))
        if case let .mark(image?) = face {
            ctx.draw(image, in: box)
        } else {
            ctx.addPath(CGPath(roundedRect: box, cornerWidth: 112, cornerHeight: 112, transform: nil))
            ctx.setFillColor(tile.cgColor)
            ctx.fillPath()
        }
        ctx.restoreGState()

        // A hairline just inside the edge: the tile's outline on a dark
        // Desktop, all but invisible on a light one.
        ctx.addPath(CGPath(roundedRect: box.insetBy(dx: 2, dy: 2), cornerWidth: 110, cornerHeight: 110, transform: nil))
        ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.12))
        ctx.setLineWidth(4)
        ctx.strokePath()

        // The letter, centred by its own outline, and made smaller should it
        // be too wide (or tall) for the tile.
        if case let .letter(letter?, color) = face, let line = line(letter, color: color, weight: weight(pixels: pixels)) {
            let glyphs = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
            let room = 512 - 2 * margin
            let scale = min(1, room / max(glyphs.width, 1), room / max(glyphs.height, 1))
            ctx.translateBy(x: 256 - glyphs.midX * scale, y: 256 - glyphs.midY * scale)
            ctx.scaleBy(x: scale, y: scale)
            ctx.textPosition = .zero
            CTLineDraw(line, ctx)
        }
        return ctx.makeImage()
    }

    /// `letter` in the system face, wide (as the logo's letters are), at
    /// `weight`, sized so its capitals are `capHeight` tall.
    static func line(_ letter: String, color: RGB, weight: CGFloat) -> CTLine? {
        func face(_ size: CGFloat) -> CTFont? {
            guard let system = CTFontCreateUIFontForLanguage(.system, size, nil) else { return nil }
            let traits: [CFString: Any] = [kCTFontWeightTrait: weight, kCTFontWidthTrait: 0.2]
            let wide = CTFontDescriptorCreateCopyWithAttributes(CTFontCopyFontDescriptor(system),
                                                                [kCTFontTraitsAttribute: traits] as CFDictionary)
            return CTFontCreateWithFontDescriptor(wide, size, nil)
        }
        guard let probe = face(100), CTFontGetCapHeight(probe) > 0,
              let font = face(capHeight * 100 / CTFontGetCapHeight(probe)) else { return nil }
        let attributes: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: color.cgColor]
        guard let text = CFAttributedStringCreate(nil, letter as CFString, attributes as CFDictionary) else { return nil }
        return CTLineCreateWithAttributedString(text)
    }

    /// The colour, lightened just enough to read on the near-black tile
    /// (4.5:1, as text must, and as the web's dark scheme lifts the same
    /// colours). A brand's darker colours are its own to choose, but on this
    /// tile they would all but vanish.
    static func legible(_ color: RGB) -> RGB {
        var c = color
        var step = 0
        while RGB.contrast(c, tile) < 4.5, step < 20 {
            step += 1
            c = color.mixed(with: RGB(255, 255, 255), by: Double(step) / 20)
        }
        return c
    }

    static func png(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }

    /// The .icns container: "icns" and the whole length, then each entry's
    /// type, its length (with its own eight bytes) and its PNG. Lengths are
    /// big-endian.
    static func pack(_ entries: [(type: String, png: Data)]) -> Data {
        func uint32(_ n: Int) -> Data { withUnsafeBytes(of: UInt32(n).bigEndian) { Data($0) } }
        var body = Data()
        for (type, png) in entries {
            body.append(Data(type.utf8))
            body.append(uint32(png.count + 8))
            body.append(png)
        }
        return Data("icns".utf8) + uint32(body.count + 8) + body
    }
}

/// An sRGB colour, 0…255 a channel.
struct RGB: Equatable {
    var r: Double
    var g: Double
    var b: Double

    init(_ r: Double, _ g: Double, _ b: Double) { self.r = r; self.g = g; self.b = b }

    /// "#RRGGBB"; nil for anything else.
    init?(hex: String) {
        let digits = hex.hasPrefix("#") ? hex.dropFirst() : Substring(hex)
        guard digits.count == 6, digits.allSatisfy(\.isHexDigit), let n = UInt32(digits, radix: 16) else { return nil }
        self.init(Double(n >> 16 & 0xFF), Double(n >> 8 & 0xFF), Double(n & 0xFF))
    }

    var hex: String {
        String(format: "#%02X%02X%02X", Int(r.rounded()), Int(g.rounded()), Int(b.rounded()))
    }

    var cgColor: CGColor { CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: 1) }

    func mixed(with other: RGB, by t: Double) -> RGB {
        RGB(r + (other.r - r) * t, g + (other.g - g) * t, b + (other.b - b) * t)
    }

    /// WCAG's relative luminance, and the contrast of two colours by it.
    var luminance: Double {
        func linear(_ v: Double) -> Double {
            let c = v / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    static func contrast(_ a: RGB, _ b: RGB) -> Double {
        let (hi, lo) = (max(a.luminance, b.luminance), min(a.luminance, b.luminance))
        return (hi + 0.05) / (lo + 0.05)
    }
}
