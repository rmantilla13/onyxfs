import Foundation

/// The way down to a folder within a place, a folder at a time: what Browse
/// stacks so Back climbs out one level at a time, and what it rebuilds when
/// a folder above is opened directly (its top, from ⌂). A place's top is
/// "", as everywhere else.
public enum FolderTrail {
    /// Each folder on the way down to `folder`, the top-most first and
    /// `folder` itself last: "Spring/Day 1" → ["Spring", "Spring/Day 1"].
    /// Empty for a place's top. Stray slashes are not folders.
    public static func steps(to folder: String) -> [String] {
        let parts = folder.split(separator: "/").map(String.init)
        return parts.indices.map { parts[...$0].joined(separator: "/") }
    }

    /// How far below its place's top `folder` is: 0 at the top, 1 in a
    /// folder there, and so on.
    public static func depth(of folder: String) -> Int {
        folder.split(separator: "/").count
    }
}
