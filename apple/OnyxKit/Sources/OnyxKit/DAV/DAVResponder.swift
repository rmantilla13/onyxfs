import Foundation

// The WebDAV half of the Finder mount: what the bridge answers when rclone
// asks about one drive.
//
// Pure — no sockets, no file handles. The socket layer parses HTTP, calls
// `respond(to:)`, and writes out what comes back, so every rule about what the
// mount shows and serves lives here and is testable without rclone.
//
// rclone's webdav backend (vendor "rclone") is the only client. It lists with
// PROPFIND Depth 1, reads with GET (following redirects, keeping its Range
// header), and matches each <D:href> against the URL it asked for, so hrefs
// must carry the same path prefix its remote was configured with.
//
// It ignores getetag. What tells it a cached file is stale is the size and
// getlastmodified (the vendor makes times count), so the modified time must
// move whenever the bytes might have — MirrorIndex takes it from the file's
// updatedAt, which every write to the row moves.

/// One HTTP request, as the socket layer parsed it.
public struct DAVRequest: Sendable {
    public var method: String
    /// The request-target as received: a percent-encoded path, possibly with
    /// a query. Decoding is the responder's job, so an encoded "/" inside a
    /// name can be told apart from a separator.
    public var target: String
    /// Keys lowercased.
    public var headers: [String: String]
    public var body: Data

    public init(method: String, target: String, headers: [String: String] = [:], body: Data = Data()) {
        self.method = method
        self.target = target
        // Lowercased here too: a caller that forgot would otherwise turn a
        // present Authorization header into a missing one.
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) },
                                  uniquingKeysWith: { first, _ in first })
        self.body = body
    }
}

public enum DAVBody: Sendable, Equatable {
    case empty
    case data(Data)
    /// `length` bytes of a local file from `offset`: a pinned copy, or a range
    /// of one. The responder has already checked the span lies within the
    /// file; the socket layer streams it.
    case file(URL, offset: Int64, length: Int64)

    /// How many bytes it writes.
    public var length: Int64 {
        switch self {
        case .empty: return 0
        case let .data(data): return Int64(data.count)
        case let .file(_, _, length): return length
        }
    }
}

public struct DAVResponse: Sendable {
    public var status: Int
    /// In order. Content-Length is always among them and always right —
    /// for HEAD too, where the body is empty and Content-Length is what a GET
    /// would have sent, so the socket layer must not wait for those bytes.
    public var headers: [(String, String)]
    public var body: DAVBody

    public init(status: Int, headers: [(String, String)] = [], body: DAVBody = .empty) {
        self.status = status; self.headers = headers; self.body = body
    }

    /// The first value of a header, by case-insensitive name.
    public func header(_ name: String) -> String? {
        let name = name.lowercased()
        return headers.first { $0.0.lowercased() == name }?.1
    }

    /// For the status line. Covers every status the responder produces.
    public static func reasonPhrase(for status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 206: return "Partial Content"
        case 207: return "Multi-Status"
        case 302: return "Found"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 416: return "Range Not Satisfiable"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        default: return "Status \(status)"
        }
    }
}

/// Answers rclone's WebDAV requests for one drive from a DAVSource.
///
/// It lists exactly what the source holds — which is what the server's
/// access-checked feed says, so the mount shows what the web shows — and
/// never proxies bytes it does not have: a streamed file is a redirect to
/// storage, and only a pinned copy is served from this Mac.
///
/// Read-only for now. Writes are refused with 403 rather than accepted and
/// lost, until writes from Finder have a conflict policy (ROADMAP 5.5).
public struct DAVResponder: Sendable {
    public static let allowedMethods = "OPTIONS, PROPFIND, GET, HEAD"

    /// Refused outright, as opposed to unknown: these are the requests a file
    /// system makes to change something, and "read-only" is the true answer.
    static let writeMethods: Set<String> = ["PUT", "DELETE", "MKCOL", "MOVE", "COPY", "PROPPATCH",
                                            "LOCK", "UNLOCK", "POST", "PATCH"]

