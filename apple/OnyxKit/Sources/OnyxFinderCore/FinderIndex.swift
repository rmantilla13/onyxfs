import Foundation

/// What Finder's Onyx menus and badges show (the OnyxFinder extension), as
/// the app hands it over: each drive mounted now — a disk of its own at
/// /Volumes/<drive>, or a folder mount in ~/Onyx/<drive> — and what it keeps
/// offline there, by path as mounted.
///
/// Small on purpose. A folder kept offline is one path however many files it
/// holds; a file is listed only when it is kept by a choice of its own, or
/// while it is still on its way to this Mac. The extension answers Finder's
/// question for every item on screen from this, in memory (FinderLookup),
/// and asks the app again only when the app says it changed.
public struct FinderIndex: Codable, Sendable, Equatable {
    public struct Drive: Codable, Sendable, Equatable {
        /// Where it is mounted: "/Volumes/Footage", "/Users/me/Onyx/Footage".
        public var root: String
        /// The drive, as SyncDomain names it: "drive.<id>", or "library".
        public var scope: String
        /// Its name, for "Kept Offline with “Footage”".
        public var name: String
        /// Folders kept offline by a rule of their own, as mounted; "" is the
        /// whole drive.
        public var folders: [String]
        /// Files kept offline by a rule of their own, where they are now.
        public var files: [String]
        /// Files kept offline, either way, that are not on this Mac yet:
        /// downloading, waiting to be tried again, or waiting for room.
        public var pending: [String]
        /// Kept folders with files still on their way, when there are more
        /// of those than `pendingLimit`: everything in them counts as on its
        /// way until what is left fits in `pending` again. Empty otherwise.
        public var pendingIn: [String]

        /// At most this many files on their way are named one by one. The
        /// first pass over a drive kept offline whole has every file on its
        /// way; naming them all would make the index as big as the drive's
        /// listing, sent again with every file that arrives.
        public static let pendingLimit = 5_000

        /// `pending` beyond `pendingLimit` is summed up by the kept folders
        /// that hold it (`pendingIn`): the outermost kept folder above each
        /// file. Files on their way that no kept folder holds (kept on their
        /// own) are still named, up to the limit.
        public init(root: String, scope: String, name: String, folders: [String], files: [String],
                    pending: [String], pendingLimit: Int = Drive.pendingLimit) {
            self.root = root
            self.scope = scope
            self.name = name
            self.folders = folders
            self.files = files
            guard pending.count > pendingLimit else {
                self.pending = pending
                self.pendingIn = []
                return
            }
            // Outermost first: a folder kept inside another kept folder is
            // already summed up by it. Each path is only lower-cased and
            // prefix-tested, not split: there may be a hundred thousand, and
            // they are clean already (the mirror's own paths).
            let kept = folders.map { (path: $0, key: FinderPath.key($0)) }
                .sorted { FinderPath.segments($0.key).count < FinderPath.segments($1.key).count }
                .map { (path: $0.path, key: $0.key, inside: $0.key + "/") }
            var holding = Set<String>(), loose: [String] = []
            for path in pending {
                let key = path.lowercased()
                if let folder = kept.first(where: { $0.key.isEmpty || key == $0.key || key.hasPrefix($0.inside) }) {
                    holding.insert(folder.path)
                } else if loose.count < pendingLimit {
                    loose.append(path)
                }
            }
            self.pending = loose
            self.pendingIn = holding.sorted()
        }
    }

    /// Moves on with every change, so a copy can tell whether it is current.
    public var generation: UInt64
    /// Someone is signed in to Onyx on this Mac.
    public var signedIn: Bool
    public var drives: [Drive]

    public init(generation: UInt64 = 0, signedIn: Bool = false, drives: [Drive] = []) {
        self.generation = generation
        self.signedIn = signedIn
        self.drives = drives
    }

    public static let empty = FinderIndex()

    public func encoded() -> Data {
        (try? JSONEncoder().encode(self)) ?? Data()
    }

    public static func decode(_ data: Data) -> FinderIndex? {
        try? JSONDecoder().decode(FinderIndex.self, from: data)
    }
}
