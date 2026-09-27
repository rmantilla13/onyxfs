import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import OnyxKit

/// A drive's disk icon: an .icns macOS can read, every size in it drawn at
/// its own size; the drive's initial in its colour on the logo's tile, and
/// the app's own icon for the library.
struct DriveIconTests {
    /// The .icns's entries, by type.
    func entries(_ icns: Data) throws -> [String: Data] {
        let bytes = [UInt8](icns)
        func uint32(_ at: Int) -> Int { bytes[at..<at + 4].reduce(0) { $0 << 8 | Int($1) } }
        try #require(bytes.count > 8 && String(decoding: bytes[0..<4], as: UTF8.self) == "icns")
        #expect(uint32(4) == bytes.count, "the header's length is the whole file's")
        var out: [String: Data] = [:]
        var at = 8
        while at < bytes.count {
            let length = uint32(at + 4)
            try #require(length > 8 && at + length <= bytes.count)
            out[String(decoding: bytes[at..<at + 4], as: UTF8.self)] = Data(bytes[at + 8..<at + length])
            at += length
        }
        return out
    }

    func image(_ png: Data) throws -> CGImage {
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        return try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    }

    /// An image's pixels, sRGB 0…255 and alpha, row by row from the top.
    struct Pixels {
        let side: Int
        let bytes: [UInt8]

        init(_ image: CGImage) {
            let side = image.width
            var bytes = [UInt8](repeating: 0, count: side * side * 4)
            let space = CGColorSpace(name: CGColorSpace.sRGB)!
            bytes.withUnsafeMutableBytes {
                let ctx = CGContext(data: $0.baseAddress, width: side, height: side, bitsPerComponent: 8,
                                    bytesPerRow: side * 4, space: space,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
            }
            self.side = side
            self.bytes = bytes
        }

        subscript(x: Int, y: Int) -> RGB? {
            let i = (y * side + x) * 4
            return bytes[i + 3] == 255 ? RGB(Double(bytes[i]), Double(bytes[i + 1]), Double(bytes[i + 2])) : nil
        }
    }

    /// The 1024-pixel image of an icon.
    func largest(_ color: String?, _ name: String?, mark: CGImage? = nil) throws -> Pixels {
        let icns = try #require(DriveIcon.icns(color: color, name: name, mark: mark))
        let png = try #require(try entries(icns)["ic10"])
        return Pixels(try image(png))
    }

    static let white = RGB(255, 255, 255)

    @Test func everySizeIsThereAtItsOwnSize() throws {
        let icns = try #require(DriveIcon.icns(color: "#22D3EE", name: "Videos"))
        let found = try entries(icns)
        #expect(Set(found.keys) == Set(DriveIcon.entries.map(\.type)))
        for (type, pixels) in DriveIcon.entries {
            let png = try #require(found[type])
            let image = try image(png)
            #expect(image.width == pixels && image.height == pixels, "\(type)")
        }
        // And macOS's own reader takes it whole.
        let source = try #require(CGImageSourceCreateWithData(icns as CFData, nil))
        #expect(CGImageSourceGetCount(source) >= 7)
    }

