import Foundation

/// The routes a browser uses to give a file its thumbnail after the fact
/// (lib/thumbnail-client.js, recordThumbnail), called with this Mac's
/// device token so a thumbnail made here is recorded exactly as one made
/// by a browser: the same keys, named by the server, the same checks, and
/// the file's `seq` moved so every device picks it up.
///
///     GET  /api/files/<id>/thumbnail   may this account record one (204)
///     GET  /api/files/<id>             the file as it is now, presigned
///     POST /api/files/presign          PUTs for the pictures: { thumb, sizes }
///                                      or { poster }, never a file
///     PUT  /api/files/<id>/thumbnail   record the keys, and the placeholder
///
/// The thumbnail route goes past the sign-in gate with a bearer token
/// (lib/bearer-gate.js), as the write routes of Writes.swift do.
extension OnyxAPI {
    /// Whether this account may record a thumbnail for the file: the same
    /// checks as the PUT (files.edit, and write access to the file itself).
    /// Asked before anything is downloaded or drawn, as the browser asks —
    /// being able to add to a drive is not being able to change every file
    /// in it.
    ///
    /// Only a 204 is a yes. A server from before this took the Mac's token
    /// sends it to the sign-in page, which answers 200 with HTML; that is
    /// `thumbnailsUnsupported`, so nothing is uploaded that could never be
    /// recorded.
    public func mayRecordThumbnail(fileId: String) async throws -> Bool {
        let (data, status) = try await send(thumbnailURL(fileId), method: "GET", body: nil)
        switch status {
        case 204: return true
        case 403, 404: return false
        case 200..<300: throw Self.thumbnailsUnsupported
        default:
            try Self.check(status, data)
            return false
        }
    }

    /// What `mayRecordThumbnail` throws for a server that does not take a
    /// thumbnail from this Mac.
    public static var thumbnailsUnsupported: OnyxError {
        .http(status: 501, message: "This server does not take thumbnails from Onyx for Mac yet.")
    }

    /// One file as the web's detail view has it (GET /api/files/<id>):
    /// its row now, its original presigned for six hours, and whether this
    /// account may change it.
    public struct FileDetail: Sendable {
        public let file: FileItem
        /// Where its bytes are: `s3` for the bucket, where previews go.
        public let storage: String?
        public let canWrite: Bool?
    }

    public func fileDetail(id: String) async throws -> FileDetail {
        struct Answer: Decodable { let file: FileItem; let canWrite: Bool? }
        // FileItem does not keep `storage`; read beside it.
        struct Place: Decodable { struct Row: Decodable { let storage: String? }; let file: Row }
        let data = try await request(config.url("api/files").appending(component: id))
        let answer = try decode(Answer.self, from: data)
        return FileDetail(file: answer.file, storage: try? decode(Place.self, from: data).file.storage,
                          canWrite: answer.canWrite)
    }

    /// Where to PUT a picture, as the presign route names it: a key under
    /// `_thumbs/` of the server's making, and the Cache-Control the PUT
    /// must carry (storage keeps it).
    public struct PreviewTarget: Decodable, Sendable {
        public struct Sibling: Decodable, Sendable {
            public let putUrl: URL
            public let key: String
        }

        public let putUrl: URL
        public let key: String
        public let cacheControl: String?
        /// A grid thumbnail's smaller siblings, under its own key.
        public let siblings: [String: Sibling]?
    }

    /// PUTs for a grid thumbnail and the siblings named in `sizes`
    /// (["sm", "xs"]), in `contentType` (image/webp or image/jpeg).
    public func presignThumbnail(contentType: String, sizes: [String]) async throws -> PreviewTarget {
        let body: [String: Any] = ["thumb": true, "sizes": sizes, "contentType": contentType]
        return try decode(PreviewTarget.self, from: try await request(config.url("api/files/presign"),
                                                                      method: "POST", json: body))
    }

    /// A PUT for a large picture: a video's player poster, or an image's
    /// preview (`_thumbs/<uuid>.poster.<ext>`, which only that column takes).
    public func presignPoster(contentType: String) async throws -> PreviewTarget {
        let body: [String: Any] = ["poster": true, "contentType": contentType]
        return try decode(PreviewTarget.self, from: try await request(config.url("api/files/presign"),
                                                                      method: "POST", json: body))
    }

    /// Record the pictures on the file, over any it had (the server deletes
    /// the ones replaced and moves the file's `seq`). `thumbSizes` names the
    /// siblings that landed. `placeholder` is the new thumbnail's tiny copy
    /// (Placeholder), which rides in the row: the server keeps it only when
    /// it is one, and the old thumbnail's goes either way. A server from
    /// before placeholders reads past it. Returns the file as it is now.
    public func recordThumbnail(fileId: String, thumbnailKey: String, posterKey: String?, thumbSizes: [String],
                                media: MediaFacts, placeholder: Placeholder? = nil) async throws -> FileItem {
        struct Answer: Decodable { let file: FileItem }
        var body: [String: Any] = ["thumbnailKey": thumbnailKey, "thumbSizes": thumbSizes, "media": media.json]
        if let posterKey { body["posterKey"] = posterKey }
        if let placeholder { body["placeholder"] = placeholder.dataURL }
        return try decode(Answer.self, from: try await request(thumbnailURL(fileId), method: "PUT", json: body)).file
    }

    private func thumbnailURL(_ fileId: String) -> URL {
        config.url("api/files").appending(component: fileId).appending(path: "thumbnail")
    }
}
