import AppKit
import OnyxKit

/// Unzipping in a drive (OnyxKit's Unzipper), one zip at a time, so two big
/// ones never need twice the room on this Mac: asked for in Finder (Unzip
/// Here), or done on its own once Archive Utility could not.
///
/// Archive Utility cannot unzip a zip from the internet in a drive (Unzipper
/// says why): it unpacks it beside the zip, throws all of it away, and says
/// Error 1. The disk's extension sees that happen and says so (POST
/// /fs/v1/unzip). Onyx then finds the zip — the one whose top is what was
/// unpacked — waits for Archive Utility to quit, which it does once its
/// error is closed, and unzips it. Never sooner: Archive Utility then
/// removes the placeholder it made for the result, by its name, which is
/// the name the result lands under. A placeholder still there once it has
/// quit (it was stopped) is removed if it is still empty.
@MainActor
final class UnzipService {
    private var last: Task<Void, Never>?
    /// Zips waiting or under way, by path: asked for twice, unzipped once.
    private var queued: Set<String> = []

    nonisolated static let archiveUtility = "com.apple.archiveutility"
    /// How long Archive Utility's error may stay open before the zip is
    /// unzipped anyway, beside the placeholder rather than in its place.
    static let archiveUtilityWait: Duration = .seconds(600)

    /// Unzip Here: each zip beside itself, after any asked for before.
    func unzip(_ zips: [URL]) {
        for zip in zips { enqueue(zip, automatic: false) }
    }

    /// Archive Utility could not unzip a zip from the internet in `folder`.
    func archiveUtilityFailed(in folder: URL, _ failure: FSUnzipFailure) {
        Task {
            var listed: [(zip: URL, top: [String])] = []
            for name in failure.zips {
                let zip = folder.appendingPathComponent(name, isDirectory: false)
                if let top = try? await Unzipper.topLevel(of: zip) { listed.append((zip, top)) }
            }
            guard let zip = Unzipper.unpackedFrom(listed, unpacked: failure.unpacked, count: failure.unpackedCount) else {
                appLog.error("finder: Archive Utility could not unzip in a drive, and which zip is unclear (\(failure.zips.count) from the internet)")
                SystemNotices.shared.unzipUnclear(folder: folder.lastPathComponent)
                return
            }
            guard !queued.contains(zip.path) else { return }
            appLog.info("finder: Archive Utility could not unzip in a drive; Onyx will")
            if Self.isArchiveUtilityRunning { SystemNotices.shared.unzipWaiting(zip.lastPathComponent) }
            if await Self.archiveUtilityQuits(within: Self.archiveUtilityWait) {
                for name in failure.placeholders {
                    await Unzipper.removePlaceholder(folder.appendingPathComponent(name))
                }
            }
            enqueue(zip, automatic: true)
        }
    }

    private func enqueue(_ zip: URL, automatic: Bool) {
        guard queued.insert(zip.path).inserted else { return }
        let before = last
        last = Task {
            await before?.value
            defer { queued.remove(zip.path) }
            do {
                let landed = try await Unzipper.unzip(zip)
                appLog.info("finder: unzipped into \(landed.lastPathComponent, privacy: .private)")
                if automatic { SystemNotices.shared.unzipped(zip.lastPathComponent, into: landed.lastPathComponent) }
            } catch {
                let reason = (error as? Unzipper.Failure)?.reason ?? error.localizedDescription
                appLog.error("finder: unzip failed: \(reason, privacy: .public)")
                SystemNotices.shared.unzipFailed(zip.lastPathComponent, reason: reason)
            }
        }
    }

    static var isArchiveUtilityRunning: Bool {
        NSRunningApplication.runningApplications(withBundleIdentifier: archiveUtility).contains { !$0.isTerminated }
    }

    /// Until Archive Utility has quit — at once when it is not running — or
    /// `limit` has passed, heard from NSWorkspace: nothing runs meanwhile.
    /// Answers whether it quit.
    private static func archiveUtilityQuits(within limit: Duration) async -> Bool {
        guard isArchiveUtilityRunning else { return true }
        let watch = QuitWatch()
        return await withCheckedContinuation { done in
            watch.start(limit: limit) { done.resume(returning: $0) }
        }
    }
}

/// One wait for Archive Utility to quit. It holds itself (the observer and
/// the time limit keep it) until it has answered, once.
@MainActor
private final class QuitWatch {
    private var observer: NSObjectProtocol?
    private var limit: Task<Void, Never>?
    private var done: ((Bool) -> Void)?

    func start(limit: Duration, _ done: @escaping (Bool) -> Void) {
        self.done = done
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                if !UnzipService.isArchiveUtilityRunning { self.finish(true) }
            }
        }
        self.limit = Task {
            try? await Task.sleep(for: limit)
            self.finish(!UnzipService.isArchiveUtilityRunning)
        }
        // It quit between the look and the watch.
        if !UnzipService.isArchiveUtilityRunning { finish(true) }
    }

    private func finish(_ quit: Bool) {
        guard let done else { return }
        self.done = nil
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        observer = nil
        limit?.cancel()
        done(quit)
    }
}
