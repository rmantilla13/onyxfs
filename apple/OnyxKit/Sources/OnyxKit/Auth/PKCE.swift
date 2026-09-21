import Foundation
import CryptoKit

/// PKCE (RFC 7636) with the S256 method.
///
/// Must agree byte-for-byte with `pkceChallenge` in
/// `app/api/desktop/token/route.js`, which uses Web Crypto and base64url with
/// the padding stripped. A mismatch fails as "PKCE verification failed" with
/// no indication of which side is wrong, so PKCETests pins the RFC's own
/// vector plus the three inputs whose SHA-256 lands on a different base64
/// padding boundary.
public enum PKCE {
    /// 43–128 characters from the unreserved set. 32 random bytes in base64url
    /// gives 43, the minimum the RFC allows and enough entropy.
    public static func verifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        // SecRandomCopyBytes is the platform CSPRNG; there is no reason to
        // reach for anything else, and every reason not to.
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64URL(Data(bytes))
    }

    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
