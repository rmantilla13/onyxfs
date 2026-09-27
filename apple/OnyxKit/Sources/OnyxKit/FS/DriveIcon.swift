import CoreGraphics
import CoreText
import Foundation
import ImageIO

/// A drive's disk icon: the Onyx mark — the slash, the root of a file
/// system, on its near-black tile (public/onyx-mark.svg) — with the slash in
/// the drive's own colour, the dot beside its name on the web, and after it
/// the drive's initial, as a path is written: "/V" for Videos. Colour alone
/// would not do: the web has seven, so drives share them, and two disks of
/// one colour would look the same on the Desktop. The library, all files, is
/// the mark as it is.
///
/// The app hands it to the file system extension (`GET /fs/v1/icon`), which
/// puts it where macOS looks for a disk's own icon (LocalStore.placeVolumeIcon
/// in OnyxFSCore). An .icns of PNGs from 16 to 1024 pixels, each drawn at its
/// own size, on the tile macOS gives every icon (824 of 1024, centred), so it
/// sits among other disks at their size.
public enum DriveIcon {
    /// The mark's own colours.
    static let tile = RGB(0x09, 0x0B, 0x0E)
    static let slash = RGB(0x99, 0xE3, 0x14)

    /// The icon for a drive: `name`'s initial after a slash in `color`
    /// ("#RRGGBB"). The mark's own slash for no colour (a server too old to
    /// say), and the mark as it is for no name — the library's disk. Nil only
    /// if the images could not be encoded. Made once per colour and initial.
    public static func icns(color: String?, name: String?) -> Data? {
        let rgb = color.flatMap(RGB.init(hex:)) ?? slash
        let letter = initial(of: name)
        let key = "\(rgb.hex)/\(letter ?? "")"
        if let made = lock.withLock({ cache[key] }) { return made }
        guard let data = make(slash: legible(rgb), letter: letter) else { return nil }
        lock.withLock { cache[key] = data }
        return data
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: Data] = [:]

    /// What follows the slash: the name's first letter or digit, in
    /// capitals; nil for a name with neither (an emoji is too wide to sit
    /// beside it), and the slash stands alone.
    static func initial(of name: String?) -> String? {
        guard let first = name?.first(where: { $0.isLetter || $0.isNumber }) else { return nil }
        return first.uppercased().first.map(String.init)
    }

