import OnyxKit
import SwiftUI

/// One folder's contents: its subfolders, from the place's tree, and its
/// files, a page at a time in the order asked for — or, while searching,
/// what matches anywhere beneath it.
@MainActor @Observable
final class FolderListing {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    let route: FolderRoute
    /// This folder's own node in the place's tree (nil at the top): what
    /// the server says of it, such as whether its links are this account's.
    private(set) var current: FolderNode?
    private(set) var subfolders: [FolderNode] = []
    /// What each subfolder holds, as the Files app counts it: its files and
    /// its folders.
    private(set) var itemCounts: [String: Int] = [:]
    private(set) var files: [FileItem] = []
    private(set) var phase: Phase = .idle
    private(set) var loadingMore = false
    /// A refresh or a further page that failed while there was something
    /// to show: said, and what was shown stays.
    var problem: String?
    private var cursor: String?
    /// What the listing on screen was asked for, and when.
    private var shown: (key: Key, at: Date)?
    /// Moves with each fresh load, so an answer to an older one is dropped.
    private var generation = 0

    struct Key: Equatable {
        let sort: FileSort
        let query: String
    }

    /// A listing this recent is shown again as it is when the folder is
    /// come back to; pull to refresh for a newer one.
    static let fresh: TimeInterval = 60

    init(route: FolderRoute) {
        self.route = route
    }

    var isEmpty: Bool { files.isEmpty && subfolders.isEmpty }
    var hasMore: Bool { cursor != nil }

    /// The file whose tile, coming into view, asks for the next page: far
    /// enough from the end that it arrives before the end is reached.
    var nextPageTrigger: String? {
        guard hasMore, !files.isEmpty else { return nil }
        return files[max(0, files.count - 24)].id
    }

    func load(_ session: Session, sort: FileSort, query: String, refresh: Bool = false) async {
        let key = Key(sort: sort, query: query.trimmingCharacters(in: .whitespacesAndNewlines))
        if !refresh, phase == .loaded, let shown, shown.key == key, Date().timeIntervalSince(shown.at) < Self.fresh {
            return
        }
        generation += 1
        let mine = generation
        // What is shown stays while a new order or a refresh loads.
        if isEmpty || shown?.key.query != key.query { phase = .loading }
        let asked = ThumbnailTrace.now
        ThumbnailTrace.event("folder-open", "folder=\(route.folder)")
        do {
            // A collection is its files alone, from the whole place: no tree.
            let inCollection = route.collection != nil
            async let tree = inCollection ? [] : session.folders(in: route.place, refresh: refresh)
            async let page = session.api.listFiles(in: route.place.scope, folder: route.folder,
                                                    query: key.query, sort: sort, collection: route.collection?.id)
            let (nodes, first) = try await (tree, page)
            ThumbnailTrace.event("listing", "files=\(first.files.count) ms=\(ThumbnailTrace.ms(since: asked))")
            guard mine == generation else { return }
            current = route.folder.isEmpty ? nil : nodes.first { $0.folder == route.folder }
            subfolders = Self.subfolders(of: route.folder, in: nodes, matching: key.query)
            itemCounts = Self.itemCounts(subfolders, in: nodes)
            files = first.files
            ThumbnailPrefetcher.shared.listed(files, by: self)
            cursor = first.cursor
            shown = (key, Date())
            problem = nil
            phase = .loaded
        } catch {
            guard mine == generation, !Session.isCancel(error) else { return }
            let words = session.explain(error)
            if isEmpty || shown?.key != key {
                phase = .failed(words)
            } else {
                problem = words
                phase = .loaded
            }
        }
    }

    func loadMore(_ session: Session, sort: FileSort, query: String) async {
        guard let cursor, !loadingMore, phase == .loaded else { return }
        loadingMore = true
        defer { loadingMore = false }
        let mine = generation
        do {
            let page = try await session.api.listFiles(in: route.place.scope, folder: route.folder,
                                                       query: query.trimmingCharacters(in: .whitespacesAndNewlines),
                                                       sort: sort, cursor: cursor, collection: route.collection?.id)
            guard mine == generation else { return }
            // Keyset paging never repeats a row, but a file moved between
            // two pages could; it is shown once.
            let known = Set(files.map(\.id))
            files += page.files.filter { !known.contains($0.id) }
            ThumbnailPrefetcher.shared.listed(files, by: self)
            self.cursor = page.cursor
        } catch {
            guard mine == generation, !Session.isCancel(error) else { return }
            problem = session.explain(error)
        }
    }

    static func itemCounts(_ shown: [FolderNode], in nodes: [FolderNode]) -> [String: Int] {
        var folders: [String: Int] = [:]
        for node in nodes { folders[node.parent, default: 0] += 1 }
        return Dictionary(shown.map { ($0.folder, $0.count + folders[$0.folder, default: 0]) },
                          uniquingKeysWith: { first, _ in first })
    }

    /// The folders in `folder`, by name — or, with a query, every folder
    /// beneath it whose name matches, as the files are searched.
    static func subfolders(of folder: String, in nodes: [FolderNode], matching query: String) -> [FolderNode] {
        let found: [FolderNode]
        if query.isEmpty {
            found = nodes.filter { $0.parent == folder }
        } else {
            let prefix = folder.isEmpty ? "" : folder + "/"
            found = nodes.filter { $0.folder.hasPrefix(prefix) && $0.name.localizedStandardContains(query) }
        }
        return found.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}

/// How a folder is laid out.
enum BrowserLayout: String {
    case grid
    case list
}

/// The ways a listing can be ordered, as the Files app offers them: a
/// field, and which way.
enum SortField: String, CaseIterable, Identifiable {
    case name, modified, added, size, kind

    var id: String { rawValue }

    var title: String {
        switch self {
        case .name: "Name"
        case .modified: "Date Modified"
        case .added: "Date Added"
        case .size: "Size"
        case .kind: "Kind"
        }
    }

    /// Chosen afresh, a field starts the way people expect it: names A to Z,
    /// dates and sizes largest first.
    var natural: FileSort {
        switch self {
        case .name: .name
        case .modified: .modified
        case .added: .newest
        case .size: .largest
        case .kind: .type
        }
    }
}

extension FileSort {
    var field: SortField {
        switch self {
        case .name, .nameDescending: .name
        case .modified, .modifiedOldest: .modified
        case .newest, .oldest: .added
        case .largest, .smallest: .size
        case .type, .typeDescending: .kind
        }
    }

    /// The same field, the other way.
    var reversed: FileSort {
        switch self {
        case .name: .nameDescending
        case .nameDescending: .name
        case .modified: .modifiedOldest
        case .modifiedOldest: .modified
        case .newest: .oldest
        case .oldest: .newest
        case .largest: .smallest
        case .smallest: .largest
        case .type: .typeDescending
        case .typeDescending: .type
        }
    }

    /// A to Z, oldest first, smallest first: which way the chevron points.
    var ascending: Bool {
        switch self {
        case .name, .type, .modifiedOldest, .oldest, .smallest: true
        case .nameDescending, .typeDescending, .modified, .newest, .largest: false
        }
    }
}
