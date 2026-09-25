import FileProvider
import OnyxKit
import os

/// Lists one folder of the location, from the replica.
///
/// Listing a folder does not change the replica — only the working set's
/// change enumeration does (SyncEngine explains why) — except on the very
/// first look at a location nothing has been read for yet, when there is no
/// anchor to fall out of step with.
final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    let path: String
    let engine: SyncEngine
    let rootName: String

    init(path: String, engine: SyncEngine, rootName: String) {
        self.path = path
        self.engine = engine
        self.rootName = rootName
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            if await !engine.hasSynced { _ = try? await engine.catchUp() }
            let replica = await engine.replica
            let (folders, files) = replica.children(of: path)
            var items: [NSFileProviderItem] = folders.map(OnyxItem.folder)
            items += files.map(OnyxItem.file)
            observer.didEnumerate(items)
            observer.finishEnumerating(upTo: nil)
        }
    }

    // Changes reach folders through the working set; a folder has none of its
    // own to report.
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
/// The anchor the system hands back and forth is the server's `seq` cursor
/// with the access fingerprint beside it. Not a timestamp, which matters: two
/// writes in the same millisecond share an `updated_at` but not a `seq`, so a
/// timestamp anchor can be placed between them and lose one silently.
final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    let engine: SyncEngine
    let rootName: String
    let log = Logger(subsystem: OnyxIdentifiers.fileProvider, category: "enumerator")
    static let pageSize = 500

    init(engine: SyncEngine, rootName: String) {
        self.engine = engine
        self.rootName = rootName
    }

    func invalidate() {}

    /// Everything, in pages. The system calls this for a first read and after
    /// an expired anchor; the replica is brought to the present first.
    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let offset = Self.offset(of: page)
                if offset == 0 {
                    do { _ = try await engine.catchUp() }
                    catch is SyncEngine.ScopeChanged { _ = try await engine.catchUp() }
                }
                let replica = await engine.replica
                let all: [NSFileProviderItem] =
                    replica.folders.sorted().map(OnyxItem.folder) +
                    replica.files.values.sorted { $0.id < $1.id }.map(OnyxItem.file)
                let end = min(offset + Self.pageSize, all.count)
                if offset < end { observer.didEnumerate(Array(all[offset..<end])) }
                observer.finishEnumerating(upTo: end < all.count ? Self.page(end) : nil)
            } catch {
                log.error("enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(mapped(error))
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        Task {
            // An anchor from some other state of the replica — before a scope
            // change, or from a pass that did not finish reporting — cannot be
            // brought forward honestly. Expiring it makes the system re-read.
            guard await engine.matches(anchor) else {
                observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
                return
            }
            do {
                let diff = try await engine.catchUp()
                let replica = await engine.replica
                let updated = diff.updated.compactMap {
                    OnyxItem.item(for: NSFileProviderItemIdentifier($0), in: replica, rootName: rootName)
                }
                if !updated.isEmpty { observer.didUpdate(updated) }
                if !diff.deleted.isEmpty { observer.didDeleteItems(withIdentifiers: diff.deleted.map { .init($0) }) }
                observer.finishEnumeratingChanges(upTo: await engine.anchor(), moreComing: false)
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

    private static func offset(of page: NSFileProviderPage) -> Int {
        Int(String(decoding: page.rawValue, as: UTF8.self)) ?? 0
    }

    private static func page(_ offset: Int) -> NSFileProviderPage {
        NSFileProviderPage(Data(String(offset).utf8))
    }
}

/// Finder shows a "Sign in" affordance for `.notAuthenticated` specifically;
/// anything else reads as a generic failure. A drive you lost access to is
/// not a sign-in problem, so that one is reported as unavailable.
func mapped(_ error: Error) -> Error {
    switch error {
    case OnyxError.notAuthenticated:
        return NSFileProviderError(.notAuthenticated)
    case OnyxError.http(let status, _) where status == 403 || status == 404:
        return NSFileProviderError(.noSuchItem)
    case let e as URLError where e.code == .notConnectedToInternet || e.code == .networkConnectionLost:
        return NSFileProviderError(.serverUnreachable)
    default:
        return error
    }
}
