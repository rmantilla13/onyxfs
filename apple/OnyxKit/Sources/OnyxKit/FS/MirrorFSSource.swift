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

    /// `presign` signs a link to a file's bytes; by default the mirror's own
    /// (DriveMirror.contentLink), which reuses one while it has time left.
    public init(scope: String, mirror: DriveMirror, pins: @escaping @Sendable () -> PinStore?,
                presign: (@Sendable (MirrorEntry) async throws -> FSRemoteLink)? = nil,
                volume: @escaping @Sendable () async -> FSVolumeInfo) {
        self.scope = scope
        self.mirror = mirror
        self.pins = pins
        self.presign = presign ?? { entry in
            guard let id = entry.fileId else { throw OnyxError.http(status: 404, message: nil) }
            let link = try await mirror.contentLink(fileId: id)
            return FSRemoteLink(url: link.url, expiresAt: link.expiresAt)
        }
        self.volume = volume
    }

    /// The mirror has no overlay of its own yet: writes from Finder will
    /// bring one, and a revision that moves with it too.
    public func snapshot() async -> FSSnapshot {
        let now = await mirror.snapshot
        return FSSnapshot(revision: now.revision, index: now.index)
    }

    public func waitForChange(after revision: UInt64, timeout: Duration) async {
        await mirror.waitForChange(after: revision, timeout: timeout)
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
}