    let source: any DAVSource
    let bearerToken: String
    /// Percent-encoded, no trailing slash; "" or "/…".
    let hrefPrefix: String
    /// hrefPrefix's segments, decoded, for matching request targets.
    let prefixSegments: [String]

    /// `hrefPrefix` is the path of the URL rclone's remote points at, already
    /// percent-encoded ("/drive.abc"). Every href starts with it, and a
    /// request-target outside it is 404: rclone drops any listed item whose
    /// href does not start with the path it asked for.
    public init(source: any DAVSource, bearerToken: String, hrefPrefix: String = "") {
        self.source = source
        self.bearerToken = bearerToken
        var prefix = hrefPrefix
        while prefix.hasSuffix("/") { prefix.removeLast() }
        if !prefix.isEmpty && !prefix.hasPrefix("/") { prefix = "/" + prefix }
        self.hrefPrefix = prefix
        self.prefixSegments = prefix.split(separator: "/").map { Self.percentDecode($0) ?? String($0) }
    }

    public func respond(to request: DAVRequest) async -> DAVResponse {
        var response = await answer(request)
        // Set once, here, from the body a GET would carry — so no branch can
        // get it wrong, and HEAD reports the length without sending it.
        response.headers.removeAll { $0.0.lowercased() == "content-length" }
        response.headers.append(("Content-Length", String(response.body.length)))
        if request.method == "HEAD" { response.body = .empty }
        return response
    }