    /// Each size an .icns holds (iconutil's set), by its type: 16-point to
    /// 512-point, and each of them at 2x.
    static let entries: [(type: String, pixels: Int)] = [
        ("icp4", 16), ("ic11", 32), ("icp5", 32), ("ic12", 64), ("ic07", 128),
        ("ic13", 256), ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024),
    ]

    static func make(slash color: RGB, letter: String?) -> Data? {
        var pngs: [Int: Data] = [:]
        for pixels in Set(entries.map(\.pixels)) {
            guard let image = draw(pixels: pixels, slash: color, letter: letter), let png = png(image) else { return nil }
            pngs[pixels] = png
        }
        return pack(entries.map { ($0.type, pngs[$0.pixels]!) })
    }

    // MARK: - Drawing

    /// The mark's slash, 300 points tall in its 512-point box (y down): a
    /// parallelogram leaning right, `x` from its lowest point's left.
    static func slash(height: CGFloat, left x: CGFloat, top y: CGFloat) -> [CGPoint] {
        let k = height / 300
        return [CGPoint(x: x + 80.75 * k, y: y), CGPoint(x: x + 138.01 * k, y: y),
                CGPoint(x: x + 57.26 * k, y: y + height), CGPoint(x: x, y: y + height)]
    }

    /// How wide the slash is, for its height.
    static func slashWidth(height: CGFloat) -> CGFloat { 138.01 * height / 300 }

    /// The slash beside a letter is 210 points tall, and so are the letter's
    /// capitals; alone it keeps the mark's 300.
    static let pairedHeight: CGFloat = 210

    static func draw(pixels: Int, slash color: RGB, letter: String?) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        let unit = CGFloat(pixels) / 1024
        ctx.interpolationQuality = .high
        ctx.setAllowsAntialiasing(true)

        // macOS's icon grid (y down from here on): the tile is 824 of 1024,
        // with a soft shadow under it. Shadows are in pixels, whatever the
        // transform, and point down in the bitmap's own y-up space.
        ctx.translateBy(x: 0, y: CGFloat(pixels))
        ctx.scaleBy(x: unit, y: -unit)
        ctx.translateBy(x: 100, y: 100)
        ctx.scaleBy(x: 824 / 512, y: 824 / 512)
        let box = CGRect(x: 0, y: 0, width: 512, height: 512)
        let tilePath = CGPath(roundedRect: box, cornerWidth: 112, cornerHeight: 112, transform: nil)

        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10 * unit), blur: 20 * unit,
                      color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.3))
        ctx.addPath(tilePath)
        ctx.setFillColor(tile.cgColor)
        ctx.fillPath()
        ctx.restoreGState()

        // A hairline just inside the edge: the tile's outline on a dark
        // Desktop, all but invisible on a light one.
        ctx.addPath(CGPath(roundedRect: box.insetBy(dx: 2, dy: 2), cornerWidth: 110, cornerHeight: 110, transform: nil))
        ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.12))
        ctx.setLineWidth(4)
        ctx.strokePath()

        // The slash and the letter, centred together, the letter in white
        // (the drive's colour is the slash's: in it, a darker drive's letter
        // would go muddy). The letter sits a small gap after the slash's top,
        // as a font sets "/V"; one too wide to fit is made smaller.
        let height = letter == nil ? 300 : pairedHeight
        let line = letter.flatMap { Self.line($0, capHeight: height) }
        let gap = 0.06 * height
        var glyphs = line.map { CTLineGetBoundsWithOptions($0, .useGlyphPathBounds) } ?? .zero
        var scale: CGFloat = 1
        let room = 512 - 2 * 48 - slashWidth(height: height) - gap
        if glyphs.width > room {
            scale = room / glyphs.width
            glyphs = glyphs.applying(CGAffineTransform(scaleX: scale, y: scale))
        }
        let width = slashWidth(height: height) + (line == nil ? 0 : gap + glyphs.width)
        let left = (512 - width) / 2, top = (512 - height) / 2
        ctx.addLines(between: slash(height: height, left: left, top: top))
        ctx.closePath()
        ctx.setFillColor(color.cgColor)
        ctx.fillPath()
        if let line {
            // Text is drawn y up: flipped back at its baseline, the slash's foot.
            ctx.saveGState()
            ctx.translateBy(x: left + slashWidth(height: height) + gap - glyphs.minX, y: top + height)
            ctx.scaleBy(x: scale, y: -scale)
            ctx.textPosition = .zero
            CTLineDraw(line, ctx)
            ctx.restoreGState()
        }
        return ctx.makeImage()
    }

    /// `letter` in the system's bold face, sized so its capitals are
    /// `capHeight` tall, in white.
    static func line(_ letter: String, capHeight: CGFloat) -> CTLine? {
        let probe = CTFontCreateUIFontForLanguage(.emphasizedSystem, 100, nil)
        guard let probe, CTFontGetCapHeight(probe) > 0 else { return nil }
        guard let font = CTFontCreateUIFontForLanguage(.emphasizedSystem, capHeight * 100 / CTFontGetCapHeight(probe), nil)
        else { return nil }
        let attributes: [CFString: Any] = [kCTFontAttributeName: font,
                                           kCTForegroundColorAttributeName: RGB(255, 255, 255).cgColor]
        guard let text = CFAttributedStringCreate(nil, letter as CFString, attributes as CFDictionary) else { return nil }
        return CTLineCreateWithAttributedString(text)
    }

    /// The colour, lightened just enough to stand out on the near-black
    /// tile (3:1, as a graphic must): a brand's darker colours are its own
    /// to choose, and on this tile they would all but vanish.
    static func legible(_ color: RGB) -> RGB {
        var c = color
        var step = 0
        while RGB.contrast(c, tile) < 3, step < 20 {
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
