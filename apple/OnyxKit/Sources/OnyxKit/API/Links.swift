import Foundation

// Links to a file or a folder, as the web's Share dialog makes them
// (lib/share-kinds.js, lib/share-guard.js): what the iPhone's Share Link
// sheet lists, makes, changes and revokes, through the web's own routes with
// the device token — app/api/files/[id]/shares and
// app/api/files/folders/shares (lib/bearer-gate.js lets those through).
//
// The server decides who may. The list says what this person may make
// (`LinkChoices`) and what each link may be changed to (`SharedLink.levels`),
// worked out by the same checks that make and change them, so the sheet
// offers exactly that and guesses nothing; every change is decided again.

/// Who a link opens for (SHARE_KINDS).
public enum LinkKind: String, Codable, Sendable, CaseIterable, Identifiable {
    /// Anyone who has the link.
    case `public`
    /// Anyone who has the link and its password.
    case password
    /// Only signed-in members who can already open the file.
    case `private`

    public var id: String { rawValue }
}

/// What the people a link reaches may do with a photo or a video besides
/// look at it (SHARE_REVIEW). `view` is what the server sends as null.
public enum LinkReview: String, Codable, Sendable, CaseIterable, Identifiable, Comparable {
    case view
    case comment
    case approve

    public var id: String { rawValue }

    private var rank: Int {
        switch self {
        case .view: 0
        case .comment: 1
        case .approve: 2
        }
    }

    public static func < (a: Self, b: Self) -> Bool { a.rank < b.rank }
}

/// When a new link stops working (SHARE_EXPIRY): the ids the server takes.
public enum LinkExpiry: String, Codable, Sendable, CaseIterable, Identifiable {
    case never
    case day = "1"
    case week = "7"
    case month = "30"

    public var id: String { rawValue }

    /// Nil for never.
    public var days: Int? {
        switch self {
        case .never: nil
        case .day: 1
        case .week: 7
        case .month: 30
        }
    }
}

/// A file's or a folder's link, as the server lists it (presentShare).
/// Never its password.
public struct SharedLink: Codable, Sendable, Identifiable, Equatable {
    public let token: String
    /// Where it opens, as a path ("/s/<token>"): on the server this app
    /// talks to, as the web's dialog puts its own origin in front.
    public let path: String?
    /// Nil for a kind this build does not know.
    public let kind: LinkKind?
    /// Nil is view.
    public let review: LinkReview?
    /// Nil: it never expires.
    public let expiresAt: EpochMillis?
    public let viewCount: Int
    public let createdAt: EpochMillis?
    public let createdBy: String?
    /// The levels this person may set it to, its own among them: a file's
    /// link (PATCH decides by the same rule). Nil for a folder's, which
    /// takes no comments.
    public let levels: [LinkReview]?

    public var id: String { token }

    public init(token: String, path: String? = nil, kind: LinkKind?, review: LinkReview? = nil,
                expiresAt: EpochMillis? = nil, viewCount: Int = 0, createdAt: EpochMillis? = nil,
                createdBy: String? = nil, levels: [LinkReview]? = nil) {
        self.token = token; self.path = path; self.kind = kind; self.review = review
        self.expiresAt = expiresAt; self.viewCount = viewCount; self.createdAt = createdAt
        self.createdBy = createdBy; self.levels = levels
    }

    enum CodingKeys: String, CodingKey { case token, path, kind, review, expiresAt, viewCount, createdAt, createdBy, levels }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        path = try? c.decodeIfPresent(String.self, forKey: .path)
        // Read leniently: one link this build cannot place is shown as a
        // link, never a list that fails to load.
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)).flatMap { $0.flatMap(LinkKind.init(rawValue:)) }
        review = (try? c.decodeIfPresent(String.self, forKey: .review)).flatMap { $0.flatMap(LinkReview.init(rawValue:)) }
        expiresAt = (try c.decodeLenientInt64(forKey: .expiresAt)).map(EpochMillis.init)
        viewCount = Int(try c.decodeLenientInt64(forKey: .viewCount) ?? 0)
        createdAt = (try c.decodeLenientInt64(forKey: .createdAt)).map(EpochMillis.init)
        createdBy = try? c.decodeIfPresent(String.self, forKey: .createdBy)
        levels = (try? c.decodeIfPresent([String].self, forKey: .levels)).flatMap { $0?.compactMap(LinkReview.init(rawValue:)) }
    }

    /// What the people it reaches may do.
    public var level: LinkReview { review ?? .view }

    /// The link itself, on `server`.
    public func url(on server: URL) -> URL {
        let path = self.path?.hasPrefix("/") == true ? self.path! : "/s/\(token)"
        return URL(string: path, relativeTo: server)?.absoluteURL ?? server.appending(path: "s").appending(component: token)
    }

    public func isExpired(now: Date = Date()) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt.date <= now
    }

    /// Whether to offer a choice of level: more than its own to choose
    /// from, and not expired — an expired link is only there to be revoked,
    /// as the web's dialog has it.
    public func offersLevels(now: Date = Date()) -> Bool {
        (levels?.count ?? 0) > 1 && !isExpired(now: now)
    }
}

