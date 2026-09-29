import Foundation

// Saving a file out of Onyx on a phone: to the photo library, to a folder in
// the Files app, or through the share sheet. What a file is offered, what it
// is called once it lands, and what the progress reads as — decided here,
// with nothing of UIKit or Photos, so it is tested by `swift test`.

/// Where a file someone chose goes.
public enum SaveDestination: String, Codable, Sendable, CaseIterable {
    /// The photo library, as a picture or a video.
    case photos
    /// A folder they pick in the Files app.
    case files
    /// The share sheet: AirDrop, Messages, another app.
    case share
}

/// Which of a file's copies is saved.
public enum SaveVariant: String, Codable, Sendable {
    /// The file as it was uploaded.
    case original
    /// A heavy video's streamable copy (lib/proxies.js): H.264 in an mp4, at
    /// most 1080 on its short side — a fraction of an action camera's master.
    case streamable
}

/// What the photo library can make of a file.
public enum PhotosSupport: Equatable, Sendable {
    case photo
    case video
    /// It cannot take it, and why, in a sentence for the screen.
    case unsupported(String)

    public var isSupported: Bool {
        if case .unsupported = self { return false }
        return true
    }

    /// Why not, when it cannot.
    public var reason: String? {
        if case let .unsupported(words) = self { return words }
        return nil
    }
}

public enum SavePlan {
    // MARK: - Photos

    /// Pictures the photo library imports: what cameras and phones write,
    /// the web's formats ImageIO reads, and camera RAW.
    static let photoExtensions: Set<String> = [
        "jpg", "jpeg", "jpe", "heic", "heif", "hif", "png", "gif", "tif", "tiff", "bmp", "webp", "avif",
        "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl",
        "pef", "srw", "3fr", "fff", "iiq", "erf", "kdc", "dcr", "mrw", "mos",
    ]

    /// Videos it imports: QuickTime and MPEG-4, whatever the codec inside
    /// (H.264, HEVC, ProRes) — the containers an iPhone, a GoPro, a DJI or a
    /// Mac writes.
    static let videoExtensions: Set<String> = ["mov", "qt", "mp4", "m4v", "3gp", "3g2"]

    /// Whether the photo library can take a file, by its name first and the
    /// server's kind for it second: a `.mov` recorded before its kind was
    /// known is stored as `other` and is still a video. This is the promise
    /// made before anything is downloaded; the file itself is checked again
    /// once it is here, since a name can be wrong.
    public static func photosSupport(name: String, kind: String? = nil) -> PhotosSupport {
        let ext = (name as NSString).pathExtension.lowercased()
        if photoExtensions.contains(ext) { return .photo }
        if videoExtensions.contains(ext) { return .video }
        let format = ext.isEmpty || ext.count > 5 ? nil : ext.uppercased()
        switch kind {
        case "video":
            return .unsupported(format.map { "Photos can't import \($0) videos." } ?? "Photos can't import this video.")
        case "image":
            return .unsupported(format.map { "Photos can't import \($0) images." } ?? "Photos can't import this image.")
        default:
            return .unsupported("Only photos and videos can be saved to Photos.")
        }
    }

    /// Where a file may go, in the order they are offered. Every file can go
    /// to Files and to the share sheet; Photos only takes what it can import.
    public static func destinations(name: String, kind: String? = nil) -> [SaveDestination] {
        photosSupport(name: name, kind: kind).isSupported ? [.photos, .files, .share] : [.files, .share]
    }

    // MARK: - Names

    /// The longest name a file may have on this device, in bytes of UTF-8.
    static let maxNameBytes = 255

    /// A name a file on this device may have: no folder separators, never
    /// empty, never "." or "..", and short enough for the file system — cut
    /// in its stem, so it keeps its extension.
    public static func fileName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: "\0", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, cleaned != ".", cleaned != ".." else { return "file" }
        guard cleaned.utf8.count > maxNameBytes else { return cleaned }
        let ext = (cleaned as NSString).pathExtension
        let suffix = ext.isEmpty || ext.utf8.count > 16 ? "" : "." + ext
        var stem = suffix.isEmpty ? cleaned : String(cleaned.dropLast(suffix.count))
        while (stem + suffix).utf8.count > maxNameBytes { stem.removeLast() }
        return stem + suffix
    }

    /// The streamable copy's name beside the original's: "GX010042 (1080p).mp4".
    /// Always .mp4, whatever the master was, because that is what it is.
    public static func streamableName(for name: String, shortSide: Int?) -> String {
        let stem = (fileName(name) as NSString).deletingPathExtension
        return fileName("\(stem.isEmpty ? "video" : stem) (\(streamableLabel(shortSide: shortSide))).mp4")
    }

    /// What a copy is called in a menu and in its name: "1080p" once its
    /// frame is known, "streamable" until then.
    public static func streamableLabel(shortSide: Int?) -> String {
        guard let shortSide, shortSide > 0 else { return "streamable" }
        return "\(shortSide)p"
    }

    /// The name each file lands under, given the others saved with it: two
    /// files of one name from different folders (a search's results) would
    /// otherwise land on each other in the one folder picked in Files. The
    /// second becomes "name 2.ext", as Finder numbers them; compared without
    /// case, as the Files app compares.
    public static func uniqueNames(_ names: [String]) -> [String] {
        var taken = Set<String>()
        return names.map { raw in
            let name = fileName(raw)
            if taken.insert(name.lowercased()).inserted { return name }
            let ext = (name as NSString).pathExtension
            let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
            var n = 2
            while true {
                let candidate = ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)"
                if taken.insert(candidate.lowercased()).inserted { return candidate }
                n += 1
            }
        }
    }

    // MARK: - Words

    public static func size(_ bytes: Int64?) -> String? {
        guard let bytes, bytes >= 0 else { return nil }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// How far along, 0…1, when the size is known.
    public static func fraction(received: Int64, expected: Int64?) -> Double? {
        guard let expected, expected > 0 else { return nil }
        return min(max(Double(received) / Double(expected), 0), 1)
    }

    /// "120 MB of 4.2 GB", or "120 MB" while the size is unknown.
    public static func progress(received: Int64, expected: Int64?) -> String {
        let done = size(received) ?? "0 bytes"
        guard let expected, expected > 0, let whole = size(expected) else { return done }
        return "\(done) of \(whole)"
    }

    /// What finished, in the words the tray and VoiceOver use.
    public static func saved(_ count: Int, to destination: SaveDestination) -> String {
        switch destination {
        case .photos: return count == 1 ? "Saved to Photos" : "Saved \(count) to Photos"
        case .files: return count == 1 ? "Saved to Files" : "Saved \(count) to Files"
        case .share: return count == 1 ? "Ready to share" : "\(count) ready to share"
        }
    }

    /// The Save button for a selection: "Save 3 to Photos".
    public static func saveSelection(_ count: Int, to destination: SaveDestination) -> String {
        switch destination {
        case .photos: return count == 1 ? "Save to Photos" : "Save \(count) to Photos"
        case .files: return count == 1 ? "Save to Files" : "Save \(count) to Files"
        case .share: return "Share"
        }
    }
}
