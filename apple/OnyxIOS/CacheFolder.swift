import Foundation
import OnyxKit
import UIKit

/// A folder in Caches held under a cap (CacheTrim): past it, what was used
/// least recently goes, off the main thread.
///
/// Weighing it means listing it — tens of thousands of thumbnails — so it
/// is listed only when it may be past its cap (CacheTally): the first time
/// it is asked, then once enough has been written since it was counted.
/// Asking costs a lock and a sum, and nothing more while the answer is no,
/// so it is asked freely: at launch, on the way to the background, and
/// after a preview downloads. Nothing runs between.
final class CacheFolder: @unchecked Sendable {
    let url: URL
    let cap: CacheTrim
    private let lock = NSLock()
    private var tally = CacheTally()
    /// What is in use now, by name, and how many times over: never trimmed.
    private var held: [String: Int] = [:]

    init(_ name: String, cap: CacheTrim) {
        url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(name, isDirectory: true)
        self.cap = cap
    }

    /// A file of `bytes` written into it, weighed as the disk allocates it
    /// and a count weighs it: in 4 KB blocks, so a 3 KB thumbnail takes 4.
    func wrote(_ bytes: Int64) {
        let allocated = (max(0, bytes) + 4095) / 4096 * 4096
        lock.withLock { tally.wrote(allocated) }
    }

    /// `name` — a file in it, or a folder — is in use until released: a
    /// trim leaves it however long ago it was last used.
    func hold(_ name: String) {
        lock.withLock { held[name, default: 0] += 1 }
    }

    func release(_ name: String) {
        lock.withLock {
            guard let count = held[name] else { return }
            held[name] = count > 1 ? count - 1 : nil
        }
    }

    /// Everything in it deleted: Clear Pictures, signing out.
    func emptied() {
        lock.withLock { tally.emptied() }
    }

    /// Trimmed back under its cap, if it may be past it. The work, or nil
    /// when there is none.
    @discardableResult
    func trim(priority: TaskPriority = .utility) -> Task<Void, Never>? {
        guard lock.withLock({ tally.beginCount(over: cap.limit) }) else { return nil }
        return Task.detached(priority: priority) { [self] in
            let entries = Self.entries(in: url)
            let plan = cap.plan(entries ?? [], held: lock.withLock { Set(held.keys) })
            for name in plan.delete {
                try? FileManager.default.removeItem(at: url.appendingPathComponent(name))
            }
            lock.withLock { tally.endCount(left: entries == nil ? nil : plan.left) }
        }
    }

    /// Each thing in the folder as a trim weighs it — a file, or a folder and
    /// everything in it — by name: its size on disk, and when any of it was
    /// last used. Nil when the folder is there and cannot be read.
    private static func entries(in folder: URL) -> [CacheTrim.Entry<String>]? {
        let keys: [URLResourceKey] = [.isDirectoryKey, .contentModificationDateKey, .totalFileAllocatedSizeKey]
        guard FileManager.default.fileExists(atPath: folder.path) else { return [] }
        guard let children = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)
        else { return nil }
        func weigh(_ url: URL) -> (bytes: Int64, used: Date, folder: Bool)? {
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (Int64(values.totalFileAllocatedSize ?? 0), values.contentModificationDate ?? .distantPast,
                    values.isDirectory == true)
        }
        return children.compactMap { child in
            guard var whole = weigh(child) else { return nil }
            if whole.folder, let inside = FileManager.default.enumerator(at: child, includingPropertiesForKeys: keys) {
                for case let url as URL in inside {
                    guard let part = weigh(url), !part.folder else { continue }
                    whole.bytes += part.bytes
                    whole.used = max(whole.used, part.used)
                }
            }
            return CacheTrim.Entry(id: child.lastPathComponent, bytes: whole.bytes, lastUse: whole.used)
        }
    }
}

extension CacheFolder {
    /// The thumbnails and posters (ThumbnailStore) and the originals
    /// downloaded to preview (PreviewFiles), each trimmed if it may be past
    /// its cap.
    @discardableResult
    static func trimAll(priority: TaskPriority = .utility) -> [Task<Void, Never>] {
        [ThumbnailStore.kept, PreviewFiles.kept].compactMap { $0.trim(priority: priority) }
    }

    /// The app is going to the background: the same, with a little time
    /// asked of the system to finish in, so a trim is not suspended half
    /// done. Nothing is asked for when there is nothing to trim.
    @MainActor
    static func trimBeforeSuspending() {
        let work = trimAll()
        guard !work.isEmpty else { return }
        let grace = Grace()
        grace.id = UIApplication.shared.beginBackgroundTask(withName: "Trim caches") { grace.end() }
        Task { @MainActor in
            for task in work { await task.value }
            grace.end()
        }
    }

    /// The time asked for, given back once: when the trim is done, or when
    /// the system wants it back first.
    @MainActor
    private final class Grace {
        var id = UIBackgroundTaskIdentifier.invalid

        func end() {
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }
}
