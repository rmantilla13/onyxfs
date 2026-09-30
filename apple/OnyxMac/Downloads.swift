import Foundation
import AppKit
import WebKit
import OnyxKit

/// The window's downloads — what the web's Download buttons save into
/// Downloads — from the click until they are cleared, for the Activity bar to
/// show. Without it a download ran unseen: nothing in the window said one had
/// started, or finished, so a second click saved the file a second time.
///
/// It is each download's delegate: WebController hands a download over as it
/// begins (`adopt`), and everything after — where it goes, how far it has
/// got, how it ended — is kept here. What they receive is counted into the
/// transfer log, as the bar's Download.
@MainActor
final class WebDownloads: NSObject, ObservableObject {
    struct Item: Identifiable, Equatable {
        enum State: Equatable {
            /// Asked for; the file has not started to arrive.
            case starting
            case running
            case finished
            case failed(String)
        }

        let id = UUID()
        /// What was clicked: to know a second click, and to try again.
        let source: URL?
        var name: String?
        var destination: URL?
        var received: Int64 = 0
        /// Nil while the server has not said.
        var expected: Int64?
        /// Bytes a second, smoothed; 0 until it has been measured.
        var rate: Double = 0
        var state: State = .starting

        var isActive: Bool { state == .starting || state == .running }

        var fraction: Double? {
            guard let expected, expected > 0 else { return nil }
            return min(1, Double(received) / Double(expected))
        }

        /// A link can be asked for again; a blob the page made is gone.
        var canRetry: Bool { ["http", "https"].contains(source?.scheme?.lowercased() ?? "") }
    }

    /// Newest first.
    @Published private(set) var items: [Item] = []
    /// The download a second click was for, for a moment.
    @Published private(set) var flashed: UUID?

    /// The window's web view, to ask again from.
    weak var webView: WKWebView?
    /// Where what arrives is counted, as the bar's Download.
    var transfers: TransferLog?
    /// Where files are saved: Downloads, as Safari saves them.
    var folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        ?? FileManager.default.temporaryDirectory

    /// Downloads under way keep Onyx out of App Nap (WorkActivity): one
    /// left running as the window closes goes on at full speed.
    private var live: [ObjectIdentifier: (id: UUID, download: WKDownload)] = [:] {
        didSet { WorkActivity.app.set(.downloads, !live.isEmpty) }
    }
    private var sampler: Task<Void, Never>?
    private var lastSample = Date()

    /// Past this many, the oldest that have ended are let go.
    static let kept = 10

    /// The one the bar shows: the newest under way, else the newest.
    var shown: Item? { items.first(where: \.isActive) ?? items.first }

    // MARK: - From the web view

    /// Whether `url` is downloading already. If it is, it becomes the one the
    /// bar shows, and says so, instead of a second copy starting.
    func showIfRunning(_ url: URL) -> Bool {
        guard let i = items.firstIndex(where: { $0.isActive && $0.source == url }) else { return false }
        let item = items.remove(at: i)
        items.insert(item, at: 0)
        flash(item.id)
        return true
    }

    /// A download the web view has begun: from here on it is this object's.
    func adopt(_ download: WKDownload) {
        download.delegate = self
        let item = Item(source: download.originalRequest?.url)
        live[ObjectIdentifier(download)] = (item.id, download)
        items.insert(item, at: 0)
        while items.count > Self.kept, let i = items.lastIndex(where: { !$0.isActive }) { items.remove(at: i) }
        startSampling()
    }

    // MARK: - From the bar

    func cancel(_ id: UUID) {
        let partial = items.first { $0.id == id }?.destination
        if let key = live.first(where: { $0.value.id == id })?.key, let download = live.removeValue(forKey: key)?.download {
            download.cancel { _ in Self.discard(partial) }
        }
        items.removeAll { $0.id == id }
    }

    /// Quitting: what has not arrived in full is not the file, so it goes
    /// rather than be left in Downloads looking like one.
    func discardUnfinished() {
        for entry in live.values { entry.download.cancel(nil) }
        live = [:]
        for item in items where item.isActive { Self.discard(item.destination) }
    }

    func retry(_ id: UUID) {
        guard let item = items.first(where: { $0.id == id }), !item.isActive, item.canRetry,
              let source = item.source, let webView else { return }
        items.removeAll { $0.id == id }
        Task { adopt(await webView.startDownload(using: URLRequest(url: source))) }
    }

    func dismiss(_ id: UUID) {
        items.removeAll { $0.id == id && !$0.isActive }
    }

    func clearEnded() {
        items.removeAll { !$0.isActive }
    }

    func showInFinder(_ id: UUID) {
        guard let file = items.first(where: { $0.id == id })?.destination else { return }
        NSWorkspace.shared.activateFileViewerSelecting([file])
    }

    func open(_ id: UUID) {
        guard let item = items.first(where: { $0.id == id }), item.state == .finished, let file = item.destination else { return }
        NSWorkspace.shared.open(file)
    }

