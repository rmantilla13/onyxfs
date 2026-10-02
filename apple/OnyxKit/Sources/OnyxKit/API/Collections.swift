import Foundation

// Collections: the files that meet a set of rules on their kind, tags and
// metadata (a folder's count for the files inside it), shared with everyone
// who can open the drive they were made in (GET /api/collections, the web's
// lib/collections.js). Their files are a listing like any other —
// listFiles(collection:) — under the listing's own access rules.

/// A collection, as the server lists it.
public struct FileCollection: Codable, Sendable, Hashable, Identifiable {
    public struct Rule: Codable, Sendable, Hashable {
        /// "kind", "tag", or "meta:<field key>".
        public var field: String
        /// any | none | set | unset | before | after
        public var op: String
        public var values: [String]

        public init(field: String, op: String, values: [String]) {
            self.field = field; self.op = op; self.values = values
        }
    }

    public let id: String
    /// The drive's id; "" for All Files.
    public let driveId: String
    public let name: String
    /// "all" or "any" of the rules.
    public let match: String
    public let rules: [Rule]
    public let canEdit: Bool?

    public var scope: SyncDomain { driveId.isEmpty ? .library : .drive(id: driveId) }
}

/// One of the workspace's metadata fields (the web's lib/dam.js): what a
/// rule can read, and what a folder can carry.
public struct MetadataField: Codable, Sendable, Hashable, Identifiable {
    public let key: String
    public let label: String
    /// text | select | multiselect | date
    public let type: String
    public let options: [String]?
    public var id: String { key }
}

/// The collections list, with what a rule editor needs alongside it.
public struct CollectionsIndex: Decodable, Sendable {
    public let collections: [FileCollection]
    /// The workspace's metadata fields.
    public let fields: [MetadataField]
    /// Where this account may make a collection: drive ids, "" for All Files.
    public let canCreate: [String]

    private enum CodingKeys: String, CodingKey { case collections, fields, canCreate }

    // A server from before the editor sends the collections alone: they are
    // still listed, and nothing is offered to make.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        collections = try c.decode([FileCollection].self, forKey: .collections)
        fields = try c.decodeIfPresent([MetadataField].self, forKey: .fields) ?? []
        canCreate = try c.decodeIfPresent([String].self, forKey: .canCreate) ?? []
    }
}

/// A metadata value as stored: one string, or a list of them.
public enum MetadataValue: Codable, Sendable, Hashable {
    case one(String)
    case many([String])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let list = try? c.decode([String].self) { self = .many(list) }
        else if let n = try? c.decode(Double.self) { self = .one(n == n.rounded() ? String(Int(n)) : String(n)) }
        else { self = .one(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .one(v): try c.encode(v)
        case let .many(v): try c.encode(v)
        }
    }

    /// Every value, as a list.
    public var values: [String] {
        switch self {
        case let .one(v): return v.isEmpty ? [] : [v]
        case let .many(v): return v
        }
    }
}

extension OnyxAPI {
    private struct CollectionWrapper: Decodable { let collection: FileCollection }

    /// Every collection in All Files and in the drives this account can open,
    /// with the metadata fields and where a new one may be made.
    public func collectionsIndex() async throws -> CollectionsIndex {
        try decode(CollectionsIndex.self, from: try await request(config.url("api/collections")))
    }

    /// Every collection in All Files and in the drives this account can open.
    public func collections() async throws -> [FileCollection] {
        try await collectionsIndex().collections
    }

    private static func body(_ rules: [FileCollection.Rule]) -> [[String: Any]] {
        rules.map { ["field": $0.field, "op": $0.op, "values": $0.values] }
    }

    /// Make a collection in `scope`. The server's sentence says what is wrong.
    public func createCollection(in scope: SyncDomain, name: String, match: String,
                                 rules: [FileCollection.Rule]) async throws -> FileCollection {
        var driveId = ""
        if case let .drive(id) = scope { driveId = id }
        let data = try await request(config.url("api/collections"), method: "POST",
                                     json: ["name": name, "driveId": driveId, "match": match, "rules": Self.body(rules)])
        return try decode(CollectionWrapper.self, from: data).collection
    }

    /// Rename a collection, or change its rules.
    public func updateCollection(_ id: String, name: String, match: String,
                                 rules: [FileCollection.Rule]) async throws -> FileCollection {
        let path = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let data = try await request(config.url("api/collections/\(path)"), method: "PATCH",
                                     json: ["name": name, "match": match, "rules": Self.body(rules)])
        return try decode(CollectionWrapper.self, from: data).collection
    }

    public func deleteCollection(_ id: String) async throws {
        let path = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await request(config.url("api/collections/\(path)"), method: "DELETE")
    }

    /// A folder's own tags (the whole list) and metadata (a field sent as nil
    /// is cleared), which the files inside it inherit in collections.
    public func setFolderMeta(in scope: SyncDomain, folder: String, tags: [String],
                              metadata: [String: MetadataValue?]) async throws {
        var body: [String: Any] = ["folder": folder, "tags": tags]
        var md: [String: Any] = [:]
        for (k, v) in metadata {
            switch v {
            case let .one(s)?: md[k] = s
            case let .many(list)?: md[k] = list
            case nil: md[k] = NSNull()
            }
        }
        body["metadata"] = md
        if case let .drive(id) = scope { body["filespaceId"] = id }
        _ = try await request(config.url("api/files/folders/meta"), method: "PUT", json: body)
    }
}