    private func answer(_ request: DAVRequest) async -> DAVResponse {
        // Every method, OPTIONS included: the bridge listens on loopback,
        // where any local process can reach it, and the token is what makes a
        // request rclone's.
        guard authorized(request) else {
            return Self.text(401, "Unauthorized.", extra: [("WWW-Authenticate", #"Bearer realm="onyx""#)])
        }
        if request.method == "OPTIONS" && request.target == "*" { return Self.options }

        let path: String
        switch Self.resolve(request.target, under: prefixSegments) {
        case .invalid: return Self.text(400, "Bad request target.")
        case .outside: return Self.notFound
        case let .path(p): path = p
        }

        switch request.method {
        case "OPTIONS": return Self.options
        case "PROPFIND": return await propfind(path, depth: request.headers["depth"])
        case "GET", "HEAD": return await get(path, range: request.headers["range"])
        case let m where Self.writeMethods.contains(m):
            return Self.text(403, "Read-only: this mount does not accept changes.")
        default:
            return Self.text(405, "Method not allowed.", extra: [("Allow", Self.allowedMethods)])
        }
    }

    // MARK: - Auth

    func authorized(_ request: DAVRequest) -> Bool {
        Self.authorizes(request.headers["authorization"], token: bearerToken)
    }

    /// Whether an Authorization header value carries `token`. Public for
    /// the socket layer, which checks it as soon as a request's headers are
    /// in — before waiting for, or holding, a body from someone without it.
    public static func authorizes(_ authorization: String?, token: String) -> Bool {
        // An empty token would make "Bearer " a password anyone can type.
        guard !token.isEmpty, let given = authorization else { return false }
        let trimmed = given.trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
        return constantTimeEquals(Array(trimmed.utf8), Array("Bearer \(token)".utf8))
    }

    /// Time depends only on the expected length, not on where a guess first
    /// goes wrong, so the token cannot be recovered a byte at a time.
    static func constantTimeEquals(_ given: [UInt8], _ expected: [UInt8]) -> Bool {
        var diff = given.count ^ expected.count
        for i in 0..<expected.count {
            diff |= Int((i < given.count ? given[i] : 0) ^ expected[i])
        }
        return diff == 0
    }

    // MARK: - Paths

    enum Resolved: Equatable {
        /// Relative to the drive root: "" is the root, else "A/b c.png".
        case path(String)
        /// Malformed, or trying to leave the tree.
        case invalid
        /// Well-formed but not under hrefPrefix.
        case outside
    }

    /// Each segment is decoded on its own, after splitting, so "%2F" is a
    /// character in a name rather than a separator — and since no name in the
    /// index can hold "/", it is refused rather than looked up. Dot segments
    /// are refused rather than collapsed: rclone never sends them, and nothing
    /// legitimate needs a path that climbs.
    static func resolve(_ target: String, under prefix: [String]) -> Resolved {
        var raw = Substring(target)
        if let q = raw.firstIndex(of: "?") { raw = raw[..<q] }
        // Absolute-form ("http://host/path"), which HTTP/1.1 servers must accept.
        if let scheme = raw.range(of: "://"), !raw[..<scheme.lowerBound].contains("/") {
            let rest = raw[scheme.upperBound...]
            raw = rest.firstIndex(of: "/").map { rest[$0...] } ?? "/"
        }
        guard raw.hasPrefix("/") else { return .invalid }

        var segments: [String] = []
        for piece in raw.split(separator: "/") {
            guard let name = percentDecode(piece), !name.contains("/"),
                  !name.unicodeScalars.contains("\0"), name != ".", name != ".." else { return .invalid }
            segments.append(name)
        }
        guard segments.count >= prefix.count, Array(segments.prefix(prefix.count)) == prefix else { return .outside }
        return .path(segments.dropFirst(prefix.count).joined(separator: "/"))
    }

    /// Strict: a "%" not followed by two hex digits, or bytes that are not
    /// UTF-8, is nil rather than guessed at. "+" is a plus; this is a path,
    /// not a form.
    static func percentDecode<S: StringProtocol>(_ s: S) -> String? {
        func hex(_ b: UInt8) -> UInt8? {
            switch b {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): return b - UInt8(ascii: "0")
            case UInt8(ascii: "a")...UInt8(ascii: "f"): return b - UInt8(ascii: "a") + 10
            case UInt8(ascii: "A")...UInt8(ascii: "F"): return b - UInt8(ascii: "A") + 10
            default: return nil
            }
        }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(s.utf8.count)
        var it = s.utf8.makeIterator()
        while let b = it.next() {
            guard b == UInt8(ascii: "%") else { bytes.append(b); continue }
            guard let hi = it.next().flatMap(hex), let lo = it.next().flatMap(hex) else { return nil }
            bytes.append(hi << 4 | lo)
        }
        let decoded = String(decoding: bytes, as: UTF8.self)
        // String(decoding:) repairs bad UTF-8 with U+FFFD; a repair means the
        // bytes were not UTF-8, which is a bad request, not a name.
        return decoded.utf8.elementsEqual(bytes) ? decoded : nil
    }

    /// Everything but RFC 3986's unreserved characters is %XX, byte by byte
    /// of the UTF-8 — spaces, "&", and every non-ASCII letter included — so
    /// an href means the same to any client and needs no XML escaping.
    static func percentEncode(_ segment: String) -> String {
        let hex = Array("0123456789ABCDEF".utf8)
        var out: [UInt8] = []
        out.reserveCapacity(segment.utf8.count)
        for b in segment.utf8 {
            switch b {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: "~"):
                out.append(b)
            default:
                out += [UInt8(ascii: "%"), hex[Int(b >> 4)], hex[Int(b & 0xF)]]
            }
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Folders end in "/": rclone tells a collection by its resourcetype, but
    /// other clients resolve relative hrefs against it.
    func href(for entry: MirrorEntry) -> String {
        let encoded = entry.path.split(separator: "/").map { Self.percentEncode(String($0)) }.joined(separator: "/")
        if encoded.isEmpty { return hrefPrefix + "/" }
        return hrefPrefix + "/" + encoded + (entry.isFolder ? "/" : "")
    }

    // MARK: - Lookup

    /// The drive itself always exists. A source that models only what is in
    /// it still mounts, rather than failing at the root.
    private func lookup(_ path: String) async -> MirrorEntry? {
        if let entry = await source.entry(at: path) { return entry }
        guard path.isEmpty else { return nil }
        return MirrorEntry(kind: .folder, name: "", path: "", fileId: nil, size: 0,
                           modified: Date(timeIntervalSince1970: 0), etag: nil, mime: nil)
    }

    // MARK: - PROPFIND

    private func propfind(_ path: String, depth: String?) async -> DAVResponse {
        let withChildren: Bool
        switch depth?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "0": withChildren = false
        case "1": withChildren = true
        // Infinity would walk the whole drive in one response; RFC 4918 lets a
        // server refuse it, and rclone never asks.
        case nil, "infinity":
            let body = #"<?xml version="1.0" encoding="utf-8"?>"# + "\n"
                + #"<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>"#
            return DAVResponse(status: 403, headers: [("Content-Type", Self.xmlType)], body: .data(Data(body.utf8)))
        default:
            return Self.text(400, "Depth must be 0, 1 or infinity.")
        }
        guard let entry = await lookup(path) else { return Self.notFound }
        var entries = [entry]
        if withChildren, entry.isFolder {
            // Nil means the folder went between the two calls, or the source
            // has no tree yet. Retry-able, not "empty": rclone caches a
            // listing, and an empty one would hide the folder's files for as
            // long as it keeps it.
            guard let children = await source.children(of: entry.path) else { return Self.unavailable }
            entries += children
        }
        return DAVResponse(status: 207, headers: [("Content-Type", Self.xmlType)],
                           body: .data(Data(multistatus(entries).utf8)))
    }

    /// Every property, whatever the request body asked for: the set is small,
    /// and rclone asks for these anyway.
    func multistatus(_ entries: [MirrorEntry]) -> String {
        var xml = #"<?xml version="1.0" encoding="utf-8"?>"# + "\n" + #"<D:multistatus xmlns:D="DAV:">"# + "\n"
        for e in entries {
            xml += "<D:response><D:href>\(Self.xmlEscape(href(for: e)))</D:href><D:propstat><D:prop>"
            xml += "<D:displayname>\(Self.xmlEscape(e.name))</D:displayname>"
            xml += e.isFolder ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>"
            xml += "<D:getlastmodified>\(Self.httpDate(e.modified))</D:getlastmodified>"
            if !e.isFolder {
                xml += "<D:getcontentlength>\(max(0, e.size))</D:getcontentlength>"
                if let etag = Self.quotedETag(e.etag) { xml += "<D:getetag>\(Self.xmlEscape(etag))</D:getetag>" }
                xml += "<D:getcontenttype>\(Self.xmlEscape(Self.contentType(e.mime)))</D:getcontenttype>"
            }
            xml += "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n"
        }
        return xml + "</D:multistatus>\n"
    }

    /// Element text only (no attribute carries a value), so &, < and > are
    /// all that need escaping. Control characters are dropped: XML 1.0 cannot
    /// carry them even escaped, and one in a name would make the whole
    /// listing unparseable — an empty folder in Finder.
    static func xmlEscape(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in s.unicodeScalars {
            switch scalar {
            case "&": out.append(contentsOf: "&amp;".unicodeScalars)
            case "<": out.append(contentsOf: "&lt;".unicodeScalars)
            case ">": out.append(contentsOf: "&gt;".unicodeScalars)
            case "\t", "\n", "\r": out.append(scalar)
            default:
                if scalar.value < 0x20 || scalar.value == 0xFFFE || scalar.value == 0xFFFF { continue }
                out.append(scalar)
            }
        }
        return String(out)
    }

    // MARK: - GET / HEAD

    private func get(_ path: String, range: String?) async -> DAVResponse {
        guard let entry = await lookup(path) else { return Self.notFound }
        guard !entry.isFolder else {
            return Self.text(405, "A folder has no content to read.", extra: [("Allow", Self.allowedMethods)])
        }
        switch await source.content(for: entry) {
        case let .redirect(url):
            // The link is presigned and short-lived: never let anything keep it.
            return DAVResponse(status: 302, headers: [("Location", url.absoluteString), ("Cache-Control", "no-store")])
        case .unavailable:
            return Self.unavailable
        case let .local(url):
            return serveLocal(url, entry: entry, range: range)
        }
    }

    /// Sized from the file on disk, not the index: the bytes served and the
    /// length promised must come from the same place.
    private func serveLocal(_ url: URL, entry: MirrorEntry, range: String?) -> DAVResponse {
        guard let size = Self.regularFileSize(url) else { return Self.unavailable }
        var headers: [(String, String)] = [
            ("Accept-Ranges", "bytes"),
            ("Content-Type", Self.contentType(entry.mime)),
            ("Last-Modified", Self.httpDate(entry.modified)),
        ]
        if let etag = Self.quotedETag(entry.etag) { headers.append(("ETag", etag)) }

        switch Self.byteRange(range, size: size) {
        case .whole:
            return DAVResponse(status: 200, headers: headers, body: .file(url, offset: 0, length: size))
        case let .partial(first, last):
            headers.append(("Content-Range", "bytes \(first)-\(last)/\(size)"))
            return DAVResponse(status: 206, headers: headers, body: .file(url, offset: first, length: last - first + 1))
        case .unsatisfiable:
            headers.append(("Content-Range", "bytes */\(size)"))
            return DAVResponse(status: 416, headers: headers)
        }
    }

    static func regularFileSize(_ url: URL) -> Int64? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.resolvingSymlinksInPath().path),
              attrs[.type] as? FileAttributeType == .typeRegular,
              let size = (attrs[.size] as? NSNumber)?.int64Value else { return nil }
        return size
    }

