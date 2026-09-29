import OnyxKit
import SwiftUI

/// Browse: the drives this account belongs to, and All Files, each a card
/// in its own colour with what it holds — the sidebar on an iPad, the first
/// screen of Browse on an iPhone.
struct PlacesView: View {
    @Environment(Session.self) private var session
    @Environment(\.horizontalSizeClass) private var width
    @Binding var selection: Place?

    var body: some View {
        List(selection: $selection) {
            EditorialTitle(text: "Browse", subtitle: subtitle)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 16, leading: 20, bottom: 14, trailing: 20))
                .selectionDisabled()
            if session.placesLoaded {
                ForEach(session.drives + [Place.library]) { place in
                    NavigationLink(value: place) {
                        PlaceRow(place: place, usage: session.usage[place.id])
                    }
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    .listRowBackground(PlaceCard(chosen: chosen(place)).padding(.horizontal, 16).padding(.vertical, 5))
                }
                if session.drives.isEmpty {
                    Text("Drives you're added to on the web appear here.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .selectionDisabled()
                }
            }
        }
        .listStyle(.plain)
        .auraBackground()
        .toolbar(.hidden, for: .navigationBar)
        .navigationTitle("Browse")
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
        .refreshable {
            await session.loadPlaces()
            await session.loadOverview(refresh: true)
        }
        .task {
            if !session.placesLoaded { await session.loadPlaces() }
            await session.loadOverview()
        }
    }

    private var subtitle: String? {
        guard session.placesLoaded else { return nil }
        let count = session.drives.count
        return count == 0 ? "All Files" : (count == 1 ? "1 drive, and All Files" : "\(count) drives, and All Files")
    }

    /// Side by side (an iPad), the place open beside the list is marked in
    /// it; one after the other, nothing stays chosen once it is left.
    private func chosen(_ place: Place) -> Bool {
        width == .regular && selection == place
    }
}

/// A place's card behind its row: near-black, lit in the brand's
/// selection tint and ringed when it is the one open beside the list.
private struct PlaceCard: View {
    var chosen = false
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
        shape.fill(reduceTransparency ? Theme.surface : Theme.card)
            .overlay { if chosen { shape.fill(Theme.selection) } }
            .overlay {
                if chosen {
                    shape.strokeBorder(Theme.brand, lineWidth: 1.5)
                } else {
                    shape.strokeBorder(Theme.edge, lineWidth: 0.5)
                }
            }
    }
}

private struct PlaceRow: View {
    let place: Place
    let usage: PlaceUsage?

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(place.cardFill)
                .frame(width: 50, height: 50)
                .overlay {
                    Image(systemName: place.isLibrary ? "square.grid.2x2.fill" : "folder.fill")
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(.white.opacity(0.16), lineWidth: 0.5)
                }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(place.name)
                    .font(.headline)
                    .lineLimit(1)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        var parts: [String] = []
        if place.isLibrary { parts.append("Everything you can see") }
        if place.role == "viewer" { parts.append("View only") }
        if let usage {
            parts.append(usage.files == 1 ? "1 file" : "\(usage.files.formatted()) files")
            if let size = SavePlan.size(usage.bytes) { parts.append(size) }
        }
        return parts.isEmpty ? "Drive" : parts.joined(separator: " · ")
    }
}
