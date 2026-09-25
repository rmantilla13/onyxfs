import Testing
import Foundation
@testable import OnyxKit

/// The tree a Finder location shows, built from delta pages. What goes wrong
/// here goes wrong silently — a folder that never disappears, a file that
/// shows up twice — so each rule is pinned.
struct ReplicaTests {
    func file(_ id: String, _ name: String, in folder: String = "", deleted: Bool = false, version: Int = 1) -> FileItem {
        FileItem(id: id, name: name, folder: folder, kind: "image", mime: "image/png", size: 10, url: nil,
                 storageKey: nil, thumbnailUrl: nil, tags: [], notes: nil, caption: nil, visibility: "org",
                 version: version, contentHash: nil, createdBy: nil, createdAt: nil, updatedAt: nil,
                 deletedAt: deleted ? EpochMillis(1) : nil, seq: nil)
    }

    @Test func foldersComeFromFilesAndTheirAncestors() {
        var r = Replica()
        let diff = r.apply(changed: [file("a", "a.png", in: "Campaigns/2026/March"), file("b", "b.png")], deleted: [])
        #expect(r.folders == ["Campaigns", "Campaigns/2026", "Campaigns/2026/March"])
        #expect(Set(diff.updated) == ["a", "b", "folder:Campaigns", "folder:Campaigns/2026", "folder:Campaigns/2026/March"])
        #expect(diff.deleted.isEmpty)
        #expect(r.children(of: "").folders == ["Campaigns"])
        #expect(r.children(of: "").files.map(\.id) == ["b"])
        #expect(r.children(of: "Campaigns/2026").folders == ["Campaigns/2026/March"])
    }

    @Test func emptyFoldersComeFromTheListAndGoWhenItDropsThem() {
        var r = Replica()
        r.apply(changed: [], deleted: [], folders: ["Empty", "Deep/Empty"])
        #expect(r.folders == ["Empty", "Deep", "Deep/Empty"])
        let diff = r.apply(changed: [], deleted: [], folders: ["Deep/Empty"])
        #expect(diff.deleted == ["folder:Empty"])
        // A page with no folder list leaves the listed folders alone.
        #expect(r.apply(changed: [], deleted: []).isEmpty)
        #expect(r.folders == ["Deep", "Deep/Empty"])
    }

    @Test func renamingAFolderOnTheWebMovesItsFilesAndSwapsTheFolder() {
        var r = Replica()
        r.apply(changed: [file("a", "a.png", in: "Old"), file("b", "b.png", in: "Old/Sub")], deleted: [])
        let diff = r.apply(changed: [file("a", "a.png", in: "New"), file("b", "b.png", in: "New/Sub")], deleted: [])
        #expect(Set(diff.updated) == ["a", "b", "folder:New", "folder:New/Sub"])
        #expect(Set(diff.deleted) == ["folder:Old", "folder:Old/Sub"])
    }

    @Test func aDeletionOrATrashedRowRemovesTheFileAndAnyFolderLeftEmpty() {
        var r = Replica()
        r.apply(changed: [file("a", "a.png", in: "Only"), file("b", "b.png")], deleted: [])
        let diff = r.apply(changed: [file("b", "b.png", deleted: true)], deleted: ["a", "never-seen"])
        #expect(Set(diff.deleted) == ["a", "b", "folder:Only"])
        #expect(r.files.isEmpty)
    }

    @Test func anUnchangedFileIsNotReportedAgain() {
        var r = Replica()
        r.apply(changed: [file("a", "a.png")], deleted: [])
        #expect(r.apply(changed: [file("a", "a.png")], deleted: []).isEmpty)
        #expect(r.apply(changed: [file("a", "a.png", version: 2)], deleted: []).updated == ["a"])
    }

    @Test func theCursorOnlyMovesForward() {
        var r = Replica()
        r.apply(changed: [], deleted: [], cursor: 40)
        r.apply(changed: [], deleted: [], cursor: 12)
        #expect(r.cursor == 40)
        r.reset(scope: "s2")
        #expect(r.cursor == 0 && r.scope == "s2" && r.files.isEmpty)
    }

    @Test func survivesARoundTripToDisk() throws {
        var r = Replica()
        r.apply(changed: [file("a", "a.png", in: "X")], deleted: [], folders: ["Empty"], cursor: 9)
        r.scope = "abc"
        let back = try JSONDecoder().decode(Replica.self, from: JSONEncoder().encode(r))
        #expect(back == r)
    }

    @Test func pathsAndIdentifiers() {
        #expect(Replica.parentPath("a/b/c") == "a/b")
        #expect(Replica.parentPath("a") == "")
        #expect(Replica.lastComponent("a/b/c") == "c")
        #expect(Replica.folderPath(ofID: "folder:a/b") == "a/b")
        #expect(Replica.folderPath(ofID: "3f9e-uuid") == nil)
    }
}

struct SyncDomainTests {
    @Test func identifiersRoundTrip() {
        for d in [SyncDomain.library, .drive(id: "7c1b-uuid")] {
            #expect(SyncDomain(identifier: d.identifier) == d)
        }
        #expect(SyncDomain.drive(id: "x").identifier == "drive.x")
        #expect(SyncDomain(identifier: "drive.") == nil)
        #expect(SyncDomain(identifier: "io.onyxfs.default") == nil)
        #expect(SyncDomain.library.deltaParameter == "library")
    }
}

struct ServerAddressTests {
    @Test func typedAddressesBecomeOrigins() {
        #expect(OnyxConfig.normalizedServer("localhost:3000")?.absoluteString == "http://localhost:3000")
        #expect(OnyxConfig.normalizedServer("onyx.example.com/files")?.absoluteString == "https://onyx.example.com")
        #expect(OnyxConfig.normalizedServer(" https://onyx.example.com/ ")?.absoluteString == "https://onyx.example.com")
        #expect(OnyxConfig.normalizedServer("ftp://x") == nil)
        #expect(OnyxConfig.normalizedServer("") == nil)
    }

    @Test func theHandoffCookieIsScopedAndShortLived() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let c = try #require(WebHandoff.cookie(secret: "s", server: URL(string: "https://www.onyxfs.io")!, now: now))
        #expect(c.name == "onyx_handoff" && c.domain.hasSuffix("www.onyxfs.io"))
        #expect(c.path == "/api/desktop/web-session")
        #expect(c.isSecure)
        #expect(c.expiresDate == now.addingTimeInterval(120))
        let (secret, challenge) = WebHandoff.makeSecret()
        #expect(PKCE.challenge(for: secret) == challenge && challenge.count == 43)
    }
}