    enum ByteRange: Equatable {
        case whole
        /// Inclusive, and within the file.
        case partial(Int64, Int64)
        case unsatisfiable
    }

    /// One range only. Several would need a multipart/byteranges body, and
    /// RFC 9110 lets a server ignore Range and send the whole representation
    /// — as it must for one it cannot parse.
    static func byteRange(_ header: String?, size: Int64) -> ByteRange {
        guard let header, let eq = header.firstIndex(of: "=") else { return .whole }
        guard header[..<eq].trimmingCharacters(in: .whitespaces).lowercased() == "bytes" else { return .whole }
        let set = header[header.index(after: eq)...].trimmingCharacters(in: .whitespaces)
        guard !set.contains(","), let dash = set.firstIndex(of: "-") else { return .whole }
        let first = set[..<dash].trimmingCharacters(in: .whitespaces)
        let last = set[set.index(after: dash)...].trimmingCharacters(in: .whitespaces)

        if first.isEmpty {
            // "-n": the last n bytes, or the whole file when it is shorter.
            guard let n = number(last) else { return .whole }
            guard n > 0, size > 0 else { return .unsatisfiable }
            return .partial(max(0, size - n), size - 1)
        }
        guard let start = number(first) else { return .whole }
        if last.isEmpty { return start < size ? .partial(start, size - 1) : .unsatisfiable }
        guard let end = number(last), end >= start else { return .whole }
        return start < size ? .partial(start, min(end, size - 1)) : .unsatisfiable
    }

