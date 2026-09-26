import Foundation

/// Where the Mac app keeps what it streams and what is kept offline: a folder
/// the user picks (Settings → Storage), holding Streaming/ and Pinned/.
public enum CacheLocation {
    /// Why `root` cannot hold the cache, or nil when it can. `current` is
    /// where it is now; `mounts` the folder the drives mount in (~/Onyx).
    ///
    /// Not in a drive's mount point: the cache would land inside the mount,
    /// or in the empty folder under it, and rclone will not mount over a
    /// folder with something in it. Not inside the cache's own Streaming or
    /// Pinned folder either: moving there, then clearing the old streaming
    /// cache, would delete what had just been moved.
    public static func refusal(for root: URL, current: URL, mounts: URL) -> String? {
        if contains(mounts, root) {
            return "Your drives appear in \(mounts.path), so the cache cannot go there. Choose a folder outside it."
        }
        for part in ["Streaming", "Pinned"] where contains(current.appendingPathComponent(part), root) {
            return "That folder is inside the cache itself. Choose one outside \(current.path)."
        }
        return nil
    }

    public static func isSame(_ a: URL, _ b: URL) -> Bool {
        contains(a, b) && contains(b, a)
    }

    /// Whether `url` is `folder` or inside it: by whole path components,
    /// with symlinks resolved and case ignored, as the Mac's disks do.
    public static func contains(_ folder: URL, _ url: URL) -> Bool {
        let outer = resolved(folder).pathComponents, inner = resolved(url).pathComponents
        guard inner.count >= outer.count else { return false }
        return zip(outer, inner).allSatisfy { $0.caseInsensitiveCompare($1) == .orderedSame }
    }

    /// Symlinks resolved in the part of the path that exists; the rest, not
    /// made yet, as given.
    static func resolved(_ url: URL) -> URL {
        var existing = url.standardizedFileURL
        var rest: [String] = []
        while !FileManager.default.fileExists(atPath: existing.path), existing.pathComponents.count > 1 {
            rest.insert(existing.lastPathComponent, at: 0)
            existing = existing.deletingLastPathComponent()
        }
        var out = existing.resolvingSymlinksInPath()
        for part in rest { out.appendPathComponent(part) }
        return out
    }
}
