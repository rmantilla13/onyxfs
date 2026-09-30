import OnyxKit
import SwiftUI

/// A folder: its subfolders, then its files, as icons or a list, in the
/// order chosen — searchable, a page at a time, pulled to refresh. A file
/// opens full screen, zooming out of its tile.
struct FolderView: View {
    let route: FolderRoute
    @Environment(Session.self) private var session
    @State private var listing: FolderListing
    @AppStorage("browser.layout") private var layout: BrowserLayout = .grid
    @AppStorage("browser.sort") private var sort: FileSort = .name
    @State private var query = ""
    @State private var previewing: FileItem?
    @State private var inspecting: FileItem?
    @Namespace private var zoom

    init(route: FolderRoute) {
        self.route = route
        _listing = State(initialValue: FolderListing(route: route))
    }

    var body: some View {
        Group {
            switch layout {
            case .grid: grid
            case .list: list
            }
        }
        .overlay { overlay }
        .safeAreaInset(edge: .bottom) { problemBanner }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(route.folder.isEmpty ? .large : .inline)
        .searchable(text: $query, prompt: route.folder.isEmpty ? "Search \(route.place.name)" : "Search \(title)")
        .toolbar {
            if !route.folder.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    let starred = session.isStarred(route)
                    Button { star(route, !starred) } label: {
                        Image(systemName: starred ? "star.fill" : "star")
                    }
                    .accessibilityLabel(starred ? "Remove from Starred" : "Add to Starred")
                }
            }
            ToolbarItem(placement: .topBarTrailing) { ViewOptions(layout: $layout, sort: $sort) }
        }
        .task(id: FolderListing.Key(sort: sort, query: query)) {
            // A keystroke is not a search: wait for the typing to settle.
            if !query.isEmpty {
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
            }
            await listing.load(session, sort: sort, query: query)
        }
        .refreshable { await listing.load(session, sort: sort, query: query, refresh: true) }
        .fullScreenCover(item: $previewing) { file in
            PreviewView(files: listing.files, startID: file.id)
                .navigationTransition(.zoom(sourceID: file.id, in: zoom))
        }
        .sheet(item: $inspecting) { FileInfoView(file: $0, place: route.place) }
    }

    private var title: String {
        route.folder.isEmpty ? route.place.name : (route.folder as NSString).lastPathComponent
    }

    // MARK: - Layouts

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104, maximum: 196), spacing: 12, alignment: .top)],
                      spacing: 18) {
                ForEach(listing.subfolders) { node in
                    NavigationLink(value: FolderRoute(place: route.place, folder: node.folder)) {
                        FolderTile(node: node, items: listing.itemCounts[node.folder] ?? node.count)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { starButton(node) }
                }
                ForEach(listing.files) { file in
                    fileButton(file) { FileTile(file: file, showsFolder: !query.isEmpty) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            if listing.loadingMore { ProgressView().padding(.bottom, 24) }
        }
    }

    private var list: some View {
        List {
            ForEach(listing.subfolders) { node in
                NavigationLink(value: FolderRoute(place: route.place, folder: node.folder)) {
                    FolderRow(node: node, items: listing.itemCounts[node.folder] ?? node.count)
                }
                .contextMenu { starButton(node) }
            }
            ForEach(listing.files) { file in
                fileButton(file) { FileRow(file: file, showsFolder: !query.isEmpty) }
            }
            if listing.loadingMore {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
    }

    // MARK: - Starring

    private func starButton(_ node: FolderNode) -> some View {
        let sub = FolderRoute(place: route.place, folder: node.folder)
        let starred = session.isStarred(sub)
        return Button { star(sub, !starred) } label: {
            SwiftUI.Label(starred ? "Remove from Starred" : "Add to Starred",
                          systemImage: starred ? "star.slash" : "star")
        }
    }

    /// Star or unstar; a refusal shows in the banner.
    private func star(_ target: FolderRoute, _ starred: Bool) {
        Task {
            if let problem = await session.setStarred(target, starred) {
                withAnimation { listing.problem = problem }
            }
        }
    }

    private func fileButton<Label: View>(_ file: FileItem, @ViewBuilder label: () -> Label) -> some View {
        Button { previewing = file } label: { label() }
            .buttonStyle(.plain)
            .matchedTransitionSource(id: file.id, in: zoom)
            .contextMenu {
                Button { previewing = file } label: { SwiftUI.Label("Open", systemImage: "eye") }
                Button { inspecting = file } label: { SwiftUI.Label("Get Info", systemImage: "info.circle") }
            }
            .onAppear {
                if file.id == listing.nextPageTrigger {
                    Task { await listing.loadMore(session, sort: sort, query: query) }
                }
            }
    }

    // MARK: - States

    @ViewBuilder private var overlay: some View {
        switch listing.phase {
        case .idle, .loading:
            if listing.isEmpty { ProgressView() }
        case let .failed(words):
            ContentUnavailableView {
                Label("Can't Open \(title)", systemImage: "exclamationmark.triangle")
            } description: {
                Text(words)
            } actions: {
                Button("Try Again") { Task { await listing.load(session, sort: sort, query: query, refresh: true) } }
            }
        case .loaded:
            if listing.isEmpty {
                if query.isEmpty {
                    ContentUnavailableView("Nothing Here Yet", systemImage: "folder",
                                           description: Text("Files added on the web or from a Mac appear here."))
                } else {
                    ContentUnavailableView.search(text: query)
                }
            }
        }
    }

    @ViewBuilder private var problemBanner: some View {
        if let problem = listing.problem {
            Label(problem, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: Capsule())
                .padding(.bottom, 8)
                .onTapGesture { listing.problem = nil }
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// Icons or a list, and the order: the folder's ⋯ menu.
private struct ViewOptions: View {
    @Binding var layout: BrowserLayout
    @Binding var sort: FileSort

    var body: some View {
        Menu {
            Picker("View", selection: $layout) {
                Label("Icons", systemImage: "square.grid.2x2").tag(BrowserLayout.grid)
                Label("List", systemImage: "list.bullet").tag(BrowserLayout.list)
            }
            .pickerStyle(.inline)
            Section("Sort By") {
                ForEach(SortField.allCases) { field in
                    Button {
                        // The field in use again: the other way round.
                        sort = sort.field == field ? sort.reversed : field.natural
                    } label: {
                        if sort.field == field {
                            Label(field.title, systemImage: sort.ascending ? "chevron.up" : "chevron.down")
                        } else {
                            Text(field.title)
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .accessibilityLabel("View Options")
        }
    }
}
