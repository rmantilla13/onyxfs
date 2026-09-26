import Testing
import Foundation
@testable import OnyxKit

/// Where each drive mounts under ~/Onyx, and how a stale rclone is found.
/// Two scopes sharing a folder, or a pattern that reaches past its own path,
/// ends with one drive's mount clearing another's live one.
struct MountFolderTests {
    @Test func namesAreCleanedForAPath() {
        #expect(MountFolder.cleaned("Brand") == "Brand")
        #expect(MountFolder.cleaned("a/b") == "a-b")
        #expect(MountFolder.cleaned("a:b") == "a-b")
        #expect(MountFolder.cleaned("  Photos. ") == "Photos")
        #expect(MountFolder.cleaned("two\nlines") == "twolines")
        #expect(MountFolder.cleaned("..") == "Drive")
        #expect(MountFolder.cleaned("") == "Drive")
    }

    @Test func aFreeNameIsUsedAsItIs() {
        #expect(MountFolder.unique(for: .drive(id: "a"), name: "Brand", taken: []) == "Brand")
        #expect(MountFolder.unique(for: .drive(id: "a"), name: "Brand", taken: ["Clients", "Library"]) == "Brand")
        #expect(MountFolder.unique(for: .drive(id: "a"), name: "Brand Archive", taken: ["Brand"]) == "Brand Archive")
    }

    @Test func theLibraryAlwaysHasItsFolderAndNoDriveTakesIt() {
        #expect(MountFolder.unique(for: .library, name: "Library", taken: []) == "Library")
        #expect(MountFolder.unique(for: .library, name: "anything", taken: ["Library"]) == "Library")
        // Mounted before the library or after it, a drive called Library
        // never lands on the library's folder.
        #expect(MountFolder.unique(for: .drive(id: "a"), name: "Library", taken: []) == "Library (2)")
        #expect(MountFolder.unique(for: .drive(id: "a"), name: "library", taken: []) == "library (2)")
        #expect(MountFolder.unique(for: .drive(id: "a"), name: "Library.", taken: []) == "Library (2)")
    }

    @Test func namesThatCleanUpAlikeGetFoldersOfTheirOwn() {
        #expect(MountFolder.unique(for: .drive(id: "b"), name: "a:b", taken: ["a-b"]) == "a-b (2)")
        #expect(MountFolder.unique(for: .drive(id: "b"), name: "Photos.", taken: ["Photos"]) == "Photos (2)")
        #expect(MountFolder.unique(for: .drive(id: "c"), name: "Photos", taken: ["Photos", "Photos (2)"]) == "Photos (3)")
        // As the Mac's disks compare them: case and Unicode normalization
        // ignored, so these would be one folder.
        #expect(MountFolder.unique(for: .drive(id: "b"), name: "PHOTOS", taken: ["photos"]) == "PHOTOS (2)")
        let composed = "Caf\u{E9}", decomposed = "Cafe\u{301}"
        #expect(MountFolder.unique(for: .drive(id: "b"), name: decomposed, taken: [composed]) == decomposed + " (2)")
        // A numbered name held by someone else is skipped too.
        #expect(MountFolder.unique(for: .drive(id: "b"), name: "Library", taken: ["library (2)"]) == "Library (3)")
    }

    // MARK: - Finding rclone

    /// What `pkill -f` compares against: the arguments joined by spaces.
    static func commandLine(_ mountPoint: String) -> String {
        "/Applications/Onyx.app/Contents/MacOS/rclone nfsmount onyxdriveabc123: \(mountPoint) --read-only --volname X"
    }

    /// With the C library's regex, extended syntax, as pkill compiles it —
    /// not NSRegularExpression, whose ICU dialect is not what runs.
    static func pkillMatches(_ pattern: String, _ text: String) -> Bool {
        var re = regex_t()
        guard regcomp(&re, pattern, REG_EXTENDED | REG_NOSUB) == 0 else {
            Issue.record("does not compile: \(pattern)")
            return false
        }
        defer { regfree(&re) }
        return regexec(&re, text, 0, nil, 0) == 0
    }

    @Test func thePatternMatchesItsOwnMountAndNoSibling() {
        let library = "/Users/u/Onyx/Library"
        let pattern = MountFolder.rclonePattern(mountPoint: library, nextArgument: "--read-only")
        #expect(Self.pkillMatches(pattern, Self.commandLine(library)))
        #expect(!Self.pkillMatches(pattern, Self.commandLine("/Users/u/Onyx/Library Archive")),
                "a sibling whose name only begins the same")
        #expect(!Self.pkillMatches(pattern, Self.commandLine("/Users/u/Onyx/Library (2)")))
        #expect(!Self.pkillMatches(pattern, Self.commandLine("/Users/u/Onyx/Old Library")))
        #expect(!Self.pkillMatches(pattern, "/usr/bin/tail -f /Users/u/Onyx/Library --read-only"),
                "not an rclone mount")
        // The rclone left by an earlier build, which put nothing else between.
        #expect(Self.pkillMatches(pattern, "rclone nfsmount onyxlibrary: \(library) --read-only"))
    }

    @Test func pathsWithRegexCharactersMatchLiterally() {
        for name in ["Q1 (2024)", "a.b", "[draft] $5 + tax?", "x|y", "^caret", "back\\slash", "{braces}*"] {
            let path = "/Users/u/Onyx/" + name
            let pattern = MountFolder.rclonePattern(mountPoint: path, nextArgument: "--read-only")
            #expect(Self.pkillMatches(pattern, Self.commandLine(path)), "\(name)")
            // "." must not stand for any character, nor "(2024)" for "2024".
            let lookalike = "/Users/u/Onyx/" + name.replacingOccurrences(of: ".", with: "x")
                .replacingOccurrences(of: "(", with: "").replacingOccurrences(of: ")", with: "")
            if lookalike != path {
                #expect(!Self.pkillMatches(pattern, Self.commandLine(lookalike)), "\(name) vs \(lookalike)")
            }
        }
    }

    @Test func escapingLeavesOrdinaryCharactersAlone() {
        #expect(MountFolder.ereEscaped("/Users/u/Onyx Dev/Brand-1_é") == "/Users/u/Onyx Dev/Brand-1_é")
        #expect(MountFolder.ereEscaped("a.b(c)") == #"a\.b\(c\)"#)
    }
}
