import Foundation
import os

private let log = Logger(subsystem: "io.onyxfs.app", category: "downloads")

/// The bytes of a download, fetched by the system rather than the app: a
/// background URLSession, so a multi-gigabyte video from an action camera
/// keeps coming while Onyx is in the background, and finishes even if iOS
/// ends the app meanwhile — it is woken to take the file
/// (AppDelegate, handleEventsForBackgroundURLSession).
///
/// A finished file is moved into its item's folder before the delegate
/// returns (the system deletes it after), and only a 2xx is a file: an
/// error page from storage is thrown away, never saved. A download that is
/// cancelled leaves nothing behind; one that fails leaves only what the
/// system keeps to resume it, which `discard` clears.
final class DownloadTransport: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let identifier = "io.onyxfs.app.downloads"

    enum Event {
        case progress(UUID, received: Int64, expected: Int64?)
        case finished(UUID, file: URL)
        case failed(UUID, Error, resumeData: Data?)
        case cancelled(UUID)
    }

    /// Where each item's file is put: DownloadCenter's folder for it.
    var destination: (UUID, String) -> URL = { id, name in
        FileManager.default.temporaryDirectory.appendingPathComponent(id.uuidString).appendingPathComponent(name)
    }
    /// Told of each event, on the session's queue.
    var onEvent: ((Event) -> Void)?

    private let lock = NSLock()
    private var tasks: [UUID: URLSessionDownloadTask] = [:]
    private var cancelledByUs: Set<UUID> = []
    private var lastReport: [UUID: CFAbsoluteTime] = [:]
    private var backgroundCompletion: (() -> Void)?

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        // Asked for now, by someone waiting: not for when the phone is charging.
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.allowsCellularAccess = true
        configuration.urlCache = nil
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "io.onyxfs.app.downloads"
        return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }()

    /// The session, made again at launch so tasks begun before — in an
    /// earlier run of the app — report to this one. Returns the items that
    /// are still under way.
    func activate() async -> Set<UUID> {
        let running = await session.allTasks
        var ids = Set<UUID>()
        lock.withLock {
            for case let task as URLSessionDownloadTask in running {
                guard let ticket = Ticket(task.taskDescription) else { task.cancel(); continue }
                tasks[ticket.item] = task
                ids.insert(ticket.item)
            }
        }
        return ids
    }

    /// iOS woke the app for this session's events; `completion` is called
    /// once they have all been delivered.
    func handleBackgroundEvents(_ completion: @escaping () -> Void) {
        lock.withLock { backgroundCompletion = completion }
        _ = session
    }

    func start(_ url: URL, item: UUID, name: String, expected: Int64?) {
        let task = session.downloadTask(with: url)
        begin(task, item: item, name: name, expected: expected)
    }

    /// Carries on from where a failed download stopped, when the link it was
    /// fetched through still works.
    func resume(_ data: Data, item: UUID, name: String, expected: Int64?) {
        let task = session.downloadTask(withResumeData: data)
        begin(task, item: item, name: name, expected: expected)
    }

    private func begin(_ task: URLSessionDownloadTask, item: UUID, name: String, expected: Int64?) {
        task.taskDescription = Ticket(item: item, name: name).encoded
        if let expected, expected > 0 { task.countOfBytesClientExpectsToReceive = expected }
        lock.withLock {
            tasks[item] = task
            cancelledByUs.remove(item)
        }
        task.resume()
    }

    /// Stops a download. The system deletes what it had of it.
    func cancel(_ item: UUID) {
        let task: URLSessionDownloadTask? = lock.withLock {
            cancelledByUs.insert(item)
            return tasks[item]
        }
        if let task { task.cancel() } else { onEvent?(.cancelled(item)) }
    }

    /// What the system kept to resume a failed download, deleted: a task
    /// made from it and cancelled at once takes its partial file with it.
    func discard(_ resumeData: Data) {
        let task = session.downloadTask(withResumeData: resumeData)
        task.taskDescription = nil
        task.cancel()
    }

    // MARK: - URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let ticket = Ticket(downloadTask.taskDescription) else { return }
        // Five times a second is enough for a bar; a gigabyte arrives in
        // tens of thousands of chunks.
        let now = CFAbsoluteTimeGetCurrent()
        let due: Bool = lock.withLock {
            if let last = lastReport[ticket.item], now - last < 0.2 { return false }
            lastReport[ticket.item] = now
            return true
        }
        guard due else { return }
        let expected = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil
        onEvent?(.progress(ticket.item, received: totalBytesWritten, expected: expected))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didResumeAtOffset fileOffset: Int64, expectedTotalBytes: Int64) {
        guard let ticket = Ticket(downloadTask.taskDescription) else { return }
        onEvent?(.progress(ticket.item, received: fileOffset, expected: expectedTotalBytes > 0 ? expectedTotalBytes : nil))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let ticket = Ticket(downloadTask.taskDescription) else {
            try? FileManager.default.removeItem(at: location)
            return
        }
        lock.withLock { _ = tasks.removeValue(forKey: ticket.item) }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // An error page is not the file.
            try? FileManager.default.removeItem(at: location)
            let problem = status == 403
                ? "The download link expired. Try again."
                : "Storage did not send the file (\(status))."
            onEvent?(.failed(ticket.item, DownloadProblem(message: problem, canRetry: true), resumeData: nil))
            return
        }
        let target = destination(ticket.item, ticket.name)
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
            try fm.moveItem(at: location, to: target)
            log.info("downloaded \(ticket.item.uuidString, privacy: .public)")
            onEvent?(.finished(ticket.item, file: target))
        } catch {
            try? FileManager.default.removeItem(at: location)
            onEvent?(.failed(ticket.item, error, resumeData: nil))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let ticket = Ticket(task.taskDescription) else { return }
        let ours: Bool = lock.withLock {
            tasks.removeValue(forKey: ticket.item)
            lastReport.removeValue(forKey: ticket.item)
            return cancelledByUs.remove(ticket.item) != nil
        }
        guard let error else { return } // didFinishDownloadingTo said how it went
        if ours {
            onEvent?(.cancelled(ticket.item))
            return
        }
        let ns = error as NSError
        let resumeData = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        log.error("download failed: \(ns.domain, privacy: .public) \(ns.code)")
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled {
            // Not by us: the app was swiped away, and the system stopped it.
            let problem = DownloadProblem(message: "The download stopped when Onyx was closed.", canRetry: true)
            onEvent?(.failed(ticket.item, problem, resumeData: resumeData))
        } else {
            onEvent?(.failed(ticket.item, error, resumeData: resumeData))
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion: (() -> Void)? = lock.withLock {
            defer { backgroundCompletion = nil }
            return backgroundCompletion
        }
        DispatchQueue.main.async { completion?() }
    }
}

/// A failure said in words for the tray.
struct DownloadProblem: LocalizedError {
    let message: String
    var canRetry = true
    var errorDescription: String? { message }
}

/// Which item a task is fetching, and the name its file takes: kept on the
/// task itself (taskDescription), so it survives the app being ended while
/// the system carries on.
private struct Ticket: Codable {
    let item: UUID
    let name: String

    init(item: UUID, name: String) {
        self.item = item
        self.name = name
    }

    init?(_ description: String?) {
        guard let data = description?.data(using: .utf8),
              let ticket = try? JSONDecoder().decode(Ticket.self, from: data) else { return nil }
        self = ticket
    }

    var encoded: String? { (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) } }
}
