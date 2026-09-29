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

    var body: some View {
        NavigationSplitView {
            PlacesView(selection: $place)
        } detail: {
            if let place {
                NavigationStack(path: $path) {
                    FolderView(route: FolderRoute(place: place, folder: ""))
                        .navigationDestination(for: FolderRoute.self) { FolderView(route: $0) }
                }
                // Another place starts from its top.
                .id(place.id)
            } else {
                ContentUnavailableView("Choose a drive", systemImage: "externaldrive",
                                       description: Text("Its folders and files open here."))
                    .onyxStyle()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background { AuraBackground() }
            }
        }
        // What is being saved, under every folder; a file open full screen
        // shows its own (PreviewView).
        .safeAreaInset(edge: .bottom, spacing: 0) { DownloadTray() }
        .onChange(of: place) { path = [] }
        // Side by side, the first drive is open rather than an empty half of
        // the screen; one after the other (an iPhone), the list comes first.
        .onChange(of: session.drives, initial: true) {
            if width == .regular, place == nil { place = session.drives.first }
        }
    }
}
