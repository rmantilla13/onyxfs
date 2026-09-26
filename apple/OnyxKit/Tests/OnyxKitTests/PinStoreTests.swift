import Testing
import Foundation
@testable import OnyxKit

/// Files kept for offline use. What goes wrong here goes wrong quietly and
/// late — a copy deleted that was still wanted, a stale version served, a
/// folder's neighbour pinned by accident — so each rule is pinned down.
struct PinStoreTests {
    let scope = "drive.d1"

    // MARK: - Fixtures

    /// A fresh folder per test; the tests run in parallel.
    func tempFolder() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("PinStoreTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The bytes the fake downloader writes: which file, at which version.
    static func body(_ id: String, _ etag: String) -> String { "\(id)@\(etag)" }

    func file(_ id: String, _ path: String, etag: String = "v1") -> MirrorEntry {
        MirrorEntry(kind: .file, name: Replica.lastComponent(path), path: path, fileId: id,
                    size: Int64(Self.body(id, etag).utf8.count), modified: Date(timeIntervalSince1970: 0),
                    etag: etag, mime: nil)
    }

    func folderEntry(_ path: String) -> MirrorEntry {
        MirrorEntry(kind: .folder, name: Replica.lastComponent(path), path: path, fileId: nil, size: 0,
                    modified: Date(timeIntervalSince1970: 0), etag: nil, mime: nil)
    }

    func pinFolder(_ path: String, in scope: String? = nil) -> PinRule {
        PinRule(scope: scope ?? self.scope, target: .folder(path: path))
    }

    func pinFile(_ id: String, in scope: String? = nil) -> PinRule {
        PinRule(scope: scope ?? self.scope, target: .file(id: id))
    }

    func contents(_ url: URL?) -> String? {
        url.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    }

    // MARK: - Rules

    @Test func rulesSurviveReopeningAndPinningTwiceChangesNothing() async throws {
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        await store.pin(pinFolder("Photos"))
        await store.pin(pinFile("a"))
        await store.pin(pinFolder("", in: "library"))
        // The same rules again, spelled differently: no duplicates.
        await store.pin(pinFolder("/photos/"))
        await store.pin(pinFile("a"))
        await store.pin(pinFolder("Old"))
        await store.unpin(pinFolder("old"))
        await store.unpin(pinFile("never-pinned"))

        let expected = [pinFolder("Photos"), pinFile("a"), pinFolder("", in: "library")]
        #expect(await store.rules() == expected)
        #expect(await store.rules(scope: "library") == [pinFolder("", in: "library")])

        let reopened = try PinStore(directory: dir)
        #expect(await reopened.rules() == expected)
    }

    @Test func manyPinsAtOnceAreOneChange() async throws {
        // Five thousand photos chosen in the window at once.
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        let rules = (1...5000).map { pinFile("f\($0)") }
        await store.pin(rules + [pinFile("f1"), pinFolder("Docs"), pinFolder("docs/")])
        #expect(await store.rules() == rules + [pinFolder("Docs")])
        await store.unpin(Array(rules.prefix(4000)) + [pinFolder("DOCS")])
        #expect(await store.rules() == Array(rules.suffix(1000)))
        let reopened = try PinStore(directory: dir)
        #expect(await reopened.rules().count == 1000)
    }

    @Test func aPassThatChangesNothingWritesNothing() async throws {
        // pins.json lists every copy: rewriting it every fifteen seconds for
        // nothing wears the disk.
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        let index = FakeIndex([file("a", "a.txt")])
        _ = await store.reconcile(scope: scope, index: index, download: downloads.download)
        let state = dir.appendingPathComponent("pins.json")
        try FileManager.default.removeItem(at: state)

        _ = await store.reconcile(scope: scope, index: index, download: downloads.download)
        await store.pin(pinFolder("/"))
        await store.unpin(pinFile("never-pinned"))
        #expect(!FileManager.default.fileExists(atPath: state.path), "nothing changed, nothing written")

        await store.pin(pinFile("b"))
        let reopened = try PinStore(directory: dir)
        #expect(await reopened.rules() == [pinFolder(""), pinFile("b")])
        #expect(await reopened.localCopy(scope: scope, fileId: "a", etag: "v1") != nil)
    }

    @Test func eachAccountOnEachServerHasAFolderOfItsOwn() throws {
        let server = URL(string: "https://www.onyxfs.io")!
        let mine = AccountFolder.name(server: server, account: "Me@Example.com")
        #expect(mine == AccountFolder.name(server: server, account: "me@example.com"), "however it is capitalised")
        #expect(mine != AccountFolder.name(server: server, account: "you@example.com"))
        #expect(mine != AccountFolder.name(server: URL(string: "http://localhost:3000")!, account: "me@example.com"))
        #expect(AccountFolder.isName(mine) && PinStore.isPlainName(mine))
        for other in ["drive.d1", "library", "account-", "account-0123", mine + "0", mine.uppercased()] {
            #expect(!AccountFolder.isName(other), "\(other)")
        }
    }

    @Test func theStoresInAFolderAreItsAccountsWithSomethingSaved() async throws {
        let pinned = try tempFolder()
        let a = AccountFolder.name(server: URL(string: "https://a.test")!, account: "a@a.test")
        let b = AccountFolder.name(server: URL(string: "https://a.test")!, account: "b@a.test")
        let store = try PinStore(directory: pinned.appendingPathComponent(a))
        await store.pin(pinFile("x"))
        _ = try PinStore(directory: pinned.appendingPathComponent(b))
        // A store from before stores were kept per account, and a folder of
        // the user's own: neither is an account's.
        try FileManager.default.createDirectory(at: pinned.appendingPathComponent("drive.d1"),
                                                withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: pinned.appendingPathComponent("pins.json"))
        #expect(PinStore.stores(in: pinned) == [a])
        #expect(PinStore.stores(in: pinned.appendingPathComponent("none")).isEmpty)
    }

    @Test func aFolderPinReachesWholeSegmentsInAnyCase() async throws {
        let store = try PinStore(directory: try tempFolder())
        await store.pin(pinFolder("Photos"))

        #expect(await store.isPinned(scope: scope, entry: file("1", "Photos/a.jpg")))
        #expect(await store.isPinned(scope: scope, entry: file("2", "photos/Trip/b.jpg")))
        #expect(await store.isPinned(scope: scope, entry: folderEntry("Photos")))
        #expect(await store.isPinned(scope: scope, entry: folderEntry("PHOTOS/Trip")))
        // A neighbour whose name merely starts the same is not inside it.
        #expect(await !store.isPinned(scope: scope, entry: file("3", "Photos 2025/c.jpg")))
        #expect(await !store.isPinned(scope: scope, entry: folderEntry("Photos 2025")))
        #expect(await !store.isPinned(scope: scope, entry: file("4", "PhotosX.jpg")))
        // Its parent is not pinned by a pin inside it, nor is another drive.
        #expect(await !store.isPinned(scope: scope, entry: folderEntry("")))
        #expect(await !store.isPinned(scope: "drive.other", entry: file("1", "Photos/a.jpg")))
    }

    @Test func aFilePinFollowsTheFileAndPinsNoFolder() async throws {
        let store = try PinStore(directory: try tempFolder())
        await store.pin(pinFile("a"))
        #expect(await store.isPinned(scope: scope, entry: file("a", "Anywhere/Deep/a.txt")))
        #expect(await store.isPinned(scope: scope, entry: file("a", "moved.txt")))
        #expect(await !store.isPinned(scope: scope, entry: file("b", "Anywhere/Deep/b.txt")))
        #expect(await !store.isPinned(scope: scope, entry: folderEntry("Anywhere")))

        await store.pin(pinFolder(""))
        #expect(await store.isPinned(scope: scope, entry: folderEntry("")))
        #expect(await store.isPinned(scope: scope, entry: file("b", "Anywhere/Deep/b.txt")))
    }

    @Test func wantedIsEachReachedFileOnce() async throws {
        let store = try PinStore(directory: try tempFolder())
        let index = FakeIndex([file("a", "Photos/a.jpg"), file("b", "Photos/Trip/b.jpg"),
                               file("c", "Photos 2025/c.jpg"), file("d", "Docs/d.pdf"), folderEntry("Photos")])
        await store.pin(pinFile("a"))
        await store.pin(pinFolder("Photos"))
        await store.pin(pinFolder("Photos/Trip"))
        await store.pin(pinFile("d"))
        await store.pin(pinFile("gone"))
        await store.pin(pinFolder("", in: "drive.other"))

        let wanted = await store.wanted(scope: scope, index: index)
        #expect(wanted.map(\.fileId) == ["a", "b", "d"])
    }

    // MARK: - Reconcile

    @Test func reconcileFetchesWhatIsPinnedAndDeletesWhatIsNot() async throws {
        let store = try PinStore(directory: try tempFolder())
        let downloads = FakeDownloads()
        await store.pin(pinFolder("Photos"))
        var index = FakeIndex([file("a", "Photos/a.jpg"), file("b", "Photos/b.jpg"), file("c", "Other/c.jpg")])

        let first = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(first.downloaded == 2 && first.removed == 0 && first.failed.isEmpty)
        #expect(first.bytes == Int64((Self.body("a", "v1") + Self.body("b", "v1")).utf8.count))
        #expect(contents(await store.localCopy(scope: scope, fileId: "a", etag: "v1")) == Self.body("a", "v1"))
        #expect(contents(await store.localCopy(scope: scope, fileId: "b", etag: "v1")) == Self.body("b", "v1"))
        #expect(await store.localCopy(scope: scope, fileId: "c", etag: nil) == nil)

        // Nothing changed: nothing fetched.
        let again = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(again == PinStore.ReconcileReport())
        #expect(await downloads.calls == ["a": 1, "b": 1])

        // Gone from the drive: its copy goes.
        let b = try #require(await store.localCopy(scope: scope, fileId: "b", etag: nil))
        index = FakeIndex([file("a", "Photos/a.jpg"), file("c", "Other/c.jpg")])
        let gone = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(gone.removed == 1 && gone.downloaded == 0)
        #expect(!FileManager.default.fileExists(atPath: b.path))

        // Unpinned: its copies go, and so does the drive's folder.
        let a = try #require(await store.localCopy(scope: scope, fileId: "a", etag: nil))
        await store.unpin(pinFolder("Photos"))
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) != nil, "kept until the next pass")
        let unpinned = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(unpinned.removed == 1)
        #expect(!FileManager.default.fileExists(atPath: a.path))
        #expect(!FileManager.default.fileExists(atPath: a.deletingLastPathComponent().path))
        #expect(await store.usage() == 0)
    }

    @Test func aDriveStillBeingFetchedDeletesNothing() async throws {
        // A first sync, or one after the access changed, fails a quarter of
        // the way through: the index has a quarter of the drive. The rest is
        // not gone, only not fetched yet, and its copies are what someone
        // offline is counting on.
        let store = try PinStore(directory: try tempFolder())
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        let whole = [file("a", "a.jpg"), file("b", "Photos/b.jpg"), file("c", "c.jpg")]
        _ = await store.reconcile(scope: scope, index: FakeIndex(whole), download: downloads.download)

        let partial = FakeIndex([file("a", "a.jpg"), file("d", "d.jpg")], authoritative: false)
        let report = await store.reconcile(scope: scope, index: partial, download: downloads.download)
        #expect(report.removed == 0)
        #expect(report.downloaded == 1, "what it does have is still fetched")
        for id in ["a", "b", "c", "d"] {
            #expect(await store.localCopy(scope: scope, fileId: id, etag: "v1") != nil, "\(id) kept")
        }

        // Once the drive is whole again, what it lacks is really gone.
        let done = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.jpg"), file("d", "d.jpg")]),
                                         download: downloads.download)
        #expect(done.removed == 2)
        #expect(await store.localCopy(scope: scope, fileId: "b", etag: nil) == nil)
    }

    @Test func aNewVersionReplacesTheOldOne() async throws {
        let store = try PinStore(directory: try tempFolder())
        let downloads = FakeDownloads()
        await store.pin(pinFile("a"))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt", etag: "v1")]),
                                  download: downloads.download)
        let v1 = try #require(await store.localCopy(scope: scope, fileId: "a", etag: "v1"))

        let report = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt", etag: "v2")]),
                                           download: downloads.download)
        #expect(report.downloaded == 1 && report.removed == 0)
        let v2 = try #require(await store.localCopy(scope: scope, fileId: "a", etag: "v2"))
        #expect(v2 != v1)
        #expect(contents(v2) == Self.body("a", "v2"))
        #expect(!FileManager.default.fileExists(atPath: v1.path))
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: "v1") == nil)
    }

    @Test func aFailedDownloadKeepsTheOldCopyAndStopsNoOther() async throws {
        // Tried again at once, for this test; see aFailedDownloadWaits….
        let store = try PinStore(directory: try tempFolder(), retryAfter: .zero)
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt", etag: "v1")]),
                                  download: downloads.download)
        let v1 = try #require(await store.localCopy(scope: scope, fileId: "a", etag: "v1"))

        await downloads.fail("a")
        await downloads.fail("new-and-failing")
        let index = FakeIndex([file("a", "a.txt", etag: "v2"), file("b", "b.txt"), file("new-and-failing", "c.txt")])
        let report = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(Set(report.failed.keys) == ["a", "new-and-failing"])
        #expect(report.downloaded == 1 && report.removed == 0)
        #expect(report.failed["a"]?.contains("refused") == true, "the downloader's own reason")

        // Still pinned, still wanted: the old version stays and is served when
        // any version will do.
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) == v1)
        #expect(contents(v1) == Self.body("a", "v1"))
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: "v2") == nil)
        #expect(await store.localCopy(scope: scope, fileId: "b", etag: "v1") != nil)
        #expect(await store.localCopy(scope: scope, fileId: "new-and-failing", etag: nil) == nil)

        // A download cut short is refused, not stored as the file.
        await downloads.succeed("a")
        await downloads.truncate("a")
        let short = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(short.failed["a"] != nil)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) == v1)
    }

    @Test func atMostThreeDownloadsAtOnce() async throws {
        let store = try PinStore(directory: try tempFolder())
        let downloads = FakeDownloads(delay: 30_000_000)
        await store.pin(pinFolder(""))
        let index = FakeIndex((1...10).map { file("f\($0)", "f\($0).bin") })
        let report = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(report.downloaded == 10)
        #expect(await downloads.maxInFlight == 3)
    }

    @Test func aSecondPassWaitsForTheFirstThenRunsItsOwn() async throws {
        let store = try PinStore(directory: try tempFolder())
        let gate = Gate()
        let downloads = FakeDownloads(gate: gate)
        await store.pin(pinFolder(""))
        let before = FakeIndex([file("a", "a.txt"), file("b", "b.txt"), file("c", "c.txt")])
        let after = FakeIndex(before.entries + [file("d", "d.txt")])

        let scope = self.scope
        let first = Task { await store.reconcile(scope: scope, index: before, download: downloads.download) }
        await until { await downloads.started >= 1 }
        // Arrives while the first pass is stuck mid-download, with news.
        let second = Task { await store.reconcile(scope: scope, index: after, download: downloads.download) }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await downloads.started == 3, "the second pass must not start while the first runs")
        await gate.open()

        let r1 = await first.value, r2 = await second.value
        #expect(r1.downloaded == 3)
        #expect(r2.downloaded == 1, "only what the first pass could not have seen")
        #expect(await downloads.calls == ["a": 1, "b": 1, "c": 1, "d": 1])
        #expect(await store.localCopy(scope: scope, fileId: "d", etag: "v1") != nil)
    }

    @Test func aFileUnpinnedMidDownloadIsNotKept() async throws {
        let store = try PinStore(directory: try tempFolder())
        let gate = Gate()
        let downloads = FakeDownloads(gate: gate)
        await store.pin(pinFile("a"))
        let scope = self.scope, index = FakeIndex([file("a", "a.txt")])
        let pass = Task { await store.reconcile(scope: scope, index: index, download: downloads.download) }
        await until { await downloads.started == 1 }
        await store.unpin(pinFile("a"))
        await gate.open()
        let report = await pass.value
        #expect(report.downloaded == 0 && report.failed.isEmpty)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) == nil)
        #expect(await store.usage() == 0)
    }

    @Test func callsDuringAPassShareOneMoreWithTheLatestIndex() async throws {
        // A tick every fifteen seconds through an hours-long download: one
        // pass waits behind it, not one per tick, and it reads the latest.
        let store = try PinStore(directory: try tempFolder())
        let gate = Gate()
        let downloads = FakeDownloads(gate: gate)
        await store.pin(pinFolder(""))
        let before = FakeIndex([file("a", "a.txt"), file("b", "b.txt"), file("c", "c.txt")])
        let stale = FakeIndex(before.entries + [file("d", "d.txt")])
        let latest = FakeIndex(before.entries + [file("e", "e.txt")])

        let scope = self.scope
        let first = Task { await store.reconcile(scope: scope, index: before, download: downloads.download) }
        await until { await downloads.started == 3 }
        let second = Task { await store.reconcile(scope: scope, index: stale, download: downloads.download) }
        let third = Task { await store.reconcile(scope: scope, index: stale, download: downloads.download) }
        try await Task.sleep(nanoseconds: 30_000_000)
        let fourth = Task { await store.reconcile(scope: scope, index: latest, download: downloads.download) }
        try await Task.sleep(nanoseconds: 30_000_000)
        await gate.open()

        #expect(await first.value.downloaded == 3)
        let r2 = await second.value, r3 = await third.value, r4 = await fourth.value
        #expect(r2 == r4 && r3 == r4, "one pass, shared")
        #expect(r4.downloaded == 1)
        #expect(await downloads.calls == ["a": 1, "b": 1, "c": 1, "e": 1], "d was out of date before its pass began")
    }

    @Test func aStoppedPassStartsNoMoreDownloads() async throws {
        // A sign-out mid-download: nothing more is fetched for the account,
        // and a sign-in straight after waits for the stopped pass to end.
        let store = try PinStore(directory: try tempFolder())
        let gate = Gate()
        let downloads = FakeDownloads(gate: gate)
        await store.pin(pinFolder(""))
        let scope = self.scope, index = FakeIndex((1...10).map { file("f\($0)", "f\($0).bin") })
        let pass = Task { await store.reconcile(scope: scope, index: index, download: downloads.download) }
        await until { await downloads.started == 3 }
        await store.cancelPasses()
        let next = Task { await store.reconcile(scope: scope, index: index, download: downloads.download) }
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(await downloads.started == 3)
        await gate.open()

        let stopped = await pass.value
        #expect(stopped.downloaded == 3 && stopped.failed.isEmpty, "what was under way is kept")
        let rest = await next.value
        #expect(rest.downloaded == 7)
        #expect(await downloads.calls.values.allSatisfy { $0 == 1 }, "nothing fetched twice")
    }

    @Test func aFailedDownloadWaitsBeforeItIsTriedAgain() async throws {
        let store = try PinStore(directory: try tempFolder(), retryAfter: .seconds(600))
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        await downloads.fail("a")
        let index = FakeIndex([file("a", "a.txt"), file("b", "b.txt")])
        let first = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(Set(first.failed.keys) == ["a"] && first.downloaded == 1)

        // Not fetched whole again on every pass, only to fail again.
        await downloads.succeed("a")
        let second = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(second.waiting == 1 && second.failed.isEmpty && second.downloaded == 0)
        #expect(await downloads.calls["a"] == 1)

        // A new version is worth a try at once.
        await downloads.fail("a")
        let v2 = FakeIndex([file("a", "a.txt", etag: "v2"), file("b", "b.txt")])
        let third = await store.reconcile(scope: scope, index: v2, download: downloads.download)
        #expect(third.failed["a"] != nil)
        #expect(await downloads.calls["a"] == 2)

        // Back online, everything is.
        await downloads.succeed("a")
        await store.retryNow()
        let fourth = await store.reconcile(scope: scope, index: v2, download: downloads.download)
        #expect(fourth.downloaded == 1 && fourth.waiting == 0)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: "v2") != nil)
    }

    @Test func aFullDiskFetchesOnlyWhatFits() async throws {
        let free = Space(PinStore.spareSpace + 10)
        let store = try PinStore(directory: try tempFolder(), freeSpace: { _ in free.bytes })
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        // Four bytes each ("a@v1"): room for two beside the spare gigabyte.
        let index = FakeIndex(["a", "b", "c", "d"].map { file($0, "\($0).txt") })
        let report = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(report.problem == .full)
        #expect(report.downloaded == 2 && Set(report.failed.keys) == ["c", "d"])
        #expect(await downloads.calls == ["a": 1, "b": 1], "the rest not fetched only to be thrown away")
        #expect(await store.problem == .full)

        // Room made: no wait to sit out, since nothing was tried.
        free.bytes = PinStore.spareSpace + 1000
        let later = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(later.problem == nil && later.downloaded == 2)
        #expect(await store.problem == nil)
    }

    @Test func aFolderItCannotWriteToIsLeftAlone() async throws {
        // As when its disk is unplugged: fetching would throw every file
        // away, and deleting would drop the records of copies still on it.
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt")]), download: downloads.download)
        let other = FakeIndex([file("b", "b.txt")])

        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path) }
        let report = await store.reconcile(scope: scope, index: other, download: downloads.download)
        #expect(report == PinStore.ReconcileReport(problem: .unavailable))
        #expect(await store.problem == .unavailable)
        #expect(await downloads.calls["b"] == nil, "nothing fetched")
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) != nil, "nothing deleted")
        let elsewhere = try tempFolder().appendingPathComponent("Moved")
        await #expect(throws: PinStoreError.unavailable(dir)) { try await store.relocate(to: elsewhere) }

        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
        let back = await store.reconcile(scope: scope, index: other, download: downloads.download)
        #expect(back.problem == nil && back.removed == 1 && back.downloaded == 1)
        #expect(await store.problem == nil)
    }

    @Test func aFolderDeletedByHandIsMadeAgain() async throws {
        let dir = try tempFolder().appendingPathComponent("Pinned", isDirectory: true)
        let store = try PinStore(directory: dir)
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        let index = FakeIndex([file("a", "a.txt")])
        _ = await store.reconcile(scope: scope, index: index, download: downloads.download)
        try FileManager.default.removeItem(at: dir)

        let report = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(report.problem == nil && report.downloaded == 1)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: "v1") != nil)
    }

    @Test func aStoreOnADiskThatIsNotConnectedIsNotMade() throws {
        let disk = URL(fileURLWithPath: "/Volumes/Onyx-Test-\(UUID().uuidString)", isDirectory: true)
        let missing = disk.appendingPathComponent("Onyx Cache/Pinned", isDirectory: true)
        #expect(PinStore.isOnMissingVolume(missing))
        #expect(throws: PinStoreError.unavailable(missing)) { try PinStore(directory: missing) }
        #expect(!FileManager.default.fileExists(atPath: disk.path))
        #expect(!PinStore.isOnMissingVolume(try tempFolder()))
        #expect(!PinStore.isOnMissingVolume(URL(fileURLWithPath: "/Volumes", isDirectory: true)))
    }

    @Test func downloadsAreWrittenOnTheStoresOwnDisk() async throws {
        // Not the startup disk's temporary folder: an external cache would
        // need room there too, for the largest files, three at once.
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        let downloads = FakeDownloads()
        await store.pin(pinFile("a"))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt")]), download: downloads.download)
        let destination = try #require(await downloads.destinations.first)
        #expect(destination.deletingLastPathComponent().standardizedFileURL
                == dir.appendingPathComponent(".incoming", isDirectory: true).standardizedFileURL)
        #expect(!FileManager.default.fileExists(atPath: destination.path), "renamed into place")
    }

    @Test func aRenamedPinnedFolderKeepsItsCopiesAndSaysSo() async throws {
        let store = try PinStore(directory: try tempFolder())
        let downloads = FakeDownloads()
        let rule = pinFolder("Projects/Client A")
        await store.pin(rule)
        let before = FakeIndex([file("a", "Projects/Client A/a.txt"), file("b", "Projects/Client A/Sub/b.txt"),
                                file("c", "Other/c.txt")])
        _ = await store.reconcile(scope: scope, index: before, download: downloads.download)
        #expect(await store.unresolved(scope: scope, index: before).isEmpty)
        #expect(await store.unresolved(scope: scope, index: FakeIndex([folderEntry("Projects/Client A")])).isEmpty,
                "an empty folder is still there")

        // Renamed on the web: the files move, and the rule names nothing.
        let renamed = FakeIndex([file("a", "Projects/Client B/a.txt"), file("b", "Projects/Client B/Sub/b.txt"),
                                 file("c", "Other/c.txt")])
        let report = await store.reconcile(scope: scope, index: renamed, download: downloads.download)
        #expect(report.removed == 0 && report.unresolved == [rule])
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: "v1") != nil, "still served, at its new path")
        // A drive still being fetched proves nothing either way.
        #expect(await store.unresolved(scope: scope, index: FakeIndex([], authoritative: false)).isEmpty)

        // A file gone from the drive goes, rule or no rule.
        let deleted = FakeIndex([file("a", "Projects/Client B/a.txt"), file("c", "Other/c.txt")])
        let gone = await store.reconcile(scope: scope, index: deleted, download: downloads.download)
        #expect(gone.removed == 1)
        #expect(await store.localCopy(scope: scope, fileId: "b", etag: nil) == nil)

        // The stale rule removed, what it kept goes.
        await store.unpin(rule)
        let cleared = await store.reconcile(scope: scope, index: deleted, download: downloads.download)
        #expect(cleared.removed == 1 && cleared.unresolved.isEmpty)
        #expect(await store.usage() == 0)
    }

    // MARK: - Copies

    @Test func aLocalCopyMustMatchItsEtagAndBeWhole() async throws {
        let store = try PinStore(directory: try tempFolder())
        let downloads = FakeDownloads()
        await store.pin(pinFile("a"))
        let index = FakeIndex([file("a", "a.txt", etag: "v1")])
        _ = await store.reconcile(scope: scope, index: index, download: downloads.download)

        let copy = try #require(await store.localCopy(scope: scope, fileId: "a", etag: "v1"))
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) == copy)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: "v0") == nil)
        #expect(await store.localCopy(scope: "drive.other", fileId: "a", etag: nil) == nil)
        #expect(await store.localCopy(scope: scope, fileId: "b", etag: nil) == nil)

        // Truncated behind the store's back: not served, and fetched again.
        try Data("a@".utf8).write(to: copy)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) == nil)
        let repaired = await store.reconcile(scope: scope, index: index, download: downloads.download)
        #expect(repaired.downloaded == 1)
        #expect(contents(await store.localCopy(scope: scope, fileId: "a", etag: "v1")) == Self.body("a", "v1"))

        // Deleted behind its back: the same.
        try FileManager.default.removeItem(at: copy)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) == nil)
    }

    @Test func copiesAreNamedForTheirVersionAndStayInTheirFolder() throws {
        let name = PinStore.storedName(fileId: "3f2a9c1e-0000-4000-8000-000000000001", etag: "abc")
        #expect(name == "3f2a9c1e-0000-4000-8000-000000000001-" + SigV4.sha256Hex("abc").prefix(12))
        #expect(PinStore.storedName(fileId: "x", etag: "abc") == PinStore.storedName(fileId: "x", etag: "abc"))
        #expect(PinStore.storedName(fileId: "x", etag: "abc") != PinStore.storedName(fileId: "x", etag: "abd"))
        // An id or scope that is not a plain name cannot climb out of the store.
        for hostile in ["../../x", "a/b", ".hidden", "", ".."] {
            #expect(!PinStore.safeName(hostile).contains("/") && !PinStore.safeName(hostile).hasPrefix("."))
            #expect(!PinStore.safeName(hostile).isEmpty)
        }
        #expect(PinStore.safeName("drive.3f2a9c1e") == "drive.3f2a9c1e")
        #expect(PinStore.safeName("library") == "library")
    }

    @Test func usageCountsTheCopiesOnDisk() async throws {
        let store = try PinStore(directory: try tempFolder())
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        await store.pin(pinFolder("", in: "library"))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt"), file("b", "b.txt")]),
                                  download: downloads.download)
        _ = await store.reconcile(scope: "library", index: FakeIndex([file("c", "c.txt")]),
                                  download: downloads.download)
        let drive = Int64((Self.body("a", "v1") + Self.body("b", "v1")).utf8.count)
        let library = Int64(Self.body("c", "v1").utf8.count)
        #expect(await store.usage(scope: scope) == drive)
        #expect(await store.usage(scope: "library") == library)
        #expect(await store.usage() == drive + library)
        #expect(await store.usage(scope: "drive.none") == 0)
    }

    @Test func removeAllForgetsOneScopeOnly() async throws {
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        await store.pin(pinFile("c", in: "library"))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt")]), download: downloads.download)
        _ = await store.reconcile(scope: "library", index: FakeIndex([file("c", "c.txt")]),
                                  download: downloads.download)
        let a = try #require(await store.localCopy(scope: scope, fileId: "a", etag: nil))

        await store.removeAll(scope: scope)
        #expect(await store.rules(scope: scope).isEmpty)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) == nil)
        #expect(!FileManager.default.fileExists(atPath: a.path))
        #expect(await store.usage(scope: scope) == 0)
        #expect(await store.rules() == [pinFile("c", in: "library")])
        #expect(await store.localCopy(scope: "library", fileId: "c", etag: nil) != nil)

        let reopened = try PinStore(directory: dir)
        #expect(await reopened.rules() == [pinFile("c", in: "library")])
        #expect(await reopened.localCopy(scope: "library", fileId: "c", etag: "v1") != nil)
    }

    @Test func removeAllWaitsForTheStoresDiskToBeBack() async throws {
        // A drive lost while the cache's disk is unplugged: dropping the
        // records now would leave its copies on that disk with nothing to
        // find them by. So nothing changes until the disk is back.
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt")]), download: downloads.download)
        let a = try #require(await store.localCopy(scope: scope, fileId: "a", etag: nil))

        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path) }
        #expect(await store.removeAll(scope: scope) == false)
        #expect(await store.problem == .unavailable)
        #expect(await store.rules(scope: scope) == [pinFolder("")])
        #expect(FileManager.default.fileExists(atPath: a.path))

        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
        #expect(await store.removeAll(scope: scope) == true)
        #expect(await store.rules(scope: scope).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: a.path))
        let reopened = try PinStore(directory: dir)
        #expect(await reopened.rules().isEmpty)
    }

    @Test func removeAllMidDownloadLeavesNothingBehind() async throws {
        // A drive the account lost while its pins were downloading: nothing
        // that lands afterwards may stay.
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        let gate = Gate()
        let downloads = FakeDownloads(gate: gate)
        await store.pin(pinFolder(""))
        let scope = self.scope, index = FakeIndex([file("a", "a.txt"), file("b", "b.txt")])
        let pass = Task { await store.reconcile(scope: scope, index: index, download: downloads.download) }
        await until { await downloads.started == 2 }
        await store.removeAll(scope: scope)
        await gate.open()
        let report = await pass.value
        #expect(report.downloaded == 0)
        #expect(await store.rules(scope: scope).isEmpty)
        #expect(await store.usage(scope: scope) == 0)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent(scope).path))
        let reopened = try PinStore(directory: dir)
        #expect(await reopened.rules().isEmpty)
    }

    // MARK: - Where it lives

    @Test func relocateMovesEverythingAndUsesTheNewPlace() async throws {
        let old = try tempFolder(), new = try tempFolder().appendingPathComponent("Offline", isDirectory: true)
        let store = try PinStore(directory: old)
        let downloads = FakeDownloads()
        await store.pin(pinFolder(""))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt"), file("b", "Sub/b.txt")]),
                                  download: downloads.download)
        // Something of the user's own in the old folder stays where it is.
        try Data("mine".utf8).write(to: old.appendingPathComponent("notes.txt"))

        try await store.relocate(to: new)
        #expect(await store.directory == new)
        let a = try #require(await store.localCopy(scope: scope, fileId: "a", etag: "v1"))
        #expect(a.path.hasPrefix(new.path))
        #expect(contents(a) == Self.body("a", "v1"))
        #expect(!FileManager.default.fileExists(atPath: old.appendingPathComponent("pins.json").path))
        #expect(!FileManager.default.fileExists(atPath: old.appendingPathComponent(scope).path))
        #expect(FileManager.default.fileExists(atPath: old.appendingPathComponent("notes.txt").path))

        // It carries on there: new downloads land in the new place, and a
        // store opened on it finds everything.
        let more = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt"), file("b", "Sub/b.txt"),
                                                                         file("c", "c.txt")]),
                                         download: downloads.download)
        #expect(more.downloaded == 1)
        let reopened = try PinStore(directory: new)
        #expect(await reopened.rules() == [pinFolder("")])
        for id in ["a", "b", "c"] {
            #expect(await reopened.localCopy(scope: scope, fileId: id, etag: "v1") != nil)
        }
        #expect(await reopened.usage() == (await store.usage()))
    }

    @Test func relocateRefusesAFolderAnotherStoreUsed() async throws {
        let old = try tempFolder(), taken = try tempFolder()
        let other = try PinStore(directory: taken)
        await other.pin(pinFile("theirs"))

        let store = try PinStore(directory: old)
        let downloads = FakeDownloads()
        await store.pin(pinFile("a"))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt")]), download: downloads.download)

        await #expect(throws: PinStoreError.locationInUse(taken)) { try await store.relocate(to: taken) }
        // Nothing moved, nothing merged.
        #expect(await store.directory == old)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: "v1") != nil)
        let theirs = try PinStore(directory: taken)
        #expect(await theirs.rules() == [pinFile("theirs")])

        // Relocating to where it already is does nothing.
        try await store.relocate(to: old)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: "v1") != nil)
    }

    @Test func theCacheCannotGoWhereItWouldBreakItself() throws {
        let home = try tempFolder()
        let mounts = home.appendingPathComponent("Onyx", isDirectory: true)
        try FileManager.default.createDirectory(at: mounts.appendingPathComponent("Team Drive"),
                                                withIntermediateDirectories: true)
        let current = home.appendingPathComponent("Library/Offline", isDirectory: true)
        try FileManager.default.createDirectory(at: current.appendingPathComponent("Streaming"),
                                                withIntermediateDirectories: true)
        func refusal(_ path: String) -> String? {
            CacheLocation.refusal(for: home.appendingPathComponent(path), current: current, mounts: mounts)
        }
        // In a drive's mount point: rclone will not mount over it again.
        #expect(refusal("Onyx/Onyx Cache") != nil)
        #expect(refusal("Onyx/Team Drive/Onyx Cache") != nil)
        #expect(refusal("onyx/team drive/Onyx Cache") != nil, "in any case")
        // In the cache itself: clearing the old streaming cache would delete it.
        #expect(refusal("Library/Offline/Streaming/Onyx Cache") != nil)
        #expect(refusal("Library/Offline/Pinned/x/Onyx Cache") != nil)
        #expect(refusal("Onyx Cache") == nil)
        #expect(refusal("Onyx 2/Onyx Cache") == nil, "a neighbour whose name merely starts the same")
        #expect(refusal("Library/Offline/Elsewhere/Onyx Cache") == nil)

        let link = home.appendingPathComponent("Shortcut")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: mounts.appendingPathComponent("Team Drive"))
        #expect(refusal("Shortcut/Onyx Cache") != nil, "nor through a link")

        #expect(CacheLocation.isSame(current, home.appendingPathComponent("library/offline/")))
        #expect(!CacheLocation.isSame(current, current.appendingPathComponent("Streaming")))
    }

    @Test func aCorruptStateFileStartsEmptyAndCarriesOn() async throws {
        let dir = try tempFolder()
        try Data("{ not json".utf8).write(to: dir.appendingPathComponent("pins.json"))
        let store = try PinStore(directory: dir)
        #expect(await store.rules().isEmpty)
        #expect(await store.usage() == 0)
        // Kept aside for a person, not silently overwritten.
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("pins.corrupt.json").path))

        await store.pin(pinFile("a"))
        let reopened = try PinStore(directory: dir)
        #expect(await reopened.rules() == [pinFile("a")])

        // A missing folder is created.
        let fresh = dir.appendingPathComponent("not/yet/here", isDirectory: true)
        let empty = try PinStore(directory: fresh)
        #expect(await empty.rules().isEmpty)
        #expect(FileManager.default.fileExists(atPath: fresh.path))
    }

    @Test func aTamperedStateFileCannotNameFilesOutsideTheStore() async throws {
        let dir = try tempFolder()
        let victim = dir.appendingPathComponent("victim.txt")
        try Data("keep me".utf8).write(to: victim)
        let json = #"{"copies":{"drive.d1":{"a":{"etag":"v1","size":7,"stored":"../victim.txt"}}},"rules":[]}"#
        try Data(json.utf8).write(to: dir.appendingPathComponent("pins.json"))
        let store = try PinStore(directory: dir)
        #expect(await store.localCopy(scope: scope, fileId: "a", etag: nil) == nil)
        await store.removeAll(scope: scope)
        _ = await store.reconcile(scope: scope, index: FakeIndex([]), download: FakeDownloads().download)
        #expect(FileManager.default.fileExists(atPath: victim.path))
    }

    @Test func reopeningClearsAnOldVersionACrashLeftBehind() async throws {
        let dir = try tempFolder()
        let store = try PinStore(directory: dir)
        await store.pin(pinFile("a"))
        _ = await store.reconcile(scope: scope, index: FakeIndex([file("a", "a.txt", etag: "v2")]),
                                  download: FakeDownloads().download)
        let current = try #require(await store.localCopy(scope: scope, fileId: "a", etag: "v2"))
        let folder = current.deletingLastPathComponent()
        let leftover = folder.appendingPathComponent(PinStore.storedName(fileId: "a", etag: "v1"))
        let unrelated = folder.appendingPathComponent("report-0123456789ab")
        try Data("old".utf8).write(to: leftover)
        try Data("not ours".utf8).write(to: unrelated)

        _ = try PinStore(directory: dir)
        #expect(!FileManager.default.fileExists(atPath: leftover.path))
        #expect(FileManager.default.fileExists(atPath: current.path))
        #expect(FileManager.default.fileExists(atPath: unrelated.path))
    }
}

