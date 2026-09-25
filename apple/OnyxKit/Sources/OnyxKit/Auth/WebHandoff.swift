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
    /// Over https: a `__Host-` cookie, which only this exact host can set, so
    /// no sibling subdomain can plant a secret of its own (lib/web-handoff.js).
    public static let secureCookieName = "__Host-onyx_handoff"

    /// A fresh secret and the challenge to send for it. PKCE's S256, because
    /// the server checks it with the same function the device sign-in uses.
    public static func makeSecret() -> (secret: String, challenge: String) {
        let secret = PKCE.verifier()
        return (secret, PKCE.challenge(for: secret))
    }

    /// The cookie to put in the web view before loading the handoff URL, gone
    /// in two minutes. Over https it is `__Host-`: Secure, this host only,
    /// Path=/ (the prefix requires all three). Over plain http (a local
    /// server) it is scoped to the one path that reads it.
    public static func cookie(secret: String, server: URL, now: Date = Date()) -> HTTPCookie? {
        guard let host = server.host else { return nil }
        let secure = server.scheme == "https"
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: secure ? secureCookieName : cookieName,
            .value: secret,
            .originURL: server,
            .path: secure ? "/" : "/api/desktop/web-session",
            .expires: now.addingTimeInterval(120),
        ]
        if secure { props[.secure] = "TRUE" } else { props[.domain] = host }
        return HTTPCookie(properties: props)
    }
}
