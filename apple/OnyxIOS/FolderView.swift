import OnyxKit
import SwiftUI

/// A folder: its subfolders, then its files, as icons or a list, in the
/// order chosen — searchable, a page at a time, pulled to refresh. A file
/// opens full screen, zooming out of its tile. Select chooses files to save
/// together: to Photos, to Files, or to share.
struct FolderView: View {
    let route: FolderRoute
    @Environment(Session.self) private var session
    @State private var listing: FolderListing
    @AppStorage("browser.layout") private var layout: BrowserLayout = .grid
    @AppStorage("browser.sort") private var sort: FileSort = .name
    @State private var query = ""
    @State private var previewing: FileItem?
    @State private var inspecting: FileItem?
    /// Choosing files, and the ones chosen.
    @State private var selecting = false
    @State private var selection: Set<String> = []
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
        .environment(\.fileSelection, selecting ? selection : nil)
        .overlay { overlay }
        .safeAreaInset(edge: .bottom) { problemBanner }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if selecting {
                SelectionBar(files: chosenFiles) { endSelecting() }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3, bounce: 0.15), value: selecting)
        .navigationTitle(selecting ? selectionTitle : title)
        .navigationBarTitleDisplayMode(route.folder.isEmpty && !selecting ? .large : .inline)
        .navigationBarBackButtonHidden(selecting)
        .searchable(text: $query, prompt: route.folder.isEmpty ? "Search \(route.place.name)" : "Search \(title)")
        .toolbar { toolbar }
        .onChange(of: listing.files.map(\.id)) { _, ids in
            // What left the listing cannot stay chosen.
            selection.formIntersection(ids)
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

    private var selectionTitle: String {
        selection.isEmpty ? "Select Files" : (selection.count == 1 ? "1 Selected" : "\(selection.count) Selected")
    }

    /// The chosen files, in the listing's order.
    private var chosenFiles: [FileItem] {
        listing.files.filter { selection.contains($0.id) }
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
                    .disabled(selecting)
                }
                ForEach(listing.files) { file in
                    fileButton(file) { FileTile(file: file, showsFolder: !query.isEmpty) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            if listing.loadingMore { ProgressView().padding(.bottom, 24) }
        }
        .background { AuraBackground() }
    }

    private var list: some View {
        List {
            ForEach(listing.subfolders) { node in
                NavigationLink(value: FolderRoute(place: route.place, folder: node.folder)) {
                    FolderRow(node: node, items: listing.itemCounts[node.folder] ?? node.count)
                }
                .disabled(selecting)
                .listRowBackground(Color.clear)
            }
            ForEach(listing.files) { file in
                fileButton(file) { FileRow(file: file, showsFolder: !query.isEmpty) }
            }
            if listing.loadingMore {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .listRowSeparatorTint(Theme.edge)
        .auraBackground()
    }

    private func fileButton<Label: View>(_ file: FileItem, @ViewBuilder label: () -> Label) -> some View {
        Button { open(file) } label: { label() }
            .buttonStyle(.plain)
            .matchedTransitionSource(id: file.id, in: zoom)
            .contextMenu { fileMenu(file) }
            .onAppear {
                if file.id == listing.nextPageTrigger {
                    Task { await listing.loadMore(session, sort: sort, query: query) }
                }
            }
    }

    /// A tap: the file full screen — or, while choosing, chosen or not.
    private func open(_ file: FileItem) {
        guard selecting else {
            previewing = file
            return
        }
        if selection.remove(file.id) == nil { selection.insert(file.id) }
    }

    /// A file's long-press menu: open it, its details, the ways to save it,
    /// and choosing it with others.
    @ViewBuilder private func fileMenu(_ file: FileItem) -> some View {
        Button { previewing = file } label: { Label("Open", systemImage: "eye") }
        Button { inspecting = file } label: { Label("Get Info", systemImage: "info.circle") }
        Section { SaveActions(file: file) }
        if !selecting {
            Button {
                selection = [file.id]
                selecting = true
            } label: {
                Label("Select", systemImage: "checkmark.circle")
            }
        }
    }

    private func endSelecting() {
        selecting = false
        selection = []
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if selecting {
            ToolbarItem(placement: .topBarLeading) {
                let all = !listing.files.isEmpty && selection.count == listing.files.count
                Button(all ? "Deselect All" : "Select All") {
                    selection = all ? [] : Set(listing.files.map(\.id))
                }
                .disabled(listing.files.isEmpty)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done", action: endSelecting)
                    .fontWeight(.semibold)
            }
        } else {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Select") { selecting = true }
                    .disabled(listing.files.isEmpty)
            }
            ToolbarItem(placement: .topBarTrailing) { ViewOptions(layout: $layout, sort: $sort) }
        }
    }

    // MARK: - States

    @ViewBuilder private var overlay: some View {
        switch listing.phase {
        case .idle, .loading:
            if listing.isEmpty { ProgressView().controlSize(.large) }
        case let .failed(words):
            ContentUnavailableView {
                Label("Can't Open \(title)", systemImage: "exclamationmark.triangle")
            } description: {
                Text(words)
            } actions: {
                Button("Try Again") { Task { await listing.load(session, sort: sort, query: query, refresh: true) } }
                    .buttonStyle(BrandButtonStyle())
            }
            .onyxStyle()
        case .loaded:
            if listing.isEmpty {
                if query.isEmpty {
                    ContentUnavailableView("Nothing Here Yet", systemImage: "folder",
                                           description: Text("Files added on the web or from a Mac appear here."))
                        .onyxStyle()
                } else {
                    ContentUnavailableView.search(text: query)
                        .onyxStyle()
                }
            }
        }
    }

    @ViewBuilder private var problemBanner: some View {
        if let problem = listing.problem {
            Label(problem, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .symbolRenderingMode(.multicolor)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .glassSurface(Capsule())
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
            // Liquid Glass draws the circle itself.
            Image(systemName: Theme.liquidGlass ? "ellipsis" : "ellipsis.circle")
                .accessibilityLabel("View Options")
        }
    }
}
