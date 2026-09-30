import Foundation

/// A video's streamable copy as the server knows it (`GET
/// /api/files/<id>/proxy`, lib/proxy-guard.js proxyBody): whether there is
/// one to play, and its frame and size — what a phone says of it beside the
/// original before saving either.
///
/// The bytes themselves come from the content link (`ContentLink.proxyUrl`),
/// signed as the original is; this only describes them.
public struct ProxyStatus: Decodable, Sendable, Equatable {
    /// none | queued | working | done | failed.
    public let status: String
    public let width: Int?
    public let height: Int?
    public let size: Int64?
    /// A copy of the file's previous contents: it plays, and shows the wrong
    /// footage, so it is not offered.
    public let stale: Bool

    public init(status: String, width: Int? = nil, height: Int? = nil, size: Int64? = nil, stale: Bool = false) {
        self.status = status; self.width = width; self.height = height; self.size = size; self.stale = stale
    }

    enum CodingKeys: String, CodingKey { case status, width, height, size, stale }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "none"
        width = (try c.decodeLenientInt64(forKey: .width)).map { Int($0) }
        height = (try c.decodeLenientInt64(forKey: .height)).map { Int($0) }
        size = try c.decodeLenientInt64(forKey: .size)
        stale = (try? c.decodeIfPresent(Bool.self, forKey: .stale)) ?? false
    }

    /// Finished, and of these contents.
    public var isReady: Bool { status == "done" && !stale }

    /// "1080" of a 1920 × 1080 copy, or of a 1080 × 1920 one: what the p in
    /// 1080p counts.
    public var shortSide: Int? {
        switch (width, height) {
        case let (w?, h?): return min(w, h)
        case let (nil, h?): return h
        case let (w?, nil): return w
        default: return nil
        }
    }
}

extension OnyxAPI {
    /// What the server says of a video's streamable copy. Read by anyone who
    /// may see the file (openProxy's `read`), so a viewer gets it too.
    public func proxyStatus(fileId: String) async throws -> ProxyStatus {
        struct Wrapper: Decodable { let proxy: ProxyStatus }
        let url = config.url("api/files").appending(component: fileId).appending(path: "proxy")
        return try decode(Wrapper.self, from: try await request(url)).proxy
    }
}
