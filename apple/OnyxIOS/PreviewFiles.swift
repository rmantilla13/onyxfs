import Foundation
import OnyxKit

/// Originals, downloaded for what can only be shown whole — a PDF, a
/// document for Quick Look — or to be shared.
///
/// Kept in Caches/Previews/<file>/<version>/<name>, so one opened again
/// opens at once, and a file whose bytes changed is fetched anew; the name
/// is the file's own, which Quick Look and the share sheet go by. The
/// system may clear them; signing out does.
enum PreviewFiles {
    static var folder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Previews", isDirectory: true)
    }

    /// The file on this device, downloaded first if need be, through a link
    /// signed now (the listing's may have expired).
    static func local(for file: FileItem, api: OnyxAPI,
                      progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        let versions = folder.appendingPathComponent(file.id, isDirectory: true)
        let target = location(of: file)
        if FileManager.default.fileExists(atPath: target.path) { return target }

        let link = try await api.contentLink(fileId: file.id)
        let (downloaded, response) = try await URLSession.shared.download(from: link.url, delegate: Progress(progress))
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            try? FileManager.default.removeItem(at: downloaded)
            throw OnyxError.http(status: (response as? HTTPURLResponse)?.statusCode ?? 0,
                                 message: "Storage did not send the file.")
        }
        // Only this version is kept: an older one's bytes are not this file's any more.
        try? FileManager.default.removeItem(at: versions)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: downloaded, to: target)
        return target
    }

    /// This version of the file, if it is on this device already — for a
    /// save, which then need not download it again.
    static func cached(for file: FileItem) -> URL? {
        let target = location(of: file)
        return FileManager.default.fileExists(atPath: target.path) ? target : nil
    }

    private static func location(of file: FileItem) -> URL {
        folder.appendingPathComponent(file.id, isDirectory: true)
            .appendingPathComponent("v\(file.version)", isDirectory: true)
            .appendingPathComponent(safeName(file.name))
    }

    static func removeAll() {
        try? FileManager.default.removeItem(at: folder)
    }

    /// The name as a file on this device may have it: no path separators,
    /// never empty.
    static func safeName(_ name: String) -> String {
        SavePlan.fileName(name)
    }

    /// Reports a download's progress as it goes.
    private final class Progress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let report: @Sendable (Double) -> Void
        private var watching: NSKeyValueObservation?

        init(_ report: @escaping @Sendable (Double) -> Void) { self.report = report }

        func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
            watching = task.progress.observe(\.fractionCompleted, options: [.new]) { [report] progress, _ in
                report(progress.fractionCompleted)
            }
        }
    }
}
