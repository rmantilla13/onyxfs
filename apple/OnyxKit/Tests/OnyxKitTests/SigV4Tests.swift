import Testing
import Foundation
@testable import OnyxKit

/// The expectations below are not hand-computed. The same algorithm was
/// implemented in JavaScript and checked against the AWS SDK's own presigner
/// (`@aws-sdk/s3-request-presigner`) on identical canonical inputs — four
/// requests covering spaces, UTF-8, reserved characters and unescaped slashes,
/// all four matching — and then frozen here.
///
/// So a failure means the Swift port diverges from AWS, not that a number
/// needs updating. Do not "fix" a test by pasting in whatever the code now
/// produces.
struct SigV4Tests {
    // AWS's documented example credentials. Not secret, not usable.
    let creds = SigV4.Credentials(
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
    )
    // 2026-09-21T02:30:00Z. Fixed, because a signature covers the timestamp.
    let when = Date(timeIntervalSince1970: 1789957800)

    private func signature(_ url: URL?) -> String? {
        guard let url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        return items.first { $0.name == "X-Amz-Signature" }?.value
    }

    @Test func testPlainKey() {
        let url = SigV4.presignedGET(
            host: "s3.us-west-004.backblazeb2.com",
            path: "/onyx-media/files/clip.mov",
            region: "us-west-004", credentials: creds, expiresIn: 3600, date: when)
        #expect(signature(url) == "664e23c657427b3383a18e271d808ffca1753cfc68f1a430be3592fcec4ba377")
    }

    @Test func testKeyWithSpaces() {
        // Spaces encode as %20, never "+". A "+" here is accepted by the URL
        // parser and rejected by S3, which is the worst combination.
        let url = SigV4.presignedGET(
            host: "s3.us-west-004.backblazeb2.com",
            path: "/onyx-media/files/Campaigns/Spring 2026/a b.mov",
            region: "us-west-004", credentials: creds, expiresIn: 3600, date: when)
        #expect(signature(url) == "fa7fad2b6e8ad571f4d993c552debf1f2e8aece6672953d5ac9ca11f79fedfff")
        #expect(url!.absoluteString.contains("Spring%202026"))
    }

    @Test func testKeyWithUTF8AndReservedCharacters() {
        let url = SigV4.presignedGET(
            host: "s3.us-east-1.amazonaws.com",
            path: "/onyx-media/files/odd chars/ü&+=?#.mov",
            region: "us-east-1", credentials: creds, expiresIn: 3600, date: when)
        #expect(signature(url) == "5f6764b878ba4f9ab5da2c5aa90ec7f86e234b7bdfe7c44832b45ab5dd4f4ad3")
    }

    @Test func testSessionTokenIsSigned() {
        // STS and B2-scoped keys carry one. It must be part of the canonical
        // query, not appended afterwards — appending produces a URL that
        // validates locally and 403s at the bucket.
        let scoped = SigV4.Credentials(
            accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey,
            sessionToken: "FwoGZXIvYXdzEJr//////////wEaDExAMPLE+TOKEN/==")
        let url = SigV4.presignedGET(
            host: "s3.us-west-004.backblazeb2.com",
            path: "/onyx-media/files/clip.mov",
            region: "us-west-004", credentials: scoped, expiresIn: 3600, date: when)
        #expect(signature(url) == "1610b60b8b692829f94c674b714c481c13f236af220a6a193cd4e7e6303c5447")
    }

    @Test func testStaticAndScopedCredentialsDifferInSignature() {
        // Guards against the session token being dropped silently.
        let a = SigV4.presignedGET(host: "h.example.com", path: "/b/k", region: "r",
                                   credentials: creds, date: when)
        let b = SigV4.presignedGET(host: "h.example.com", path: "/b/k", region: "r",
                                   credentials: .init(accessKeyId: creds.accessKeyId,
                                                      secretAccessKey: creds.secretAccessKey,
                                                      sessionToken: "T"), date: when)
        #expect(signature(a) != signature(b))
    }

    // MARK: - Encoding

    @Test func testUriEncodeKeepsSlashesInPathsAndEscapesThemInValues() {
        // The single most consequential line in the file: wrong, and every key
        // in a foldered library fails while a flat test bucket passes.
        #expect(SigV4.uriEncode("a/b/c", keepSlash: true) == "a/b/c")
        #expect(SigV4.uriEncode("a/b/c", keepSlash: false) == "a%2Fb%2Fc")
    }

    @Test func testUriEncodeUnreservedSetIsLeftAlone() {
        #expect(SigV4.uriEncode("~-._", keepSlash: false) == "~-._")
    }

    @Test func testUriEncodeEscapesReservedAndMultibyte() {
        #expect(SigV4.uriEncode("+=&?#", keepSlash: false) == "%2B%3D%26%3F%23")
        #expect(SigV4.uriEncode("files/ü.mov", keepSlash: true) == "files/%C3%BC.mov")
    }

    @Test func testAmzDateIsUTCAndFixedFormat() {
        #expect(SigV4.amzDate(when) == "20260921T023000Z")
    }
}
