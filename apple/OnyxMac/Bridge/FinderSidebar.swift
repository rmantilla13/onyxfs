import Foundation
import CoreServices

/// Onyx's disks in Finder's sidebar, under Locations.
///
/// Finder lists a volume there by itself when it arrives as a disk or a
/// server does. A file system extension's volume never has been: Finder's
/// record of every volume it has shown held external disks, installers and
/// Frame.io Drive's shares, and not one Onyx disk. So each disk is added as
/// it mounts — as Frame.io Drive adds its own — and taken away when it is
/// turned off in Onyx or ejected. One that is only unmounted (Onyx quit, a
/// sign-out) keeps its place: Finder shows it again when it is back.
///
/// Finder keeps the list with LSSharedFileList, deprecated since macOS 10.11
/// and still the way to change it. The work is off the main thread: the list
/// resolves each entry to see whether it is this disk's.
enum FinderSidebar {
    static func add(_ volume: URL) {
        Task.detached(priority: .utility) { add(volume, to: LocationsList.self) }
    }

    static func remove(_ volume: URL) {
        Task.detached(priority: .utility) { remove(volume, from: LocationsList.self) }
    }

    // Through `SidebarEditing`, generically, so the deprecated calls compile
    // without a warning each.
    private static func add<List: SidebarEditing>(_ volume: URL, to list: List.Type) { list.add(volume) }
    private static func remove<List: SidebarEditing>(_ volume: URL, from list: List.Type) { list.remove(volume) }
}

protocol SidebarEditing {
    static func add(_ volume: URL)
    static func remove(_ volume: URL)
}

/// Finder's Locations list: kLSSharedFileListFavoriteVolumes.
private enum LocationsList: SidebarEditing {
    @available(macOS, deprecated: 10.11, message: "LSSharedFileList is how Finder's sidebar is kept")
    static func add(_ volume: URL) {
        guard let list = open() else { return }
        let items = snapshot(list)
        guard !items.contains(where: { resolves($0, to: volume) }) else { return }
        // After the list's last entry, which is an entry: the "last"
        // position LSSharedFileList offers is the sentinel 0x2, which Swift
        // would retain as if it were an object, and crash.
        guard let last = items.last else { return }
        _ = LSSharedFileListInsertItemURL(list, last, nil, nil, volume as CFURL, nil, nil)
    }

    @available(macOS, deprecated: 10.11, message: "LSSharedFileList is how Finder's sidebar is kept")
    static func remove(_ volume: URL) {
        guard let list = open() else { return }
        for item in snapshot(list) where resolves(item, to: volume) {
            LSSharedFileListItemRemove(list, item)
        }
    }

    @available(macOS, deprecated: 10.11)
    private static func open() -> LSSharedFileList? {
        LSSharedFileListCreate(nil, kLSSharedFileListFavoriteVolumes.takeUnretainedValue(), nil)?.takeRetainedValue()
    }

    @available(macOS, deprecated: 10.11)
    private static func snapshot(_ list: LSSharedFileList) -> [LSSharedFileListItem] {
        var seed: UInt32 = 0
        return LSSharedFileListCopySnapshot(list, &seed)?.takeRetainedValue() as? [LSSharedFileListItem] ?? []
    }

    /// Without mounting anything, or asking anyone: an entry for a server
    /// that is not there is simply not this disk.
    @available(macOS, deprecated: 10.11)
    private static func resolves(_ item: LSSharedFileListItem, to volume: URL) -> Bool {
        let flags = UInt32(kLSSharedFileListNoUserInteraction | kLSSharedFileListDoNotMountVolumes)
        guard let url = LSSharedFileListItemCopyResolvedURL(item, flags, nil)?.takeRetainedValue() as URL? else { return false }
        return url.standardizedFileURL.path == volume.standardizedFileURL.path
    }
}