    /// An image of one colour, edge to edge, as the app's icon comes.
    func solid(_ color: RGB) -> CGImage {
        let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(color.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        return ctx.makeImage()!
    }

    @Test func theLibrarysDiskIsTheAppsOwnIcon() throws {
        let red = RGB(0xD0, 0x10, 0x20)
        let library = try largest(nil, nil, mark: solid(red))
        // On macOS's grid: 824 of 1024, centred, and clear around it.
        #expect(library[512, 512] == red && library[110, 512] == red && library[914, 512] == red)
        #expect(library[60, 512] == nil && library[2, 2] == nil)
        // With no icon to hand (a test, a build without one): the bare tile.
        #expect(try largest(nil, nil)[512, 512] == DriveIcon.tile)
    }

    @Test func aDrivesInitialIsInItsColourOnTheTile() throws {
        // An I is a stem through the middle.
        let icon = try largest("#E040FB", "Inbox")
        #expect(icon[512, 512] == RGB(0xE0, 0x40, 0xFB))
        let row = (100..<924).compactMap { icon[$0, 512] }
        #expect(row.contains(DriveIcon.tile) && !row.contains(Self.white))
        // The small sizes are drawn too, heavier: the 16-pixel one has the colour in it.
        let icns = try #require(DriveIcon.icns(color: "#E040FB", name: "Inbox"))
        let small = Pixels(try image(try #require(try entries(icns)["icp4"])))
        let colours = (0..<16).flatMap { y in (0..<16).compactMap { small[$0, y] } }
        #expect(colours.contains { $0.r > $0.g + 40 && $0.b > $0.g + 40 }, "magenta at 16 pixels")

        // No colour from the server: the logo's cyan.
        for color in [nil, "", "blue", "#12345", "#GG0000"] as [String?] {
            #expect(try largest(color, "Inbox")[512, 512] == DriveIcon.cyan, "\(color ?? "nil")")
        }
    }

    @Test func twoDrivesOfOneColourAreToldApartByTheirInitials() throws {
        let videos = try #require(DriveIcon.icns(color: "#81A628", name: "Videos"))
        #expect(DriveIcon.icns(color: "#81A628", name: "Memories") != videos)
        #expect(DriveIcon.icns(color: "#81A628", name: "vacation") == videos, "one initial, one icon")
        #expect(DriveIcon.icns(color: "#81a628", name: "Videos") == videos, "hex in either case")
        #expect(DriveIcon.icns(color: "#AA8200", name: "Videos") != videos)
    }

    @Test func theInitialIsTheNamesFirstLetterOrDigit() {
        let cases: [(String?, String?)] = [
            ("Videos", "V"), ("memories", "M"), ("2024 Shoots", "2"), ("🎬 Film", "F"),
            ("[Archive]", "A"), ("ßeta", "S"), ("éclair", "É"), ("映像", "映"),
            // A name with no letter or digit: its first sign, an emoji say.
            ("🎬", "🎬"), ("  🎞 ", "🎞"), ("!!!", nil), ("  ", nil), ("", nil), (nil, nil),
        ]
        for (name, initial) in cases {
            #expect(DriveIcon.initial(of: name) == initial, "\(name ?? "nil")")
        }
    }

    @Test func aWideLetterIsMadeToFit() throws {
        // Letters far wider than a W (Ǆ is one letter; so is the Arabic
        // ligature ﷲ), and an emoji: nothing strays past the tile's margin.
        for name in ["Ǆ", "ﷲ", "Ｗ", "W", "🎬"] {
            #expect(DriveIcon.initial(of: name) != nil, "\(name) has an initial")
            let icon = try largest("#22D3EE", name)
            var drawn = 0
            for y in stride(from: 110, to: 914, by: 2) {
                for x in [120, 150, 170, 854, 874, 904] {
                    let p = icon[x, y]
                    #expect(p == nil || p == DriveIcon.tile || RGB.contrast(p!, DriveIcon.tile) < 1.5,
                            "\(name) at \(x),\(y)")
                }
                drawn += (170..<854).filter { icon[$0, y].map { RGB.contrast($0, DriveIcon.tile) > 2 } ?? false }.count
            }
            #expect(drawn > 0, "\(name) is drawn")
        }
    }

    @Test func aColourTooDarkForTheTileIsLiftedJustEnough() {
        let navy = RGB(hex: "#1A237E")!
        let lifted = DriveIcon.legible(navy)
        #expect(RGB.contrast(lifted, DriveIcon.tile) >= 4.5)
        #expect(DriveIcon.legible(lifted) == lifted, "lifted once, enough")
        #expect(lifted.b > lifted.r, "still blue")
        // Bright enough already: as it was.
        #expect(DriveIcon.legible(RGB(hex: "#22D3EE")!) == RGB(hex: "#22D3EE")!)
        #expect(DriveIcon.legible(RGB(hex: "#81A628")!) == RGB(hex: "#81A628")!)
        // The warning's orange is dark for thin letters: lifted, still orange.
        let orange = DriveIcon.legible(RGB(hex: "#C2410C")!)
        #expect(RGB.contrast(orange, DriveIcon.tile) >= 4.5 && orange.r > orange.g && orange.g > orange.b)
    }
}
