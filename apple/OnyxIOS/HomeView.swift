import OnyxKit
import SwiftUI

/// Home: a greeting, each drive as a card in its own colour with what it
/// holds, where the space goes, and the files that came in last — each
/// with the ways to save it.
///
/// Everything here is read as a member reads it: the drives this account
/// belongs to, their totals as the listing counts them (only the files it
/// may see), and the newest of those files.
struct HomeView: View {
    /// Opens a place in Browse.
    let open: (Place) -> Void
    /// Goes to Search.
    let search: () -> Void
    @Environment(Session.self) private var session
    @State private var recent: [FileItem] = []
    @State private var recentLoaded = false
    @State private var recentProblem: String?
    @State private var previewing: FileItem?
    @State private var inspecting: FileItem?
    @State private var showingAccount = false
    @State private var showingAll = false
    @Namespace private var zoom

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    header
                    driveCards
                    storage
                    recentFiles
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 28)
            }
            .scrollIndicators(.hidden)
            .background { AuraBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await load(refresh: true) }
            .task { await load() }
            .navigationDestination(isPresented: $showingAll) { RecentFilesView() }
        }
        .fullScreenCover(item: $previewing) { file in
            PreviewView(files: recent, startID: file.id)
                .navigationTransition(.zoom(sourceID: file.id, in: zoom))
        }
        .sheet(item: $inspecting) { FileInfoView(file: $0, place: nil) }
        .sheet(isPresented: $showingAccount) { AccountView() }
    }

    private func load(refresh: Bool = false) async {
        if !session.placesLoaded || refresh { await session.loadPlaces() }
        async let overview: Void = session.loadOverview(refresh: refresh)
        async let files: Void = loadRecent()
        _ = await (overview, files)
    }

    private func loadRecent() async {
        do {
            recent = try await session.api.recentFiles(limit: 8).files
            recentProblem = nil
        } catch {
            if !Session.isCancel(error) { recentProblem = session.explain(error) }
        }
        recentLoaded = true
    }

    // MARK: - Hello

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Greeting(name: session.identity?.firstName)
            Spacer(minLength: 8)
            HStack(spacing: 10) {
                RoundIconButton(systemName: "magnifyingglass", label: "Search", action: search)
                Button { showingAccount = true } label: {
                    Avatar(initial: avatarInitial)
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("Account")
            }
            .padding(.top, 4)
        }
    }

    private var avatarInitial: String {
        let source = session.identity?.firstName ?? session.email ?? "?"
        return source.prefix(1).uppercased()
    }

    // MARK: - Drives

    private var driveCards: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 14) {
                if session.placesLoaded {
                    ForEach(session.drives) { place in
                        DriveCard(place: place, usage: session.usage[place.id]) { open(place) }
                    }
                    DriveCard(place: .library, usage: session.usage[Place.library.id]) { open(.library) }
                } else {
                    ForEach(0..<3, id: \.self) { _ in
                        DriveCard(place: .library, usage: nil) {}
                            .redacted(reason: .placeholder)
                            .disabled(true)
                    }
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, 20)
            .padding(.vertical, 6)
        }
        .scrollIndicators(.hidden)
        .scrollTargetBehavior(.viewAligned)
        .scrollClipDisabled()
        .padding(.horizontal, -20)
    }

    // MARK: - Storage

    @ViewBuilder private var storage: some View {
        if let summary = StorageSummary(drives: session.drives, usage: session.usage) {
            StorageCard(summary: summary)
        } else if session.placesLoaded {
            StorageCard(summary: .placeholder)
                .redacted(reason: .placeholder)
        }
    }

    // MARK: - Recent

    private var recentFiles: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeading(title: "Recent Files", action: recent.isEmpty ? nil : ("See All", { showingAll = true }))
            if !recentLoaded {
                ForEach(0..<3, id: \.self) { _ in
                    PlaceholderRow()
                }
            } else if let recentProblem, recent.isEmpty {
                Label(recentProblem, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .symbolRenderingMode(.multicolor)
                    .foregroundStyle(.secondary)
            } else if recent.isEmpty {
                Text("Files added on the web or from a Mac show up here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 12) {
                    ForEach(recent.prefix(6)) { file in
                        FileListRow(file: file, open: { previewing = file }, info: { inspecting = file })
                            .matchedTransitionSource(id: file.id, in: zoom)
                    }
                }
            }
        }
    }
}

