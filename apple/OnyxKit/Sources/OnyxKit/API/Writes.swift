import Foundation

/// The server's own write routes — the ones the web uses — called with this
/// Mac's device token, so a drive mounted as a disk (onyxfs) changes exactly
/// what the web changes, under exactly the web's rules: drive roles, the
/// role's capabilities, quotas, the trash flag. Nothing here decides who
/// may do what; the server answers 403 and its sentence says why.
///
/// Uploads are the web's two ways: one presigned PUT for a file under
/// `UploadPlan.multipartThreshold`, a multipart upload above it (parts
/// signed in batches, completed by the server from the bucket's own list of
/// parts), then the file recorded (POST /api/files) with the key the server
/// issued — never a key of our own.
extension OnyxAPI {
    // MARK: - Uploading

    public struct PresignedPut: Decodable, Sendable {
        public let putUrl: URL
        public let publicUrl: String?
        public let key: String
        public let name: String
    }

    public func presignUpload(filename: String, contentType: String, folder: String,
                              filespaceId: String?, size: Int64) async throws -> PresignedPut {
        var body: [String: Any] = ["filename": filename, "contentType": contentType, "folder": folder, "size": size]
        if let filespaceId { body["filespaceId"] = filespaceId }
        return try decode(PresignedPut.self, from: try await request(config.url("api/files/presign"), method: "POST", json: body))
    }

    public struct MultipartUpload: Decodable, Sendable {
        public let id: String
        public let key: String
        public let name: String
        public let partSize: Int64
        public let partCount: Int
    }

    public func startMultipart(filename: String, mime: String, folder: String,
                               filespaceId: String?, size: Int64) async throws -> MultipartUpload {
        var body: [String: Any] = ["action": "create", "filename": filename, "mime": mime, "folder": folder, "size": size]
        if let filespaceId { body["filespaceId"] = filespaceId }
        return try decode(MultipartUpload.self, from: try await request(multipartURL, method: "POST", json: body))
    }

    /// Presigned PUTs for these parts (1-based).
    public func signParts(uploadId: String, parts: [Int]) async throws -> [Int: URL] {
        struct Signed: Decodable { struct Part: Decodable { let partNumber: Int; let url: URL }; let parts: [Part] }
        let data = try await request(multipartURL, method: "POST",
                                     json: ["action": "sign", "id": uploadId, "partNumbers": parts])
        return Dictionary(uniqueKeysWithValues: try decode(Signed.self, from: data).parts.map { ($0.partNumber, $0.url) })
    }

    public struct MultipartStatus: Decodable, Sendable {
        /// The parts the bucket already holds.
        public let done: Set<Int>
        public let partSize: Int64
        public let partCount: Int

        enum Keys: String, CodingKey { case parts, upload, partCount }
        struct Part: Decodable { let partNumber: Int }
        struct Upload: Decodable { let partSize: Int64 }

        public init(done: Set<Int>, partSize: Int64, partCount: Int) {
            self.done = done
            self.partSize = partSize
            self.partCount = partCount
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            done = Set(try c.decode([Part].self, forKey: .parts).map(\.partNumber))
            partSize = try c.decode(Upload.self, forKey: .upload).partSize
            partCount = try c.decode(Int.self, forKey: .partCount)
        }
    }

    /// Which parts the bucket already holds, and the upload's own plan — for
    /// picking it up where it stopped (a restart, a network that went away
    /// for an hour). The plan is the server's (it depends on the storage),
    /// so it is read back, never worked out here.
    public func multipartStatus(uploadId: String) async throws -> MultipartStatus {
        try decode(MultipartStatus.self, from: try await request(multipartURL, method: "POST",
                                                                 json: ["action": "status", "id": uploadId]))
    }

    public struct CompletedUpload: Decodable, Sendable {
        public let key: String
        public let publicUrl: String?
        public let name: String
    }

    public func completeMultipart(uploadId: String) async throws -> CompletedUpload {
        try decode(CompletedUpload.self, from: try await request(multipartURL, method: "POST",
                                                                 json: ["action": "complete", "id": uploadId]))
    }

    public func abortMultipart(uploadId: String) async throws {
        _ = try await request(multipartURL, method: "POST", json: ["action": "abort", "id": uploadId])
    }

    /// The file row, as the web's list has it — enough to place it.
    public struct RecordedFile: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let folder: String?
        public let size: Int64?
    }

    /// Records an uploaded object as a file in the library (in the drive
    /// its key sits under). `name` is what Finder called it, which may differ
    /// from the key's last part when the bucket already had that key.
    public func recordFile(key: String, publicUrl: String?, name: String, size: Int64, mime: String,
                           folder: String, filespaceId: String?) async throws -> RecordedFile {
        struct Wrapper: Decodable { let file: RecordedFile }
        var body: [String: Any] = [
            "storage": "s3", "storageKey": key, "url": publicUrl ?? key, "name": name,
            "size": size, "mime": mime, "folder": folder,
        ]
        if let filespaceId { body["filespace"] = filespaceId }
        return try decode(Wrapper.self, from: try await request(config.url("api/files"), method: "POST", json: body)).file
    }

    // MARK: - Changing files and folders

    /// Rename and/or move (folder "" is the drive's top level). The server
    /// moves the stored object with it.
    public func updateFile(id: String, name: String? = nil, folder: String? = nil, filespaceId: String?) async throws {
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let folder { body["folder"] = folder }
        if let filespaceId { body["filespaceId"] = filespaceId }
        _ = try await request(fileURL(id), method: "PATCH", json: body)
    }

    /// To the trash, or gone — the server's `trash` flag decides, as it
    /// does for the web's Delete.
    public func deleteFile(id: String) async throws {
        _ = try await request(fileURL(id), method: "DELETE")
    }

    /// `path` is the folder's full path within the drive ("Footage/Day 1").
    /// An existing folder is not an error.
    public func createFolder(path: String, filespaceId: String?) async throws {
        var body: [String: Any] = ["name": path, "ensure": true]
        if let filespaceId { body["filespaceId"] = filespaceId }
        _ = try await request(config.url("api/files/folders"), method: "POST", json: body)
    }

    public func moveFolder(from: String, to: String, filespaceId: String?) async throws {
        var body: [String: Any] = ["from": from, "to": to]
        if let filespaceId { body["filespaceId"] = filespaceId }
        _ = try await request(config.url("api/files/folders"), method: "PATCH", json: body)
    }

    /// The folder and what is in it, the way the web's folder delete does.
    public func deleteFolder(path: String, filespaceId: String?) async throws {
        var query = [URLQueryItem(name: "name", value: path)]
        if let filespaceId { query.append(URLQueryItem(name: "filespace", value: filespaceId)) }
        _ = try await request(config.url("api/files/folders", query: query), method: "DELETE")
    }

    private var multipartURL: URL { config.url("api/files/upload/multipart") }

    private func fileURL(_ id: String) -> URL {
        config.url("api/files/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")
    }
}
