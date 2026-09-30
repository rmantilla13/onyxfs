import Foundation

// Starred folders: a person's shortcuts, kept on the server (GET/PUT
// /api/stars) so the web's sidebar and the iPhone's show the same ones. A
// star only points: opening one is a listing like any other, under the
// listing's own access rules, and the server returns a star only while its
// drive is one this account can open.

/// A starred folder: its path within a drive, or within All Files.
public struct FolderStar: Codable, Sendable, Hashable, Identifiable {
    /// The drive's id; "" for All Files.
    public let driveId: String
    /// Its path within that scope ("Footage/Day 1").
    public let folder: String

    public init(scope: SyncDomain, folder: String) {
        if case let .drive(id) = scope { driveId = id } else { driveId = "" }
        self.folder = folder
    }

    public var scope: SyncDomain { driveId.isEmpty ? .library : .drive(id: driveId) }
    public var id: String { "\(scope.identifier)\n\(folder)" }
    /// The folder's own name, the last part of its path.
    public var name: String { folder.split(separator: "/").last.map(String.init) ?? folder }
}

extension OnyxAPI {
    private struct StarsWrapper: Decodable { let stars: [FolderStar] }

    /// Every folder this account has starred, oldest first.
    public func stars() async throws -> [FolderStar] {
        try decode(StarsWrapper.self, from: try await request(config.url("api/stars"))).stars
    }

    /// Star or unstar a folder; either is idempotent. Returns the whole list
    /// as it now stands.
    @discardableResult
    public func setStar(_ star: FolderStar, starred: Bool) async throws -> [FolderStar] {
        let data = try await request(config.url("api/stars"), method: "PUT",
                                     json: ["driveId": star.driveId, "folder": star.folder, "starred": starred])
        return try decode(StarsWrapper.self, from: data).stars
    }
}
