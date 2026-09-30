import Foundation

/// What one drive keeps offline, by path as mounted: for Finder's menus and
/// marks (the OnyxFinder extension), which know an item only by where it is.
///
/// Folders by the rules' own paths, however many files they hold; files only
/// when kept by a rule of their own; and the files not on this Mac yet.
public struct KeptPaths: Sendable, Equatable {
    /// Folder rules' paths ("" is the whole drive).
    public var folders: [String]
    /// Files kept by a rule of their own, by id: where the index has them now
    /// (Finder's marks, and their names in Settings).
    public var files: [String: String]
    /// Files kept, either way, with no copy here at their version yet:
    /// downloading, waiting to be tried again, or waiting for room.
    public var pending: Set<String>

    public init(folders: [String] = [], files: [String: String] = [:], pending: Set<String> = []) {
        self.folders = folders; self.files = files; self.pending = pending
    }

    /// From one drive's `rules`, its index, the files those rules reach
    /// (PinStore.wanted) and which of those have a copy here now
    /// (PinStore.keptOffline, by file id).
    public static func make(rules: [PinRule], index: any PinnableIndex, wanted: [MirrorEntry],
                            kept: Set<String>) -> KeptPaths {
        var out = KeptPaths()
        for rule in rules {
            switch rule.target {
            case let .folder(path): out.folders.append(path)
            case let .file(id): if let entry = index.file(id: id) { out.files[id] = entry.path }
            }
        }
        for entry in wanted {
            guard let id = entry.fileId, !kept.contains(id) else { continue }
            out.pending.insert(entry.path)
        }
        return out
    }
}

/// What a request from Finder about an item in a drive means, by its path as
/// mounted: the rule Keep Offline makes for it, and the page Show in Onyx
/// opens.
public enum FinderPins {
    /// The rule that keeps the item at `path` offline: the whole drive for
    /// "", a folder by the path the index has for it (as the rest of the
    /// app's folder rules are kept), a file by its id wherever it moves. Nil
    /// for a path the index does not have — a file still on its way up from
    /// this Mac, or one of macOS's own (.DS_Store), which the server never
    /// sees.
    public static func rule(scope: String, path: String, index: MirrorIndex) -> PinRule? {
        guard let clean = MirrorIndex.normalize(path) else { return nil }
        if clean.isEmpty { return PinRule(scope: scope, target: .folder(path: "")) }
        guard let entry = index.entry(at: clean) else { return nil }
        if entry.isFolder { return PinRule(scope: scope, target: .folder(path: entry.path)) }
        return entry.fileId.map { PinRule(scope: scope, target: .file(id: $0)) }
    }

    /// Where the web shows the item: a file's own page, a folder's listing in
    /// its drive (by the folder's path on the server, which is what the page
    /// reads), the drive's listing for "". Nil for a path the index does not
    /// have.
    public static func webPath(scope: SyncDomain, path: String, index: MirrorIndex) -> String? {
        guard let clean = MirrorIndex.normalize(path) else { return nil }
        var query: [(String, String)] = []
        if case let .drive(id) = scope { query.append(("filespace", id)) }
        if !clean.isEmpty {
            guard let entry = index.entry(at: clean) else { return nil }
            if !entry.isFolder {
                guard let id = entry.fileId else { return nil }
                return "/files/" + encoded(id)
            }
            query.append(("folder", entry.apiPath))
        }
        guard !query.isEmpty else { return "/files" }
        return "/files?" + query.map { "\($0.0)=\(encoded($0.1))" }.joined(separator: "&")
    }

    /// Percent-encoded for a query value or a path segment, as the page reads
    /// it back (URLSearchParams): "+" is a space there, so it is encoded, as
    /// is everything but unreserved ASCII and "/".
    static func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/")
}
