import Foundation
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif

/// Device sign-in over the existing PKCE routes.
///
/// The flow, unchanged from what the Tauri client already does against these
/// endpoints:
///
///   1. make a verifier, derive its S256 challenge
///   2. open /space/authorize?challenge=… in ASWebAuthenticationSession, which
///      signs the person in with a magic link if they are not already
///   3. the page redirects to onyxfs://callback?code=…
///   4. POST /api/desktop/token with the code AND the verifier
///
/// The verifier never leaves the device until step 4, so a code intercepted at
/// step 3 is useless on its own. That is the whole point of PKCE and the
/// reason the verifier must be held across the browser round trip rather than
/// regenerated.
public final class AuthClient: NSObject, @unchecked Sendable {
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

    /// The URL to open in the browser, and the verifier to keep until the
    /// callback arrives.
    public func authorizeURL(label: String) -> (url: URL, verifier: String) {
        let verifier = PKCE.verifier()
        let url = config.url("space/authorize", query: [
            .init(name: "challenge", value: PKCE.challenge(for: verifier)),
            .init(name: "label", value: label),
        ])
        return (url, verifier)
    }

    /// Pull `code` out of `onyxfs://callback?code=…`.
    public static func code(from callback: URL) -> String? {
        URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "code" }?.value
    }

    /// Exchange the code for a bearer token and store it in the Keychain.
    @discardableResult
    public func exchange(code: String, verifier: String, label: String) async throws -> DesktopToken {
        try await redeem([
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "label": label,
        ])
    }

    /// Sign in with a pairing code from the web's "Pair Onyx" page — for when
    /// the browser the web is signed in on is not the one this Mac opens (a
    /// different profile, or another computer). The code was bound to an
    /// account when the signed-in page made it, so no verifier is needed.
    @discardableResult
    public func pair(code: String, label: String) async throws -> DesktopToken {
        let cleaned = code.uppercased().filter { $0.isLetter || $0.isNumber }
        return try await redeem(["grant_type": "pairing_code", "code": cleaned, "label": label])
    }

    private func redeem(_ body: [String: String]) async throws -> DesktopToken {
        var req = URLRequest(url: config.url("api/desktop/token"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw OnyxError.http(status: status, message: message)
        }
        let token = try JSONDecoder().decode(DesktopToken.self, from: data)
        // Store before returning: a caller that forgets to persist leaves the
        // person signed in until the process dies, which is a confusing bug to
        // report and an easy one to avoid here.
        try tokens.set(token.token)
        SharedSettings().email = token.email
        return token
    }

    public var isSignedIn: Bool { tokens.get() != nil }

    #if canImport(AuthenticationServices)
    /// Run the whole flow. Must be called from the main actor — the web
    /// authentication session needs a presentation anchor.
    @MainActor
    public func signIn(label: String, anchor: ASPresentationAnchor) async throws -> DesktopToken {
        let (url, verifier) = authorizeURL(label: label)
        // Both are held by the completion handler until it runs. The session's
        // presentationContextProvider is WEAK: handed a fresh object inline,
        // it is freed on the spot and the session refuses to start with no
        // window to show in. And a session nothing retains can be torn down
        // mid-sign-in.
        let provider = PresentationAnchor(anchor)
        let code: String = try await withCheckedThrowingContinuation { continuation in
            var session: ASWebAuthenticationSession?
            session = ASWebAuthenticationSession(
                url: url, callbackURLScheme: OnyxIdentifiers.urlScheme
            ) { callback, error in
                _ = provider
                session = nil
                if let error { continuation.resume(throwing: error); return }
                guard let callback, let code = AuthClient.code(from: callback) else {
                    continuation.resume(throwing: OnyxError.http(status: 0, message: "No code in the callback."))
                    return
                }
                continuation.resume(returning: code)
            }
            session?.presentationContextProvider = provider
            // The magic-link sign-in needs the browser's existing session; an
            // ephemeral one would force a fresh sign-in on every device add.
            session?.prefersEphemeralWebBrowserSession = false
            if session?.start() != true {
                session = nil
                continuation.resume(throwing: OnyxError.http(status: 0, message: "The sign-in window could not be opened."))
            }
        }
        return try await exchange(code: code, verifier: verifier, label: label)
    }

    private final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        let anchor: ASPresentationAnchor
        init(_ anchor: ASPresentationAnchor) { self.anchor = anchor }
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
    }
    #endif
}
