import OnyxKit
import SwiftUI

/// Signed out: the sign-in. Signed in: Home, Search and Browse, under a
/// floating glass tab bar.
struct RootView: View {
    @Environment(Session.self) private var session

    var body: some View {
        switch session.phase {
        case .signedOut: SignInView()
        case .signedIn: MainTabs()
        }
    }
}

/// A folder within a place ("" is its top) — or, with a `collection`, that
/// collection's files from the whole place instead.
struct FolderRoute: Hashable {
    let place: Place
    let folder: String
    var collection: CollectionRef? = nil
}

/// Which collection a route lists, and what to call it.
struct CollectionRef: Hashable {
    let id: String
    let name: String
}

/// The app's three places to be.
enum AppTab: String, CaseIterable, Identifiable {
    case home, search, browse

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "Home"
        case .search: "Search"
        case .browse: "Browse"
        }
    }

    func symbol(selected: Bool) -> String {
        switch self {
        case .home: selected ? "house.fill" : "house"
        case .search: "magnifyingglass"
        case .browse: selected ? "circle.grid.2x2.fill" : "circle.grid.2x2"
        }
    }
}

/// What the frame around the tabs should know of the screen in it.
@MainActor @Observable
final class AppChrome {
    /// Files are being chosen: their bar takes the tab bar's place.
    var selecting = false
}

/// The tabs, each keeping its own place, under a tab bar of our own — a
/// dark glass pill of three line icons that floats over the content — and
/// the download tray above it. On an iPhone Duo the pill stands down the
/// right edge instead, with the status bar and the system's own bars.
struct MainTabs: View {
    @State private var tab: AppTab = .home
    @State private var chrome = AppChrome()
    /// The place open in Browse, which Home's cards can open.
    @State private var place: Place?
    /// The status bar stands in a column down the right edge — an iPhone
    /// Duo's, open or closed (iOS 27.1) — and the tab bar stands there too.
    @State private var sideRail = false

