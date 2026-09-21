import FileProvider
import OnyxKit
import os

/// Enumeration against /api/files/delta.
///
/// The anchor the system hands back and forth is the server's `seq` cursor,
/// encoded as UTF-8 text. It is not a timestamp, and that matters: two writes
/// in the same millisecond share an `updated_at` but not a `seq`, so a
/// timestamp anchor can be placed between them and lose one silently.
final class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
    let container: NSFileProviderItemIdentifier
    let api: OnyxAPI
    let cursors: CursorStore
    let log = Logger(subsystem: OnyxIdentifiers.fileProvider, category: "enumerator")

    init(container: NSFileProviderItemIdentifier, api: OnyxAPI, cursors: CursorStore) {
        self.container = container
        self.api = api
        self.cursors = cursors
        super.init()
    }

    func invalidate() {}

    /// The full listing. Pulled from the local mirror after a sync rather than
    /// straight from the network, so the mirror stays the single answer to
    /// "what is in this drive".
    func enumerateItems(for observer: NSFileProviderEnumerationObserver,
                        startingAt page: NSFileProviderPage) {
        Task {
            do {
                try await syncToPresent()
                observer.didEnumerate(ItemStore.shared.all())
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(mapped(error))
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver,
                          from anchor: NSFileProviderSyncAnchor) {
        Task {
            do {
                let from = Int64(String(decoding: anchor.rawValue, as: UTF8.self)) ?? 0
                let sync = DeltaSync(api: api, cursor: from)
                var deletions: [NSFileProviderItemIdentifier] = []
                var updates: [NSFileProviderItem] = []

                try await sync.drain { page in
                    let filespaceId = await self.defaultFilespaceId()
                    ItemStore.shared.apply(changed: page.changed, deleted: page.deleted,
                                           filespaceId: filespaceId)
                    for file in page.changed {
                        // A soft delete arrives as a change with deletedAt
                        // set, not as a tombstone. Reported as an update it
                        // would leave deleted files in Finder forever.
                        if file.deletedAt != nil { deletions.append(.init(file.id)) }
                        else if let item = ItemStore.shared.item(id: file.id) { updates.append(item) }
                    }
                    deletions.append(contentsOf: page.deleted.map { .init($0.id) })
                }

                let settled = await sync.cursor
                cursors.save(settled)
                if !updates.isEmpty { observer.didUpdate(updates) }
                if !deletions.isEmpty { observer.didDeleteItems(withIdentifiers: deletions) }
                observer.finishEnumeratingChanges(upTo: anchorFor(settled), moreComing: false)
            } catch {
                observer.finishEnumeratingWithError(mapped(error))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(anchorFor(cursors.load()))
    }

    // MARK: - Helpers

    private func anchorFor(_ cursor: Int64) -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data(String(cursor).utf8))
    }

    private func syncToPresent() async throws {
        let sync = DeltaSync(api: api, cursor: cursors.load())
        let filespaceId = await defaultFilespaceId()
        try await sync.drain { page in
            ItemStore.shared.apply(changed: page.changed, deleted: page.deleted, filespaceId: filespaceId)
        }
        // Saved only after every page applied cleanly. Committing the cursor
        // first would skip an unapplied page permanently.
        cursors.save(await sync.cursor)
    }

    /// /api/files/delta does not say which filespace a row belongs to, so for
    /// now every item is attributed to the first one. That is correct for a
    /// single-filespace deployment and wrong for several — when the server
    /// starts returning a filespace per row, this is the only place that
    /// changes.
    private func defaultFilespaceId() async -> String {
        guard let spaces = try? await api.filespaces(), let first = spaces.first else { return "" }
        return first.id
    }

    private func mapped(_ error: Error) -> Error {
        if case OnyxError.notAuthenticated = error {
            // Finder shows a "Sign in" affordance for this specific error.
            // Anything else is presented as a generic failure.
            return NSFileProviderError(.notAuthenticated)
        }
        return error
    }
}
