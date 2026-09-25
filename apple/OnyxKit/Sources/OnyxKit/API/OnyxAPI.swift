import Foundation

/// Typed client for the endpoints a native client uses.
///
/// Only these paths are reachable without a browser session — middleware.js
/// excludes them from the cookie gate precisely so a bearer request gets a
/// clean 401 instead of a 302 to a sign-in page an extension cannot render:
///
///     /api/desktop/*      device auth (PKCE), and signing the app's web view in
///     /api/space/*        drives, credentials, and one file's download link
///     /api/files/delta    sync enumeration
///
/// Anything else needs a cookie. If a new endpoint is added for this client,
/// it has to be added to that matcher too, or it will 302 and the JSON decode
/// will fail on HTML with a message about the letter "<".
public actor OnyxAPI {
    let config: OnyxConfig
    let tokens: TokenStore
    let session: URLSession

    public init(config: OnyxConfig = .current,
                tokens: TokenStore = TokenStore(),
                session: URLSession = .shared) {
        self.config = config
        self.tokens = tokens
        self.session = session
    }

    private func request(_ url: URL, method: String = "GET", json: [String: Any]? = nil,
                         authenticated: Bool = true) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = method
        if authenticated {
            guard let token = tokens.get() else { throw OnyxError.notAuthenticated }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // The server's own message when there is one — it is written to be
            // read ("Storage is not configured for AWS S3") and is far more
            // use than the status code.
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            if status == 401 { throw OnyxError.notAuthenticated }
            throw OnyxError.http(status: status, message: message)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw OnyxError.decoding(String(describing: error)) }
    }

    // MARK: - Sync

    /// One page of changes since `cursor`, within one Finder location's scope
    /// (nil: everything this account may see). Cursor 0 means everything, so
    /// first sync and incremental catch-up are the same code path.
    public func delta(cursor: Int64, limit: Int = 500, domain: SyncDomain? = nil,
                      folders: Bool = false) async throws -> DeltaPage {
        var query: [URLQueryItem] = [
            .init(name: "cursor", value: String(cursor)),
            .init(name: "limit", value: String(limit)),
        ]
        if let domain { query.append(.init(name: "drive", value: domain.deltaParameter)) }
        if folders { query.append(.init(name: "folders", value: "1")) }
        return try decode(DeltaPage.self, from: try await request(config.url("api/files/delta", query: query)))
    }

    /// The current high-water mark, with no payload — for a client that wants
    /// to start watching from now rather than replay history it does not want.
    public func currentCursor() async throws -> Int64 {
        let url = config.url("api/files/delta", query: [.init(name: "cursor", value: "now")])
        return try decode(DeltaPage.self, from: try await request(url)).cursor
    }

    /// Where to download one file's bytes from, now. Checked against the same
    /// rule as the web's detail view; a file you may not see is a 404.
    public func contentLink(fileId: String) async throws -> ContentLink {
        let id = fileId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? fileId
        return try decode(ContentLink.self, from: try await request(config.url("api/space/files/\(id)")))
    }

    // MARK: - The app's web view

    /// A one-time URL that signs a web view in as this device's account. It
    /// works only in a web view holding `secret` as the `onyx_handoff` cookie
    /// (WebHandoff), so it is useless to anyone who sees it.
    public func webSession(challenge: String, next: String = "/files") async throws -> WebSessionLink {
        let data = try await request(config.url("api/desktop/web-session"), method: "POST",
                                     json: ["challenge": challenge, "next": next])
        return try decode(WebSessionLink.self, from: data)
    }

    // MARK: - Filespaces and credentials

    public func filespaces() async throws -> [Filespace] {
        try await drives().drives
    }

    /// The drives this account may open, and whether it is an admin.
    public func drives() async throws -> (drives: [Filespace], isAdmin: Bool) {
        struct Wrapper: Decodable { let filespaces: [Filespace]; let isAdmin: Bool? }
        let data = try await request(config.url("api/space/filespaces"))
        let w = try decode(Wrapper.self, from: data)
        return (w.filespaces, w.isAdmin ?? false)
    }

    public func credentials(filespaceId: String) async throws -> SpaceCredentials {
        let data = try await request(config.url("api/space/sts"), method: "POST",
                                     json: ["filespaceId": filespaceId])
        return try decode(SpaceCredentials.self, from: data)
    }

    // MARK: - Updates

    /// The newest Mac release this server knows of, or nil when none has been
    /// published. Needs no sign-in: the app checks before anyone signs in.
    public func latestMacRelease() async throws -> MacRelease? {
        do {
            return try decode(MacRelease.self, from: try await request(config.url("api/desktop/mac/latest"), authenticated: false))
        } catch OnyxError.http(let status, _) where status == 404 {
            return nil
        }
    }

    // MARK: - Identity

    public func me() async throws -> String {
        struct Me: Decodable { let email: String }
        return try decode(Me.self, from: try await request(config.url("api/desktop/me"))).email
    }

    /// Is there a token at all? Checked before enumerating, so the system is
    /// told `.notAuthenticated` — which shows a "Sign in" affordance in
    /// Finder — rather than being handed an empty drive, which looks to the
    /// user like their files were deleted.
    public nonisolated var hasCredentials: Bool { tokens.get() != nil }

    /// Revoke this device's own token.
    public func signOut() async throws {
        _ = try? await request(config.url("api/desktop/me"), method: "DELETE")
        tokens.clear()
    }
}
