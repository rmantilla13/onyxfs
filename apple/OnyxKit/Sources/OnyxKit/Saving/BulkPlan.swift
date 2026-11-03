import Foundation

/// Acting on a selection that holds folders, in the iPhone app: which
/// folders a move or a delete has to act on, which a destination leaves
/// where they are, what one confirmation says about them all, and how it
/// went. The web's rules (lib/bulk-items.js), in the app's words.
///
/// A selection is folder paths ("Footage/Day 1") and the files beside them.
/// Each folder goes through the routes one folder takes, one after another;
/// this is only the arithmetic around them.
public enum BulkPlan {
    /// The folders an action on `paths` has to act on: each once, in the
    /// order given, leaving out any inside another of them — moving or
    /// deleting the outer one takes it along. The top level is no one's pick.
    public static func outermost(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        let list = paths.filter { !$0.isEmpty && seen.insert($0).inserted }
        return list.filter { p in !list.contains { q in q != p && isWithin(p, q) } }
    }

    /// Moving `paths` into `destination` ("" is the top level).
    public struct Move: Equatable, Sendable {
        /// The outermost folders that move.
        public var move: [String] = []
        /// Those already in the destination: nothing to do.
        public var here: [String] = []
        /// Those the destination is inside of. A folder cannot go into itself,
        /// so a move with any of these is refused whole.
        public var into: [String] = []
    }

    public static func planMove(_ paths: [String], to destination: String) -> Move {
        var plan = Move()
        for p in outermost(paths) {
            if isWithin(destination, p) { plan.into.append(p) }
            else if parent(of: p) == destination { plan.here.append(p) }
            else { plan.move.append(p) }
        }
        return plan
    }

    /// What a delete of a folder would take (GET /api/files/folders?summary=).
    public struct Summary: Decodable, Equatable, Sendable {
        public var files: Int
        public var folders: Int
        public var outside: Int

        public init(files: Int = 0, folders: Int = 0, outside: Int = 0) {
            self.files = files
            self.folders = folders
            self.outside = outside
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            files = (try? c.decode(Int.self, forKey: .files)) ?? 0
            folders = (try? c.decode(Int.self, forKey: .folders)) ?? 0
            outside = (try? c.decode(Int.self, forKey: .outside)) ?? 0
        }

        private enum CodingKeys: String, CodingKey { case files, folders, outside }

        /// Several folders' summaries, added up.
        public static func sum(_ list: [Summary]) -> Summary {
            list.reduce(into: Summary()) { out, s in
                out.files += s.files
                out.folders += s.folders
                out.outside += s.outside
            }
        }
    }

    /// "1 folder", "3 folders", "4 files" — folders with files "5 items", or
    /// with `exact` "2 folders and 3 files".
    public static func describe(folders: Int, files: Int, exact: Bool = false) -> String {
        if folders > 0, files > 0 {
            return exact ? "\(count(folders, "folder")) and \(count(files, "file"))" : count(folders + files, "item")
        }
        return folders > 0 ? count(folders, "folder") : count(files, "file")
    }

    /// The one confirmation for deleting `folders` folders (and `files`
    /// files picked with them) at once. `inside` is what the folders hold;
    /// `trash` whether the server keeps deleted files in Trash — nil from
    /// a server too old to say, and then it promises neither.
    public struct DeleteWords: Equatable, Sendable {
        public let title: String
        public let message: String
        public let confirm: String
    }

    public static func deleteWords(folders: Int, files: Int, inside: Summary, trash: Bool?, days: Int = 30) -> DeleteWords {
        let one = folders == 1
        var held: [String] = []
        if inside.files > 0 { held.append(count(inside.files, "file")) }
        if inside.folders > 0 { held.append(count(inside.folders, "subfolder")) }
        let they = files > 0 ? (one ? "The folder" : "The folders") : (one ? "It" : "They")
        var lines = [held.isEmpty
            ? "\(they) \(one ? "is" : "are") empty."
            : "\(they) \(one ? "holds" : "hold") \(held.joined(separator: " and "))."]
        let going = inside.files + files
        if going > 0 {
            let theFiles = going == 1 ? "The file" : "The files"
            switch trash {
            case true?:
                lines.append("\(theFiles) \(going == 1 ? "goes" : "go") to Trash, where \(going == 1 ? "it" : "they") can be restored on the web for \(days) days; the \(one ? "folder’s" : "folders’") own tags and stars are not kept.")
            case false?:
                lines.append("\(going == 1 ? "The file" : "All \(count(going, "file"))") will be permanently deleted. This cannot be undone.")
            case nil:
                lines.append("\(theFiles) may not be recoverable.")
            }
        }
        if inside.outside > 0 {
            lines.append("\(count(inside.outside, "file")) from another drive at \(one ? "this path" : "these paths") will stay.")
        }
        return DeleteWords(
            title: "Delete \(describe(folders: folders, files: files, exact: true))?",
            message: lines.joined(separator: " "),
            confirm: "Delete \(describe(folders: folders, files: files))")
    }

    /// How a move went: `folders` and `files` are (moved, tried). "Moved 3
    /// folders to Archive.", "Moved 2 of 3 folders and 4 files to Archive."
    /// Nil when nothing moved.
    public static func movedWords(folders: (Int, Int), files: (Int, Int) = (0, 0), to place: String) -> String? {
        var parts: [String] = []
        if folders.0 > 0 { parts.append(share(folders, "folder")) }
        if files.0 > 0 { parts.append(share(files, "file")) }
        return parts.isEmpty ? nil : "Moved \(parts.joined(separator: " and ")) to \(place)."
    }

    /// How a delete went: `folders` is (deleted, tried), `files` the picked
    /// files that went with them. Nil when nothing went.
    public static func deletedWords(folders: (Int, Int), files: Int = 0) -> String? {
        if folders.0 == 0 { return files > 0 ? "Deleted \(count(files, "file"))." : nil }
        let f = share(folders, "folder")
        return files > 0 ? "Deleted \(f) and \(count(files, "file"))." : "Deleted \(f)."
    }

    // MARK: - Paths

    /// `path` is `folder` itself or somewhere beneath it.
    public static func isWithin(_ path: String, _ folder: String) -> Bool {
        path == folder || path.hasPrefix(folder + "/")
    }

    public static func parent(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    public static func name(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: slash)...])
    }

    // MARK: - Words

    private static func count(_ n: Int, _ one: String) -> String {
        "\(n.formatted(.number.locale(Locale(identifier: "en_US")))) \(n == 1 ? one : one + "s")"
    }

    private static func share(_ pair: (Int, Int), _ one: String) -> String {
        pair.0 == pair.1 ? count(pair.1, one) : "\(pair.0.formatted(.number.locale(Locale(identifier: "en_US")))) of \(count(pair.1, one))"
    }
}
