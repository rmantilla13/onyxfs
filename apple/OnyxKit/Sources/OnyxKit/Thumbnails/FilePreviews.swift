import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Which of the web's pictures of a file exist, as the change feed says:
/// its grid thumbnail, that thumbnail's smaller siblings (sm, xs), and the
/// large picture (a video's player poster, an image's preview). What the
/// thumbnail worker reads to find the files that have none.
///
/// Three bits a file, kept in the drive's replica, rather than the keys
/// themselves: a hundred thousand files' keys would be megabytes held for
/// the one question of whether there are any.
public struct FilePreviews: OptionSet, Codable, Sendable, Hashable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue }

    public static let thumbnail = FilePreviews(rawValue: 1 << 0)
    public static let sizes = FilePreviews(rawValue: 1 << 1)
    public static let poster = FilePreviews(rawValue: 1 << 2)

    /// As a row of the feed has them. A thumbnail is only one the server
    /// named (lib/media.js isThumbKey); siblings only count beside it.
    public init(_ item: FileItem) {
        var previews: FilePreviews = []
        if Self.isThumbKey(item.thumbnailKey) {
            previews.insert(.thumbnail)
            if !(item.thumbSizes ?? []).isEmpty { previews.insert(.sizes) }
        }
        if item.posterKey != nil { previews.insert(.poster) }
        self = previews
    }

    /// `_thumbs/<uuid>.webp` or `.jpg`, as the presign route names a grid
    /// thumbnail (lib/media.js isThumbKey).
    public static func isThumbKey(_ key: String?) -> Bool {
        guard let key, key.hasPrefix("_thumbs/") else { return false }
        let name = key.dropFirst("_thumbs/".count)
        guard let dot = name.lastIndex(of: ".") else { return false }
        let uuid = name[..<dot]
        let ext = name[name.index(after: dot)...]
        return (ext == "webp" || ext == "jpg") && uuid.count == 36
            && uuid.allSatisfy { $0 == "-" || ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
}

extension Poster.Kind {
    /// Whether this Mac can draw a picture of a file, and which kind: a
    /// video AVFoundation opens, or an image ImageIO decodes — which is
    /// more than a browser does (HEIC, TIFF and camera RAW, which keep
    /// their placeholder on the web until someone makes them a thumbnail).
    /// By its type, then by its name's extension, as lib/media.js reads a
    /// file (a type the server stored as octet-stream says nothing).
    public static func of(name: String, mime: String?) -> Poster.Kind? {
        let ext = (name as NSString).pathExtension.lowercased()
        let type = mime?.lowercased() ?? ""
        let key = type + "\u{0}" + ext
        if let known = lock.withLock({ cache[key] }) { return known.kind }
        var candidates: [UTType] = []
        if !type.isEmpty, let t = UTType(mimeType: type) { candidates.append(t) }
        if !ext.isEmpty, let t = UTType(filenameExtension: ext) { candidates.append(t) }
        let kind = candidates.lazy.compactMap(classify).first
        lock.withLock { cache[key] = Known(kind: kind) }
        return kind
    }

    private struct Known { let kind: Poster.Kind? }

    /// Kinds already worked out, by type and extension: a drive has
    /// thousands of files and a handful of kinds.
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: Known] = [:]

    private static func classify(_ type: UTType) -> Poster.Kind? {
        if type.conforms(to: .movie) || type.conforms(to: .video) {
            return AVTypes.readable.contains(type.identifier) ? .video : nil
        }
        if type.conforms(to: .image) {
            return ImageTypes.readable.contains(type.identifier) ? .image : nil
        }
        return nil
    }

    private enum AVTypes {
        static let readable = Set(AVURLAsset.audiovisualTypes().map(\.rawValue))
    }

    private enum ImageTypes {
        static let readable = Set((CGImageSourceCopyTypeIdentifiers() as? [String]) ?? [])
    }
}

/// What a file lacks, for the thumbnail worker.
public enum ThumbnailNeed: String, Sendable, Codable {
    /// No thumbnail at all: the whole set is made.
    case missing
    /// A thumbnail without the smaller siblings every one made since they
    /// existed has: most often one of the old 480px ones, which is made
    /// again; or one new enough to keep (a small picture has no siblings),
    /// which a look at it tells (Poster.isUndersized).
    case check
}

/// One file waiting for a picture, in one drive (a SyncDomain identifier).
public struct ThumbnailCandidate: Sendable, Equatable {
    public let fileId: String
    public let scope: String
    public let version: Int
    public let need: ThumbnailNeed
    public let kind: Poster.Kind
    /// When it was added, in milliseconds: the newest go first.
    public let added: Int64

    public init(fileId: String, scope: String, version: Int, need: ThumbnailNeed, kind: Poster.Kind, added: Int64) {
        self.fileId = fileId; self.scope = scope; self.version = version
        self.need = need; self.kind = kind; self.added = added
    }

    /// The file as the replica has it, when it is one this Mac should make
    /// pictures of. It follows the browser's rules (lib/thumbnail-client.js):
    ///   - a video or an image this Mac can draw, an image no bigger than
    ///     the web would decode (Poster.thumbSourceMaxBytes);
    ///   - with no thumbnail (`missing`), or a video with one that may be of
    ///     the old small kind (`check`).
    /// An image's original is read whole to draw it — megabytes a photo,
    /// for a whole library at once — so one that has a thumbnail, however
    /// old, is left to the browser, which remakes it when someone looks at
    /// it. A video's frame is a few megabytes read from the file, whatever
    /// its size.
    ///
    /// Nil for anything else, and for a file whose previews the replica does
    /// not know yet (saved before they were kept; it is fetched again).
    public init?(_ file: ReplicaFile, scope: String) {
        guard let need = Self.need(file.previews) else { return nil }
        guard let kind = Poster.Kind.of(name: file.name, mime: file.mime) else { return nil }
        if kind == .image, need == .check { return nil }
        if kind == .image, let size = file.size, size > Poster.thumbSourceMaxBytes { return nil }
        if let size = file.size, size <= 0 { return nil }
        self.init(fileId: file.id, scope: scope, version: file.version, need: need, kind: kind,
                  added: (file.createdAt ?? file.updatedAt)?.raw ?? 0)
    }

    static func need(_ previews: FilePreviews?) -> ThumbnailNeed? {
        guard let previews else { return nil }
        if !previews.contains(.thumbnail) { return .missing }
        if !previews.contains(.sizes) { return .check }
        return nil
    }

    /// The cheap half of `init`, for a whole drive on its mirror's actor:
    /// a file whose previews are known and fall short. The kind is worked
    /// out afterwards, off that actor, for these few.
    @Sendable public static func lacksPreviews(_ file: ReplicaFile) -> Bool {
        need(file.previews) != nil
    }

    /// The order work is done in: a tile with no picture at all before a
    /// soft one (as the browser's queue), a video before an image (what a
    /// browser is slowest at, and what this Mac was asked to make), and the
    /// newest first, since that is what someone is waiting to see.
    public func goesBefore(_ other: ThumbnailCandidate) -> Bool {
        if need != other.need { return need == .missing }
        if kind != other.kind { return kind == .video }
        if added != other.added { return added > other.added }
        return fileId < other.fileId
    }
}
