import Testing
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import OnyxKit

// The web's own strings (test/placeholder.test.js): a real 24x18 WebP, as a
// browser's canvas makes one, and a JPEG's first bytes, which are all the
// server checks of it.
private let webp = "data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA=="
private let jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

/// placeholderFacts, as far as a placeholder from this Mac needs it: the
/// string as sent, within what the server takes; compacted as the server
/// compacts a JPEG (lib/placeholder.js bareJpeg, which TinyJPEG.bare is);
/// then a placeholder within PLACEHOLDER_MAX_CHARS. What the server would
/// store, or nil.
private func serverKeeps(_ sent: String) -> String? {
    guard sent.utf8.count <= 8192 else { return nil }
    var compacted = sent
    let prefix = "data:image/jpeg;base64,"
    if sent.hasPrefix(prefix), let bytes = Data(base64Encoded: String(sent.dropFirst(prefix.count))),
       let bare = TinyJPEG.bare(bytes) {
        compacted = prefix + bare.base64EncodedString()
    }
    return Placeholder(dataURL: compacted)?.dataURL == compacted ? compacted : nil
}

/// A JPEG's markers before its scan, in order.
private func markers(_ data: Data) -> [UInt8] {
    let b = [UInt8](data)
    var out: [UInt8] = []
    var i = 2
    while i + 4 <= b.count, b[i] == 0xFF, b[i + 1] != 0xDA {
        out.append(b[i + 1])
        i += 2 + (Int(b[i + 2]) << 8 | Int(b[i + 3]))
    }
    return out
}

/// Pictures for the squeezing: noise, gradients, flat and blocks, in colour
/// or grey, at any size a placeholder might be and a little over — the same
/// ones every run.
private struct Pictures {
    private var state: UInt64 = 0x5EED

    private mutating func next() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Double(state >> 11) / Double(1 << 53)
    }

    private mutating func upTo(_ n: Int) -> Int { 1 + Int(next() * Double(n)) % n }

    mutating func picture(_ trial: Int) -> CGImage {
        let width = upTo(48), height = upTo(48)
        let grey = trial % 5 == 0
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: grey ? CGColorSpaceCreateDeviceGray() : ThumbnailRenderer.sRGB,
                                bitmapInfo: grey ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue)!
        switch trial % 4 {
        case 0:
            for y in 0..<height {
                for x in 0..<width {
                    context.setFillColor(red: next(), green: next(), blue: next(), alpha: 1)
                    context.fill(CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
        case 1:
            let gradient = CGGradient(colorsSpace: ThumbnailRenderer.sRGB,
                                      colors: [CGColor(red: next(), green: 0.5, blue: 0.2, alpha: 1),
                                               CGColor(red: 0.1, green: next(), blue: 0.7, alpha: 1)] as CFArray,
                                      locations: [0, 1])!
            context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: width, y: height), options: [])
        case 2:
            context.setFillColor(red: next(), green: next(), blue: next(), alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        default:
            for _ in 0..<10 {
                context.setFillColor(red: next(), green: next(), blue: next(), alpha: 1)
                context.fill(CGRect(x: upTo(width) - 1, y: upTo(height) - 1, width: upTo(width), height: upTo(height)))
            }
        }
        return context.makeImage()!
    }

    mutating func quality() -> Double { next() }
}

/// Placeholder is lib/placeholder.js in Swift: what one is, read as the
/// server reads it, the size it is drawn at, and the one this Mac makes —
/// which the server must keep as it is sent.
struct PlaceholderTests {
    // MARK: - What a placeholder is

    @Test func aWebPOrAJPEGAsTheWebWritesThem() throws {
        let picture = try #require(Placeholder(dataURL: webp))
        #expect(picture.format == .webp)
        #expect(picture.dataURL == webp, "and written back byte for byte")
        let small = try #require(ThumbnailRenderer.decoded(picture.data))
        #expect(small.width == 24 && small.height == 18, "ImageIO reads the browser's WebP as it is")

        let start = try #require(Placeholder(dataURL: jpeg))
        #expect(start.format == .jpeg && start.data == Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46]))
        // Unpadded, as atob reads it too.
        #expect(Placeholder(dataURL: "data:image/jpeg;base64,/9j/4AAQSkZJRg") == start)
    }