    /// Digits only. Too many to fit is past the end of any file, not an error.
    private static func number(_ s: String) -> Int64? {
        guard !s.isEmpty, s.utf8.allSatisfy({ $0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9") }) else { return nil }
        return Int64(s) ?? .max
    }

    // MARK: - Shapes

    static let xmlType = "application/xml; charset=utf-8"

    /// The file's type as the server recorded it, when it is one. The server
    /// keeps whatever a client sent, and this goes into a response header:
    /// a CR or LF in it would end the header block early, and the rest would
    /// be read as body — or as the next response on the connection. So only
    /// a well-formed media type goes out; anything else is plain bytes.
    static func contentType(_ mime: String?) -> String {
        guard let mime, isMediaType(mime) else { return "application/octet-stream" }
        return mime
    }

    /// RFC 9110's media-type, in printable ASCII: type "/" subtype, then any
    /// number of `; name=value` parameters, each value a token or a quoted
    /// string with no quote or backslash inside. No control character — tab
    /// aside, between parameters — fits anywhere in it.
    static func isMediaType(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard !b.isEmpty, b.count <= 255 else { return false }
        var i = 0
        func token() -> Bool {
            let start = i
            while i < b.count, isTokenByte(b[i]) { i += 1 }
            return i > start
        }
        func skipSpace() {
            while i < b.count, b[i] == UInt8(ascii: " ") || b[i] == UInt8(ascii: "\t") { i += 1 }
        }
        func take(_ c: Character) -> Bool {
            guard i < b.count, b[i] == c.asciiValue else { return false }
            i += 1
            return true
        }
        guard token(), take("/"), token() else { return false }
        while true {
            skipSpace()
            if i == b.count { return true }
            guard take(";") else { return false }
            skipSpace()
            guard token(), take("=") else { return false }
            if take("\"") {
                while i < b.count, b[i] != UInt8(ascii: "\"") {
                    // Printable ASCII and spaces; a backslash would start an
                    // escape, and nothing here needs one.
                    guard b[i] == UInt8(ascii: " ") || (0x21...0x7E).contains(b[i]),
                          b[i] != UInt8(ascii: "\\") else { return false }
                    i += 1
                }
                guard take("\"") else { return false }
            } else {
                guard token() else { return false }
            }
        }
    }

    /// RFC 9110 tchar.
    private static func isTokenByte(_ b: UInt8) -> Bool {
        switch b {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"):
            return true
        default:
            return "!#$%&'*+-.^_`|~".utf8.contains(b)
        }
    }

    /// Quoted, keeping only what an entity-tag may hold (RFC 9110 etagc), so
    /// a stray quote in a hash cannot end the tag early. Nil when nothing is
    /// left.
    static func quotedETag(_ etag: String?) -> String? {
        guard let etag else { return nil }
        let kept = etag.unicodeScalars.filter { $0.value == 0x21 || (0x23...0x7E).contains($0.value) }
        guard !kept.isEmpty else { return nil }
        return "\"" + String(String.UnicodeScalarView(kept)) + "\""
    }

    /// RFC 1123 in GMT ("Sun, 06 Nov 1994 08:49:37 GMT"), by arithmetic: no
    /// formatter to share across threads, and no locale to get wrong.
    static func httpDate(_ date: Date) -> String {
        let t = date.timeIntervalSince1970
        // Clamped to years 1–9999, which the four-digit field can hold.
        let seconds = t.isFinite ? Int64(min(max(t, -62_135_596_800), 253_402_300_799).rounded(.down)) : 0
        let days = seconds >= 0 ? seconds / 86_400 : (seconds - 86_399) / 86_400
        let secondOfDay = seconds - days * 86_400

        // Days since 1970-01-01 to a proleptic Gregorian date (Howard
        // Hinnant's civil_from_days).
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        let year = yoe + era * 400 + (month <= 2 ? 1 : 0)
        // 1970-01-01 was a Thursday.
        let weekday = Int(((days % 7) + 11) % 7)

        let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        func pad(_ n: Int64, _ width: Int) -> String {
            let s = String(n)
            return String(repeating: "0", count: max(0, width - s.count)) + s
        }
        return "\(weekdays[weekday]), \(pad(day, 2)) \(months[Int(month) - 1]) \(pad(year, 4)) "
            + "\(pad(secondOfDay / 3_600, 2)):\(pad(secondOfDay / 60 % 60, 2)):\(pad(secondOfDay % 60, 2)) GMT"
    }

    static let options = DAVResponse(status: 200, headers: [
        ("DAV", "1"), ("Allow", allowedMethods), ("Accept-Ranges", "bytes"),
    ])

    static let notFound = text(404, "Not found.")

    /// Retry-able: rclone backs off and asks again on a 503.
    static let unavailable = text(503, "Not available right now.", extra: [("Retry-After", "30")])

    static func text(_ status: Int, _ message: String, extra: [(String, String)] = []) -> DAVResponse {
        DAVResponse(status: status, headers: [("Content-Type", "text/plain; charset=utf-8")] + extra,
                    body: .data(Data((message + "\n").utf8)))
    }
}
