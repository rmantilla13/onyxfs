import Foundation

// The iPhone's Home: who is signed in, what each place holds for them, and
// what came in lately. All of it read through the routes a member already
// reads — the listing (GET /api/files), authorized and filtered as the
// files page is — so it counts only what this account may see.

/// What a place holds for this account.
public struct PlaceUsage: Sendable, Equatable {
    public let files: Int
    /// What they weigh; nil from a server that only counts them.
    public let bytes: Int64?

    public init(files: Int, bytes: Int64?) {
        self.files = files
        self.bytes = bytes
    }
}

/// The account a token signs in as (GET /api/desktop/me).
public struct Identity: Decodable, Sendable, Equatable {
    public let email: String
    /// The name it gave itself, when it has one.
    public let name: String?
    public let isAdmin: Bool?

    public init(email: String, name: String? = nil, isAdmin: Bool? = nil) {
        self.email = email
        self.name = name
        self.isAdmin = isAdmin
    }

    /// Who to greet: the first word of the name, or else the part of the
    /// address a person is called by ("ricky.mantilla@…" → "Ricky"). Nil
    /// for an address that names no one ("hi@", "info@").
    public var firstName: String? {
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return name.split(whereSeparator: \.isWhitespace).first.map(String.init)
        }
        return Self.firstName(fromEmail: email)
    }

    static let impersonal: Set<String> = [
        "hi", "hello", "hey", "info", "admin", "me", "mail", "contact", "team", "office", "support",
        "appreview", "review", "test", "user", "demo", "noreply", "no-reply", "help", "sales", "studio",
    ]

    static func firstName(fromEmail email: String) -> String? {
        guard let local = email.split(separator: "@").first?.lowercased() else { return nil }
        let words = local.split(whereSeparator: { ".-_+0123456789".contains($0) })
        guard let first = words.first, first.count >= 2, !impersonal.contains(String(first)) else { return nil }
        return first.prefix(1).uppercased() + first.dropFirst()
    }
}

extension OnyxAPI {
    /// How many files `scope` holds that this account may see, and what they
    /// weigh: the listing's own total (`withTotal`), over exactly the rows it
    /// would list, one row fetched.
    public func usage(of scope: SyncDomain) async throws -> PlaceUsage {
        struct Totals: Decodable {
            let total: Int?
            let totalBytes: Int64?

            enum CodingKeys: String, CodingKey { case total, totalBytes }

            // A BIGINT may arrive as a string.
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                total = (try c.decodeLenientInt64(forKey: .total)).map { Int($0) }
                totalBytes = try c.decodeLenientInt64(forKey: .totalBytes)
            }
        }
        var items: [URLQueryItem] = [
            .init(name: "sort", value: FileSort.newest.rawValue),
            .init(name: "limit", value: "1"),
            .init(name: "withTotal", value: "1"),
            .init(name: "folders", value: "0"),
        ]
        if case let .drive(id) = scope { items.append(.init(name: "filespace", value: id)) }
        let totals = try decode(Totals.self, from: try await request(config.url("api/files", query: items)))
        return PlaceUsage(files: totals.total ?? 0, bytes: totals.totalBytes)
    }

    /// The newest files anywhere in `scope` — every folder of it — a page at
    /// a time.
    public func recentFiles(in scope: SyncDomain = .library, limit: Int = 20, cursor: String? = nil) async throws -> FilePage {
        var items: [URLQueryItem] = [
            .init(name: "sort", value: FileSort.newest.rawValue),
            .init(name: "limit", value: String(limit)),
            .init(name: "folders", value: "0"),
        ]
        if case let .drive(id) = scope { items.append(.init(name: "filespace", value: id)) }
        if let cursor { items.append(.init(name: "cursor", value: cursor)) }
        return try decode(FilePage.self, from: try await request(config.url("api/files", query: items)))
    }

    /// Who this token signs in as, and the name the account gave itself.
    public func identity() async throws -> Identity {
        try decode(Identity.self, from: try await request(config.url("api/desktop/me")))
    }
}

/// When something happened, as a glance at a tile says it: "now", "20m
/// ago", "3h ago", "2d ago", then the date.
public enum RelativeTime {
    public static func short(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "now"
        case ..<3600: return "\(Int(seconds / 60))m ago"
        case ..<86_400: return "\(Int(seconds / 3600))h ago"
        case ..<(7 * 86_400): return "\(Int(seconds / 86_400))d ago"
        default:
            let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
            return sameYear
                ? date.formatted(.dateTime.month(.abbreviated).day())
                : date.formatted(.dateTime.month(.abbreviated).day().year())
        }
    }
}