    // MARK: - Progress

    /// How far each has got, once a second while any runs; what arrived
    /// since the last look goes into the transfer log.
    private func startSampling() {
        guard sampler == nil else { return }
        lastSample = Date()
        sampler = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self else { return }
                guard !self.live.isEmpty else { break }
                self.measure()
            }
            self?.sampler = nil
        }
    }

    private func measure() {
        let now = Date()
        let elapsed = now.timeIntervalSince(lastSample)
        lastSample = now
        var next = items
        var moved: Int64 = 0
        for (id, download) in live.values {
            guard let i = next.firstIndex(where: { $0.id == id }) else { continue }
            let progress = download.progress
            let done = progress.completedUnitCount
            let delta = max(0, done - next[i].received)
            moved += delta
            next[i].received = max(next[i].received, done)
            if progress.totalUnitCount > 0 { next[i].expected = progress.totalUnitCount }
            if elapsed > 0.2 {
                let rate = Double(delta) / elapsed
                next[i].rate = next[i].rate == 0 ? rate : next[i].rate * 0.7 + rate * 0.3
            }
        }
        if next != items { items = next }
        if moved > 0 { transfers?.add(.download, moved) }
    }

    private func flash(_ id: UUID) {
        flashed = id
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            if self?.flashed == id { self?.flashed = nil }
        }
    }

    private func update(_ download: WKDownload, _ change: (inout Item) -> Void) {
        guard let id = live[ObjectIdentifier(download)]?.id,
              let i = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[i])
    }

    /// What a download that did not finish wrote. WebKit leaves it, the
    /// size it got to, under the file's own name — which would pass for the
    /// file, cut short.
    nonisolated static func discard(_ partial: URL?) {
        if let partial { try? FileManager.default.removeItem(at: partial) }
    }

    /// `name` in `folder`, else "name 2", "name 3"… — never over a file that
    /// is there, or one a download under way has chosen.
    nonisolated static func destination(in folder: URL, for suggested: String, taken: (URL) -> Bool) -> URL {
        let leaf = (suggested as NSString).lastPathComponent
        let name = leaf.isEmpty || leaf == "/" ? "Download" : leaf
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var n = 2
        while taken(candidate) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        return candidate
    }
}

// MARK: - WKDownloadDelegate

extension WebDownloads: WKDownloadDelegate {
    /// Into Downloads, as Safari would, never over an existing file.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        // Stopped before it got this far.
        guard live[ObjectIdentifier(download)] != nil else { return nil }
        let chosen = Set(items.filter(\.isActive).compactMap(\.destination))
        let destination = Self.destination(in: folder, for: suggestedFilename) { url in
            chosen.contains(url) || FileManager.default.fileExists(atPath: url.path)
        }
        update(download) { item in
            item.name = destination.lastPathComponent
            item.destination = destination
            if response.expectedContentLength > 0 { item.expected = response.expectedContentLength }
            item.state = .running
        }
        return destination
    }

    func downloadDidFinish(_ download: WKDownload) {
        measure()
        let key = ObjectIdentifier(download)
        update(download) { item in
            item.received = max(item.received, download.progress.completedUnitCount)
            item.expected = item.received
            item.state = .finished
        }
        guard let id = live.removeValue(forKey: key)?.id,
              let file = items.first(where: { $0.id == id })?.destination else { return }
        // Bounces the Downloads stack in the Dock, as a finished download in
        // Safari does.
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"),
                                                     object: file.resolvingSymlinksInPath().path)
    }

    /// Ended short: said so, and what arrived goes. Trying again asks for
    /// the file afresh, into the same name.
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        measure()
        let ns = error as NSError
        let stopped = ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
        var partial: URL?
        update(download) { item in
            partial = item.destination
            item.destination = nil
            item.state = .failed(stopped ? "Stopped" : error.localizedDescription)
        }
        live[ObjectIdentifier(download)] = nil
        Self.discard(partial)
    }
}

#if DEBUG
extension WebDownloads {
    /// Pretend downloads for the Activity bar (`--demo-activity`, debug
    /// builds only): one arriving, one done, one that did not finish.
    func demo() {
        items = [
            Item(source: nil, name: "Ashley Marie-remaster.mp4", destination: folder.appendingPathComponent("Ashley Marie-remaster.mp4"),
                 received: 97_300_000, expected: 231_658_984, rate: 5_900_000, state: .running),
            Item(source: nil, name: "Contact sheet.pdf", destination: folder.appendingPathComponent("Contact sheet.pdf"),
                 received: 4_200_000, expected: 4_200_000, state: .finished),
            Item(source: URL(string: "https://example.com/x"), name: "B-roll 04.mov", received: 12_000_000,
                 expected: 880_000_000, state: .failed("The network connection was lost.")),
        ]
    }
}
#endif
