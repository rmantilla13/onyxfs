import AVFoundation
import Combine
import OnyxKit

/// Where the preview's pages get a file's bytes from: a link that is here
/// already when there is one (ContentLinks, OnyxKit), so a page plays or
/// opens at once instead of waiting on the server for a link first.
///
/// A page asks `ready` — a link kept for the file, or, for one with no
/// streamable copy to prefer, the listing's own, which is good for hours —
/// then `link`, which asks the server (or joins the request already on its
/// way) and keeps what it answers. A link storage refuses is `refused`, and
/// the page asks again. The pages either side of the one on screen have
/// theirs fetched while it shows (`prefetch`). For the video page, the sound
/// page, and the originals a document or a picture opens from.
enum PreviewLinks {
    /// One for the app: a video opened again, or swiped back to, plays at
    /// once. Forgotten at sign-out.
    static let shared = ContentLinks()

    /// A link to `file` from what is here already: one kept for it, or —
    /// when it has no streamable copy to prefer — the listing's own. Nil:
    /// the server must be asked. `needed`: seconds it must still work, by
    /// default long enough to play the file through.
    static func ready(for file: FileItem, needed: TimeInterval? = nil) async -> ContentLinks.Link? {
        let needed = needed ?? ContentLinks.needed(toPlay: file.metadata?.duration)
        if let kept = await shared.kept(file.id, version: file.version, needed: needed) { return kept }
        return StreamableCopy.mayHave(file) ? nil : ContentLinks.listed(file.url, needed: needed)
    }

    /// A link from the server, or the request on its way for it already;
    /// kept for next time.
    static func link(for file: FileItem, api: OnyxAPI) async throws -> ContentLinks.Link {
        let id = file.id
        return try await shared.link(id, version: file.version, needed: ContentLinks.needed(toPlay: file.metadata?.duration),
                                     copyExpected: StreamableCopy.mayHave(file)) { try await api.contentLink(fileId: id) }
    }

    /// Storage refused the link `file` was read from: expired, or the file
    /// moved. The next is asked for.
    static func refused(_ file: FileItem) async {
        await shared.forget(file.id)
    }

    /// The pages either side of the one on screen: the links of what will
    /// play there, fetched while this one shows, so a swipe plays at once.
    static func prefetch(around current: String?, in files: [FileItem], api: OnyxAPI) async {
        guard let current, let at = files.firstIndex(where: { $0.id == current }) else { return }
        for index in [at + 1, at - 1] where files.indices.contains(index) {
            let file = files[index]
            guard file.kind == "video" || file.kind == "audio", await ready(for: file) == nil else { continue }
            let id = file.id
            await shared.prefetch(id, version: file.version, needed: ContentLinks.needed(toPlay: file.metadata?.duration),
                                  copyExpected: StreamableCopy.mayHave(file)) { try await api.contentLink(fileId: id) }
        }
    }

    /// A large video with no streamable copy, and no job to make one: one is
    /// asked for, so the next time it plays, it plays smoothly. Uploads since
    /// proxies came ask for their own; this catches the ones before. Once a
    /// launch for each file, and never over a job queued or under way:
    /// asking again starts it over, and the Mac making it — often the one
    /// that uploaded the video, a minute before — loses its work.
    @MainActor static func askForCopy(of file: FileItem, api: OnyxAPI) {
        guard StreamableCopy.mayHave(file), asked.insert(file.id).inserted else { return }
        let id = file.id
        Task.detached(priority: .utility) {
            guard let job = try? await api.proxyStatus(fileId: id),
                  job.status == "none" || (job.status == "done" && job.stale) else { return }
            try? await api.requestProxy(fileId: id)
        }
    }

    @MainActor private static var asked: Set<String> = []

    // MARK: - Watching a player

    /// When `item` fails — at the start, as one given a refused link does,
    /// or part-way — with why. Nil when the task ends first.
    @MainActor static func failure(of item: AVPlayerItem) async -> Error? {
        let failed = item.publisher(for: \.status)
            .filter { $0 == .failed }
            .map { _ -> Error in item.error ?? URLError(.resourceUnavailable) }
        let stopped = NotificationCenter.default.publisher(for: AVPlayerItem.failedToPlayToEndTimeNotification, object: item)
            .map { note -> Error in
                (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error) ?? URLError(.networkConnectionLost)
            }
        for await error in failed.merge(with: stopped).values { return error }
        return nil
    }

    /// Whether `item` comes to be ready to play, rather than failing.
    @MainActor static func readyToPlay(_ item: AVPlayerItem) async -> Bool {
        for await status in item.publisher(for: \.status).values where status != .unknown {
            return status == .readyToPlay
        }
        return false
    }
}
