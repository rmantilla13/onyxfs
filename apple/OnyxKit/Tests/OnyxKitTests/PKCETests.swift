import Testing
import Foundation
@testable import OnyxKit

/// Expectations produced by running the SERVER's own pkceChallenge
/// (app/api/desktop/token/route.js) — not by this code. The first case is the
/// vector from RFC 7636 Appendix B, which the server also reproduces, so all
/// three implementations are pinned to the same standard.
struct PKCETests {
    @Test func testRFC7636Vector() {
        #expect(PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func testPaddingIsStrippedAtEveryBoundary() {
        // A SHA-256 digest is 32 bytes, so base64 always ends "=" — but these
        // inputs were chosen because a naive implementation that strips only
        // a trailing "==" or forgets the URL alphabet diverges on one of them.
        #expect(PKCE.challenge(for: "a") == "ypeBEsobvcr6wjGzmiPcTaeG7_gUfE5yuYB3ha_uSLs")
        #expect(PKCE.challenge(for: "aa") == "lhtt0-3jy47LqsvWjeBAzXjrLtWIkTDM60xJJo6k1QY")
        #expect(PKCE.challenge(for: "aaa") == "mDSHbc-wXLFnpcJJU-uljErImxrfV_KPL50JrxB-6PA")
    }

    @Test func testLongVerifier() {
        #expect(PKCE.challenge(for: "onyx-" + String(repeating: "x", count: 59)) == "urPezSg5kfZ3uwFxMEQwllmkgzP8MGHRcA9Nlj0IK-Y")
    }

    @Test func testChallengeNeverContainsURLUnsafeCharacters() {
        for _ in 0..<200 {
            let c = PKCE.challenge(for: PKCE.verifier())
            #expect(!(c.contains("+")), "base64url uses '-', not '+'")
            #expect(!(c.contains("/")), "base64url uses '_', not '/'")
            #expect(!(c.contains("=")), "padding must be stripped")
        }
    }

    @Test func testVerifierMeetsRFCLengthAndCharset() {
        let allowed = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        for _ in 0..<200 {
            let v = PKCE.verifier()
            #expect((43...128).contains(v.count), "RFC 7636 requires 43–128, got \(v.count)")
            #expect(v.rangeOfCharacter(from: allowed.inverted) == nil)
        }
    }

    @Test func testVerifiersAreNotRepeated() {
        // A repeated verifier would let a captured auth code be replayed.
        let many = Set((0..<500).map { _ in PKCE.verifier() })
        #expect(many.count == 500)
    }
}
