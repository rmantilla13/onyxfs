import Foundation

/// Wire models for proxy renditions: small H.264 copies of heavy videos that
/// stream and seek everywhere, the iPhone included (lib/proxies.js). The
/// server keeps the queue and decides the rendition; a Mac claims a job,
/// makes the copy, uploads it where the claim said, and says it is done.

/// A video waiting for a proxy (`GET /api/proxies/queue`).
public struct ProxyJob: Codable, Sendable, Equatable, Identifiable {
    public let fileId: String
    public let name: String
    public let mime: String?
    public let size: Int64?
    /// The source's height, when something measured it.
    public let height: Int?

    public var id: String { fileId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fileId = try c.decode(String.self, forKey: .fileId)
        name = try c.decode(String.self, forKey: .name)
        mime = try c.decodeIfPresent(String.self, forKey: .mime)
        size = try c.decodeLenientInt64(forKey: .size)
        height = (try c.decodeLenientInt64(forKey: .height)).map { Int($0) }
    }
}

/// The rendition the server decided on (lib/proxies.js proxySpec).
public struct ProxySpec: Codable, Sendable, Equatable {
    /// The short side's size: 1080 at most, never more than the source's.
    public let height: Int
    /// The bitrate ceiling, kilobits a second.
    public let maxrateKbps: Int
    public let audioKbps: Int

    public init(height: Int, maxrateKbps: Int, audioKbps: Int) {
        self.height = height; self.maxrateKbps = maxrateKbps; self.audioKbps = audioKbps
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        height = (try c.decodeLenientInt64(forKey: .height)).map { Int($0) } ?? 1080
        maxrateKbps = (try c.decodeLenientInt64(forKey: .maxrateKbps)).map { Int($0) } ?? 6000
        audioKbps = (try c.decodeLenientInt64(forKey: .audioKbps)).map { Int($0) } ?? 128
    }
}

/// A job this Mac holds (`POST /api/files/<id>/proxy/claim`): where to read
/// the master from, what to make, and where to put it. The server named
/// both URLs; the Mac chooses neither.
public struct ProxyClaim: Codable, Sendable, Equatable {
    public let fileId: String
    public let name: String
    public let mime: String?
    public let size: Int64?
    /// The object the master is (the file's storage key as the claim found
    /// it): a copy of the bytes this Mac uploaded to that key is the master.
    public let sourceKey: String?
    /// The file's content hash (`content_hash`), should the server send it:
    /// it changes exactly when the bytes do, and not on a rename.
    public let contentHash: String?
    public let spec: ProxySpec
    /// The most one upload may carry; past it the job fails rather than
    /// storing a copy cut short.
    public let maxBytes: Int64?
    public let downloadUrl: URL
    public let uploadUrl: URL
    public let leaseSeconds: Int?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fileId = try c.decode(String.self, forKey: .fileId)
        name = try c.decode(String.self, forKey: .name)
        mime = try c.decodeIfPresent(String.self, forKey: .mime)
        size = try c.decodeLenientInt64(forKey: .size)
        sourceKey = Self.text(c, .sourceKey)
        contentHash = Self.text(c, .contentHash)
        spec = try c.decodeIfPresent(ProxySpec.self, forKey: .spec) ?? ProxySpec(height: 1080, maxrateKbps: 6000, audioKbps: 128)
        maxBytes = try c.decodeLenientInt64(forKey: .maxBytes)
        downloadUrl = try c.decode(URL.self, forKey: .downloadUrl)
        uploadUrl = try c.decode(URL.self, forKey: .uploadUrl)
        leaseSeconds = (try c.decodeLenientInt64(forKey: .leaseSeconds)).map { Int($0) }
    }

    /// A string that is there and not empty. Anything else is nil rather
    /// than a failed claim: these only say whether a copy on this Mac is the
    /// master, and without them the master is downloaded, as it always was.
    private static func text<Key: CodingKey>(_ c: KeyedDecodingContainer<Key>, _ key: Key) -> String? {
        guard let value = try? c.decodeIfPresent(String.self, forKey: key), !value.isEmpty else { return nil }
        return value
    }
}

/// Which files the server asks for a proxy of as they are uploaded
/// (lib/proxies.js shouldProxy): a video, by its type and name as
/// lib/media.js fileKind has it, of at least PROXY_MIN_BYTES, in the bucket
/// (every upload from this Mac is). The server decides; this only says
/// which of this Mac's uploads a job will come for, so their bytes are
/// worth keeping for it (ProxySources).
public enum ProxyRule {
    /// lib/proxies.js PROXY_MIN_BYTES.
    public static let minBytes: Int64 = 200 * 1024 * 1024

    public static func asksForProxy(name: String, mime: String?, size: Int64) -> Bool {
        size >= minBytes && isVideo(name: name, mime: mime)
    }

    /// lib/media.js fileKind: an image by its type or its extension is an
    /// image whatever else it says; then a video by either.
    static func isVideo(name: String, mime: String?) -> Bool {
        let type = (mime ?? "").lowercased()
        let ext = (name as NSString).pathExtension.lowercased()
        if type.hasPrefix("image/") || imageExtensions.contains(ext) { return false }
        return type.hasPrefix("video/") || videoExtensions.contains(ext)
    }

    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "heic", "heif",
                                               "tif", "tiff"]
    static let videoExtensions: Set<String> = ["mp4", "webm", "mov", "m4v", "ogv"]
}

/// What a finished proxy is (`PUT /api/files/<id>/proxy`): what the player
/// needs before its first byte.
public struct ProxyResult: Codable, Sendable, Equatable {
    public let width: Int
    public let height: Int
    public let size: Int64
    public let duration: Double

    public init(width: Int, height: Int, size: Int64, duration: Double) {
        self.width = width; self.height = height; self.size = size; self.duration = duration
    }
}

/// A 409 from a proxy route, told apart by its code, as for transcripts.
public enum ProxyConflict: Error, Equatable, LocalizedError {
    /// Another Mac holds the job: take the next.
    case taken
    /// Not this Mac's any more — requested again, deleted, or its lease ran
    /// out and another Mac took it. The work is thrown away.
    case lost

    public var errorDescription: String? {
        switch self {
        case .taken: return "Another Mac is already making this video's streamable version."
        case .lost: return "This streamable version was asked for again or removed while it was being made."
        }
    }

    static func from(status: Int, data: Data) -> ProxyConflict? {
        guard status == 409,
              let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String
        else { return nil }
        switch code {
        case "taken": return .taken
        case "lost": return .lost
        default: return nil
        }
    }
}
