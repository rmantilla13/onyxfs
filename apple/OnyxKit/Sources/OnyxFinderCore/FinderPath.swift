import Foundation

/// Paths as Finder's menus and badges compare them: by whole segment, with
/// case and Unicode normalization ignored, as the drives' disks and the
/// mirror behind them do (MirrorIndex folds names the same way). "Photos"
/// holds "photos/a.jpg", not "Photos 2025/a.jpg".
public enum FinderPath {
    /// The segments of an absolute or relative path, none empty: "/a//b/" is
    /// ["a", "b"].
    public static func segments(_ path: String) -> [Substring] {
        path.split(separator: "/", omittingEmptySubsequences: true)
    }

    /// One segment, or a path, as it compares: lower case. Swift's own
    /// comparison, hashing and prefix test already take "é" typed as one
    /// character and as "e" with an accent for the same, so nothing more is
    /// needed — and composing each name first made a question about 100,000
    /// paths eighteen times slower.
    public static func fold(_ text: some StringProtocol) -> String {
        text.lowercased()
    }

    /// A relative path ("a/b", "" for the drive itself) as it compares.
    public static func key(_ path: String) -> String {
        segments(path).map(fold).joined(separator: "/")
    }

    /// The folder holding `key` ("" for something at the top), or nil for ""
    /// itself.
    public static func parent(_ key: String) -> String? {
        guard !key.isEmpty else { return nil }
        guard let slash = key.lastIndex(of: "/") else { return "" }
        return String(key[..<slash])
    }

    /// Every folder above `key`, nearest first, ending with "" (the drive).
    /// None for "".
    public static func ancestors(_ key: String) -> [String] {
        var out: [String] = []
        var at = parent(key)
        while let folder = at {
            out.append(folder)
            at = parent(folder)
        }
        return out
    }

    /// Whether `key` is `folder` or inside it. Both are keys (`key(_:)`);
    /// "" holds everything.
    public static func isAtOrUnder(_ key: String, _ folder: String) -> Bool {
        folder.isEmpty || key == folder || key.hasPrefix(folder + "/")
    }

    /// The last segment of a path as written ("" for "").
    public static func lastSegment(_ path: String) -> String {
        segments(path).last.map(String.init) ?? ""
    }
}
