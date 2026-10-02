import Foundation

// Browsing, as the web browses: a folder's files (GET /api/files) and a
// drive's folders (GET /api/files/folders). The server authorizes, filters
// and presigns these exactly as it does the files page (lib/file-listing.js),
// so nothing shows here that the web would not show this account.
//
// The Mac mirrors whole drives from the change feed instead; a phone lists
// only the folder in front of it, a page at a time.

/// One page of a listing.
public struct FilePage: Decodable, Sendable {
    public let files: [FileItem]
    /// Opaque: handed back for the next page. Nil on the last.
    public let cursor: String?
}

/// A folder, as the drive's tree lists it.
public struct FolderNode: Codable, Sendable, Hashable, Identifiable {
    /// Its path within the drive ("Footage/Day 1").
    public let folder: String
    public let name: String
    /// Its parent's path; "" at the top of the drive.
    public let parent: String
    public let depth: Int
    /// The files directly in it.
    public let count: Int
    /// Whether its links are this account's to manage (the server's
    /// markFolderLinks): the folder's half of whether to offer Share Link…,
    /// as a file's `can.share` is. Nil, from an older server, is no.
    public let share: Bool?
    /// What the folder carries itself, which the files inside it inherit in
    /// collections (FileCollection). Nil when it carries nothing.
    public let tags: [String]?
    public let metadata: [String: MetadataValue]?

    public var id: String { folder }

    public init(folder: String, name: String, parent: String, depth: Int, count: Int, share: Bool? = nil,
                tags: [String]? = nil, metadata: [String: MetadataValue]? = nil) {
        self.folder = folder; self.name = name; self.parent = parent; self.depth = depth; self.count = count
        self.share = share
        self.tags = tags; self.metadata = metadata
    }
}

/// The orders a listing comes in: SORTS in lib/file-query.js, whose keys
/// these are on the wire.
public enum FileSort: String, CaseIterable, Sendable {
    case newest = "new"
    case oldest = "old"
    case name
    case nameDescending = "name_desc"
    case largest = "size"
    case smallest = "small"
    case type
    case typeDescending = "type_desc"
    case modified
    case modifiedOldest = "modified_old"
}

extension OnyxAPI {
    /// One page of a folder: the files directly in `folder` ("" is the top
    /// of the scope). With a `query`, the files matching it anywhere beneath
    /// `folder` instead — the web's search, scoped the same way.
    ///
    /// With a `collection` (FileCollection.id), its files instead: everything
    /// in its drive that meets its rules, whatever `folder` says, narrowed by
    /// the `query` too.
    public func listFiles(in scope: SyncDomain, folder: String, query: String? = nil, sort: FileSort = .name,
                          cursor: String? = nil, limit: Int = 100, collection: String? = nil) async throws -> FilePage {
        var items: [URLQueryItem] = [
            .init(name: "sort", value: sort.rawValue),
            .init(name: "limit", value: String(limit)),
            // The tree comes from folders(in:), once, not with every page.
            .init(name: "folders", value: "0"),
        ]
        if case let .drive(id) = scope { items.append(.init(name: "filespace", value: id)) }
        if let collection {
            items.append(.init(name: "collection", value: collection))
            if let query = query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
                items.append(.init(name: "q", value: query))
            }
        } else if let query = query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            items.append(.init(name: "q", value: query))
            if !folder.isEmpty { items.append(.init(name: "folderPrefix", value: folder)) }
        } else {
            items.append(.init(name: "folder", value: folder))
        }
        if let cursor { items.append(.init(name: "cursor", value: cursor)) }
        return try decode(FilePage.self, from: try await request(config.url("api/files", query: items)))
    }

    /// Every folder in `scope`, each with how many files it holds.
    public func folders(in scope: SyncDomain) async throws -> [FolderNode] {
        struct Wrapper: Decodable { let folders: [FolderNode] }
        var items: [URLQueryItem] = []
        if case let .drive(id) = scope { items.append(.init(name: "filespace", value: id)) }
        return try decode(Wrapper.self, from: try await request(config.url("api/files/folders", query: items))).folders
    }
}
