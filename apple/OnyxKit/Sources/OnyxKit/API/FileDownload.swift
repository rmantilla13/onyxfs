import Foundation

/// A GET written to a file of the caller's choosing as it arrives.
///
/// For offline copies. URLSession's own download task writes to a temporary
/// folder on the startup disk first, so a copy bound for an external disk
/// would need room there as well — for three at once, three of the largest
/// files — and then a full copy across. Written where it is going, a download
/// needs room on that disk only, and is never held whole in memory.
public enum FileDownload {
    /// No URL cache: a file kept offline is kept by the pin store, not in
    /// URLSession's cache as well.
    public static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    /// Writes the body of `url` to `destination`, replacing whatever is
    /// there. The folder must exist: a missing one fails here, before a
    /// byte is asked for. A status that is not 2xx throws OnyxError.http and
    /// writes none of that body. On any throw the caller removes what is at
    /// `destination`. Cancelling the calling task stops the transfer.
    public static func fetch(_ url: URL, to destination: URL, session: URLSession = session) async throws {
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let handle = try FileHandle(forWritingTo: destination)
        let writer = Writer(handle: handle)
        let task = session.dataTask(with: url)
        task.delegate = writer
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                writer.start(task, then: continuation)
            }
        } onCancel: {
            task.cancel()
        }
    }
}

/// The task's own delegate: each chunk goes to the file as it comes.
private final class Writer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    // Set by start() before the task runs; after that, touched only by the
    // session's delegate queue, one callback at a time.
    private let handle: FileHandle
    private var continuation: CheckedContinuation<Void, Error>?
    private var failure: Error?

    init(handle: FileHandle) {
        self.handle = handle
    }

    func start(_ task: URLSessionDataTask, then continuation: CheckedContinuation<Void, Error>) {
        self.continuation = continuation
        task.resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // An error page is not the file.
            failure = OnyxError.http(status: status, message: "Storage refused the download (\(status)).")
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        do { try handle.write(contentsOf: data) } catch {
            // The disk filled, or went away: nothing more is worth fetching.
            failure = error
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        var outcome = failure ?? error
        do { try handle.close() } catch { outcome = outcome ?? error }
        let continuation = self.continuation
        self.continuation = nil
        if let outcome { continuation?.resume(throwing: outcome) } else { continuation?.resume() }
    }
}
