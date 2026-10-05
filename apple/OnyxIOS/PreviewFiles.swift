import Foundation
import OnyxKit

/// Originals, downloaded for what can only be shown whole — a PDF, a
/// document for Quick Look — or to be shared.
///
/// Kept in Caches/Previews/<file>/<version>/<name>, so one opened again
/// opens at once, and a file whose bytes changed is fetched anew; the name
/// is the file's own, which Quick Look and the share sheet go by. The
/// system may clear them; signing out does.
///
/// Held under 500 MB, back to 400 once past it: the least recently opened
/// go first (CacheFolder), each opening marking its file used, and a file on
/// screen (`hold`) stays whatever its age.
enum PreviewFiles {
    static let kept = CacheFolder("Previews", cap: CacheTrim(limit: 500 << 20, trimTo: 400 << 20))

    static var folder: URL { kept.url }

    /// The file on this device, downloaded first if need be: through a link
    /// that is here already when one will do — the listing's, good for
    /// hours, or one kept (PreviewLinks) — else one signed now. A link
    /// storage refuses (expired, or the file moved) gives way to one signed
    /// now.
    static func local(for file: FileItem, api: OnyxAPI,
                      progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        let versions = folder.appendingPathComponent(file.id, isDirectory: true)
        let target = location(of: file)
        if FileManager.default.fileExists(atPath: target.path) {
            touch(target)
            return target
        }

        // A download needs its link only as it starts.
        var source = await PreviewLinks.ready(for: file, needed: 60)?.url
        var fresh = false
        while true {
            let url: URL
            if let source {
                url = source
            } else {
                url = try await PreviewLinks.link(for: file, api: api).url
                fresh = true
            }
            let (downloaded, response) = try await URLSession.shared.download(from: url, delegate: Progress(progress))
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                try? FileManager.default.removeItem(at: downloaded)
                if !fresh, [400, 403, 404].contains(status) {
                    await PreviewLinks.refused(file)
                    source = nil
                    continue
                }
                throw OnyxError.http(status: status, message: "Storage did not send the file.")
            }
            // Only this version is kept: an older one's bytes are not this file's any more.
            try? FileManager.default.removeItem(at: versions)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: downloaded, to: target)
            let allocated = (try? target.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?.totalFileAllocatedSize
            kept.wrote(allocated.map { Int64($0) } ?? file.size ?? 0)
            // An original is tens of megabytes: this one may have taken the
            // folder past its cap. The page that asked for it holds it.
            CacheFolder.trimAll()
            return target
        }
    }

    /// This version of the file, if it is on this device already — for a
    /// save, which then need not download it again.
    static func cached(for file: FileItem) -> URL? {
        let target = location(of: file)
        guard FileManager.default.fileExists(atPath: target.path) else { return nil }
        touch(target)
        return target
    }

    /// `file` is on screen — a document in Quick Look, an original being
    /// decoded — and no trim takes it until it is released.
    static func hold(_ file: FileItem) {
        kept.hold(file.id)
    }

    static func release(_ file: FileItem) {
        kept.release(file.id)
    }

    /// Marks it used, so a trim keeps what is still being opened: its date
    /// changed, nothing written.
    private static func touch(_ url: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    }

    private static func location(of file: FileItem) -> URL {
        folder.appendingPathComponent(file.id, isDirectory: true)
            .appendingPathComponent("v\(file.version)", isDirectory: true)
            .appendingPathComponent(safeName(file.name))
    }

    static func removeAll() {
        try? FileManager.default.removeItem(at: folder)
        kept.emptied()
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
