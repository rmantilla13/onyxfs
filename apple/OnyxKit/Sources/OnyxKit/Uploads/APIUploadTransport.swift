import Foundation

/// UploadQueue's network: the server's routes through OnyxAPI (with the
/// device token), and the bytes straight to storage by presigned PUT — they
/// never pass through the server.
public struct APIUploadTransport: UploadTransport {
    let api: OnyxAPI
    let session: URLSession

    /// No cache, no cookies; long timeouts, because a part of a large file on
    /// a slow line is minutes of sending.
    public static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 6 * 3600
        return URLSession(configuration: configuration)
    }()

    public init(api: OnyxAPI, session: URLSession = APIUploadTransport.session) {
        self.api = api
        self.session = session
    }

    public func presign(_ job: UploadJob) async throws -> OnyxAPI.PresignedPut {
        if let file = job.replaceOf {
            return try await api.presignReplacement(fileId: file, contentType: job.mime, size: job.size)
        }
        return try await api.presignUpload(filename: job.name, contentType: job.mime, folder: job.folder,
                                           filespaceId: job.filespaceId, size: job.size)
    }

    public func startMultipart(_ job: UploadJob) async throws -> OnyxAPI.MultipartUpload {
        if let file = job.replaceOf {
            return try await api.startReplacementMultipart(fileId: file, mime: job.mime, size: job.size)
        }
        return try await api.startMultipart(filename: job.name, mime: job.mime, folder: job.folder,
                                            filespaceId: job.filespaceId, size: job.size)
    }

    public func signParts(uploadId: String, parts: [Int]) async throws -> [Int: URL] {
        try await api.signParts(uploadId: uploadId, parts: parts)
    }

    public func multipartStatus(uploadId: String) async throws -> OnyxAPI.MultipartStatus {
        try await api.multipartStatus(uploadId: uploadId)
    }

    public func completeMultipart(uploadId: String) async throws -> OnyxAPI.CompletedUpload {
        try await api.completeMultipart(uploadId: uploadId)
    }

    public func abortMultipart(uploadId: String) async throws {
        try await api.abortMultipart(uploadId: uploadId)
    }

    public func record(_ job: UploadJob, key: String, publicUrl: String?) async throws -> OnyxAPI.RecordedFile {
        try await api.recordFile(key: key, publicUrl: publicUrl, name: job.name, size: job.size, mime: job.mime,
                                 folder: job.folder, filespaceId: job.filespaceId,
                                 created: job.fileCreatedAt, modified: job.fileModifiedAt)
    }

    public func replaceContent(_ job: UploadJob, key: String) async throws -> OnyxAPI.RecordedFile {
        guard let file = job.replaceOf else { throw OnyxError.decoding("not a replacement") }
        return try await api.replaceContent(fileId: file, key: key, mime: job.mime, modified: job.fileModifiedAt)
    }

    /// The whole file is streamed from disk; a part (a range of it) is read
    /// into memory first — a part is tens of megabytes, and the queue sends
    /// two at a time at most.
    public func put(_ file: URL, offset: Int64, length: Int64, to url: URL, contentType: String?,
                    progress: @escaping @Sendable (Int64) -> Void) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        request.setValue(String(length), forHTTPHeaderField: "Content-Length")
        let delegate = Progress(progress)
        let response: URLResponse
        let body: Data
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? -1
        if offset == 0, length == size {
            (body, response) = try await session.upload(for: request, fromFile: file, delegate: delegate)
        } else {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            let data = try handle.read(upToCount: Int(length)) ?? Data()
            (body, response) = try await session.upload(for: request, from: data, delegate: delegate)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // Storage's own error is XML; its code (e.g. SignatureDoesNotMatch)
            // is the useful part.
            let text = String(decoding: body.prefix(2048), as: UTF8.self)
            let code = text.range(of: "<Code>(.*?)</Code>", options: .regularExpression)
                .map { String(text[$0]).replacingOccurrences(of: "<Code>", with: "").replacingOccurrences(of: "</Code>", with: "") }
            // A presigned URL that expired while it waited is worth a new one:
            // 403 from storage is not the server refusing, so not permanent.
            throw OnyxError.http(status: status == 403 ? 503 : status,
                                 message: "Storage refused the upload (\(code ?? "HTTP \(status)")).")
        }
    }

    private final class Progress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let report: @Sendable (Int64) -> Void
        init(_ report: @escaping @Sendable (Int64) -> Void) { self.report = report }
        func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                        totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
            report(totalBytesSent)
        }
    }
}
