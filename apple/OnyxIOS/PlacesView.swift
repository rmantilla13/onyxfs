import OnyxKit
import SwiftUI

/// The drives this account belongs to, and All Files — the sidebar on an
/// iPad, the first screen on an iPhone.
struct PlacesView: View {
    @Environment(Session.self) private var session
    @Binding var selection: Place?
    @State private var showingAccount = false

    var body: some View {
        List(selection: $selection) {
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
