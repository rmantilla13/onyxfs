import Foundation

/// A drive's folder under ~/Onyx, where Finder shows it, and how the Mac app
/// finds the rclone serving one.
///
/// A folder is named for its drive, so two scopes can clean up to one name:
/// a drive called "Library" beside the library itself, "a/b" beside "a:b",
/// "Photos." beside "Photos", or one name spelled two ways in Unicode. The
/// Mac's disks ignore case and normalization, so "photos" is the same folder
/// too. Mounting a second scope there would first clear what looked like a
/// stale mount — the first drive's live one. So each scope gets a folder no
/// other scope holds.
public enum MountFolder {
    /// The library's folder, always: a drive whose name would take it gets
    /// "Library (2)" instead, whichever of the two mounts first.
    public static let library = "Library"

    /// A drive's name, made safe for a path: no "/" or ":" (both separators
    /// somewhere on a Mac), no newlines, and no spaces or dots at either end.
    public static func cleaned(_ name: String) -> String {
        let kept = name.map { $0 == "/" || $0 == ":" ? "-" : $0 }.filter { !$0.isNewline }
        let s = String(kept).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return s.isEmpty ? "Drive" : s
    }

    /// The folder for `scope`, named `name`, that is none of `taken` — the
    /// folders other scopes hold now — as the Mac's disks compare names.
    /// The first that is free of "Name", "Name (2)", "Name (3)"…
    public static func unique(for scope: SyncDomain, name: String, taken: [String]) -> String {
        if scope == .library { return library }
        let base = cleaned(name)
        var held = Set(taken.map(key))
        held.insert(key(library))
        if !held.contains(key(base)) { return base }
        var n = 2
        while held.contains(key("\(base) (\(n))")) { n += 1 }
        return "\(base) (\(n))"
    }

    /// Case and Unicode normalization ignored, as APFS and HFS+ do by default.
    static func key(_ name: String) -> String {
        name.precomposedStringWithCanonicalMapping.lowercased()
    }

    /// For `pkill -f`: the rclone mounting exactly `mountPoint`, and no other.
    ///
    /// pkill matches the whole command line, arguments joined by spaces, so
    /// a path alone also matches a sibling whose name only begins the same —
    /// "~/Onyx/Library Archive --read-only …" for "~/Onyx/Library". The Mac
    /// app puts the mount point right after the remote, and `nextArgument`
    /// right after it, so the three together pin it to that one argument.
    public static func rclonePattern(mountPoint: String, nextArgument: String) -> String {
        "nfsmount [^ ]+ " + ereEscaped(mountPoint) + " " + ereEscaped(nextArgument) + "( |$)"
    }

    /// Literal text in a POSIX extended regular expression, which is what
    /// pkill reads: each character with a meaning there is escaped, and
    /// nothing else is (an escaped ordinary character is undefined in ERE).
    public static func ereEscaped(_ text: String) -> String {
        var out = ""
        for c in text {
            if "\\.[]()*+?{}|^$".contains(c) { out.append("\\") }
            out.append(c)
        }
        return out
    }
}