    var body: some View {
        TabView(selection: $tab) {
            Tab(AppTab.home.title, systemImage: AppTab.home.symbol(selected: false), value: AppTab.home) {
                HomeView(open: { opened in
                    place = opened
                    tab = .browse
                }, search: { tab = .search })
                .toolbar(.hidden, for: .tabBar)
            }
            Tab(AppTab.search.title, systemImage: AppTab.search.symbol(selected: false), value: AppTab.search) {
                SearchView()
                    .toolbar(.hidden, for: .tabBar)
            }
            Tab(AppTab.browse.title, systemImage: AppTab.browse.symbol(selected: false), value: AppTab.browse) {
                Browser(place: $place)
                    .toolbar(.hidden, for: .tabBar)
            }
        }
        .environment(chrome)
        // The column shows as a right inset wider than the top's (and than
        // the left's, which an iPhone on its side has as wide).
        .onGeometryChange(for: Bool.self) { proxy in
            let inset = proxy.safeAreaInsets
            return inset.trailing > max(inset.top, inset.leading) + 20
        } action: { sideRail = $0 }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
                DownloadTray()
                if !sideRail, !chrome.selecting {
                    FloatingTabBar(selection: $tab)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(.bottom, 2)
            .animation(.spring(duration: 0.3, bounce: 0.15), value: chrome.selecting)
            // Bent, an iPhone Duo's fold would run through the middle of
            // the pill: it moves into one half.
            .clearOfFold()
            // Typing, the keyboard covers the bar rather than lifting it.
            .ignoresSafeArea(.keyboard, edges: .bottom)
        }
        // On an iPhone Duo the pill stands at the foot of the status bar's
        // column, in line below the system's own buttons there (48 points
        // wide, 24 in from the screen's edge): clear of the content and of
        // the fold, and the screen's whole height left to it.
        .overlay {
            ZStack {
                if sideRail, !chrome.selecting {
                    FloatingTabBar(selection: $tab, axis: .vertical)
                        .padding(.trailing, 24)
                        .padding(.bottom, 10)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            .ignoresSafeArea(.container, edges: .trailing)
            .ignoresSafeArea(.keyboard, edges: .bottom)
            .animation(.spring(duration: 0.3, bounce: 0.15), value: chrome.selecting)
        }
    }
}

/// Home, Search, Browse: a dark glass pill of monochrome line icons, the
/// chosen one lit.
struct FloatingTabBar: View {
    @Binding var selection: AppTab
    /// Across, or standing down the side as on an iPhone Duo.
    var axis: Axis = .horizontal
    @Namespace private var lit
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let stack = axis == .horizontal ? AnyLayout(HStackLayout(spacing: 2)) : AnyLayout(VStackLayout(spacing: 2))
        stack {
            ForEach(AppTab.allCases) { tab in
                let chosen = selection == tab
                Button {
                    selection = tab
                } label: {
                    Image(systemName: tab.symbol(selected: chosen))
                        .font(.system(size: 19, weight: chosen ? .semibold : .regular))
                        .foregroundStyle(chosen ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .frame(width: axis == .horizontal ? 62 : 38, height: axis == .horizontal ? 46 : 52)
                        .background {
                            if chosen {
                                Capsule()
                                    .fill(Color.white.opacity(0.14))
                                    .matchedGeometryEffect(id: "lit", in: lit)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(chosen ? .isSelected : [])
            }
        }
        .padding(5)
        .glassSurface(Capsule())
        .shadow(color: .black.opacity(0.55), radius: 22, y: 10)
        .animation(reduceMotion ? nil : .spring(duration: 0.32, bounce: 0.22), value: selection)
    }
}

/// Browse: the drives, and the folder open beside them — side by side on
/// an iPad and an open iPhone Duo, one after the other on an iPhone.
private struct Browser: View {
    @Binding var place: Place?
    @Environment(Session.self) private var session
    @Environment(\.horizontalSizeClass) private var width
    @State private var path: [FolderRoute] = []
    /// A starred folder's way down, waiting for its place to open.
    @State private var pending: [FolderRoute]?
    /// Which column an iPhone shows: a star opened goes to the folder.
    @State private var column = NavigationSplitViewColumn.sidebar
    /// All of Browse, which side by side its columns' auras are parts of.
    @State private var canvas: CGRect?

    /// The place open: the one chosen — or, side by side with none chosen,
    /// the first drive rather than an empty half of the screen. That one
    /// isn't selected, so one after the other (an iPhone, a closed iPhone
    /// Duo) the list comes first, unless someone had gone into it.
    private var shown: Place? {
        place ?? (width == .regular ? session.drives.first : path.first?.place)
    }

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            PlacesView(selection: $place, beside: width == .regular ? shown : nil, open: open)
        } detail: {
            if let shown {
                NavigationStack(path: $path) {
                    FolderView(route: FolderRoute(place: shown, folder: ""))
                        .navigationDestination(for: FolderRoute.self) { FolderView(route: $0) }
                }
                // Another place starts from its top — or, opened from a
                // star, at its folder. Set once the stack is there: a path
                // set before it appears is lost.
                .id(shown.id)
                .onAppear {
                    if let trail = pending {
                        pending = nil
                        path = trail
                    }
                }
            } else {
                ContentUnavailableView("Choose a drive", systemImage: "externaldrive",
                                       description: Text("Its folders and files open here."))
                    .onyxStyle()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background { AuraBackground() }
            }
        }
        // Side by side — an iPad, an open iPhone Duo — the list and the
        // folder are lit by one aura, not one each with a seam between them.
        .environment(\.auraCanvas, width == .regular ? canvas : nil)
        .background {
            Color.clear
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { canvas = $0 }
                .ignoresSafeArea()
        }
        // Another place starts from its top; the one already open keeps the
        // folder it is in.
        .onChange(of: place) { if path.first?.place != place { path = [] } }
        // An iPhone Duo closing goes from side by side to one after the
        // other: the folder that was open stays on screen — in the first
        // drive too, once someone has gone into it.
        .onChange(of: width) {
            guard width == .compact else { return }
            if place == nil, let opened = path.first?.place { place = opened }
            if place != nil { column = .detail }
        }
    }

    /// Open a starred folder: its place, then each folder on the way down to
    /// it, so Back climbs out one level at a time.
    private func open(_ route: FolderRoute) {
        let parts = route.folder.split(separator: "/").map(String.init)
        // A collection is one screen; a folder brings the ones above it.
        let trail = route.collection != nil ? [route] : parts.indices.map { i in
            FolderRoute(place: route.place, folder: parts[...i].joined(separator: "/"))
        }
        if shown == route.place {
            place = route.place
            path = trail
        } else {
            pending = trail
            place = route.place
        }
        column = .detail
    }
}
