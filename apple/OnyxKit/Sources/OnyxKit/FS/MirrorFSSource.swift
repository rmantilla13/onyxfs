import Foundation

/// The app's FSSource for one drive: the tree from the drive's mirror, the
/// bytes from the copy kept on this Mac when there is a current one, else
/// from storage by a presigned link — what MountSource is to DAVResponder.
public struct MirrorFSSource: FSSource {
    public let scope: String
    public let mirror: DriveMirror
    /// The signed-in account's store as it is now: it may open after the
    /// drive mounted (its disk plugged in later), or not at all.
    let pins: @Sendable () -> PinStore?
    let presign: @Sendable (MirrorEntry) async throws -> FSRemoteLink
    let volume: @Sendable () async -> FSVolumeInfo
    /// What this Mac has written that the mirror does not show yet (the
    /// drive's DriveWriter), and its revision.
    let overlay: (@Sendable () async -> (FSOverlay, UInt64))?
    /// The drive's disk icon (DriveIcon).
    let icon: (@Sendable () async -> Data?)?
    /// The drive's collections, as its read-only Collections folder.
    let collections: CollectionsFolder?

    /// `presign` signs a link to a file's bytes; by default the mirror's own
    /// (DriveMirror.contentLink), which reuses one while it has time left.
    public init(scope: String, mirror: DriveMirror, pins: @escaping @Sendable () -> PinStore?,
                presign: (@Sendable (MirrorEntry) async throws -> FSRemoteLink)? = nil,
                volume: @escaping @Sendable () async -> FSVolumeInfo,
                overlay: (@Sendable () async -> (FSOverlay, UInt64))? = nil,
                icon: (@Sendable () async -> Data?)? = nil,
                collections: CollectionsFolder? = nil) {
        self.scope = scope
        self.mirror = mirror
        self.pins = pins
        self.presign = presign ?? { entry in
            guard let id = entry.fileId else { throw OnyxError.http(status: 404, message: nil) }
            let link = try await mirror.contentLink(fileId: id)
            return FSRemoteLink(url: link.url, expiresAt: link.expiresAt)
        }
        self.volume = volume
        self.overlay = overlay
        self.icon = icon
        self.collections = collections
    }

    /// The mirror, with this Mac's writes laid over it. Both revisions only
    /// ever go up, so their sum does too — and moves with either.
    public func snapshot() async -> FSSnapshot {
        let now = await mirror.snapshot
        var snap = FSSnapshot(revision: now.revision, index: now.index)
        if let overlay {
            let (written, revision) = await overlay()
            snap.overlay = written
            snap.revision &+= revision
        }
        if let collections {
            // Its revision before the folders: a change meanwhile is seen
            // as one still to come, never missed.
            let held = await collections.revision
            snap.collections = await collections.folders(index: now.index, mirrorRevision: now.revision)
            snap.revision &+= held
        }
        return snap
    }

    /// `revision` is snapshot()'s, mirror, overlay and collections summed:
    /// the mirror is waited on past its own share, the collections past
    /// theirs, whichever moves first. Had the overlay or the collections
    /// moved meanwhile, the mirror's share is smaller than it was and this
    /// returns at once — which is right, as there is something new to see.
    public func waitForChange(after revision: UInt64, timeout: Duration) async {
        var rest = revision
        if let overlay {
            let (_, written) = await overlay()
            rest = rest >= written ? rest - written : 0
        }
        guard let collections else { return await mirror.waitForChange(after: rest, timeout: timeout) }
        let held = await collections.revision
        let mirrorShare = rest >= held ? rest - held : 0
        let mirror = mirror
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await mirror.waitForChange(after: mirrorShare, timeout: timeout) }
            group.addTask { await collections.waitForChange(after: held, timeout: timeout) }
            await group.next()
            group.cancelAll()
        }
    }

    public func listed(_ path: String) async {
        guard let collections else { return }
        await collections.listed(path, rootName: await collections.rootName)
    }

    public func keptOffline(_ entries: [MirrorEntry]) async -> Set<String> {
        guard let store = pins() else { return [] }
        return await store.keptOffline(scope: scope, entries)
    }

    public func localCopy(of entry: MirrorEntry) async -> URL? {
        guard let id = entry.fileId, let store = pins() else { return nil }
        return await store.localCopy(scope: scope, fileId: id, etag: entry.etag)
    }

    public func remoteLink(for entry: MirrorEntry) async throws -> FSRemoteLink {
        try await presign(entry)
    }

    public func volumeInfo() async -> FSVolumeInfo {
        await volume()
    }

    public func volumeIcon() async -> Data? {
        await icon?()
    }
}