/// "Hello, / Ricky", large; "Good evening" for an address that names no one.
private struct Greeting: View {
    let name: String?
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 40

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let name {
                Text("Hello,")
                    .font(.system(size: size * 0.82, weight: .regular))
                    .foregroundStyle(.secondary)
                Text(name)
                    .font(.system(size: size, weight: .bold))
                    .tracking(-size * 0.025)
            } else {
                Text(Self.timeOfDay)
                    .font(.system(size: size, weight: .bold))
                    .tracking(-size * 0.025)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    static var timeOfDay: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: "Good morning"
        case 12..<18: "Good afternoon"
        default: "Good evening"
        }
    }
}

/// The account's initial on the brand gradient (the web's .avatar).
private struct Avatar: View {
    let initial: String
    var size: CGFloat = 46

    var body: some View {
        Text(initial)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(Theme.onAura)
            .frame(width: size, height: size)
            .background(BrandFill(shape: Circle(), glow: false))
    }
}

/// A drive as a card in its own colour: its name, what it holds, and a
/// big folder glyph caught at the corner.
private struct DriveCard: View {
    let place: Place
    let usage: PlaceUsage?
    let action: () -> Void
    @ScaledMetric(relativeTo: .title3) private var width: CGFloat = 158

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
                    .fill(place.cardFill)
                Image(systemName: place.isLibrary ? "square.grid.2x2.fill" : "folder.fill")
                    .font(.system(size: width * 0.6, weight: .regular))
                    .foregroundStyle(.white.opacity(0.2))
                    .rotationEffect(.degrees(-12))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .offset(x: width * 0.12, y: width * 0.1)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(place.name)
                        .font(.title3.weight(.bold))
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    Text(sizeText)
                        .font(.subheadline.weight(.semibold))
                        .opacity(0.9)
                    Text(filesText)
                        .font(.footnote)
                        .opacity(0.75)
                }
                .foregroundStyle(.white)
                .padding(18)
            }
            .frame(width: width, height: width * 1.18)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous))
            .overlay {
                // The web's glaze: a sheen across the top, a lit rim.
                RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
                    .fill(LinearGradient(colors: [.white.opacity(0.16), .white.opacity(0)],
                                         startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.42)))
                    .allowsHitTesting(false)
                RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
                    .strokeBorder(.white.opacity(0.16), lineWidth: 1)
            }
            .shadow(color: place.tint.opacity(0.28), radius: 18, y: 10)
        }
        .buttonStyle(PressableStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens it in Browse")
    }

    private var sizeText: String {
        guard let usage else { return "—" }
        return SavePlan.size(usage.bytes) ?? FileFormat.items(usage.files)
    }

    private var filesText: String {
        guard let usage else { return " " }
        return usage.files == 1 ? "1 file" : "\(usage.files.formatted()) files"
    }
}

/// Where the space goes: each drive's share of what this account can see,
/// and whatever is in no drive.
struct StorageSummary {
    struct Part: Identifiable {
        let id: String
        let name: String
        let amount: Int64
        let label: String
        let color: Color
    }

    let parts: [Part]
    let total: String
    /// Weighed in bytes; counted in files from a server that only counts.
    let weighed: Bool

    static let placeholder = StorageSummary(parts: [
        Part(id: "a", name: "Drive", amount: 3, label: "0 GB", color: .gray),
        Part(id: "b", name: "Drive", amount: 2, label: "0 GB", color: .gray),
    ], total: "0 GB", weighed: true)

    init(parts: [Part], total: String, weighed: Bool) {
        self.parts = parts
        self.total = total
        self.weighed = weighed
    }

    /// Nil until the places are counted.
    @MainActor
    init?(drives: [Place], usage: [String: PlaceUsage]) {
        guard let all = usage[Place.library.id], drives.allSatisfy({ usage[$0.id] != nil }) else { return nil }
        let weighed = all.bytes != nil && drives.allSatisfy { usage[$0.id]?.bytes != nil }
        func amount(_ u: PlaceUsage) -> Int64 { weighed ? (u.bytes ?? 0) : Int64(u.files) }
        func label(_ u: PlaceUsage) -> String {
            weighed ? (SavePlan.size(u.bytes) ?? "—") : FileFormat.items(u.files)
        }
        var parts = drives.compactMap { place -> Part? in
            guard let u = usage[place.id] else { return nil }
            return Part(id: place.id, name: place.name, amount: amount(u), label: label(u), color: place.tint)
        }
        // All Files counts every file this account sees; what the drives do
        // not hold is its own.
        let inDrives = parts.reduce(Int64(0)) { $0 + $1.amount }
        let rest = amount(all) - inDrives
        if rest > 0 {
            let restLabel = weighed ? (SavePlan.size(rest) ?? "—") : FileFormat.items(Int(rest))
            parts.append(Part(id: "rest", name: "Not in a drive", amount: rest, label: restLabel, color: Color.white.opacity(0.45)))
        }
        self.parts = parts
        self.weighed = weighed
        total = weighed ? (SavePlan.size(max(amount(all), inDrives)) ?? "—") : FileFormat.items(all.files)
    }
}

