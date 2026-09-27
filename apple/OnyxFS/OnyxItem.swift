import FSKit

/// A file or folder the kernel holds: FSKit's side of a vnode. It carries
/// only the engine's id for it; everything else is asked of the engine.
@available(macOS 27.0, *)
final class OnyxItem: FSItem {
    let id: UInt64

    init(id: UInt64) {
        self.id = id
        super.init()
    }
}

/// One FSItem per id while the kernel holds it: a lookup of a name the
/// kernel already has must return the same object, and a reclaim must not
/// race a lookup that is handing it out again (FSItem.tryReclaim).
@available(macOS 27.0, *)
final class ItemTable: @unchecked Sendable {
    private var items: [UInt64: OnyxItem] = [:]
    private let lock = NSLock()

    func item(for id: UInt64) -> OnyxItem {
        lock.lock(); defer { lock.unlock() }
        if let known = items[id] { return known }
        let item = OnyxItem(id: id)
        items[id] = item
        return item
    }

    func existing(_ id: UInt64) -> OnyxItem? {
        lock.lock(); defer { lock.unlock() }
        return items[id]
    }

    var all: [OnyxItem] {
        lock.lock(); defer { lock.unlock() }
        return Array(items.values)
    }

    /// Whether the item was reclaimed (and so dropped here).
    func reclaim(_ item: OnyxItem) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return item.tryReclaim { self.items[item.id] = nil }
    }
}
