import OnyxKit
import SwiftUI

/// The drives this account belongs to, and All Files — the sidebar on an
/// iPad, the first screen on an iPhone.
struct PlacesView: View {
    @Environment(Session.self) private var session
    @Environment(\.horizontalSizeClass) private var width
    @Binding var selection: Place?
    @State private var showingAccount = false

    var body: some View {
        List(selection: $selection) {
            if !session.drives.isEmpty {
                Section("Drives") {
                    ForEach(session.drives) { place in
                        NavigationLink(value: place) { PlaceRow(place: place, chosen: chosen(place)) }
                            .glassRow(selected: chosen(place))
                    }
                }
            }
            if session.placesLoaded {
                Section {
                    NavigationLink(value: Place.library) { PlaceRow(place: .library, chosen: chosen(.library)) }
                        .glassRow(selected: chosen(.library))
                } footer: {
                    if session.drives.isEmpty {
                        Text("Drives you're added to on the web appear here.")
                    }
                }
            }
        }
        .auraBackground()
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
                            .buttonStyle(BrandButtonStyle())
                    }
                    .onyxStyle()
                } else {
                    ProgressView().controlSize(.large)
                }
            }
        }
        .refreshable { await session.loadPlaces() }
        .task { if !session.placesLoaded { await session.loadPlaces() } }
        .sheet(isPresented: $showingAccount) { AccountView() }
    }

    /// Side by side (an iPad), the place open beside the list is marked in
    /// it; one after the other, nothing stays chosen once it is left.
    private func chosen(_ place: Place) -> Bool {
        width == .regular && selection == place
    }
}

private struct PlaceRow: View {
    let place: Place
    var chosen = false

    var body: some View {
        HStack(spacing: 12) {
            SymbolChip(systemName: place.isLibrary ? "square.grid.2x2.fill" : "externaldrive.fill",
                       tint: place.tint, chosen: chosen, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(place.name)
                    .font(.body.weight(chosen ? .semibold : .regular))
                    .lineLimit(1)
                if let role = roleName {
                    Text(role).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    /// What this account is in the drive, when that limits it.
    private var roleName: String? {
        switch place.role {
        case "viewer": return "View only"
        default: return nil
        }
    }
}

extension Place {
    /// The drive's own colour, as the web's dot beside its name and the
    /// Mac's disk icon have it; the accent for All Files, or a drive the
    /// server gave none.
    var tint: Color {
        color.flatMap(Color.init(hex:)) ?? .accentColor
    }
}
