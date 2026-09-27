import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import OnyxKit

/// A drive's disk icon: an .icns macOS can read, every size in it drawn at
/// its own size; the slash in the drive's colour on the mark's tile, and the
/// drive's initial after it.
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
    func largest(_ color: String?, _ name: String?) throws -> Pixels {
        let icns = try #require(DriveIcon.icns(color: color, name: name))
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

    @Test func theLibrarysDiskIsTheMarkAsItIs() throws {
        let mark = try largest(nil, nil)
        // The tile is 824 of 1024, centred; the slash leans through its middle.
        #expect(mark[512, 512] == RGB(0x99, 0xE3, 0x14))
        #expect(mark[300, 512] == DriveIcon.tile)
        #expect(mark[2, 2] == nil, "clear around the tile")
    }

    @Test func aDrivesSlashIsItsColourAndItsInitialFollows() throws {
        let photos = try largest("#E040FB", "Photos")
        // Across the middle: the tile, the slash, the tile, the letter.
        let row = (100..<924).compactMap { photos[$0, 512] }
        let slash = try #require(row.firstIndex(of: RGB(0xE0, 0x40, 0xFB)))
        let letter = try #require(row.firstIndex(of: Self.white))
        #expect(slash < letter)
        #expect(row.lastIndex(of: RGB(0xE0, 0x40, 0xFB))! < letter, "the slash first, then the letter")
        #expect(row[..<slash].contains(DriveIcon.tile), "on the tile")

        // No colour from the server: the mark's own slash, the letter still.
        for color in [nil, "", "blue", "#12345", "#GG0000"] as [String?] {
            let icon = try largest(color, "Photos")
            let row = (100..<924).compactMap { icon[$0, 512] }
            #expect(row.contains(RGB(0x99, 0xE3, 0x14)) && row.contains(Self.white), "\(color ?? "nil")")
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
            ("  ", nil), ("🎬", nil), ("", nil), (nil, nil),
        ]
        for (name, initial) in cases {
            #expect(DriveIcon.initial(of: name) == initial, "\(name ?? "nil")")
        }
    }

    @Test func aWideLetterIsMadeToFit() throws {
        // Letters far wider than a W (Ǆ is one letter; so is the Arabic
        // ligature ﷲ): nothing white strays past the tile's inner margin.
        for name in ["Ǆ", "ﷲ", "Ｗ", "W"] {
            #expect(DriveIcon.initial(of: name) != nil, "\(name) is a letter")
            let icon = try largest("#22D3EE", name)
            var letter = 0
            for y in stride(from: 150, to: 874, by: 2) {
                for x in [120, 150, 170, 854, 874, 904] {
                    #expect(icon[x, y] != Self.white, "\(name) at \(x),\(y)")
                }
                letter += (170..<854).filter { icon[$0, y] == Self.white }.count
            }
            #expect(letter > 0, "\(name) is drawn")
        }
    }

    @Test func aColourTooDarkForTheTileIsLiftedJustEnough() {
        let navy = RGB(hex: "#1A237E")!
        let lifted = DriveIcon.legible(navy)
        #expect(RGB.contrast(lifted, DriveIcon.tile) >= 3)
        #expect(RGB.contrast(DriveIcon.legible(lifted), DriveIcon.tile) >= 3)
        #expect(lifted.b > lifted.r, "still blue")
        // Bright enough already: as it was.
        #expect(DriveIcon.legible(RGB(hex: "#22D3EE")!) == RGB(hex: "#22D3EE")!)
        #expect(DriveIcon.legible(RGB(hex: "#C2410C")!) == RGB(hex: "#C2410C")!)
    }
}
