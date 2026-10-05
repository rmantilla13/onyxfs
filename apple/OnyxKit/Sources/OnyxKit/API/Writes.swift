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
///
/// A file saved over in Finder keeps its id (its tags, comments, links, and
/// place on the web): its new bytes go up under a key issued for that file
/// (`replaceOf`), then are swapped in (`replaceContent`).
extension OnyxAPI {
    /// The server's refusal with its `code`, where what happens next depends
    /// on it (an upload's record and content swap: start again, wait, or
    /// give up). Everything else stays OnyxError.
    public struct Refusal: Error, LocalizedError, Equatable, Sendable {
        public let status: Int
        public let code: String?
        public let message: String?

        public init(status: Int, code: String? = nil, message: String? = nil) {
            self.status = status
            self.code = code
            self.message = message
        }

        public var errorDescription: String? { message ?? "The server returned \(status)." }
    }

    /// A request whose refusal keeps the server's code (Refusal).
    func coded(_ url: URL, method: String = "POST", json: [String: Any]) async throws -> Data {
        let (data, status) = try await send(url, method: method, body: try JSONSerialization.data(withJSONObject: json))
        guard (200..<300).contains(status) else {
            if status == 401 { throw OnyxError.notAuthenticated }
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw Refusal(status: status, code: object?["code"] as? String, message: object?["error"] as? String)
        }
        return data
    }

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
        return try decode(PresignedPut.self, from: try await coded(config.url("api/files/presign"), json: body))
    }

    /// New bytes for an existing file: the key is the server's, beside the
    /// file's own object, and good only for swapping into that file.
    public func presignReplacement(fileId: String, contentType: String, size: Int64) async throws -> PresignedPut {
        let body: [String: Any] = ["replaceOf": fileId, "contentType": contentType, "size": size]
        return try decode(PresignedPut.self, from: try await coded(config.url("api/files/presign"), json: body))
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
        return try decode(MultipartUpload.self, from: try await coded(multipartURL, json: body))
    }

    /// `presignReplacement`, in parts.
    public func startReplacementMultipart(fileId: String, mime: String, size: Int64) async throws -> MultipartUpload {
        let body: [String: Any] = ["action": "create", "replaceOf": fileId, "mime": mime, "size": size]
        return try decode(MultipartUpload.self, from: try await coded(multipartURL, json: body))
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

    /// The file row, as the web's list has it — enough to place it, and to
    /// know when the mirror has caught up with it.
    public struct RecordedFile: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let folder: String?
        public let size: Int64?
        /// When the server made this change: the mirror shows it once its
        /// entry is this new.
        public let updatedAt: EpochMillis?

        public init(id: String, name: String, folder: String?, size: Int64?, updatedAt: EpochMillis? = nil) {
            self.id = id
            self.name = name
            self.folder = folder
            self.size = size
            self.updatedAt = updatedAt
        }
    }

    /// Records an uploaded object as a file in the library (in the drive
    /// its key sits under). `name` is what Finder called it, which may differ
    /// from the key's last part when the bucket already had that key.
    ///
    /// Not idempotent: a key is recorded once, and asked again (an answer
    /// lost on the way back) the server says 409.
    ///
    /// `created` and `modified` are the file's own dates (what Finder showed
    /// for it here), kept beside when it was added (lib/file-record.js).
    /// `videoCodec`: what a video's picture is encoded as (VideoCodec), by
    /// which the server asks for a proxy of one some browser will not play
    /// (lib/proxies.js shouldProxy); a server from before reads past it.
    public func recordFile(key: String, publicUrl: String?, name: String, size: Int64, mime: String,
                           folder: String, filespaceId: String?, created: Date? = nil,
                           modified: Date? = nil, videoCodec: VideoCodec? = nil) async throws -> RecordedFile {
        var body: [String: Any] = [
            "storage": "s3", "storageKey": key, "url": publicUrl ?? key, "name": name,
            "size": size, "mime": mime, "folder": folder,
        ]
        if let filespaceId { body["filespace"] = filespaceId }
        if let created { body["fileCreatedAt"] = Self.millis(created) }
        if let modified { body["fileModifiedAt"] = Self.millis(modified) }
        if let videoCodec { body["media"] = ["videoCodec": videoCodec.json] }
        return try decode(FileAnswer.self, from: try await coded(config.url("api/files"), json: body)).file
    }

    /// The bytes uploaded to `key` (issued by `presignReplacement` or
    /// `startReplacementMultipart` for this file) become its contents: the
    /// same file, new bytes. Asked again after a lost answer, the server
    /// answers as the first time. `modified`: when these bytes were written
    /// (the server stamps now without it); the file's created date stays.
    public func replaceContent(fileId: String, key: String, mime: String?, modified: Date? = nil) async throws -> RecordedFile {
        var body: [String: Any] = ["key": key]
        if let mime { body["mime"] = mime }
        if let modified { body["fileModifiedAt"] = Self.millis(modified) }
        return try decode(FileAnswer.self, from: try await coded(fileURL(fileId, "content"), json: body)).file
    }

    private struct FileAnswer: Decodable { let file: RecordedFile }

    /// Epoch milliseconds, as the API counts time.
    static func millis(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }

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

    /// The folder and what is in it, the way the web's folder delete does:
    /// a few hundred files a call, so asked again while it says there is more.
    public func deleteFolder(path: String, filespaceId: String?) async throws {
        struct Answer: Decodable { let failed: Int?; let error: String?; let more: Bool? }
        var query = [URLQueryItem(name: "name", value: path)]
        if let filespaceId { query.append(URLQueryItem(name: "filespace", value: filespaceId)) }
        let url = config.url("api/files/folders", query: query)
        for _ in 0..<2_500 {
            let answer = try? JSONDecoder().decode(Answer.self, from: try await request(url, method: "DELETE"))
            if let failed = answer?.failed, failed > 0 {
                throw OnyxError.http(status: 500, message: answer?.error ?? "\(failed) of its files could not be deleted.")
            }
            guard answer?.more == true else { return }
        }
    }

    private var multipartURL: URL { config.url("api/files/upload/multipart") }

    private func fileURL(_ id: String, _ sub: String? = nil) -> URL {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return config.url("api/files/\(escaped)" + (sub.map { "/\($0)" } ?? ""))
    }
}
