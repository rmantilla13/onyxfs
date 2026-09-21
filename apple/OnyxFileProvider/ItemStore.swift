import Foundation
import FileProvider
import OnyxKit

/// The local mirror the extension answers `item(for:)` from.
///
/// The system asks for items constantly — every Finder redraw, every stat —
/// and answering each from the network is the per-item round trip a File
/// Provider exists to eliminate. A JSON file in the shared app group is
/// enough at this size and has no dependencies; if the library outgrows it,
/// SQLite goes here and nothing above this file changes.
final class ItemStore {
    static let shared = ItemStore()

    private let queue = DispatchQueue(label: "io.onyxfs.itemstore")
    private var items: [String: OnyxItem] = [:]
    private let url: URL?

    init() {
        url = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: OnyxIdentifiers.appGroup)?
            .appendingPathComponent("items.json")
        load()
    }

    func item(id: String) -> OnyxItem? { queue.sync { items[id] } }

    func all() -> [OnyxItem] { queue.sync { Array(items.values) } }

    /// Apply one delta page. Tombstones remove; everything else upserts.
    func apply(changed: [FileItem], deleted: [Tombstone], filespaceId: String) {
        queue.sync {
            for file in changed {
                // A soft-deleted row arrives as a normal change with
                // deletedAt set, not as a tombstone. Treating it as present
                // would leave deleted files visible in Finder indefinitely.
                if file.deletedAt != nil { items.removeValue(forKey: file.id) }
                else { items[file.id] = OnyxItem(file: file, filespaceId: filespaceId) }
            }
            for gone in deleted { items.removeValue(forKey: gone.id) }
            persist()
        }
    }

    func reset() { queue.sync { items.removeAll(); persist() } }

    // MARK: - Persistence

    private struct Row: Codable { let file: FileItem; let filespaceId: String }

    private func persist() {
        guard let url else { return }
        let rows = items.values.map { Row(file: $0.file, filespaceId: $0.filespaceId) }
        // Atomic: a half-written mirror read at next launch would present a
        // truncated library as if it were the whole thing.
        try? JSONEncoder().encode(rows).write(to: url, options: .atomic)
    }

    private func load() {
        guard let url, let data = try? Data(contentsOf: url),
              let rows = try? JSONDecoder().decode([Row].self, from: data) else { return }
        items = Dictionary(uniqueKeysWithValues: rows.map {
            ($0.file.id, OnyxItem(file: $0.file, filespaceId: $0.filespaceId))
        })
    }
}
