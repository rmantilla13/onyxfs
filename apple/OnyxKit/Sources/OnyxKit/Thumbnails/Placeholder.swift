import Foundation

/// A thumbnail's picture, tiny enough to ride in its row (lib/placeholder.js):
/// the thumbnail again, `edge` pixels on its long side — a hundred or a few
/// hundred bytes of WebP or JPEG — kept in the row's `metadata.placeholder`
/// as a data URL. The listing that draws a folder has it already, so a tile
/// shows its picture, softened, the moment it is drawn, and sharpens when the
/// thumbnail arrives: no request, and nothing but ImageIO to read it.
///
/// Read as the server reads one (placeholderFacts): a data URL of a WebP or a
/// JPEG and nothing else, no longer than `maxChars`, whose bytes start as
/// that format's do. The server stores only such a one, compacted
/// (compactPlaceholder), and fills it in itself — it is one of the media keys
/// (lib/media.js), never a metadata edit's. It is read again here rather than
/// trusted, and one that is not a placeholder is none: never a row that fails
/// to decode.
///
/// Onyx for Mac makes one with each thumbnail it makes
/// (ThumbnailRenderer.placeholder), as a JPEG, since ImageIO writes no WebP.
/// A thumbnail from before placeholders gets its one from a browser, which
/// draws it from the smallest picture the row has as the tile comes into
/// view; the Mac downloads nothing for them.
public struct Placeholder: Sendable, Hashable {
    public enum Format: String, Sendable {
        case webp, jpeg
    }

    public let format: Format
    /// The picture's bytes, as the data URL carries them.
    public let data: Data

    /// How many pixels a placeholder is on its long side (PLACEHOLDER_EDGE).
    public static let edge = 24
    /// The most a stored one may be, as a data URL (PLACEHOLDER_MAX_CHARS):
    /// past this it is not a placeholder any more.
    public static let maxChars = 1600

    /// `data` as a placeholder in `format`: when its bytes start as that
    /// format's do, and it is within `maxChars` as a data URL.
    public init?(format: Format, data: Data) {
        guard Self.starts(data, as: format),
              Self.prefix(format).utf8.count + (data.count + 2) / 3 * 4 <= Self.maxChars else { return nil }
        self.format = format
        self.data = data
    }

    /// A data URL as the server keeps one, or nil when it is not one: not a
    /// WebP or a JPEG (an SVG or a link would be something a page runs or
    /// fetches), not base64, too long, or bytes that are not what the URL
    /// says they are.
    public init?(dataURL: String) {
        let text = dataURL.utf8
        guard text.count <= Self.maxChars else { return nil }
        guard let format = [Format.webp, .jpeg].first(where: { text.starts(with: Self.prefix($0).utf8) }) else { return nil }
        var payload = String(decoding: text.dropFirst(Self.prefix(format).utf8.count), as: UTF8.self)
        guard !payload.isEmpty else { return nil }
        // As atob reads it: padded or not. Anything that is not base64 is
        // refused by the decoding itself.
        if !payload.hasSuffix("=") {
            switch payload.utf8.count % 4 {
            case 1: return nil
            case 2: payload += "=="
            case 3: payload += "="
            default: break
            }
        }
        guard let data = Data(base64Encoded: payload) else { return nil }
        self.init(format: format, data: data)
    }

    /// As the server keeps it: `data:image/<format>;base64,<bytes>`.
    public var dataURL: String { Self.prefix(format) + data.base64EncodedString() }

    /// Its size for a picture of `source` (placeholderSize): `edge` on the
    /// long side, the shape kept, rounded as the web rounds. Nil without a
    /// size.
    public static func size(for source: PixelSize?) -> PixelSize? {
        guard let s = source, s.width > 0, s.height > 0 else { return nil }
        let scale = Double(edge) / Double(s.longEdge)
        return PixelSize(width: max(1, Int((Double(s.width) * scale).rounded())),
                         height: max(1, Int((Double(s.height) * scale).rounded())))
    }

    static func prefix(_ format: Format) -> String { "data:image/\(format.rawValue);base64," }

    /// Whether `data` starts as a picture in `format` does: RIFF….WEBP, or
    /// a JPEG's start-of-image and the marker after it.
    static func starts(_ data: Data, as format: Format) -> Bool {
        let head = [UInt8](data.prefix(12))
        switch format {
        case .webp:
            return head.count >= 12 && head[0..<4].elementsEqual("RIFF".utf8) && head[8..<12].elementsEqual("WEBP".utf8)
        case .jpeg:
            return head.count >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF
        }
    }
}

/// As the server keeps it, the data URL, so a file's metadata is written
/// back as it was read.
extension Placeholder: Codable {
    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let placeholder = Placeholder(dataURL: text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a placeholder"))
        }
        self = placeholder
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(dataURL)
    }
}
