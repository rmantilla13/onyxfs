import Foundation

/// Wire models for video transcripts. The server keeps the queue and the
/// results; a Mac claims a job, transcribes the file on its own, and submits
/// the segments. The shapes are the contract's (transcripts-contract.md in
/// the pull request that added them), not guesses.

/// One caption: start and end in seconds, three decimals, and its text.
/// Short on the wire (`s`, `e`, `t`) because a long recording has
/// thousands of them.
public struct TranscriptSegment: Codable, Sendable, Equatable {
    public var start: Double
    public var end: Double
    public var text: String

    public init(start: Double, end: Double, text: String) {
        self.start = start; self.end = end; self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case start = "s", end = "e", text = "t"
    }
}

/// A file waiting for a transcript (`GET /api/transcripts/queue`).
public struct TranscriptionJob: Codable, Sendable, Equatable, Identifiable {
    public let fileId: String
    public let name: String
    public let mime: String?
    public let size: Int64?
    /// BCP-47, or nil for "the Mac's own language".
    public let language: String?
    public let requestedAt: String?

    public var id: String { fileId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fileId = try c.decode(String.self, forKey: .fileId)
        name = try c.decode(String.self, forKey: .name)
        mime = try c.decodeIfPresent(String.self, forKey: .mime)
        size = try c.decodeLenientInt64(forKey: .size)
        language = try c.decodeIfPresent(String.self, forKey: .language)
        requestedAt = try c.decodeIfPresent(String.self, forKey: .requestedAt)
    }
}

/// A job this Mac now holds (`POST /api/files/<id>/transcript/claim`), with
/// where to download the file from. The link is presigned, so it is used at
/// once and never kept.
public struct TranscriptionClaim: Codable, Sendable, Equatable {
    public let fileId: String
    public let name: String
    public let mime: String?
    public let size: Int64?
    public let language: String?
    /// The version of the file claimed. Sent back with the result, so a
    /// transcript of an older version is known to be stale.
    public let sourceKey: String?
    public let downloadUrl: URL
    public let leaseSeconds: Int?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fileId = try c.decode(String.self, forKey: .fileId)
        name = try c.decode(String.self, forKey: .name)
        mime = try c.decodeIfPresent(String.self, forKey: .mime)
        size = try c.decodeLenientInt64(forKey: .size)
        language = try c.decodeIfPresent(String.self, forKey: .language)
        sourceKey = try c.decodeIfPresent(String.self, forKey: .sourceKey)
        downloadUrl = try c.decode(URL.self, forKey: .downloadUrl)
        leaseSeconds = try c.decodeLenientInt64(forKey: .leaseSeconds).map { Int($0) }
    }
}

/// The body of `PUT /api/files/<id>/transcript`.
public struct TranscriptSubmission: Codable, Sendable, Equatable {
    public let segments: [TranscriptSegment]
    /// The locale the Mac actually used, which may differ from the one asked
    /// for ("en" asked, "en-US" used).
    public let resultLanguage: String
    /// `apple-speechanalyzer` or `apple-sfspeech`.
    public let engine: String
    public let sourceKey: String?

    public init(segments: [TranscriptSegment], resultLanguage: String, engine: String, sourceKey: String?) {
        self.segments = segments; self.resultLanguage = resultLanguage
        self.engine = engine; self.sourceKey = sourceKey
    }
}

/// A 409 from a transcript route, by the `code` the server gives it.
public enum TranscriptionConflict: Error, Equatable, LocalizedError {
    /// Another Mac holds the job. Nothing to say to anyone: take the next.
    case taken
    /// The job is not this Mac's any more — requested again, deleted, or
    /// its lease ran out and another Mac took it. Stop and throw the work
    /// away; submitting it would overwrite someone else's.
    case lost

    public var errorDescription: String? {
        switch self {
        case .taken: return "Another Mac is already transcribing this file."
        case .lost: return "This transcript was requested again or removed while it was being made."
        }
    }

    /// The conflict a response names, if it is one.
    static func from(status: Int, data: Data) -> TranscriptionConflict? {
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

extension KeyedDecodingContainer {
    /// A count that may arrive as a number or as a string: Postgres BIGINTs
    /// reach JSON as strings unless the route converts them, and a size is
    /// not worth failing a whole job over.
    func decodeLenientInt64(forKey key: Key) throws -> Int64? {
        if let n = try? decodeIfPresent(Int64.self, forKey: key) { return n }
        if let d = try? decodeIfPresent(Double.self, forKey: key), d.isFinite { return Int64(d) }
        if let s = try? decodeIfPresent(String.self, forKey: key) { return Int64(s) }
        return nil
    }
}
