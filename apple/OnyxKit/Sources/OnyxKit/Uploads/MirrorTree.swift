import Foundation

/// A drive's mirror as DriveWriter asks it: what is at a path, and "bring
/// yourself up to date now". `refresh` is the app's, which syncs the mirror
/// and passes the change on (to the bridge's listings, to the page).
public struct MirrorTree: DriveTree {
    let mirror: DriveMirror
    let refreshing: @Sendable () async -> Void

    public init(mirror: DriveMirror, refresh: @escaping @Sendable () async -> Void) {
        self.mirror = mirror
        self.refreshing = refresh
    }

    public func item(at path: String) async -> DriveItem? {
        guard let key = MirrorIndex.normalize(path) else { return nil }
        if key.isEmpty { return .folder }
        guard let entry = await mirror.index.entry(at: key) else { return nil }
        if entry.isFolder { return .folder }
        return entry.fileId.map { .file(id: $0) }
    }

    public func changed(at path: String) async -> Date? {
        guard let key = MirrorIndex.normalize(path), let entry = await mirror.index.entry(at: key), !entry.isFolder else {
            return nil
        }
        return entry.changed
    }

    public func refresh() async { await refreshing() }
}