/// What this person may make here, as the server works it out
/// (lib/share-guard.js linkChoices): only these are offered.
public struct LinkChoices: Codable, Sendable, Equatable {
    /// In the web's order: public, password, private.
    public let kinds: [LinkKind]
    /// The levels past view a public or password link may take: comment
    /// and approve, or none.
    public let review: [LinkReview]
    public let expires: [LinkExpiry]
    /// The longest a link of theirs may last; nil for no limit.
    public let maxExpiryDays: Int?
    /// The shortest password a password link takes.
    public let passwordMin: Int
    /// Only when nothing may be made: why not, in the server's words.
    public let reason: String?

    public init(kinds: [LinkKind], review: [LinkReview] = [], expires: [LinkExpiry] = LinkExpiry.allCases,
                maxExpiryDays: Int? = nil, passwordMin: Int = 6, reason: String? = nil) {
        self.kinds = kinds; self.review = review; self.expires = expires
        self.maxExpiryDays = maxExpiryDays; self.passwordMin = passwordMin; self.reason = reason
    }

    /// Nothing may be made: what a server that does not say is taken to mean.
    public static let none = LinkChoices(kinds: [], expires: [])

    enum CodingKeys: String, CodingKey { case kinds, review, expires, maxExpiryDays, passwordMin, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func ids(_ key: CodingKeys) -> [String] { (try? c.decodeIfPresent([String].self, forKey: key)) ?? [] }
        kinds = ids(.kinds).compactMap(LinkKind.init(rawValue:))
        review = ids(.review).compactMap(LinkReview.init(rawValue:)).filter { $0 != .view }
        expires = ids(.expires).compactMap(LinkExpiry.init(rawValue:))
        maxExpiryDays = (try c.decodeLenientInt64(forKey: .maxExpiryDays)).map { Int($0) }
        passwordMin = (try c.decodeLenientInt64(forKey: .passwordMin)).map { Int($0) } ?? 6
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }

    /// Whether a link may be made at all.
    public var canMake: Bool { !kinds.isEmpty && !expires.isEmpty }

    /// Where a new link's expiry starts: never, as the web's does, when that
    /// may be chosen; else the longest that may.
    public var defaultExpiry: LinkExpiry? {
        expires.contains(.never) ? .never : expires.max { ($0.days ?? .max) < ($1.days ?? .max) }
    }

    /// Whether a link of `kind` may take comments: a public or password one,
    /// where the server says review links may be made.
    public func offersReview(for kind: LinkKind) -> Bool { kind != .private && !review.isEmpty }
}

/// One file's or folder's links, and what may be made there.
public struct LinkList: Codable, Sendable, Equatable {
    /// Newest first.
    public let shares: [SharedLink]
    /// Nil from a server that does not say: then nothing is offered.
    public let can: LinkChoices?

    public init(shares: [SharedLink], can: LinkChoices?) {
        self.shares = shares
        self.can = can
    }

    public var choices: LinkChoices { can ?? .none }
}

/// What is shared: a file, or a folder of a drive (or of the library).
public enum LinkTarget: Hashable, Sendable {
    case file(id: String)
    /// `path` as the Files view names it ("Footage/Day 1"); never the top of
    /// a place, which is not a folder a link can be made to.
    case folder(path: String, scope: SyncDomain)
}

/// A link to make.
public struct LinkRequest: Sendable, Equatable {
    public var kind: LinkKind
    /// For a password link; sent only then.
    public var password: String?
    public var expires: LinkExpiry
    /// Sent only past view, and never for a private link or a folder: what
    /// the web's dialog sends.
    public var review: LinkReview

    public init(kind: LinkKind, password: String? = nil, expires: LinkExpiry = .never, review: LinkReview = .view) {
        self.kind = kind; self.password = password; self.expires = expires; self.review = review
    }

    /// The body the create route takes, for `target`.
    func body(for target: LinkTarget) -> [String: Any] {
        var body: [String: Any] = ["kind": kind.rawValue, "expires": expires.rawValue]
        if kind == .password, let password { body["password"] = password }
        switch target {
        case .file:
            if kind != .private, review != .view { body["review"] = review.rawValue }
        case let .folder(path, scope):
            body["folder"] = path
            if case let .drive(id) = scope { body["filespaceId"] = id }
        }
        return body
    }
}

extension OnyxAPI {
    /// The links to `target`, newest first, and what this person may make
    /// there. A 403 says the links are not theirs to manage, in the server's
    /// words (OnyxError.http).
    public func links(to target: LinkTarget) async throws -> LinkList {
        try decode(LinkList.self, from: try await request(linksURL(target)))
    }

    /// Make a link to `target`. The server may hand back one that exists
    /// already, when it is exactly the one asked for (plain, unexpiring).
    public func makeLink(to target: LinkTarget, _ link: LinkRequest) async throws -> SharedLink {
        struct Made: Decodable { let share: SharedLink }
        let url: URL
        switch target {
        case .file: url = linksURL(target)
        case .folder: url = config.url("api/files/folders/shares")
        }
        return try decode(Made.self, from: try await request(url, method: "POST", json: link.body(for: target))).share
    }

