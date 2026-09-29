import Foundation

/// A drive's mirror as DriveWriter asks it: what is at a path, and "bring
/// yourself up to date now". `refresh` is the app's, which syncs the mirror
/// and passes the change on (to the bridge's listings, to the page).
/// `refreshSoon` is the app's too, for uploads finishing: it syncs at most
/// once a second however many finish, and tells the writer after.
public struct MirrorTree: DriveTree {
    let mirror: DriveMirror
    let refreshing: @Sendable () async -> Void
    let refreshingSoon: @Sendable () async -> Void

    public init(mirror: DriveMirror, refresh: @escaping @Sendable () async -> Void,
                refreshSoon: (@Sendable () async -> Void)? = nil) {
        self.mirror = mirror
        self.refreshing = refresh
        self.refreshingSoon = refreshSoon ?? refresh
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

    public func serverPath(at path: String) async -> String? {
        guard let key = MirrorIndex.normalize(path) else { return nil }
        if key.isEmpty { return "" }
        guard let entry = await mirror.index.entry(at: key), entry.isFolder else { return nil }
        return entry.apiPath
    }

    public func refresh() async { await refreshing() }

    public func refreshSoon() async { await refreshingSoon() }
}
