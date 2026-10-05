import OnyxKit
import SwiftUI

/// Browse: the drives this account belongs to, and All Files, each a card
/// in its own colour with what it holds, then the folders starred in any of
/// them — the sidebar on an iPad, the first screen of Browse on an iPhone.
struct PlacesView: View {
    @Environment(Session.self) private var session
    @Environment(\.horizontalSizeClass) private var width
    @Binding var selection: Place?
    /// A starred folder chosen: open it, in its place.
    var open: (FolderRoute) -> Void = { _ in }
    @State private var makingCollection = false

    /// Collections in a place this account can open, each with that place,
    /// by place then name: a new one takes its place among its drive's.
    private var gathered: [(collection: FileCollection, place: Place)] {
        session.collections.compactMap { c in session.place(for: c.scope).map { (c, $0) } }
            .sorted {
                let byPlace = $0.place.name.localizedStandardCompare($1.place.name)
                if byPlace != .orderedSame { return byPlace == .orderedAscending }
                // Two drives of one name stay apart.
                if $0.place.id != $1.place.id { return $0.place.id < $1.place.id }
                return $0.collection.name.localizedStandardCompare($1.collection.name) == .orderedAscending
            }
    }

    /// Stars in a place this account can open, each with that place.
    private var starred: [(star: FolderStar, place: Place)] {
        session.stars.compactMap { star in session.place(for: star).map { (star, $0) } }
    }

    var body: some View {
        List(selection: $selection) {
            EditorialTitle(text: "Browse", subtitle: subtitle)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 16, leading: 20, bottom: 14, trailing: 20))
                .selectionDisabled()
            if session.placesLoaded {
                ForEach(session.places) { place in
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
                if !gathered.isEmpty || !session.placesForNewCollections.isEmpty {
                    SectionHeading(title: "Collections",
                                   action: session.placesForNewCollections.isEmpty ? nil : ("New", { makingCollection = true }))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 22, leading: 20, bottom: 6, trailing: 20))
                        .selectionDisabled()
                    ForEach(gathered, id: \.collection) { item in
                        Button {
                            open(FolderRoute(place: item.place, folder: "",
                                             collection: CollectionRef(id: item.collection.id, name: item.collection.name)))
                        } label: {
                            CollectionRow(collection: item.collection, place: item.place)
                        }
                        .buttonStyle(.plain)
                        .selectionDisabled()
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                        .listRowBackground(PlaceCard().padding(.horizontal, 16).padding(.vertical, 5))
                    }
                }
                if !starred.isEmpty {
                    SectionHeading(title: "Starred")
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 22, leading: 20, bottom: 6, trailing: 20))
                        .selectionDisabled()
                    ForEach(starred, id: \.star) { item in
                        let route = FolderRoute(place: item.place, folder: item.star.folder)
                        // A button, not a selection: it is a folder within a
                        // place, and the list selects places.
                        Button { open(route) } label: { StarRow(star: item.star, place: item.place) }
                            .buttonStyle(.plain)
                            .selectionDisabled()
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                            .listRowBackground(PlaceCard().padding(.horizontal, 16).padding(.vertical, 5))
                            .contextMenu {
                                Button(role: .destructive) {
                                    Task { _ = await session.setStarred(route, false) }
                                } label: {
                                    Label("Remove from Starred", systemImage: "star.slash")
                                }
                            }
                            .swipeActions {
                                Button("Unstar", systemImage: "star.slash") {
                                    Task { _ = await session.setStarred(route, false) }
                                }
                                .tint(.orange)
                            }
                    }
                }
            }
        }
        .listStyle(.plain)
        .sheet(isPresented: $makingCollection) {
            CollectionEditor(existing: nil) { saved, place in
                open(FolderRoute(place: place, folder: "", collection: CollectionRef(id: saved.id, name: saved.name)))
            }
        }
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
        let drives = count == 1 ? "1 drive" : "\(count) drives"
        if session.drivesOnly { return count == 0 ? "No drives yet" : drives }
        return count == 0 ? "All Files" : "\(drives), and All Files"
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

/// A collection: its name, and the place whose files it gathers.
private struct CollectionRow: View {
    let collection: FileCollection
    let place: Place

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(place.cardFill)
                .frame(width: 50, height: 50)
                .overlay {
                    Image(systemName: "square.stack.3d.up.fill")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(.white.opacity(0.16), lineWidth: 0.5)
                }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(collection.name)
                    .font(.headline)
                    .lineLimit(1)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        let n = collection.rules.count
        return "\(place.name) · \(n == 1 ? "1 rule" : "\(n) rules")"
    }
}

/// A starred folder: its name, and the place it is in.
private struct StarRow: View {
    let star: FolderStar
    let place: Place

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(place.cardFill)
                .frame(width: 50, height: 50)
                .overlay {
                    Image(systemName: "star.fill")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(.white.opacity(0.16), lineWidth: 0.5)
                }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(star.name)
                    .font(.headline)
                    .lineLimit(1)
                Text(place.name)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
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
