import OnyxKit
import SwiftUI

/// Keeps a folder's next pictures ready before they are scrolled to.
///
/// A folder's listing says what is in it, in order (`listed`); its cells say
/// where the eye is as they come into view (`appeared`). From the two, each
/// burst of cells plans the pictures past the edge of the screen, the way
/// the folder is moving (PrefetchWindow), and hands them to the store to
/// fetch ahead and decode. Without it, every cell scrolled in stayed blank
/// for a round trip to storage at least; with it, a cell finds its picture
/// in memory on its first frame.
///
/// Thumbnails only: a frame drawn from a video costs a megabyte or so, and
/// is drawn for a cell on screen, not ahead of one. And the placeholders
/// the near ones will show until their thumbnails come (PlaceholderImages),
/// which are in the listing already and only need decoding: a new folder's
/// first screen as soon as it is listed, then the warm window's as it moves.
@MainActor
final class ThumbnailPrefetcher {
    static let shared = ThumbnailPrefetcher()

    let window = PrefetchWindow()

    private final class Listing {
        weak var owner: AnyObject?
        var files: [FileItem]
        var index: [String: Int]
        var focus = ScrollFocus()
        /// The size its cells show pictures at, and how many cells in a row
        /// have lately asked for another.
        var size: ThumbnailSize?
        var other: (size: ThumbnailSize, count: Int)?

        init(owner: AnyObject, files: [FileItem]) {
            self.owner = owner
            self.files = files
            index = Self.index(files)
        }

        static func index(_ files: [FileItem]) -> [String: Int] {
            Dictionary(files.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
    }

    /// The folders open, the one looked at most recently last. A few only:
    /// the folders on the navigation stack.
    private var listings: [Listing] = []
    private var burst: Listing?
    private var settling = false

    /// A folder's files, in the order shown: after its first page, a further
    /// page, a new order or a search.
    func listed(_ files: [FileItem], by owner: AnyObject) {
        listings.removeAll { $0.owner == nil }
        if let listing = listings.first(where: { $0.owner === owner }) {
            // A further page keeps the eye where it was and plans into it;
            // anything else starts over.
            let grown = files.count >= listing.files.count
                && zip(listing.files, files).allSatisfy { $0.id == $1.id }
            listing.files = files
            listing.index = Listing.index(files)
            if grown {
                replan(listing)
            } else {
                listing.focus.reset()
                firstScreen(files)
            }
            touch(listing)
        } else {
            let listing = Listing(owner: owner, files: files)
            listings.append(listing)
            if listings.count > 6 { listings.removeFirst(listings.count - 6) }
            firstScreen(files)
        }
    }

    /// The placeholders a listing's first screen shows, decoded now, before
    /// its cells ask: most are ready for their first frame. None for a
    /// picture in memory already, at either size (no cell has said which
    /// yet): that is on its cell's first frame itself.
    private func firstScreen(_ files: [FileItem]) {
        let first = files.prefix(window.warmAhead + window.warmBehind).filter { file in
            file.metadata?.placeholder != nil
                && ![ThumbnailSize.card, .row].contains { file.thumbnail($0).flatMap(ThumbnailStore.shared.cached) != nil }
        }
        PlaceholderImages.shared.warm(first, priority: .userInitiated)
    }

    /// A cell came into view showing `file` at `size`.
    func appeared(_ file: FileItem, size: ThumbnailSize) {
        if ThumbnailTrace.enabled, let key = file.picture(size)?.key {
            ThumbnailTrace.event("appear", "key=\(key)")
        }
        guard let listing = listings.last(where: { $0.index[file.id] != nil }), let at = listing.index[file.id] else { return }
        // One cell of another size is a sheet (Get Info), not the folder;
        // a run of them is the folder shown the other way.
        if listing.size == nil {
            listing.size = size
        } else if size != listing.size {
            let count = listing.other?.size == size ? (listing.other?.count ?? 0) + 1 : 1
            listing.other = (size, count)
            guard count >= 3 else { return }
            listing.size = size
            listing.other = nil
            listing.focus.reset()
        } else {
            listing.other = nil
        }
        touch(listing)
        listing.focus.note(at)
        burst = listing
        // The rest of the burst is on its way: plan once it is all in.
        guard !settling else { return }
        settling = true
        Task { @MainActor in self.settle() }
    }

    private func settle() {
        settling = false
        guard let listing = burst, listing.owner != nil else { return }
        burst = nil
        guard let anchor = listing.focus.settle() else { return }
        plan(listing, around: anchor)
    }

    private func replan(_ listing: Listing) {
        guard let anchor = listing.focus.anchor else { return }
        plan(listing, around: anchor)
    }

    private func plan(_ listing: Listing, around anchor: Int) {
        guard let size = listing.size else { return }
        let plan = window.plan(around: anchor, count: listing.files.count, forward: listing.focus.forward)
        let fetch = plan.fetch.compactMap { listing.files[$0].thumbnail(size) }
        let warm = plan.warm.compactMap { listing.files[$0].thumbnail(size) }
        ThumbnailStore.shared.prefetch(fetch: fetch, warm: warm)
        // What the near ones show until then: none for a picture in memory
        // already, which is on its cell's first frame.
        PlaceholderImages.shared.warm(plan.warm.lazy.map { listing.files[$0] }.filter { file in
            file.metadata?.placeholder != nil && file.thumbnail(size).map { ThumbnailStore.shared.cached($0) == nil } == true
        })
    }

    private func touch(_ listing: Listing) {
        guard listings.last !== listing, let i = listings.firstIndex(where: { $0 === listing }) else { return }
        listings.remove(at: i)
        listings.append(listing)
    }
}