// MARK: - Fakes

extension PinStoreTests {
    /// A drive's files, answered the way MirrorIndex does: by whole path
    /// segments, ignoring case.
    struct FakeIndex: PinnableIndex {
        let entries: [MirrorEntry]
        var isAuthoritative = true
        init(_ entries: [MirrorEntry], authoritative: Bool = true) {
            self.entries = entries
            isAuthoritative = authoritative
        }

        func files(under folderPath: String) -> [MirrorEntry] {
            let prefix = folderPath.lowercased().split(separator: "/")
            return entries.filter { entry in
                let parts = entry.path.lowercased().split(separator: "/")
                return !entry.isFolder && parts.count > prefix.count && Array(parts.prefix(prefix.count)) == prefix
            }
        }

        func file(id: String) -> MirrorEntry? { entries.first { $0.fileId == id && !$0.isFolder } }

        func hasFolder(at path: String) -> Bool {
            let parts = path.lowercased().split(separator: "/")
            guard !parts.isEmpty else { return true }
            return entries.contains { entry in
                let p = entry.path.lowercased().split(separator: "/")
                return (entry.isFolder && p == parts) || (p.count > parts.count && Array(p.prefix(parts.count)) == parts)
            }
        }
    }

    /// Writes "<id>@<etag>" to a temporary file, counting calls and how many run
    /// at once; can be told to fail, to cut a body short, or to wait at a gate.
    actor FakeDownloads {
        struct Refused: LocalizedError {
            let id: String
            var errorDescription: String? { "The server refused \(id)." }
        }

        private(set) var calls: [String: Int] = [:]
        /// Where each download was told to write.
        private(set) var destinations: [URL] = []
        private(set) var started = 0
        private(set) var maxInFlight = 0
        private var inFlight = 0
        private var failing: Set<String> = []
        private var truncating: Set<String> = []
        let delay: UInt64
        let gate: Gate?

        init(delay: UInt64 = 0, gate: Gate? = nil) {
            self.delay = delay
            self.gate = gate
        }

        func fail(_ id: String) { failing.insert(id) }
        func succeed(_ id: String) { failing.remove(id) }
        func truncate(_ id: String) { truncating.insert(id) }

        nonisolated var download: PinStore.Download {
            { entry, destination in try await self.fetch(entry, to: destination) }
        }

        private func fetch(_ entry: MirrorEntry, to destination: URL) async throws {
            let id = entry.fileId ?? ""
            calls[id, default: 0] += 1
            destinations.append(destination)
            started += 1
            inFlight += 1
            maxInFlight = max(maxInFlight, inFlight)
            defer { inFlight -= 1 }
            if let gate { await gate.wait() }
            if delay > 0 { try await Task.sleep(nanoseconds: delay) }
            if failing.contains(id) { throw Refused(id: id) }
            var body = PinStoreTests.body(id, entry.etag ?? "")
            if truncating.contains(id) { body = String(body.prefix(2)) }
            try Data(body.utf8).write(to: destination)
        }
    }

    /// Free bytes, as a test sets them.
    final class Space: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Int64
        init(_ bytes: Int64) { value = bytes }
        var bytes: Int64 {
            get { lock.withLock { value } }
            set { lock.withLock { value = newValue } }
        }
    }

    /// Holds downloads until opened.
    actor Gate {
        private var isOpen = false
        private var waiting: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            if isOpen { return }
            await withCheckedContinuation { waiting.append($0) }
        }

        func open() {
            isOpen = true
            waiting.forEach { $0.resume() }
            waiting = []
        }
    }

    /// Polls until `condition` holds, for up to about two seconds.
    func until(_ condition: @Sendable () async -> Bool) async {
        for _ in 0..<1000 {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }
}
