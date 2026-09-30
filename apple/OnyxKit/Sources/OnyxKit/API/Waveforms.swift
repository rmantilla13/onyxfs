import Foundation

/// The route a browser records a sound's waveform with (lib/waveform-client.js
/// recordWaveform), called with this Mac's device token — past the sign-in
/// gate as the thumbnail route is (lib/bearer-gate.js), with the same checks:
/// files.edit, and write access to the file itself.
///
///     PUT  /api/files/<id>/waveform   { waveform, contentHash? }
extension OnyxAPI {
    /// Record `waveform` on the file. `contentHash`, when given, is the
    /// contents it was drawn from: the server refuses it (409) for a file
    /// whose contents have been replaced since. → the file as it is now.
    @discardableResult
    public func recordWaveform(fileId: String, waveform: Waveform, contentHash: String? = nil) async throws -> FileItem {
        struct Answer: Decodable { let file: FileItem }
        var body: [String: Any] = ["waveform": waveform.stored]
        if let contentHash { body["contentHash"] = contentHash }
        let url = config.url("api/files").appending(component: fileId).appending(path: "waveform")
        return try decode(Answer.self, from: try await request(url, method: "PUT", json: body)).file
    }
}
