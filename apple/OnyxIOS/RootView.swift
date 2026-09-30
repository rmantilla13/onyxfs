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

/// A folder within a place ("" is its top).
struct FolderRoute: Hashable {
    let place: Place
    let folder: String
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
/// the download tray above it.
struct MainTabs: View {
    @State private var tab: AppTab = .home
    @State private var chrome = AppChrome()
    /// The place open in Browse, which Home's cards can open.
    @State private var place: Place?

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
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 10) {
                DownloadTray()
                if !chrome.selecting {
                    FloatingTabBar(selection: $tab)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(.bottom, 2)
            .animation(.spring(duration: 0.3, bounce: 0.15), value: chrome.selecting)
            // Typing, the keyboard covers the bar rather than lifting it.
            .ignoresSafeArea(.keyboard, edges: .bottom)
        }
    }
}

/// Home, Search, Browse: a dark glass pill of monochrome line icons, the
/// chosen one lit.
struct FloatingTabBar: View {
    @Binding var selection: AppTab
    @Namespace private var lit
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(AppTab.allCases) { tab in
                let chosen = selection == tab
                Button {
                    selection = tab
                } label: {
                    Image(systemName: tab.symbol(selected: chosen))
                        .font(.system(size: 19, weight: chosen ? .semibold : .regular))
                        .foregroundStyle(chosen ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .frame(width: 62, height: 46)
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
/// an iPad, one after the other on an iPhone.
private struct Browser: View {
    @Binding var place: Place?
    @Environment(Session.self) private var session
    @Environment(\.horizontalSizeClass) private var width
    @State private var path: [FolderRoute] = []
    /// A starred folder's way down, waiting for its place to open.
    @State private var pending: [FolderRoute]?
    /// Which column an iPhone shows: a star opened goes to the folder.
    @State private var column = NavigationSplitViewColumn.sidebar

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            PlacesView(selection: $place, open: open)
        } detail: {
            if let place {
                NavigationStack(path: $path) {
                    FolderView(route: FolderRoute(place: place, folder: ""))
                        .navigationDestination(for: FolderRoute.self) { FolderView(route: $0) }
                }
                // Another place starts from its top — or, opened from a
                // star, at its folder. Set once the stack is there: a path
                // set before it appears is lost.
                .id(place.id)
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
        .onChange(of: place) { path = [] }
        // Side by side, the first drive is open rather than an empty half of
        // the screen; one after the other (an iPhone), the list comes first.
        .onChange(of: session.drives, initial: true) {
            if width == .regular, place == nil { place = session.drives.first }
        }
    }

    /// Open a starred folder: its place, then each folder on the way down to
    /// it, so Back climbs out one level at a time.
    private func open(_ route: FolderRoute) {
        let parts = route.folder.split(separator: "/").map(String.init)
        let trail = parts.indices.map { i in
            FolderRoute(place: route.place, folder: parts[...i].joined(separator: "/"))
        }
        if place == route.place {
            path = trail
        } else {
            pending = trail
            place = route.place
        }
        column = .detail
    }
}
