import FileProvider
import OnyxKit
import os

/// Lists one folder of the location, from the replica, a page at a time.
///
/// Only reads. Changes reach every folder through the working set
/// (SyncEngine says why); a folder has none of its own to report.
final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    let path: String
    let engine: SyncEngine

    init(path: String, engine: SyncEngine) {
        self.path = path
        self.engine = engine
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            let replica = await engine.replica
            let (folders, files) = replica.children(of: path)
            let all: [NSFileProviderItem] = folders.map(OnyxItem.folder) + files.map(OnyxItem.file)
            Paging.send(all, from: page, size: observer.suggestedPageSize ?? 200, to: observer)
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        Task { observer.finishEnumeratingChanges(upTo: await engine.anchor(), moreComing: false) }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task { completionHandler(await engine.anchor()) }
    }
}

/// The working set: everything in the location, and the only place changes
/// are reported from.
///
/// The system reads the anchor, lists the items, then asks for changes since
/// that anchor. Listing therefore never moves the replica — if it did, the
/// anchor read a moment before would no longer match, and every first sync
/// would expire it and pay for a second full scan. So a new location lists
/// empty, and its contents arrive as the first changes.
///
/// The anchor is the server's `seq` cursor with the access fingerprint
/// beside it — never a timestamp: two writes in the same millisecond share
/// an `updated_at` but not a `seq`.
final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    let engine: SyncEngine
    let rootName: String
    let log = Logger(subsystem: OnyxIdentifiers.fileProvider, category: "enumerator")

    init(engine: SyncEngine, rootName: String) {
        self.engine = engine
        self.rootName = rootName
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            let replica = await engine.replica
            let all: [NSFileProviderItem] =
                replica.folders.sorted().map(OnyxItem.folder) +
                replica.files.values.sorted { $0.id < $1.id }.map(OnyxItem.file)
            Paging.send(all, from: page, size: observer.suggestedPageSize ?? 200, to: observer)
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        Task {
            // An anchor from some other state of the replica — before a scope
            // change, or from before a crash — cannot be brought forward
            // honestly. Expiring it makes the system re-read.
            guard await engine.matches(anchor) else {
                observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
                return
            }
            do {
                let step = try await engine.step()
                let replica = await engine.replica
                let updated = step.diff.updated.compactMap {
                    OnyxItem.item(for: NSFileProviderItemIdentifier($0), in: replica, rootName: rootName)
                }
                let batch = max(1, observer.suggestedBatchSize ?? 200)
                for chunk in updated.chunked(batch) { observer.didUpdate(chunk) }
                for chunk in step.diff.deleted.map({ NSFileProviderItemIdentifier($0) }).chunked(batch) {
                    observer.didDeleteItems(withIdentifiers: chunk)
                }
                observer.finishEnumeratingChanges(upTo: step.anchor, moreComing: step.more)
            } catch is SyncEngine.ScopeChanged {
                observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            } catch {
                log.error("changes failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(mapped(error))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task { completionHandler(await engine.anchor()) }
    }
}

/// Items in pages of the size the system suggests; the page token is an offset.
enum Paging {
    static func send(_ all: [NSFileProviderItem], from page: NSFileProviderPage, size suggested: Int,
                     to observer: NSFileProviderEnumerationObserver) {
        let size = max(1, suggested)
        let offset = Int(String(decoding: page.rawValue, as: UTF8.self)) ?? 0
        let end = min(offset + size, all.count)
        if offset < end { observer.didEnumerate(Array(all[offset..<end])) }
        observer.finishEnumerating(upTo: end < all.count ? NSFileProviderPage(Data(String(end).utf8)) : nil)
    }
}

extension Array {
    func chunked(_ size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

/// Errors in the only terms the system accepts: its own and Cocoa's.
///
/// Finder shows a "Sign in" affordance for `.notAuthenticated` specifically.
/// Anything that may pass on its own — offline, a timeout, a server error —
/// is `.serverUnreachable`, which the system retries. Only the server saying
/// a file is not there (or not yours) is `.noSuchItem`, because the system
/// answers that by removing its copy.
func mapped(_ error: Error) -> Error {
    switch error {
    case OnyxError.notAuthenticated:
        return NSFileProviderError(.notAuthenticated)
    case OnyxError.http(let status, _) where status == 404:
        return NSFileProviderError(.noSuchItem)
    case let e as URLError where e.code == .cancelled:
        return CocoaError(.userCancelled)
    case is URLError, OnyxError.http, OnyxError.decoding, OnyxError.storageUnavailable, is StorageError:
        return NSFileProviderError(.serverUnreachable)
    case let e as NSError where e.domain == NSFileProviderErrorDomain || e.domain == NSCocoaErrorDomain:
        return e
    default:
        return NSFileProviderError(.serverUnreachable)
    }
}

/// The object store refused a download. Never "no such item": a storage 403
/// or 404 is an expired link or a hiccup, and the system would delete the
/// user's copy if told the item is gone.
struct StorageError: Error {
    let status: Int
}
