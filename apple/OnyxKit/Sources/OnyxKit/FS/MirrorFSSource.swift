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

    /// `presign` signs a link to a file's bytes; by default the mirror's own
    /// (DriveMirror.contentLink), which reuses one while it has time left.
    public init(scope: String, mirror: DriveMirror, pins: @escaping @Sendable () -> PinStore?,
                presign: (@Sendable (MirrorEntry) async throws -> FSRemoteLink)? = nil,
                volume: @escaping @Sendable () async -> FSVolumeInfo,
                overlay: (@Sendable () async -> (FSOverlay, UInt64))? = nil,
                icon: (@Sendable () async -> Data?)? = nil) {
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
    }

    /// The mirror, with this Mac's writes laid over it. Both revisions only
    /// ever go up, so their sum does too — and moves with either.
    public func snapshot() async -> FSSnapshot {
        let now = await mirror.snapshot
        guard let overlay else { return FSSnapshot(revision: now.revision, index: now.index) }
        let (written, revision) = await overlay()
        return FSSnapshot(revision: now.revision &+ revision, index: now.index, overlay: written)
    }

    /// `revision` is snapshot()'s, mirror and overlay summed: the mirror is
    /// waited on past its own share. Had the overlay moved meanwhile, that
    /// share is smaller than it was and this returns at once — which is
    /// right, as there is something new to see.
    public func waitForChange(after revision: UInt64, timeout: Duration) async {
        guard let overlay else { return await mirror.waitForChange(after: revision, timeout: timeout) }
        let (_, written) = await overlay()
        await mirror.waitForChange(after: revision >= written ? revision - written : 0, timeout: timeout)
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
