import Foundation
import Testing
@testable import OnyxKit

/// Unzip Here: what lands beside a zip, named as Archive Utility names it,
/// and a real unzip that keeps the zip's quarantine.
struct UnzipperTests {
    @Test func oneItemLandsAsItselfAndMoreInAFolderNamedAfterTheZip() {
        let none: (String) -> Bool = { _ in false }
        #expect(Unzipper.landing(items: ["Walmart Ad Videos"], isFolder: true, zipName: "videos.zip", taken: none)
            == ("Walmart Ad Videos", false))
        #expect(Unzipper.landing(items: ["a.mov", "b.mov"], isFolder: false, zipName: "Selects.ZIP", taken: none)
            == ("Selects", true))
    }

    @Test func aNameAlreadyThereGetsANumber() {
        let there: Set = ["Footage", "Footage 2", "notes.txt", "Selects"]
        let taken = { there.contains($0) }
        #expect(Unzipper.landing(items: ["Footage"], isFolder: true, zipName: "f.zip", taken: taken).name == "Footage 3")
        #expect(Unzipper.landing(items: ["notes.txt"], isFolder: false, zipName: "n.zip", taken: taken).name == "notes 2.txt")
        #expect(Unzipper.landing(items: ["a", "b"], isFolder: false, zipName: "Selects.zip", taken: taken).name == "Selects 2")
        // A folder's dot is part of its name.
        #expect(Unzipper.free("v1.2", isFolder: true, taken: { $0 == "v1.2" }) == "v1.2 2")
    }

    @Test func dittosComplaintsInWords() {
        #expect(Unzipper.reason("ditto: No password was provided and the client did not provide a callback", copying: false)
            .contains("password"))
        #expect(Unzipper.reason("ditto: /Volumes/D/x: Permission denied", copying: true) == "Files can't be added to this folder.")
        #expect(Unzipper.reason("ditto: x: No space left on device", copying: false) == "There isn't room on this Mac to unzip it.")
        #expect(Unzipper.reason("", copying: false) == "The zip could not be read.")
        #expect(Unzipper.isZip("/D/a.ZIP") && !Unzipper.isZip("/D/.zip") && !Unzipper.isZip("/D/a.mov"))
    }

    #if os(macOS)
    /// A downloaded zip: what it holds lands beside it, every item still
    /// marked as downloaded, and the unpacking left nothing behind.
    @Test func aDownloadedZipLandsBesideItselfStillQuarantined() async throws {
        let place = try Place()
        defer { place.remove() }
        let zip = try place.zip("Shoot", files: ["Shoot/a.txt": "a", "Shoot/Day 2/b.txt": "b"], quarantined: true)
        let landed = try await Unzipper.unzip(zip, scratch: place.scratch)
        #expect(landed.lastPathComponent == "Shoot")
        #expect(try String(contentsOf: landed.appendingPathComponent("Day 2/b.txt"), encoding: .utf8) == "b")
        for item in ["", "a.txt", "Day 2/b.txt"] {
            #expect(Place.quarantine(landed.appendingPathComponent(item)) != nil, "\(item) still marked as downloaded")
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: place.scratch.path).isEmpty, "the unpacking is gone")

        // Again: beside the first, under a name of its own.
        let again = try await Unzipper.unzip(zip, scratch: place.scratch)
        #expect(again.lastPathComponent == "Shoot 2")
    }

    @Test func severalItemsLandInAFolderAndAPlainZipStaysPlain() async throws {
        let place = try Place()
        defer { place.remove() }
        let zip = try place.zip("Selects", files: ["a.mov": "1", "b.mov": "2"], quarantined: false)
        let landed = try await Unzipper.unzip(zip, scratch: place.scratch)
        #expect(landed.lastPathComponent == "Selects")
        #expect(try FileManager.default.contentsOfDirectory(atPath: landed.path).sorted() == ["a.mov", "b.mov"])
        #expect(Place.quarantine(landed.appendingPathComponent("a.mov")) == nil)
    }

    @Test func aPasswordProtectedZipFailsWithoutWaiting() async throws {
        let place = try Place()
        defer { place.remove() }
        try "secret".write(to: place.root.appendingPathComponent("s.txt"), atomically: true, encoding: .utf8)
        let zip = place.drive.appendingPathComponent("locked.zip")
        try Place.run("/usr/bin/zip", ["-q", "-P", "pw", zip.path, "s.txt"], in: place.root)
        await #expect(throws: Unzipper.Failure.self) { try await Unzipper.unzip(zip, scratch: place.scratch) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: place.drive.path) == ["locked.zip"], "nothing landed")
    }

    @Test func notAZipIsRefused() async throws {
        let place = try Place()
        defer { place.remove() }
        let file = place.drive.appendingPathComponent("a.mov")
        try Data([1]).write(to: file)
        await #expect(throws: Unzipper.Failure("It isn't a zip file.")) { try await Unzipper.unzip(file, scratch: place.scratch) }
    }

    /// A folder standing in for a drive's, with the files a zip is made of
    /// beside it and a scratch folder of its own.
    private struct Place {
        let root: URL
        var drive: URL { root.appendingPathComponent("drive") }
        var scratch: URL { root.appendingPathComponent("scratch") }

        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("unzipper-\(UUID().uuidString)")
            for dir in ["drive", "scratch", "source"] {
                try FileManager.default.createDirectory(at: root.appendingPathComponent(dir), withIntermediateDirectories: true)
            }
        }

        func remove() { try? FileManager.default.removeItem(at: root) }

        /// `name`.zip in the drive folder, holding `files` (relative path →
        /// contents), marked as downloaded by a browser when `quarantined`.
        func zip(_ name: String, files: [String: String], quarantined: Bool) throws -> URL {
            let source = root.appendingPathComponent("source/\(name)")
            for (path, text) in files {
                let file = source.appendingPathComponent(path)
                try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                try text.write(to: file, atomically: true, encoding: .utf8)
            }
            let zip = drive.appendingPathComponent("\(name).zip")
            try Place.run("/usr/bin/ditto", ["-c", "-k", source.path, zip.path], in: root)
            if quarantined {
                let value = "0081;\(String(Int(Date().timeIntervalSince1970), radix: 16));Chrome;\(UUID().uuidString)"
                guard setxattr(zip.path, "com.apple.quarantine", value, value.utf8.count, 0, 0) == 0 else {
                    throw Unzipper.Failure("quarantine not set")
                }
            }
            return zip
        }

        static func quarantine(_ url: URL) -> String? {
            var buffer = [UInt8](repeating: 0, count: 512)
            let n = getxattr(url.path, "com.apple.quarantine", &buffer, buffer.count, 0, XATTR_NOFOLLOW)
            return n > 0 ? String(decoding: buffer[0..<n], as: UTF8.self) : nil
        }

        static func run(_ tool: String, _ arguments: [String], in folder: URL) throws {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: tool)
            process.arguments = arguments
            process.currentDirectoryURL = folder
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw Unzipper.Failure("\(tool) failed") }
        }
    }
    #endif
}
