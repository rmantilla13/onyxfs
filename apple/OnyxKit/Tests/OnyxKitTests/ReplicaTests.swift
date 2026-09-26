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

    @Test func anIdIsReportedOnceAsWhatItIsNow() {
        var r = Replica()
        r.apply(changed: [file("a", "a.png", in: "F")], deleted: [])
        // One page: a moves out of F (F empties), then b is created in F.
        let diff = r.apply(changed: [file("a", "a.png", in: "G"), file("b", "b.png", in: "F")], deleted: [])
        #expect(!diff.deleted.contains("folder:F"), "F still exists; it must not be deleted and updated at once")
        // Changed and then hard-deleted within a page: a deletion only.
        let gone = r.apply(changed: [file("c", "c.png")], deleted: ["c"])
        #expect(gone.updated.isEmpty, "created and removed within a page is never reported as present")
        r.apply(changed: [file("d", "d.png")], deleted: [])
        let d = r.apply(changed: [file("d", "d2.png")], deleted: ["d"])
        #expect(d.updated.isEmpty && d.deleted == ["d"])
    }

    @Test func theReplicaKeepsNoLinksAndCleansFolders() {
        var r = Replica()
        let withLink = FileItem(id: "a", name: "a.png", folder: "/X//Y/", kind: "image", mime: nil, size: 1,
                                url: "https://s3.example/a?X-Amz-Signature=secret", storageKey: "k", thumbnailUrl: "https://t",
                                tags: [], notes: nil, caption: nil, visibility: "org", version: 1, contentHash: nil,
                                createdBy: nil, createdAt: nil, updatedAt: nil, deletedAt: nil, seq: 1)
        r.apply(changed: [withLink], deleted: [])
        #expect(r.file(id: "a")?.folder == "X/Y")
        let encoded = String(decoding: try! JSONEncoder().encode(r), as: UTF8.self)
        #expect(!encoded.contains("Signature") && !encoded.contains("https://"))
        #expect(r.children(of: "X/Y").files.map(\.id) == ["a"])
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

    @Test func aFolderIsStampedWithWhenItAppeared() throws {
        var r = Replica()
        r.apply(changed: [file("a", "a.png", in: "A")], deleted: [], folders: ["E"], cursor: 10)
        #expect(r.firstSeen("A") == 0 && r.firstSeen("E") == 0, "the first page is the start")
        r.apply(changed: [file("b", "b.png", in: "B/C")], deleted: [], folders: ["E"], cursor: 20)
        #expect(r.firstSeen("B") == 10 && r.firstSeen("B/C") == 10)
        r.apply(changed: [], deleted: ["b"], folders: ["E"], cursor: 30)
        #expect(r.folderSeen["B"] == nil && r.folderSeen["B/C"] == nil, "gone, so forgotten")
        r.apply(changed: [file("b2", "b.png", in: "B")], deleted: [], folders: ["E"], cursor: 40)
        #expect(r.firstSeen("B") == 30, "back, and new")

        // Fetched again from the start: the stamps it had carry over.
        var fresh = Replica()
        fresh.apply(changed: [file("a", "a.png", in: "A"), file("b2", "b.png", in: "B"), file("z", "z.png", in: "Z")],
                    deleted: [], folders: ["E"], cursor: 50)
        fresh.keepFolderStamps(from: r)
        #expect(fresh.firstSeen("B") == 30 && fresh.firstSeen("A") == 0 && fresh.firstSeen("Z") == 0)

        r.reset(scope: "s2")
        #expect(r.folderSeen.isEmpty)
    }

    @Test func aReplicaSavedBeforeFolderStampsStillLoads() throws {
        var r = Replica()
        r.apply(changed: [file("a", "a.png", in: "X")], deleted: [], folders: ["Empty"], cursor: 9)
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(r)) as! [String: Any]
        json["folderSeen"] = nil
        let back = try JSONDecoder().decode(Replica.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(back.files == r.files && back.cursor == 9 && back.folders == r.folders)
        #expect(back.folderSeen.isEmpty)
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
        // https: __Host-, which requires Secure, the exact host and Path=/.
        let c = try #require(WebHandoff.cookie(secret: "s", server: URL(string: "https://www.onyxfs.io")!, now: now))
        #expect(c.name == "__Host-onyx_handoff")
        #expect(c.domain == "www.onyxfs.io", "host-only, never a parent domain")
        #expect(c.path == "/")
        #expect(c.isSecure)
        #expect(c.expiresDate == now.addingTimeInterval(120))
        // http (a local server): the plain name, on the handoff's own path.
        let local = try #require(WebHandoff.cookie(secret: "s", server: URL(string: "http://localhost:3000")!, now: now))
        #expect(local.name == "onyx_handoff" && local.path == "/api/desktop/web-session" && !local.isSecure)
        let link = WebSessionLink(url: "/api/desktop/web-session?code=x&next=%2Ffiles", expiresAt: nil)
        #expect(link.resolved(against: URL(string: "http://127.0.0.1:3000")!)?.absoluteString
                == "http://127.0.0.1:3000/api/desktop/web-session?code=x&next=%2Ffiles")
        let (secret, challenge) = WebHandoff.makeSecret()
        #expect(PKCE.challenge(for: secret) == challenge && challenge.count == 43)
    }
}
