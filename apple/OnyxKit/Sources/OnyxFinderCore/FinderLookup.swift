import Foundation

/// The extension's answer to "what is this item?", for every item Finder
/// shows in a drive: which drive holds it, whether it is kept offline — by a
/// choice of its own, or with a folder that is — and whether it is still on
/// its way. Built once per FinderIndex; every question after is a few set
/// lookups, one per folder above the item, with nothing asked of the app.
public struct FinderLookup: Sendable {
    /// Where an item is: which drive, and its path inside it as given.
    public struct Location: Equatable, Sendable {
        /// Its position in the index's `drives`.
        public let drive: Int
        public let scope: String
        /// Inside the drive, as Finder gave it ("" for the drive itself).
        public let path: String
    }

    public enum Kept: Equatable, Sendable {
        case no
        /// By a rule of its own: a file or folder chosen, or the whole drive
        /// for the drive itself.
        case own
        /// With the folder that is (its path as the rule names it, "" for the
        /// whole drive): letting go of the item alone would change nothing.
        case with(folder: String)
    }

    public struct State: Equatable, Sendable {
        public let location: Location
        public let kept: Kept
        /// Kept, and not all on this Mac yet: the file, or something inside
        /// the folder, is on its way.
        public let pending: Bool
        /// A folder kept by a rule of its own (or the whole drive): letting
        /// go of it lets go of many copies.
        public let isKeptFolder: Bool
    }

    public enum Badge: String, Sendable, CaseIterable {
        /// On this Mac, to open with no connection.
        case kept
        /// Kept offline, but still on its way here.
        case pending
    }

    private struct Drive: Sendable {
        let root: [String]
        let scope: String
        let name: String
        /// Key → the path as the rule names it.
        let folders: [String: String]
        let files: Set<String>
        let pending: Set<String>
        let pendingIn: [String]
        /// Every folder with something on its way beneath it.
        let pendingFolders: Set<String>
    }

    private let drives: [Drive]
    /// Positions in `drives`, the deepest root first, so a drive mounted
    /// inside another's folder is found before it.
    private let order: [Int]
    public let generation: UInt64
    public let signedIn: Bool
    /// Where each drive is mounted, as the index says: the folders Finder is
    /// asked to watch.
    public let roots: [String]

    public init(_ index: FinderIndex) {
        generation = index.generation
        signedIn = index.signedIn
        roots = index.drives.map(\.root)
        let drives = index.drives.map { drive in
            let pending = Set(drive.pending.map(FinderPath.key))
            let pendingIn = drive.pendingIn.map(FinderPath.key)
            var pendingFolders = Set<String>()
            for key in pending.union(pendingIn) {
                for folder in FinderPath.ancestors(key) {
                    // Already there: so is every folder above it.
                    if !pendingFolders.insert(folder).inserted { break }
                }
            }
            var folders: [String: String] = [:]
            for path in drive.folders { folders[FinderPath.key(path)] = path }
            return Drive(root: FinderPath.segments(drive.root).map(FinderPath.fold), scope: drive.scope,
                         name: drive.name, folders: folders, files: Set(drive.files.map(FinderPath.key)),
                         pending: pending, pendingIn: pendingIn, pendingFolders: pendingFolders)
        }
        self.drives = drives
        order = drives.indices.sorted { drives[$0].root.count > drives[$1].root.count }
    }

    public static let empty = FinderLookup(.empty)

    /// The drive holding an absolute path, and the path inside it; nil for
    /// anything in none of them.
    public func locate(_ absolute: String) -> Location? {
        let parts = FinderPath.segments(absolute)
        let folded = parts.map(FinderPath.fold)
        for at in order {
            let root = drives[at].root
            guard !root.isEmpty, folded.count >= root.count, Array(folded[..<root.count]) == root else { continue }
            return Location(drive: at, scope: drives[at].scope,
                            path: parts[root.count...].joined(separator: "/"))
        }
        return nil
    }

    /// Whether an item is kept offline, and whether it is all here yet; nil
    /// for anything in no drive.
    public func state(of absolute: String) -> State? {
        guard let location = locate(absolute) else { return nil }
        let drive = drives[location.drive]
        let key = FinderPath.key(location.path)
        let isKeptFolder = drive.folders[key] != nil
        let kept: Kept
        if isKeptFolder || drive.files.contains(key) {
            kept = .own
        } else if let folder = FinderPath.ancestors(key).first(where: { drive.folders[$0] != nil }) {
            kept = .with(folder: drive.folders[folder]!)
        } else {
            kept = .no
        }
        let pending = kept != .no && (drive.pending.contains(key) || drive.pendingFolders.contains(key)
            || drive.pendingIn.contains { FinderPath.isAtOrUnder(key, $0) })
        return State(location: location, kept: kept, pending: pending, isKeptFolder: isKeptFolder)
    }

    /// The mark Finder puts on an item: kept offline, or on its way; nil for
    /// an item not kept, or in no drive.
    public func badge(for absolute: String) -> Badge? {
        guard let state = state(of: absolute), state.kept != .no else { return nil }
        return state.pending ? .pending : .kept
    }

    /// A drive's name, for the words of the menu.
    public func name(ofDrive at: Int) -> String {
        drives.indices.contains(at) ? drives[at].name : ""
    }
}
