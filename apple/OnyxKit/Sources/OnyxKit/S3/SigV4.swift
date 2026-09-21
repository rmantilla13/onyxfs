import Foundation
import CryptoKit

/// AWS Signature Version 4, presigned GET only.
///
/// Hand-rolled rather than taken from the AWS SDK for Swift, which is roughly
/// 60 MB of dependency for the two request shapes this app makes — and a File
/// Provider extension runs under a memory ceiling of about 50 MB, so the SDK
/// is not merely heavy here, it is disqualifying.
///
/// The algorithm was verified before it was written: the same implementation
/// in JavaScript was checked against the AWS SDK's own presigner on four
/// requests covering spaces, UTF-8, reserved characters and unescaped slashes,
/// and produced identical signatures in every case. The expectations in
/// SigV4Tests are that verified output, frozen. If a change here breaks them,
/// the change is wrong.
public struct SigV4 {
    public struct Credentials: Sendable, Equatable {
        public let accessKeyId: String
        public let secretAccessKey: String
        /// Present for STS / B2-scoped keys, absent for static ones.
        public let sessionToken: String?

        public init(accessKeyId: String, secretAccessKey: String, sessionToken: String? = nil) {
            self.accessKeyId = accessKeyId
            self.secretAccessKey = secretAccessKey
            self.sessionToken = sessionToken
        }
    }

    /// RFC 3986 unreserved set. Everything else is percent-encoded.
    ///
    /// `keepSlash` is the S3-specific part and is not cosmetic: the canonical
    /// URI keeps path separators literal, while a value inside the query
    /// string must escape them. Getting this backwards produces a signature
    /// that is wrong only for keys containing a slash — which is every key in
    /// a foldered library, and none in a flat test bucket.
    static func uriEncode(_ s: String, keepSlash: Bool) -> String {
        var out = ""
        out.reserveCapacity(s.utf8.count)
        for byte in Array(s.utf8) {
            let c = Character(UnicodeScalar(byte))
            if (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
                || (byte >= 0x30 && byte <= 0x39) || c == "-" || c == "." || c == "_" || c == "~" {
                out.unicodeScalars.append(UnicodeScalar(byte))
            } else if c == "/" && keepSlash {
                out.append("/")
            } else {
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    static func hmac(_ key: SymmetricKey, _ message: String) -> SymmetricKey {
        SymmetricKey(data: Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)))
    }

    static func hex(_ data: some DataProtocol) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    static func sha256Hex(_ s: String) -> String { hex(SHA256.hash(data: Data(s.utf8))) }

    /// `20260921T023000Z` / `20260921`.
    static func amzDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        f.timeZone = TimeZone(identifier: "UTC")
        // Fixed locale: under a Persian or Buddhist calendar the default would
        // format a different year entirely, and the failure would only appear
        // on the devices of people whose region settings differ from the
        // developer's.
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: date)
    }

    /// A presigned GET URL for `path` (which must begin with "/" and, for
    /// path-style endpoints, include the bucket).
    public static func presignedGET(
        host: String,
        path: String,
        region: String,
        credentials: Credentials,
        expiresIn: Int = 3600,
        date: Date = Date(),
        service: String = "s3"
    ) -> URL? {
        let stamp = amzDate(date)
        let day = String(stamp.prefix(8))
        let scope = "\(day)/\(region)/\(service)/aws4_request"

        var query: [(String, String)] = [
            ("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
            ("X-Amz-Credential", "\(credentials.accessKeyId)/\(scope)"),
            ("X-Amz-Date", stamp),
            ("X-Amz-Expires", String(expiresIn)),
            ("X-Amz-SignedHeaders", "host"),
        ]
        if let token = credentials.sessionToken, !token.isEmpty {
            query.append(("X-Amz-Security-Token", token))
        }

        // Sorted by the ENCODED key, per the spec — not by the raw one. They
        // differ as soon as a key contains a character that encodes.
        let canonicalQuery = query
            .map { (uriEncode($0.0, keepSlash: false), uriEncode($0.1, keepSlash: false)) }
            .sorted { $0.0 < $1.0 }
            .map { "\($0.0)=\($0.1)" }
            .joined(separator: "&")

        let canonicalPath = uriEncode(path, keepSlash: true)
        let canonicalRequest = [
            "GET", canonicalPath, canonicalQuery, "host:\(host)\n", "host", "UNSIGNED-PAYLOAD",
        ].joined(separator: "\n")

        let stringToSign = [
            "AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest),
        ].joined(separator: "\n")

        var key = SymmetricKey(data: Data("AWS4\(credentials.secretAccessKey)".utf8))
        for part in [day, region, service, "aws4_request"] { key = hmac(key, part) }
        let signature = hex(HMAC<SHA256>.authenticationCode(for: Data(stringToSign.utf8), using: key))

        return URL(string: "https://\(host)\(canonicalPath)?\(canonicalQuery)&X-Amz-Signature=\(signature)")
    }
}
