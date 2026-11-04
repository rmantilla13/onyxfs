import Foundation

/// Names macOS keeps on any volume for itself — Finder's view settings, the
/// Trash, Spotlight's index, AppleDouble halves of files from volumes without
/// extended attributes. On an onyxfs volume they stay on this Mac: they are
/// never uploaded, never listed by the app's bridge, and never seen on the
/// web, where they would be clutter nobody made.
public enum LocalOnly {
    static let names: Set<String> = [
        ".DS_Store", ".Trashes", ".Spotlight-V100", ".fseventsd", ".TemporaryItems",
        ".DocumentRevisions-V100", ".VolumeIcon.icns", ".localized", ".apdisk",
        "Icon\r", ".metadata_never_index", ".metadata_never_index_unless_rootfs",
        "com.apple.timemachine.donotpresent", ".com.apple.timemachine.supported",
    ]

    /// This name is macOS's, not the person's. Archive Utility's own scratch
    /// folders too (.ArchiveServiceTemp.sb-…, and .AU.…): it unpacks into one
    /// beside the zip and moves the result out, so the unpacking stays on
    /// this Mac and only what it unpacked goes up. Its helper makes .AU.…
    /// and then renames it to .AU.….nosync: both names are this Mac's, or
    /// the rename would make a real folder local and be refused (EPERM),
    /// leaving the scratch folder on the server.
    public static func isLocalOnly(_ name: String) -> Bool {
        name.hasPrefix("._") || names.contains(name) || name.hasPrefix(".ArchiveServiceTemp") || name.hasPrefix(".AU.")
    }

    /// Any part of the path is (a file inside .Trashes is local too).
    public static func isLocalOnly(path: String) -> Bool {
        path.split(separator: "/").contains { isLocalOnly(String($0)) }
    }

    /// A sandboxed app's safe save: "<name>.sb-<8 hex>-<6 letters or
    /// digits>", the names the App Sandbox lets it write beside a document
    /// it may change — the folder it writes the new copy in, and the name it
    /// sets the document aside under while the copy takes its place
    /// ("Report.rtf.sb-d22dcccc-3mKm0y"). Never the person's. What is made
    /// under one is this Mac's (DriveEngine.create); one the server already
    /// has — left by a save that failed — stays the drive's, and is listed.
    public static func isSafeSave(_ name: String) -> Bool {
        let tail = Array(name.utf8.suffix(19))
        guard name.utf8.count > 19, tail[0] == UInt8(ascii: "."), tail[1] == UInt8(ascii: "s"),
              tail[2] == UInt8(ascii: "b"), tail[3] == UInt8(ascii: "-"), tail[12] == UInt8(ascii: "-") else { return false }
        let hex = { (c: UInt8) in (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) }
        let letterOrDigit = { (c: UInt8) in (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }
        return tail[4..<12].allSatisfy(hex) && tail[13..<19].allSatisfy(letterOrDigit)
    }

    /// Empty files every onyxfs volume has at its root, which ask macOS to
    /// leave it alone:
    ///   .metadata_never_index           Spotlight must not index it — to
    ///                                   index is to read every file, which on
    ///                                   a streaming drive is downloading it
    ///   com.apple.timemachine.donotpresent
    ///                                   no "back up to this disk?" offer each
    ///                                   time it mounts
    public static let rootMarkers: [String] = [".metadata_never_index", "com.apple.timemachine.donotpresent"]
}
