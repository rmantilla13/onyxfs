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

    /// This name is macOS's, not the person's.
    public static func isLocalOnly(_ name: String) -> Bool {
        name.hasPrefix("._") || names.contains(name)
    }

    /// Any part of the path is (a file inside .Trashes is local too).
    public static func isLocalOnly(path: String) -> Bool {
        path.split(separator: "/").contains { isLocalOnly(String($0)) }
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