/// Used space by drive: a segmented bar in each drive's colour, and a
/// legend of coloured dots — the web's Overview, on the page.
private struct StorageCard: View {
    let summary: StorageSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline) {
                Text("Storage")
                    .font(.headline)
                Spacer()
                Text(summary.weighed ? "\(summary.total) used" : summary.total)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            SegmentedBar(parts: summary.parts)
                .frame(height: 14)
            VStack(spacing: 13) {
                ForEach(summary.parts) { part in
                    HStack(spacing: 12) {
                        Circle().fill(part.color).frame(width: 10, height: 10)
                        Text(part.name)
                            .font(.subheadline)
                            .lineLimit(1)
                        Spacer()
                        Text(part.label)
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .padding(20)
        .background {
            RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
                .fill(Theme.card)
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous)
                        .strokeBorder(Theme.edge, lineWidth: 0.5)
                }
        }
    }
}

private struct SegmentedBar: View {
    let parts: [StorageSummary.Part]

    var body: some View {
        GeometryReader { geo in
            let shown = parts.filter { $0.amount > 0 }
            let total = max(1, shown.reduce(Int64(0)) { $0 + $1.amount })
            let gaps = CGFloat(max(0, shown.count - 1)) * 3
            HStack(spacing: 3) {
                ForEach(shown) { part in
                    Rectangle()
                        .fill(part.color)
                        .frame(width: max(6, (geo.size.width - gaps) * CGFloat(part.amount) / CGFloat(total)))
                }
                if shown.isEmpty {
                    Rectangle().fill(Color.white.opacity(0.12))
                }
            }
            .frame(width: geo.size.width, alignment: .leading)
            .clipShape(Capsule())
        }
        .accessibilityHidden(true)
    }
}

/// A row's shape while its file is on the way.
private struct PlaceholderRow: View {
    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous)
                .fill(Theme.card)
                .frame(width: 58, height: 58)
            VStack(alignment: .leading, spacing: 6) {
                Text("A file's name here").font(.body)
                Text("0 MB · now").font(.subheadline)
            }
            .redacted(reason: .placeholder)
            Spacer()
        }
        .accessibilityHidden(true)
    }
}

/// Every file, newest first, a page at a time: Recent Files' See All.
struct RecentFilesView: View {
    @Environment(Session.self) private var session
    @State private var files: [FileItem] = []
    @State private var cursor: String?
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var problem: String?
    @State private var previewing: FileItem?
    @State private var inspecting: FileItem?
    @Namespace private var zoom

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                EditorialTitle(text: "Recent", subtitle: "Every drive, newest first")
                    .padding(.bottom, 12)
                ForEach(files) { file in
                    FileListRow(file: file, showsFolder: true, open: { previewing = file }, info: { inspecting = file })
                        .matchedTransitionSource(id: file.id, in: zoom)
                        .onAppear { if file.id == files.last?.id { Task { await more() } } }
                }
                if !loaded || loadingMore {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 20)
                } else if let problem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .symbolRenderingMode(.multicolor)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background { AuraBackground() }
        .navigationTitle("Recent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1) } }
        .task { if !loaded { await more() } }
        .refreshable {
            files = []
            cursor = nil
            loaded = false
            await more()
        }
        .fullScreenCover(item: $previewing) { file in
            PreviewView(files: files, startID: file.id)
                .navigationTransition(.zoom(sourceID: file.id, in: zoom))
        }
        .sheet(item: $inspecting) { FileInfoView(file: $0, place: nil) }
    }

    private func more() async {
        guard !loadingMore, !loaded || cursor != nil else { return }
        loadingMore = loaded
        defer { loadingMore = false }
        do {
            let page = try await session.api.recentFiles(limit: 40, cursor: cursor)
            let known = Set(files.map(\.id))
            files += page.files.filter { !known.contains($0.id) }
            cursor = page.cursor
            problem = nil
        } catch {
            if !Session.isCancel(error) { problem = session.explain(error) }
        }
        loaded = true
    }
}
