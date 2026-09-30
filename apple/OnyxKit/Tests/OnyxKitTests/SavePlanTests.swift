import Foundation
import Testing
@testable import OnyxKit

/// Saving out of the iPhone app: which files Photos is offered, what a
/// saved file is called, and what a streamable copy says of itself.
@Suite struct SavePlanTests {
    // MARK: - Photos

    @Test func picturesAndCameraFormatsGoToPhotos() {
        for name in ["IMG_0001.HEIC", "a.jpg", "a.JPEG", "scan.png", "loop.gif", "print.tiff", "web.webp", "raw.DNG", "R5.CR3", "Z9.nef"] {
            #expect(SavePlan.photosSupport(name: name, kind: "image") == .photo, "\(name)")
        }
    }

    @Test func videosInQuickTimeAndMPEG4GoToPhotos() {
        for name in ["GX010042.MP4", "clip.mov", "phone.m4v", "old.3gp"] {
            #expect(SavePlan.photosSupport(name: name, kind: "video") == .video, "\(name)")
        }
    }

    @Test func theNameDecidesBeforeTheKind() {
        // A .mov recorded before its kind was worked out is stored as `other`.
        #expect(SavePlan.photosSupport(name: "A001.mov", kind: "other") == .video)
        #expect(SavePlan.photosSupport(name: "shot.jpg", kind: nil) == .photo)
    }

    @Test func whatPhotosCannotImportSaysWhy() {
        #expect(SavePlan.photosSupport(name: "concert.mkv", kind: "video") == .unsupported("Photos can't import MKV videos."))
        #expect(SavePlan.photosSupport(name: "promo.webm", kind: "video").reason == "Photos can't import WEBM videos.")
        #expect(SavePlan.photosSupport(name: "A001.braw", kind: "video").isSupported == false)
        #expect(SavePlan.photosSupport(name: "logo.svg", kind: "image") == .unsupported("Photos can't import SVG images."))
        #expect(SavePlan.photosSupport(name: "notes.pdf", kind: "doc") == .unsupported("Only photos and videos can be saved to Photos."))
        #expect(SavePlan.photosSupport(name: "song.mp3", kind: "audio").isSupported == false)
        // No extension, or one too long to be a format: said without it.
        #expect(SavePlan.photosSupport(name: "untitled", kind: "video") == .unsupported("Photos can't import this video."))
    }

    @Test func everyFileCanGoToFilesAndTheShareSheet() {
        #expect(SavePlan.destinations(name: "a.jpg", kind: "image") == [.photos, .files, .share])
        #expect(SavePlan.destinations(name: "cut.mov", kind: "video") == [.photos, .files, .share])
        #expect(SavePlan.destinations(name: "concert.mkv", kind: "video") == [.files, .share])
        #expect(SavePlan.destinations(name: "brief.pdf", kind: "doc") == [.files, .share])
    }

    // MARK: - Names

    @Test func aNameIsOneAFileMayHave() {
        #expect(SavePlan.fileName("Day 1/Take 2.mov") == "Day 1-Take 2.mov")
        #expect(SavePlan.fileName("10:30 standup.m4a") == "10-30 standup.m4a")
        #expect(SavePlan.fileName("  ") == "file")
        #expect(SavePlan.fileName("..") == "file")
        let long = String(repeating: "é", count: 200) + ".jpeg"
        let cut = SavePlan.fileName(long)
        #expect(cut.utf8.count <= 255)
        #expect(cut.hasSuffix(".jpeg"), "cut in the stem, so it keeps its extension")
    }

    @Test func theStreamableCopyIsNamedForWhatItIs() {
        #expect(SavePlan.streamableName(for: "GX010042.MP4", shortSide: 1080) == "GX010042 (1080p).mp4")
        #expect(SavePlan.streamableName(for: "A001_C003.mov", shortSide: 720) == "A001_C003 (720p).mp4")
        #expect(SavePlan.streamableName(for: "take.mov", shortSide: nil) == "take (streamable).mp4")
        #expect(SavePlan.streamableName(for: ".mov", shortSide: 1080).hasSuffix("(1080p).mp4"))
    }

