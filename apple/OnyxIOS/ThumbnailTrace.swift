import Foundation
import os

/// How the pictures are arriving, as lines of the unified log, for timing
/// a folder: launched with `--trace-thumbnails`, every step of every
/// picture is logged with a monotonic time in milliseconds —
///
///     xcrun simctl spawn booted log stream --level info \
///       --predicate 'subsystem == "io.onyxfs.app" AND category == "thumbs"'
///
/// Without it, nothing is logged and nothing is measured.
enum ThumbnailTrace {
    static let enabled = ProcessInfo.processInfo.arguments.contains("--trace-thumbnails")
    private static let log = Logger(subsystem: "io.onyxfs.app", category: "thumbs")

    static var now: Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

    static func ms(since start: Double) -> String { String(format: "%.1f", now - start) }

    static func event(_ name: String, _ fields: @autoclosure () -> String = "") {
        guard enabled else { return }
        let line = "thumbs \(name) t=\(String(format: "%.1f", now)) \(fields())"
        log.notice("\(line, privacy: .public)")
    }

    /// A delegate that logs a download's timings — how long it waited for a
    /// connection, its first byte, whether its connection was new — or nil.
    static func metrics(for url: URL) -> URLSessionTaskDelegate? {
        enabled ? Metrics(name: url.lastPathComponent) : nil
    }

    private final class Metrics: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let name: String
        init(name: String) { self.name = name }

        func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
            guard let t = metrics.transactionMetrics.last else { return }
            func ms(_ a: Date?, _ b: Date?) -> String {
                guard let a, let b else { return "-" }
                return String(format: "%.1f", b.timeIntervalSince(a) * 1000)
            }
            ThumbnailTrace.event("metrics", "file=\(name) proto=\(t.networkProtocolName ?? "-") reused=\(t.isReusedConnection) "
                + "wait=\(ms(metrics.taskInterval.start, t.requestStartDate)) ttfb=\(ms(t.requestStartDate, t.responseStartDate)) "
                + "total=\(String(format: "%.1f", metrics.taskInterval.duration * 1000)) bytes=\(t.countOfResponseBodyBytesReceived)")
        }
    }
}
