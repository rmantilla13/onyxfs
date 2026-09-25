import Testing
import Foundation
@testable import OnyxKit

struct UpdateTests {
    @Test func versionsCompareAsNumbers() {
        #expect(AppVersion.isNewer("0.10.0", build: nil, than: "0.9.9", currentBuild: nil))
        #expect(!AppVersion.isNewer("0.9.9", build: nil, than: "0.10.0", currentBuild: nil))
        #expect(AppVersion.isNewer("1.0", build: nil, than: "0.99.99", currentBuild: nil))
        #expect(!AppVersion.isNewer("0.2.0", build: nil, than: "0.2", currentBuild: nil), "0.2 and 0.2.0 are the same")
        #expect(AppVersion.isNewer("v0.3.0", build: nil, than: "0.2.9", currentBuild: nil), "a tag's v is ignored")
    }

    @Test func theBuildBreaksATieAndOnlyATie() {
        #expect(AppVersion.isNewer("0.2.0", build: "202610011200", than: "0.2.0", currentBuild: "202609251532"))
        #expect(!AppVersion.isNewer("0.2.0", build: "202609251532", than: "0.2.0", currentBuild: "202609251532"))
        #expect(!AppVersion.isNewer("0.1.9", build: "999999999999", than: "0.2.0", currentBuild: "1"), "an older version never wins on build")
        #expect(!AppVersion.isNewer("0.2.0", build: nil, than: "0.2.0", currentBuild: "5"))
    }

    @Test func aReleaseSaysWhetherThisMacCanRunIt() {
        let r = MacRelease(version: "1.0", minimumSystemVersion: "14.0")
        #expect(r.runs(on: OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 0)))
        #expect(r.runs(on: OperatingSystemVersion(majorVersion: 27, minorVersion: 0, patchVersion: 0)))
        #expect(!r.runs(on: OperatingSystemVersion(majorVersion: 13, minorVersion: 6, patchVersion: 1)))
    }

    @Test func decodesTheServersShape() throws {
        let json = """
        {"version":"0.3.0","build":"202610011200","minimumSystemVersion":"14.0","notes":"Faster Finder",
         "publishedAt":"2026-10-01T12:00:00Z","dmgUrl":"https://example.com/Onyx.dmg",
         "zipUrl":"https://example.com/Onyx.zip","zipSha256":"\(String(repeating: "a", count: 64))",
         "zipSize":12345,"pageUrl":null}
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(MacRelease.self, from: json)
        #expect(r.version == "0.3.0" && r.zipSize == 12345 && r.pageUrl == nil)
    }
}