    @Test func nothingElseAnImgWouldTake() {
        let svg = "data:image/svg+xml;base64," + Data(#"<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>"#.utf8).base64EncodedString()
        let png = "data:image/png;base64," + Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).base64EncodedString()
        for bad in [
            svg, png, "https://evil.test/p.webp",
            webp.replacingOccurrences(of: "image/webp", with: "image/jpeg"),
            jpeg.replacingOccurrences(of: "image/jpeg", with: "image/webp"),
            "data:image/webp;base64,", "data:image/webp;base64,@@@", webp + " ", " " + webp,
            "data:image/webp;base64," + String(repeating: "A", count: Placeholder.maxChars),
            "data:image/jpeg;base64,/9j/4AAQSkZJRg=", "data:image/jpeg;base64,/9j/4A==AQSkZJRg==",
            "DATA:image/jpeg;base64,/9j/4AAQSkZJRg==",
        ] {
            #expect(Placeholder(dataURL: bad) == nil, "\(bad.prefix(40))")
        }
        #expect(Placeholder(format: .jpeg, data: Data([0x89, 0x50, 0x4E])) == nil, "bytes that are not the format")
        #expect(Placeholder(format: .jpeg, data: Data([0xFF, 0xD8, 0xFF] + [UInt8](repeating: 0, count: 1200))) == nil,
                "past PLACEHOLDER_MAX_CHARS as a data URL")
    }

    @Test func itsSizeIsTheWebs() {
        // placeholderSize, as test/placeholder.test.js has it.
        #expect(Placeholder.size(for: PixelSize(width: 4000, height: 3000)) == PixelSize(width: 24, height: 18))
        #expect(Placeholder.size(for: PixelSize(width: 1080, height: 1920)) == PixelSize(width: 14, height: 24))
        #expect(Placeholder.size(for: PixelSize(width: 10000, height: 10)) == PixelSize(width: 24, height: 1))
        #expect(Placeholder.size(for: PixelSize(width: 0, height: 10)) == nil)
        #expect(Placeholder.size(for: nil) == nil)
        // A list row's picture, and a card's, of a 16:9 clip.
        #expect(Placeholder.size(for: PixelSize(width: 213, height: 120)) == PixelSize(width: 24, height: 14))
    }

    // MARK: - In a file's metadata

    @Test func aListingsPlaceholderIsReadAndABadOneIsNone() throws {
        func decode(_ json: String) throws -> FileMetadata {
            try JSONDecoder().decode(FileMetadata.self, from: Data(json.utf8))
        }
        let read = try decode(#"{ "width": 4032, "height": 3024, "placeholder": "\#(webp)" }"#)
        #expect(read.placeholder?.format == .webp && read.width == 4032)
        let bad = try decode(#"{ "width": 4032, "placeholder": "data:image/svg+xml;base64,PHN2Zz4=" }"#)
        #expect(bad == FileMetadata(width: 4032), "the rest of the metadata still reads")
        #expect(try decode(#"{ "placeholder": 7 }"#) == FileMetadata())
        #expect(try decode(#"{ "placeholder": null }"#) == FileMetadata())

        // Written back as the server keeps it, and read again the same.
        let written = try JSONEncoder().encode(read)
        let object = try #require(try JSONSerialization.jsonObject(with: written) as? [String: Any])
        #expect(object["placeholder"] as? String == webp)
        #expect(try JSONDecoder().decode(FileMetadata.self, from: written) == read)
    }

    @Test func aRowOfTheListingCarriesIt() throws {
        let json = #"""
        { "id": "f1", "name": "IMG_0001.HEIC", "folder": "Day 1", "kind": "image", "mime": "image/heic", "size": 3456789,
          "url": null, "storageKey": null, "thumbnailUrl": "https://s3.test/t?sig", "tags": [], "notes": null, "caption": null,
          "visibility": "org", "version": 2, "contentHash": null, "createdBy": null, "createdAt": 1, "updatedAt": 2,
          "deletedAt": null, "seq": 9, "thumbnailKey": "_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp",
          "metadata": { "width": 4032, "height": 3024, "placeholder": "\#(jpeg)", "client": "Acme" } }
        """#
        let file = try JSONDecoder().decode(FileItem.self, from: Data(json.utf8))
        #expect(file.metadata?.placeholder == Placeholder(dataURL: jpeg))
    }

    // MARK: - Squeezing a JPEG

    @Test func squeezingLosesNothingButBytes() throws {
        var pictures = Pictures()
        for trial in 0..<160 {
            let picture = pictures.picture(trial)
            let written = try ThumbnailRenderer.encode(picture, as: .jpeg, quality: pictures.quality()).data
            let bare = try #require(TinyJPEG.bare(written))
            let squeezed = try #require(TinyJPEG.squeezed(written), "trial \(trial): \(picture.width)x\(picture.height)")
            #expect(ThumbnailRenderer.samePicture(squeezed, written), "trial \(trial): the same pixels")
            #expect(squeezed.count <= bare.count, "trial \(trial): never bigger than without its segments")
            #expect(!markers(squeezed).contains { (0xE1...0xEF).contains($0) }, "trial \(trial)")
            #expect(markers(squeezed).filter { $0 == 0xC4 }.count == 1, "one set of tables, its own")
        }
    }

    @Test func bareIsTheServersCompaction() throws {
        // test/placeholder.test.js's own: a JFIF segment, a colour profile
        // after it, and a scan. The profile goes; the rest is kept as it was.
        func segment(_ marker: UInt8, _ body: [UInt8]) -> [UInt8] {
            [0xFF, marker, UInt8((body.count + 2) >> 8), UInt8((body.count + 2) & 0xFF)] + body
        }
        let jfif = segment(0xE0, Array("JFIF\0".utf8) + [1, 1, 0, 0, 1, 0, 1, 0, 0])
        let icc = segment(0xE2, Array("ICC_PROFILE\0".utf8) + [UInt8](repeating: 0x63, count: 600))
        let scan: [UInt8] = [0xFF, 0xDA, 0, 8] + Array("rest-of-scan".utf8) + [0xFF, 0xD9]
        let whole = Data([0xFF, 0xD8] + jfif + icc + scan)
        #expect(TinyJPEG.bare(whole) == Data([0xFF, 0xD8] + jfif + scan))
        #expect(TinyJPEG.squeezed(whole) == nil, "not a JPEG it reads: left for the caller to keep as it was")
        #expect(TinyJPEG.bare(Data("not a jpeg".utf8)) == nil)
    }

    @Test func tablesAreAlwaysOnesAJPEGDecoderTakes() throws {
        // One symbol; a few; and counts that grow like Fibonacci's, which
        // Huffman's procedure alone would give codes longer than 16 bits
        // (some 24: within the 32 libjpeg allows before folding them back).
        var fibonacci = [Int](repeating: 0, count: 256)
        var (a, b) = (1, 1)
        for s in 0..<25 {
            fibonacci[s] = a
            (a, b) = (b, a + b)
        }
        var few = [Int](repeating: 0, count: 256)
        few[0] = 50; few[1] = 3; few[0xF0] = 1; few[0x21] = 9
        var one = [Int](repeating: 0, count: 256)
        one[7] = 12
        for counts in [one, few, fibonacci] {
            let table = try #require(TinyJPEG.optimalTable(counts))
            let used = counts.filter { $0 > 0 }.count
            #expect(table.symbols.count == used && table.bits.map(Int.init).reduce(0, +) == used)
            // Kraft's sum under one: every code fits in 16 bits, and none is all ones.
            let kraft = table.bits.enumerated().reduce(0.0) { $0 + Double($1.element) / Double(1 << ($1.offset + 1)) }
            #expect(kraft < 1)
        }
    }

    // MARK: - The one this Mac makes

    @Test func theMacsPlaceholderIsOneTheServerKeepsAsItIsSent() throws {
        let folder = Samples.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        // A camera's photo, turned by its EXIF, and one in Display P3, as an
        // iPhone takes them: ImageIO writes the P3 one with its profile.
        let photo = try Samples.image(in: folder, name: "IMG_0001.jpg", type: .jpeg, width: 3000, height: 2000, orientation: 6)
        let p3 = folder.appendingPathComponent("IMG_0002.jpg")
        let context = CGContext(data: nil, width: 4032, height: 3024, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.displayP3)!,
                                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        Samples.bars(context, width: 4032, height: 3024, frame: 3)
        let destination = CGImageDestinationCreateWithURL(p3 as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        #expect(CGImageDestinationFinalize(destination))

        for (file, shown) in [(photo, PixelSize(width: 16, height: 24)), (p3, PixelSize(width: 24, height: 18))] {
            let set = try ThumbnailRenderer.image(file, bytes: 10_000_000, mime: "image/jpeg", name: file.lastPathComponent,
                                                  format: .jpeg)
            let placeholder = try #require(set.placeholder, "\(file.lastPathComponent)")
            #expect(placeholder.format == .jpeg)
            #expect(Array(placeholder.data.prefix(3)) == [0xFF, 0xD8, 0xFF], "what the server checks")
            let drawn = try #require(ThumbnailRenderer.decoded(placeholder.data))
            #expect(PixelSize(width: drawn.width, height: drawn.height) == shown, "24 on the long side, upright")
            // Nothing but the picture: no Exif, no colour profile, nothing
            // for the server to take off.
            #expect(!markers(placeholder.data).contains { (0xE1...0xEF).contains($0) })
            #expect(placeholder.data.range(of: Data("ICC_PROFILE".utf8)) == nil)
            #expect(serverKeeps(placeholder.dataURL) == placeholder.dataURL, "kept as it is sent")
            #expect(placeholder.dataURL.utf8.count <= 900, "\(placeholder.dataURL.utf8.count) characters")
            #expect(set.byteCount == set.grid.data.count + (set.sm?.data.count ?? 0) + (set.xs?.data.count ?? 0)
                    + (set.large?.data.count ?? 0) + placeholder.data.count)
        }
    }

    @Test func aTransparentOrATinyPictureAsTheWebDrawsIt() throws {
        let context = CGContext(data: nil, width: 20, height: 15, bitsPerComponent: 8, bytesPerRow: 0,
                                space: ThumbnailRenderer.sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        Samples.bars(context, width: 20, height: 15, frame: 0)
        let tiny = context.makeImage()!
        // A JPEG would put transparency on black: a browser makes that one.
        #expect(ThumbnailRenderer.placeholder(of: tiny, alpha: true) == nil)
        // No bigger than a placeholder: its own, never enlarged.
        let own = try #require(ThumbnailRenderer.placeholder(of: tiny, alpha: false))
        let drawn = try #require(ThumbnailRenderer.decoded(own.data))
        #expect(drawn.width == 20 && drawn.height == 15)
    }
}
