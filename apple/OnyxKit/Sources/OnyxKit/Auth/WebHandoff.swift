import Foundation

/// Signing the app's web view in from the device token, without a second
/// magic link (server side: lib/web-handoff.js).
///
/// The app makes a secret, sends only its S256 challenge with its token, sets
/// the secret as a cookie in its own web view, and loads the one-time URL it
/// got back. The server spends the code only for a browser holding that
/// cookie — so the URL, if it leaked, would sign nobody in.
public enum WebHandoff {
    public static let cookieName = "onyx_handoff"

    /// A fresh secret and the challenge to send for it. PKCE's S256, because
    /// the server checks it with the same function the device sign-in uses.
    public static func makeSecret() -> (secret: String, challenge: String) {
        let secret = PKCE.verifier()
        return (secret, PKCE.challenge(for: secret))
    }

    /// The cookie to put in the web view before loading the handoff URL:
    /// scoped to the one path that reads it, and gone in two minutes.
    public static func cookie(secret: String, server: URL, now: Date = Date()) -> HTTPCookie? {
        guard let host = server.host else { return nil }
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: cookieName,
            .value: secret,
            .domain: host,
            .path: "/api/desktop/web-session",
            .expires: now.addingTimeInterval(120),
        ]
        if server.scheme == "https" { props[.secure] = "TRUE" }
        return HTTPCookie(properties: props)
    }
}
