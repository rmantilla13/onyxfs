import OnyxKit
import SwiftUI

/// The drives this account belongs to, All Files, and the folders starred
/// on any of them — the sidebar on an iPad, the first screen on an iPhone.
struct PlacesView: View {
    @Environment(Session.self) private var session
    @Binding var selection: Place?
    /// A starred folder chosen: open it, in its place.
    var open: (FolderRoute) -> Void = { _ in }
    @State private var showingAccount = false

    /// Stars in a place this account can open, each with that place.
    private var starred: [(star: FolderStar, place: Place)] {
        session.stars.compactMap { star in session.place(for: star).map { (star, $0) } }
    }

    var body: some View {
        List(selection: $selection) {
            if !starred.isEmpty {
                Section("Starred") {
                    ForEach(starred, id: \.star) { item in
                        // A button, not a selection: it is a folder within a
                        // place, and the list selects places.
                        Button { open(FolderRoute(place: item.place, folder: item.star.folder)) } label: {
                            StarRow(star: item.star, place: item.place)
                        }
                        .foregroundStyle(.primary)
                        .contextMenu {
                            Button(role: .destructive) {
                                Task { _ = await session.setStarred(FolderRoute(place: item.place, folder: item.star.folder), false) }
                            } label: {
                                Label("Remove from Starred", systemImage: "star.slash")
                            }
                        }
                        .swipeActions {
                            Button("Unstar", systemImage: "star.slash") {
                                Task { _ = await session.setStarred(FolderRoute(place: item.place, folder: item.star.folder), false) }
                            }
                            .tint(.orange)
                        }
                    }
                }
            }
            if !session.drives.isEmpty {
                Section("Drives") {
                    ForEach(session.drives) { place in
                        NavigationLink(value: place) { PlaceRow(place: place) }
                    }
                }
            }
            if session.placesLoaded {
                Section {
                    NavigationLink(value: Place.library) { PlaceRow(place: .library) }
                } footer: {
                    if session.drives.isEmpty {
                        Text("Drives you're added to on the web appear here.")
                    }
                }
            }
        }
        .navigationTitle("Onyx")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingAccount = true
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Account")
            }
        }
        .overlay {
            if !session.placesLoaded {
                if let problem = session.problem, !session.loadingPlaces {
                    ContentUnavailableView {
                        Label("Can't Load Your Drives", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(problem)
                    } actions: {
                        Button("Try Again") { Task { await session.loadPlaces() } }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .refreshable { await session.loadPlaces() }
        .task { if !session.placesLoaded { await session.loadPlaces() } }
        .sheet(isPresented: $showingAccount) { AccountView() }
    }
}

private struct StarRow: View {
    let star: FolderStar
    let place: Place

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(star.name).lineLimit(1)
                Text(place.name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        } icon: {
            Image(systemName: "star.fill").foregroundStyle(.yellow)
        }
    }
}

private struct PlaceRow: View {
    let place: Place

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(place.name).lineLimit(1)
                if let role = roleName {
                    Text(role).font(.caption).foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: place.isLibrary ? "square.grid.2x2" : "externaldrive.fill")
                .foregroundStyle(.tint)
        }
    }

    /// What this account is in the drive, when that limits it.
    private var roleName: String? {
        switch place.role {
        case "viewer": return "View only"
        default: return nil
        }
    }
}