    /// Change what the people a file's link reaches may do. → the link as
    /// it is now, with the levels it may go to from here.
    public func setLinkReview(_ review: LinkReview, token: String, fileId: String) async throws -> SharedLink? {
        struct Changed: Decodable { let share: SharedLink? }
        let url = linksURL(.file(id: fileId)).appending(component: token)
        return try decode(Changed.self, from: try await request(url, method: "PATCH", json: ["review": review.rawValue])).share
    }

    /// Revoke a link: it stops working with the next request made to it.
    public func revokeLink(token: String, of target: LinkTarget) async throws {
        let url: URL
        switch target {
        case .file: url = linksURL(target).appending(component: token)
        case .folder: url = config.url("api/files/folders/shares").appending(component: token)
        }
        _ = try await request(url, method: "DELETE")
    }

    /// `api/files/<id>/shares` — the id one path component, whatever it
    /// holds — or `api/files/folders/shares?folder=&filespace=`.
    func linksURL(_ target: LinkTarget) -> URL {
        switch target {
        case let .file(id):
            return config.url("api/files").appending(component: id).appending(path: "shares")
        case let .folder(path, scope):
            var items: [URLQueryItem] = [.init(name: "folder", value: path)]
            if case let .drive(id) = scope { items.append(.init(name: "filespace", value: id)) }
            return config.url("api/files/folders/shares", query: items)
        }
    }
}

/// What a link reads as, as the web's Share dialog says it
/// (app/components/ShareDialog.js, lib/share-kinds.js).
public enum LinkWords {
    public static func title(_ kind: LinkKind) -> String {
        switch kind {
        case .public: "Public"
        case .password: "Password"
        case .private: "Private"
        }
    }

    /// Who it opens for, said for a file or for a folder.
    public static func detail(_ kind: LinkKind, folder: Bool = false) -> String {
        switch kind {
        case .public:
            folder ? "Anyone with the link can open the folder and download what is in it."
                : "Anyone with the link can view and download."
        case .password: "Anyone with the link and the password."
        case .private: "Only signed-in members who can already open this file."
        }
    }

    public static func expiry(_ expiry: LinkExpiry) -> String {
        switch expiry {
        case .never: "Never"
        case .day: "In 1 day"
        case .week: "In 7 days"
        case .month: "In 30 days"
        }
    }

    /// A level as a choice: "View", "Comment", "Comment & approve".
    public static func choice(_ level: LinkReview) -> String {
        switch level {
        case .view: "View"
        case .comment: "Comment"
        case .approve: "Comment & approve"
        }
    }

    /// A level as a link has it: "View only", "Can comment", "Can approve".
    public static func level(_ level: LinkReview) -> String {
        switch level {
        case .view: "View only"
        case .comment: "Can comment"
        case .approve: "Can approve"
        }
    }

    /// What a level lets people do, said for this file: frames on a video,
    /// spots on a picture.
    public static func levelDetail(_ level: LinkReview, video: Bool) -> String {
        switch level {
        case .comment:
            video ? "They can comment on frames and ranges, draw on the picture, and reply."
                : "They can pin comments to spots, draw on the picture, and reply."
        case .approve: "They can comment, and approve it or ask for changes — which counts toward its status."
        case .view: "They can open and download it."
        }
    }

    /// "Expires in 3 days", "Expires in 5 hours", "Expired", or nil for a
    /// link that never does — lib/share-kinds.js expiryLabel, to the hour.
    public static func expires(_ expiresAt: EpochMillis?, now: Date = Date()) -> String? {
        guard let expiresAt else { return nil }
        let ms = Double(expiresAt.raw) - now.timeIntervalSince1970 * 1000
        if ms <= 0 { return "Expired" }
        let hours = Int((ms / 3_600_000).rounded(.up))
        if hours < 24 { return "Expires in \(hours) hour\(hours == 1 ? "" : "s")" }
        let days = Int((ms / 86_400_000).rounded(.up))
        return "Expires in \(days) day\(days == 1 ? "" : "s")"
    }

    /// "1 view", "12 views".
    public static func views(_ count: Int) -> String { count == 1 ? "1 view" : "\(count.formatted()) views" }

    /// The rule a longest expiry makes, for beneath the choice: nil for none.
    public static func maxExpiry(_ days: Int?) -> String? {
        guard let days else { return nil }
        return "Links you make must expire within \(days) day\(days == 1 ? "" : "s")."
    }

    /// What a folder's link reaches, as the web's dialog says it: the
    /// library's leaves out what is in drives.
    public static func folderNote(inDrive: Bool) -> String {
        "People with the link see the folder as it is whenever they open it — its subfolders, and whatever is added later. "
            + "Files shared only with certain people stay out of it"
            + (inDrive ? "." : ", and so do files in drives: share those from their drive.")
    }

    /// When nothing is listed.
    public static func none(folder: Bool) -> String {
        folder ? "None yet. Nobody outside can open this folder by a link to it." : "None yet. Nobody outside can open this file."
    }
}
