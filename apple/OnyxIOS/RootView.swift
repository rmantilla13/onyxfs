import OnyxKit
import SwiftUI

/// Signed out: the sign-in. Signed in: the places in a sidebar, and the
/// folder open beside it — side by side on an iPad, one after the other on
/// an iPhone.
struct RootView: View {
    @Environment(Session.self) private var session

    var body: some View {
        switch session.phase {
        case .signedOut: SignInView()
        case .signedIn: Browser()
        }
    }
}

/// A folder within a place ("" is its top).
struct FolderRoute: Hashable {
    let place: Place
    let folder: String
}

private struct Browser: View {
    @Environment(Session.self) private var session
    @Environment(\.horizontalSizeClass) private var width
    @State private var place: Place?
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
