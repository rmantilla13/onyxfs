import Foundation

/// Wire models. Every field here was read off the server rather than guessed:
/// `shapeFile` in lib/db.js for files, the handler in app/api/space/sts for
/// credentials. Anything the server can send as null is Optional, because a
/// non-optional that arrives null fails the whole decode, not just that field.

/// TIMESTAMPS ARE EPOCH MILLISECONDS throughout this API, not ISO-8601 and not
/// seconds. Decoding one as seconds puts every file in 1970 and sorts the
/// library backwards, which looks like a UI bug for a long time.
public struct EpochMillis: Codable, Sendable, Equatable, Comparable {
    public let raw: Int64
    public var date: Date { Date(timeIntervalSince1970: Double(raw) / 1000) }
    public init(_ raw: Int64) { self.raw = raw }
    public init(from decoder: Decoder) throws {
        raw = try decoder.singleValueContainer().decode(Int64.self)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer(); try c.encode(raw)
    }
    public static func < (a: Self, b: Self) -> Bool { a.raw < b.raw }
}

public struct FileItem: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let folder: String
    public let kind: String
    public let mime: String?
    public let size: Int64?
    /// Presigned and therefore SHORT-LIVED. Never cache this; re-fetch when it
    /// expires. Storing it is how a library ends up full of dead links.
    public let url: String?
    public let storageKey: String?
    public let thumbnailUrl: String?
    public let tags: [String]
    public let notes: String?
    public let caption: String?
    public let visibility: String?
    /// Bumped on every write. Backs `If-Match` and tells an enumerator that
    /// something changed without fetching the bytes.
    public let version: Int
    /// Changes only when the BYTES change, so a rename can be applied without
    /// re-downloading a 40 GB master.
    public let contentHash: String?
    public let createdBy: String?
    public let createdAt: EpochMillis?
    public let updatedAt: EpochMillis?
    public let deletedAt: EpochMillis?
    /// Monotonic change sequence. The delta cursor is a `seq`, never a date:
    /// two writes in the same millisecond can straddle a timestamp cursor and
    /// one of them is then lost forever.
    public let seq: Int64?
}

public struct Tombstone: Codable, Sendable, Equatable {
    public let id: String
    public let seq: Int64
    public let folder: String?
    public let storageKey: String?
}

public struct DeltaPage: Codable, Sendable {
    public let changed: [FileItem]
    public let deleted: [Tombstone]
    /// Feed this back as `?cursor=`. Persist it only once the page has been
    /// applied — advancing past work that was not committed skips it silently.
    public let cursor: Int64
    /// False when more pages remain at this instant.
    public let done: Bool
}

public struct Filespace: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let bucket: String?
    public let prefix: String?
    public let region: String?
}

/// The response from `POST /api/space/sts`.
public struct SpaceCredentials: Codable, Sendable {
    public let filespaceId: String
    public let name: String?
    public let role: String?
    public let accessKeyId: String
    public let secretAccessKey: String
    public let sessionToken: String?
    /// NULL for the `static`, `filespace-static` and B2 static rungs — those
    /// keys do not expire. Treat absent as "nothing to refresh" rather than
    /// crashing on a missing date, which is what the Tauri client learned to
    /// do the hard way.
    public let expiration: EpochMillis?
    public let bucket: String
    public let prefix: String?
    public let region: String?
    /// Which rung of the credential ladder produced these:
    /// filespace-static | assume-role | b2-native | federation | static.
    public let mode: String?
    public let endpoint: String?

    public var sigV4: SigV4.Credentials {
        .init(accessKeyId: accessKeyId, secretAccessKey: secretAccessKey, sessionToken: sessionToken)
    }

    /// A static key has no expiry, so "expired" is false rather than unknown.
    public func isExpired(now: Date = Date(), slack: TimeInterval = 300) -> Bool {
        guard let expiration else { return false }
        return expiration.date.timeIntervalSince(now) < slack
    }

    /// The host to sign against.
    ///
    /// `endpoint` is a full URL for anything that is not AWS (B2, R2, Spaces,
    /// MinIO); AWS itself sends none, so the regional hostname is derived.
    /// Path-style addressing is used throughout, which is why the bucket
    /// appears in the PATH rather than here — see the note in
    /// lib/storage.js about a bucket pasted onto the end of an endpoint.
    public var host: String? {
        if let endpoint, !endpoint.isEmpty {
            // Tolerate a stored value with no scheme. The web side normalises
            // this on save, but a config written before that did not.
            let withScheme = endpoint.contains("://") ? endpoint : "https://" + endpoint
            return URLComponents(string: withScheme)?.host
        }
        guard let region, !region.isEmpty else { return nil }
        return "s3.\(region).amazonaws.com"
    }
}

public struct DesktopToken: Codable, Sendable {
    public let token: String
    public let email: String
    public let expiresAt: EpochMillis?
}
