import Testing
import Foundation
@testable import OnyxKit

private let thumb = "_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp"

private func item(_ id: String, _ name: String, mime: String? = nil, size: Int64? = 1000, version: Int = 1,
                  created: Int64? = nil, thumbnail: String? = nil, sizes: [String]? = nil,
                  poster: String? = nil) -> FileItem {
    var file = FileItem(id: id, name: name, folder: "", kind: "other", mime: mime, size: size, url: nil,
                        storageKey: nil, thumbnailUrl: nil, tags: [], notes: nil, caption: nil, visibility: "org",
                        version: version, contentHash: nil, createdBy: nil, createdAt: created.map(EpochMillis.init),
                        updatedAt: nil, deletedAt: nil, seq: nil)
    file.thumbnailKey = thumbnail
    file.thumbSizes = sizes
    file.posterKey = poster
    return file
}

private func candidate(_ file: FileItem, scope: String = "drive.d1") -> ThumbnailCandidate? {
    ThumbnailCandidate(ReplicaFile(file), scope: scope)
}

/// Which files the Mac makes pictures for, in what order, and when it
/// leaves one alone. Getting these wrong costs either a drive's worth of
/// downloads or thumbnails that never come.
struct ThumbnailRulesTests {
    @Test func previewsAreReadFromTheFeedsRow() {
        #expect(FilePreviews(item("a", "a.mov")) == [])
        #expect(FilePreviews(item("a", "a.mov", thumbnail: thumb)) == [.thumbnail])
        #expect(FilePreviews(item("a", "a.mov", thumbnail: thumb, sizes: ["sm", "xs"])) == [.thumbnail, .sizes])
        #expect(FilePreviews(item("a", "a.mov", thumbnail: thumb, sizes: [],
                                  poster: "_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.poster.webp")) == [.thumbnail, .poster])
        // Only a key the presign route names is a thumbnail; siblings only beside one.
        #expect(FilePreviews(item("a", "a.mov", thumbnail: "team/Cuts/a-thumb-x.jpg", sizes: ["sm"])) == [])
        #expect(FilePreviews(item("a", "a.mov", thumbnail: "_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.sm.webp")) == [])
        #expect(FilePreviews.isThumbKey("_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg"))
        #expect(!FilePreviews.isThumbKey("_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.png"))
        #expect(!FilePreviews.isThumbKey("_thumbs/nested/7c9e6679-7425-40de-944b-e07fc1f9.jpg"))
        #expect(!FilePreviews.isThumbKey(nil))
    }

    @Test func aReplicaKeepsThemAndSurvivesOneSavedWithout() throws {
        var r = Replica()
        r.apply(changed: [item("a", "a.mov", thumbnail: thumb, sizes: ["sm"])], deleted: [])
        #expect(r.file(id: "a")?.previews == [.thumbnail, .sizes])
        let back = try JSONDecoder().decode(Replica.self, from: JSONEncoder().encode(r))
        #expect(back == r)
        let old = #"{ "id": "f", "name": "a.mov", "folder": "", "mime": null, "size": 1, "version": 1, "contentHash": null }"#
        #expect(try JSONDecoder().decode(ReplicaFile.self, from: Data(old.utf8)).previews == nil, "not known, rather than none")
    }

    @Test func aPictureMadeLaterIsNotAChangeFinderSees() {
        var r = Replica()
        r.apply(changed: [item("a", "a.mov")], deleted: [])
        let made = r.apply(changed: [item("a", "a.mov", thumbnail: thumb, sizes: ["sm", "xs"])], deleted: [])
        #expect(made.isEmpty, "nothing listed changed")
        #expect(made.previews == ["a"])
        #expect(r.file(id: "a")?.previews == [.thumbnail, .sizes])
        // New contents drop the pictures, and that is a change of its own.
        let replaced = r.apply(changed: [item("a", "a.mov", version: 2)], deleted: [])
        #expect(replaced.updated == ["a"] && replaced.previews.isEmpty)
        #expect(r.apply(changed: [item("a", "a.mov", version: 2)], deleted: []) == Replica.Diff())
    }

    @Test func videosAndImagesThisMacDrawsAreKnownByTypeThenName() {
        #expect(Poster.Kind.of(name: "GX010042.MP4", mime: "video/mp4") == .video)
        #expect(Poster.Kind.of(name: "Take 1.mov", mime: nil) == .video)
        #expect(Poster.Kind.of(name: "Take 1.MOV", mime: "application/octet-stream") == .video, "a type that says nothing")
        #expect(Poster.Kind.of(name: "clip", mime: "video/quicktime") == .video)
        #expect(Poster.Kind.of(name: "IMG_0001.HEIC", mime: "image/heic") == .image)
        #expect(Poster.Kind.of(name: "scan.tiff", mime: nil) == .image)
        #expect(Poster.Kind.of(name: "a.png", mime: "image/png") == .image)
        #expect(Poster.Kind.of(name: "logo.svg", mime: "image/svg+xml") == nil, "ImageIO does not draw SVG")
        #expect(Poster.Kind.of(name: "song.mp3", mime: "audio/mpeg") == nil)
        #expect(Poster.Kind.of(name: "brief.pdf", mime: "application/pdf") == nil)
        #expect(Poster.Kind.of(name: "notes.txt", mime: "text/plain") == nil)
        #expect(Poster.Kind.of(name: "noext", mime: nil) == nil)
    }

    @Test func whatIsMadeFollowsTheBrowsersRules() {
        #expect(candidate(item("v", "a.mov"))?.need == .missing)
        #expect(candidate(item("v", "a.mov", thumbnail: thumb))?.need == .check, "maybe one of the old 480px ones")
        #expect(candidate(item("v", "a.mov", thumbnail: thumb, sizes: ["xs"])) == nil)
        #expect(candidate(item("i", "a.jpg", mime: "image/jpeg"))?.need == .missing)
        #expect(candidate(item("i", "a.jpg", mime: "image/jpeg", thumbnail: thumb)) == nil,
                "an image's old thumbnail is the browser's to remake: its original is read whole")
        #expect(candidate(item("i", "big.jpg", mime: "image/jpeg", size: 60 << 20)) == nil, "past the web's decode limit")
        #expect(candidate(item("v", "huge.mov", size: 40 << 30))?.need == .missing, "a video is read a frame at a time")
        #expect(candidate(item("e", "empty.mov", size: 0)) == nil)
        #expect(candidate(item("d", "brief.pdf", mime: "application/pdf")) == nil)
        var unknown = ReplicaFile(item("u", "a.mov"))
        unknown.previews = nil
        #expect(ThumbnailCandidate(unknown, scope: "library") == nil, "saved before previews were kept")
        #expect(!ThumbnailCandidate.lacksPreviews(unknown))
        #expect(ThumbnailCandidate.lacksPreviews(ReplicaFile(item("v", "a.mov"))))
    }

    @Test func noPictureBeforeASoftOneVideosFirstNewestFirst() {
        let list = [
            candidate(item("old-check", "a.mov", created: 5, thumbnail: thumb))!,
            candidate(item("image", "a.heic", mime: "image/heic", created: 9))!,
            candidate(item("old-video", "b.mov", created: 1))!,
            candidate(item("new-video", "c.mov", created: 8))!,
            candidate(item("new-check", "d.mov", created: 7, thumbnail: thumb))!,
        ]
        let order = list.sorted { $0.goesBefore($1) }.map(\.fileId)
        #expect(order == ["new-video", "old-video", "image", "new-check", "old-check"])
    }

    // MARK: - The ledger

    @Test func aFailureWaitsAnHourThenTwiceAsLongUpToAWeek() {
        var ledger = ThumbnailLedger()
        let start = Date(timeIntervalSince1970: 1_000_000)
        #expect(ledger.isDue("f", version: 1, now: start))
        ledger.record(.failed, fileId: "f", version: 1, at: start)
        #expect(!ledger.isDue("f", version: 1, now: start.addingTimeInterval(3599)))
        #expect(ledger.isDue("f", version: 1, now: start.addingTimeInterval(3600)))
        var at = start.addingTimeInterval(3600)
        var waits: [TimeInterval] = []
        for _ in 0..<10 {
            ledger.record(.failed, fileId: "f", version: 1, at: at)
            let wait = ledger.notBefore("f", version: 1)!.timeIntervalSince(at)
            waits.append(wait)
            at += wait
        }
        #expect(waits.prefix(4) == [7200, 14400, 28800, 57600])
        #expect(waits.last == TimeInterval(7 * 86400), "never longer than a week")
        // Made at last: nothing more for a day, as the feed catches up.
        ledger.record(.made, fileId: "f", version: 1, at: at)
        #expect(ledger.entries["f"]?.failures == 0)
        #expect(!ledger.isDue("f", version: 1, now: at.addingTimeInterval(3600)))
    }

    @Test func newContentsAreTriedAfreshButARefusalIsTheAccounts() {
        var ledger = ThumbnailLedger()
        let now = Date(timeIntervalSince1970: 2_000_000)
        ledger.record(.unusable, fileId: "f", version: 3, at: now)
        #expect(!ledger.isDue("f", version: 3, now: now.addingTimeInterval(6 * 86400)))
        #expect(ledger.isDue("f", version: 3, now: now.addingTimeInterval(7 * 86400)), "a week, as the browser")
        #expect(ledger.isDue("f", version: 4, now: now), "new bytes are worth a try")
        ledger.record(.refused, fileId: "g", version: 3, at: now)
        #expect(!ledger.isDue("g", version: 9, now: now.addingTimeInterval(86400)), "whatever the file's version")
        ledger.record(.kept, fileId: "h", version: 1, at: now)
        #expect(!ledger.isDue("h", version: 1, now: now.addingTimeInterval(90 * 86400)))
    }

    @Test func theLedgerStaysSmall() throws {
        var ledger = ThumbnailLedger()
        let now = Date(timeIntervalSince1970: 3_000_000)
        ledger.record(.made, fileId: "made", version: 1, at: now)
        ledger.record(.failed, fileId: "failed", version: 1, at: now)
        ledger.record(.refused, fileId: "refused", version: 1, at: now)
        ledger.prune(now: now.addingTimeInterval(2 * 86400))
        #expect(Set(ledger.entries.keys) == ["failed", "refused"], "a failure's count is kept for a week")
        ledger.prune(now: now.addingTimeInterval(8 * 86400))
        #expect(ledger.entries.isEmpty)
        for i in 0..<50 { ledger.record(.refused, fileId: "f\(i)", version: nil, at: now.addingTimeInterval(Double(i))) }
        ledger.prune(now: now, limit: 10)
        #expect(ledger.entries.count == 10 && ledger.entries["f49"] != nil && ledger.entries["f0"] == nil, "the newest kept")
        let back = try JSONDecoder().decode(ThumbnailLedger.self, from: JSONEncoder().encode(ledger))
        #expect(back == ledger)
    }
}
