import OnyxKit
import SwiftUI

/// A folder: its subfolders, then its files, as icons or a list, in the
/// order chosen — searchable, a page at a time, pulled to refresh. A file
/// opens full screen, zooming out of its tile. Select chooses files to save
/// together: to Photos, to Files, or to share.
struct FolderView: View {
    let route: FolderRoute
    @Environment(Session.self) private var session
    @Environment(AppChrome.self) private var chrome: AppChrome?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openFolderAbove) private var openFolderAbove
    @Environment(\.horizontalSizeClass) private var width
    @State private var listing: FolderListing
    @AppStorage("browser.layout") private var layout: BrowserLayout = .grid
    @AppStorage("browser.sort") private var sort: FileSort = .name
    @State private var query = ""
    @State private var previewing: FileItem?
    @State private var inspecting: FileItem?
    /// The file or folder a Share Link sheet is open for.
    @State private var linking: LinkSubject?
    /// The subfolder whose tags and metadata are being set.
    @State private var tagging: FolderNode?
    /// The collection on screen, being edited.
    @State private var editingCollection: FileCollection?
    /// Choosing files, and the ones chosen.
    @State private var selecting = false
    @State private var selection: Set<String> = []
    /// The big title has scrolled away: the bar says the name instead.
    @State private var titleGone = false
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
        .animation(Theme.motion(.arrive), value: selecting)
        .navigationTitle(selecting ? selectionTitle : title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(selecting)
        // The back button is a bare chevron; the parent's name is its chip.
        .toolbarRole(.editor)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic),
                    prompt: route.folder.isEmpty ? "Search \(route.place.name)" : "Search \(title)")
        .toolbar { toolbar }
        .onChange(of: selecting) { chrome?.selecting = selecting }
        .onDisappear { if selecting { chrome?.selecting = false } }
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
        .sheet(item: $linking) { ShareLinkSheet(subject: $0) }
        .sheet(item: $tagging) { node in
            FolderMetaEditor(place: route.place, node: node) {
                Task { await listing.load(session, sort: sort, query: query, refresh: true) }
            }
        }
        .sheet(item: $editingCollection) { c in
            CollectionEditor(existing: c, onSaved: { _, _ in
                Task { await listing.load(session, sort: sort, query: query, refresh: true) }
            }, onDeleted: { dismiss() })
        }
    }

    /// The collection on screen, as the session last heard of it.
    private var collection: FileCollection? {
        route.collection.flatMap { ref in session.collections.first { $0.id == ref.id } }
    }

    private var title: String {
        // Its current name: it may have been renamed since it was opened.
        if let ref = route.collection { return collection?.name ?? ref.name }
        return route.folder.isEmpty ? route.place.name : (route.folder as NSString).lastPathComponent
    }

    private var selectionTitle: String {
        selection.isEmpty ? "Select Files" : (selection.count == 1 ? "1 Selected" : "\(selection.count) Selected")
    }

    /// The folder this one is in, for the chip beside the back chevron: its
    /// name, or the drive's at the drive's top level. Nil at the top.
    private var parentName: String? {
        // A collection is opened from Browse, and goes back there.
        guard route.collection == nil, !route.folder.isEmpty else { return nil }
        let parent = (route.folder as NSString).deletingLastPathComponent
        return parent.isEmpty ? route.place.name : (parent as NSString).lastPathComponent
    }

    /// Whether the folder above is the drive's top: the chip says so with a
    /// house, as ⌂ does further down.
    private var parentIsTop: Bool { FolderTrail.depth(of: route.folder) == 1 }

    /// ⌂, the drive's top in one tap, from two folders down — one down, the
    /// chip is the top already. Back's long press lists every folder between.
    /// It sits in the chip rather than beside it: as an item of its own it
    /// cost the bar ~60 points, and iOS put Select and the view options away
    /// behind an overflow ⋯ to make room.
    private var topAction: (() -> Void)? {
        guard route.collection == nil, FolderTrail.depth(of: route.folder) > 1, let openFolderAbove else { return nil }
        return { openFolderAbove("") }
    }

    /// The page's headline: the folder's name, huge, and what it holds.
    private var header: some View {
        EditorialTitle(text: title, subtitle: headerSubtitle)
    }

    private var headerSubtitle: String? {
        guard listing.phase == .loaded else { return nil }
        let count = listing.subfolders.count + listing.files.count
        let more = listing.hasMore ? "+" : ""
        if !query.isEmpty { return count == 1 ? "1 result" : "\(count)\(more) results" }
        if route.collection != nil {
            return "\(count == 1 ? "1 file" : "\(count)\(more) files") in \(route.place.name)"
        }
        return count == 1 ? "1 item" : "\(count)\(more) items"
    }

    /// Whether the headline has scrolled out from under the bar.
    private static func titleGone(_ geometry: ScrollGeometry) -> Bool {
        geometry.contentOffset.y + geometry.contentInsets.top > 64
    }

    /// The chosen files, in the listing's order.
    private var chosenFiles: [FileItem] {
        listing.files.filter { selection.contains($0.id) }
    }

    // MARK: - Layouts

    private var grid: some View {
        ScrollView {
            header
                .padding(.horizontal, Theme.Space.gutter)
                .padding(.top, Theme.Space.gutter)
                .padding(.bottom, Theme.Space.s2)
            // Two big tiles across a phone, more on an iPad.
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 250), spacing: 14, alignment: .top)],
                      spacing: 22) {
                ForEach(listing.subfolders) { node in
                    NavigationLink(value: FolderRoute(place: route.place, folder: node.folder)) {
                        FolderTile(node: node, items: listing.itemCounts[node.folder] ?? node.count,
                                   tint: route.place.tint)
                    }
                    .buttonStyle(.plain)
                    .disabled(selecting)
                    .contextMenu { folderMenu(node) }
                }
                ForEach(listing.files) { file in
                    fileButton(file) { FileTile(file: file, showsFolder: !query.isEmpty) }
                }
            }
            .padding(.horizontal, Theme.Space.s4)
            .padding(.vertical, Theme.Space.s3)
            if listing.loadingMore { ProgressView().padding(.bottom, Theme.Space.s5) }
        }
        .onScrollGeometryChange(for: Bool.self, of: Self.titleGone) { _, gone in titleGone = gone }
        .softScrollEdge()
        .background { AuraBackground() }
    }

    private var list: some View {
        List {
            header
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: Theme.Space.gutter, leading: Theme.Space.gutter,
                                          bottom: Theme.Space.s3, trailing: Theme.Space.gutter))
            ForEach(listing.subfolders) { node in
                NavigationLink(value: FolderRoute(place: route.place, folder: node.folder)) {
                    FolderRow(node: node, items: listing.itemCounts[node.folder] ?? node.count,
                              tint: route.place.tint)
                }
                .disabled(selecting)
                .listRowBackground(Color.clear)
                .contextMenu { folderMenu(node) }
            }
            ForEach(listing.files) { file in
                fileButton(file) { FileRow(file: file, showsFolder: !query.isEmpty, share: shareAction(file)) }
            }
            if listing.loadingMore {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .listRowSeparatorTint(Theme.edge)
        .onScrollGeometryChange(for: Bool.self, of: Self.titleGone) { _, gone in titleGone = gone }
        .softScrollEdge()
        .auraBackground()
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
    /// a link to it, and choosing it with others.
    @ViewBuilder private func fileMenu(_ file: FileItem) -> some View {
        Button { previewing = file } label: { Label("Open", systemImage: "eye") }
        Button { inspecting = file } label: { Label("Get Info", systemImage: "info.circle") }
        Section { SaveActions(file: file) }
        if let share = shareAction(file) {
            Section {
                Button(action: share) { Label("Share Link…", systemImage: "link") }
            }
        }
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

    // MARK: - Links

    /// Share Link… for a file, where the server says its links are this
    /// account's to manage; nil where they are not, and nothing is offered.
    private func shareAction(_ file: FileItem) -> (() -> Void)? {
        session.mayLink(file) ? { linking = .file(file) } : nil
    }

    /// Share Link… for a folder, likewise (the tree's `share`).
    private func shareAction(_ node: FolderNode) -> (() -> Void)? {
        guard session.mayLink(node), !selecting else { return nil }
        return { linking = .folder(path: node.folder, place: route.place) }
    }

    /// A folder's long-press menu: a link to it, where one is theirs to
    /// make or manage. With nothing to offer, no menu at all.
    @ViewBuilder private func folderMenu(_ node: FolderNode) -> some View {
        if route.place.role != "viewer" {
            Button { tagging = node } label: { Label("Tags & Metadata…", systemImage: "tag") }
        }
        starButton(node)
        if let share = shareAction(node) {
            Button(action: share) { Label("Share Link…", systemImage: "link") }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        // The name in the bar only once the headline has scrolled away.
        ToolbarItem(placement: .principal) {
            Text(selecting ? selectionTitle : title)
                .font(.headline)
                .lineLimit(1)
                .opacity(selecting || titleGone ? 1 : 0)
                .animation(Theme.motion(.quick), value: titleGone)
                .accessibilityHidden(!(selecting || titleGone))
        }
        if !selecting, let parentName {
            ToolbarItem(placement: .topBarLeading) {
                ParentChip(name: parentName, top: parentIsTop, place: route.place.name, home: topAction) { dismiss() }
            }
        }
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
            if let collection, collection.canEdit == true {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { editingCollection = collection }
                }
            }
            if !route.folder.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    let starred = session.isStarred(route)
                    Button { star(route, !starred) } label: {
                        Image(systemName: starred ? "star.fill" : "star")
                            .bounce(on: starred)
                    }
                    .sensoryFeedback(.impact(weight: .light), trigger: starred)
                    .accessibilityLabel(starred ? "Remove from Starred" : "Add to Starred")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Select") { selecting = true }
                    .disabled(listing.files.isEmpty)
            }
            ToolbarItem(placement: .topBarTrailing) {
                ViewOptions(layout: $layout, sort: $sort, share: listing.current.flatMap { shareAction($0) })
            }
        }
    }

    // MARK: - States

    @ViewBuilder private var overlay: some View {
        switch listing.phase {
        case .idle, .loading:
            if listing.isEmpty { ProgressView().controlSize(.large) }
        case let .failed(words):
            EmptyState(symbol: "exclamationmark.triangle", title: "Can't Open \(title)", message: words,
                       action: ("Try Again", { Task { await listing.load(session, sort: sort, query: query, refresh: true) } }))
        case .loaded:
            if listing.isEmpty {
                if query.isEmpty {
                    EmptyState(symbol: "folder", title: "Nothing Here Yet",
                               message: "Files added on the web or from a Mac appear here.")
                } else {
                    EmptyState(symbol: "magnifyingglass", title: "No Results",
                               message: "Nothing in \(title) matches “\(query)”.")
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

/// The folder this one is in, as a pill beside the back chevron: a tap goes
/// up to it — with a house when that is the drive's top. Further down, the
/// pill leads with ⌂ (`home`), its own button, which goes to the drive's top
/// (`place`) in one tap. Liquid Glass draws the pill on iOS 26; before it, a
/// frosted one.
private struct ParentChip: View {
    let name: String
    var top = false
    var place = ""
    var home: (() -> Void)? = nil
    let action: () -> Void

    /// Its own width, whatever the toolbar offers: on iOS 26 the toolbar
    /// squeezed a pill in the back button's group to "F…". A long name is
    /// shortened here instead, so the pill never crowds the title.
    private var shown: String { name.count > 22 ? String(name.prefix(20)) + "…" : name }

    /// Beside ⌂ the name gets at most this many points, and is cut to fit
    /// them: any wider and an iPhone's bar moved Select into its overflow ⋯.
    /// The whole name is still in Back's long press.
    private static let besideHome: CGFloat = 56

    var body: some View {
        HStack(spacing: 0) {
            if let home {
                Button(action: home) {
                    Image(systemName: "house")
                        .font(.subheadline.weight(.semibold))
                        .padding(.leading, Theme.liquidGlass ? 0 : 10)
                        .padding(.trailing, 6)
                        .padding(.vertical, Theme.liquidGlass ? 0 : 7)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(place), the top folder")
                Rectangle()
                    .fill(.secondary.opacity(0.5))
                    .frame(width: 1, height: 14)
            }
            upButton
        }
        .background {
            if !Theme.liquidGlass, home != nil { Capsule().fill(Color.white.opacity(0.12)) }
        }
    }

    private var upButton: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if top { Image(systemName: "house").imageScale(.small) }
                Text(shown)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: home == nil ? nil : Self.besideHome, alignment: .leading)
            }
                .font(.subheadline.weight(.semibold))
                .fixedSize()
                .padding(.leading, home == nil ? (Theme.liquidGlass ? 6 : 14) : 6)
                .padding(.trailing, Theme.liquidGlass ? 6 : 14)
                .padding(.vertical, Theme.liquidGlass ? 0 : 7)
                .background {
                    if !Theme.liquidGlass, home == nil { Capsule().fill(Color.white.opacity(0.12)) }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(top ? "Up to \(name), the top folder" : "Up to \(name)")
    }
}

/// Icons or a list, and the order: the folder's ⋯ menu — and, where the
/// folder's links are this account's, Share Link… for the folder itself.
private struct ViewOptions: View {
    @Binding var layout: BrowserLayout
    @Binding var sort: FileSort
    var share: (() -> Void)?

    var body: some View {
        Menu {
            if let share {
                Section {
                    Button(action: share) { Label("Share Link…", systemImage: "link") }
                }
            }
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
                .accessibilityLabel(share == nil ? "View Options" : "More")
        }
    }
}
