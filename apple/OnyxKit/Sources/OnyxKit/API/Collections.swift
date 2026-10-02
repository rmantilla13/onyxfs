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
        public let field: String
        /// any | none | set | unset | before | after
        public let op: String
        public let values: [String]
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

extension OnyxAPI {
    private struct CollectionsWrapper: Decodable { let collections: [FileCollection] }

    /// Every collection in All Files and in the drives this account can open.
    public func collections() async throws -> [FileCollection] {
        try decode(CollectionsWrapper.self, from: try await request(config.url("api/collections"))).collections
    }
}