    @Test func namesSavedTogetherDoNotLandOnEachOther() {
        #expect(SavePlan.uniqueNames(["a.jpg", "b.jpg", "a.jpg", "A.JPG", "a.jpg"])
                == ["a.jpg", "b.jpg", "a 2.jpg", "A 3.JPG", "a 4.jpg"])
        #expect(SavePlan.uniqueNames(["README", "README"]) == ["README", "README 2"])
        // A name that is already a numbered one is not taken twice.
        #expect(SavePlan.uniqueNames(["a 2.jpg", "a.jpg", "a.jpg"]) == ["a 2.jpg", "a.jpg", "a 3.jpg"])
    }

    // MARK: - Words

    @Test func progressReadsAsBytesOfTheWhole() {
        let gigabytes: Int64 = 4_200_000_000
        #expect(SavePlan.fraction(received: 1_050_000_000, expected: gigabytes) == 0.25)
        #expect(SavePlan.fraction(received: 10, expected: nil) == nil)
        #expect(SavePlan.fraction(received: 10, expected: 0) == nil)
        #expect(SavePlan.fraction(received: 20, expected: 10) == 1, "never past the end")
        let text = SavePlan.progress(received: 1_050_000_000, expected: gigabytes)
        #expect(text == "\(SavePlan.size(1_050_000_000)!) of \(SavePlan.size(gigabytes)!)")
        #expect(SavePlan.progress(received: 5_000, expected: nil) == SavePlan.size(5_000))
    }

    @Test func whatFinishedIsSaidPlainly() {
        #expect(SavePlan.saved(1, to: .photos) == "Saved to Photos")
        #expect(SavePlan.saved(3, to: .photos) == "Saved 3 to Photos")
        #expect(SavePlan.saved(2, to: .files) == "Saved 2 to Files")
        #expect(SavePlan.saveSelection(5, to: .photos) == "Save 5 to Photos")
        #expect(SavePlan.saveSelection(1, to: .photos) == "Save to Photos")
    }

    // MARK: - The streamable copy, as the server describes it

    @Test func aFinishedCopyCarriesItsFrameAndSize() throws {
        struct Wrapper: Decodable { let proxy: ProxyStatus }
        let json = """
        {"proxy":{"status":"done","progress":1,"error":null,"width":1920,"height":1080,"size":"402653184",
         "device":"Ricky's MacBook Pro","requestedAt":1790000000000,"finishedAt":1790000300000,"stale":false,
         "url":"https://s/proxy?sig=1"},"canRequest":true,"canDelete":false}
        """
        let proxy = try JSONDecoder().decode(Wrapper.self, from: Data(json.utf8)).proxy
        #expect(proxy.isReady)
        #expect(proxy.size == 402_653_184, "a BIGINT that arrives as a string")
        #expect(proxy.shortSide == 1080)
        #expect(SavePlan.streamableLabel(shortSide: proxy.shortSide) == "1080p")
    }

    @Test func aPortraitCopyCountsItsShortSide() throws {
        let proxy = try JSONDecoder().decode(ProxyStatus.self, from: Data(#"{"status":"done","width":1080,"height":1920,"stale":false}"#.utf8))
        #expect(proxy.shortSide == 1080)
    }

    @Test func aCopyOfOlderContentsOrNoneIsNotOffered() throws {
        let stale = try JSONDecoder().decode(ProxyStatus.self, from: Data(#"{"status":"done","width":1920,"height":1080,"stale":true}"#.utf8))
        #expect(!stale.isReady)
        let none = try JSONDecoder().decode(ProxyStatus.self, from: Data(#"{"status":"none"}"#.utf8))
        #expect(!none.isReady && none.size == nil && none.shortSide == nil)
        let working = try JSONDecoder().decode(ProxyStatus.self, from: Data(#"{"status":"working","progress":0.4,"width":null}"#.utf8))
        #expect(!working.isReady)
    }
}
