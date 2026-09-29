import OnyxKit
import SwiftUI

/// Search: every drive this account belongs to at once, by name, tag or
/// note — the web's search, over All Files — or just by kind: photos,
/// videos, sound, documents.
struct SearchView: View {
    @Environment(Session.self) private var session
    @State private var query = ""
    @State private var kind: Kind?
    @State private var results: [FileItem] = []
    @State private var cursor: String?
    @State private var phase: Phase = .idle
    @State private var loadingMore = false
    @State private var previewing: FileItem?
    @State private var inspecting: FileItem?
    @FocusState private var typing: Bool
    @Namespace private var zoom

    enum Phase: Equatable {
        case idle, searching, done
        case failed(String)
    }

    enum Kind: String, CaseIterable, Identifiable {
        case image, video, audio, doc

        var id: String { rawValue }

        var title: String {
            switch self {
            case .image: "Photos"
            case .video: "Videos"
            case .audio: "Sound"
            case .doc: "Documents"
            }
        }

        var symbol: String {
            switch self {
            case .image: "photo"
            case .video: "film"
            case .audio: "waveform"
            case .doc: "doc.text"
            }
        }
    }

    private struct Ask: Equatable {
        let query: String
        let kind: Kind?
    }

    private var ask: Ask { Ask(query: query.trimmingCharacters(in: .whitespacesAndNewlines), kind: kind) }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    EditorialTitle(text: "Search")
                    field
                    chips
                    content
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 28)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            .background { AuraBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .task(id: ask) { await search() }
        }
        .fullScreenCover(item: $previewing) { file in
            PreviewView(files: results, startID: file.id)
                .navigationTransition(.zoom(sourceID: file.id, in: zoom))
        }
        .sheet(item: $inspecting) { FileInfoView(file: $0, place: nil) }
    }

    // MARK: - Asking

    private var field: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("Files in every drive", text: $query)
                .focused($typing)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .font(.body)
        .padding(.horizontal, 18)
        .frame(minHeight: 52)
        .glassSurface(Capsule(), interactive: true)
        .onTapGesture { typing = true }
    }

    private var chips: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(Kind.allCases) { option in
                    let on = kind == option
                    Button {
                        kind = on ? nil : option
                    } label: {
                        Label(option.title, systemImage: option.symbol)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(on ? AnyShapeStyle(Theme.onAura) : AnyShapeStyle(.primary))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background {
                                if on {
                                    BrandFill(glow: false)
                                } else {
                                    Capsule().fill(Theme.card)
                                        .overlay { Capsule().strokeBorder(Theme.edge, lineWidth: 0.5) }
                                }
                            }
                            .contentShape(Capsule())
                    }
                    .buttonStyle(PressableStyle())
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(.horizontal, 20)
        }
        .scrollIndicators(.hidden)
        .padding(.horizontal, -20)
    }

    // MARK: - Answers

    @ViewBuilder private var content: some View {
        if ask.query.isEmpty, ask.kind == nil {
            VStack(alignment: .leading, spacing: 8) {
                Text("Every drive you're in, at once.")
                    .font(.headline)
                Text("Names, tags and notes are searched, as on the web. Or choose a kind above to see all of it, newest first.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 12)
        } else {
            switch phase {
            case .idle, .searching:
                if results.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else {
                    rows
                }
            case let .failed(words):
                Label(words, systemImage: "exclamationmark.triangle.fill")
                    .symbolRenderingMode(.multicolor)
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
            case .done:
                if results.isEmpty {
                    ContentUnavailableView.search(text: ask.query.isEmpty ? (ask.kind?.title ?? "") : ask.query)
                        .onyxStyle()
                        .padding(.top, 24)
                } else {
                    rows
                }
            }
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeading(title: ask.kind?.title ?? "Files")
                .padding(.top, 6)
            ForEach(results) { file in
                FileListRow(file: file, showsFolder: true, open: { previewing = file }, info: { inspecting = file })
                    .matchedTransitionSource(id: file.id, in: zoom)
                    .onAppear { if file.id == results.last?.id { Task { await more() } } }
            }
            if loadingMore { ProgressView().frame(maxWidth: .infinity).padding(.vertical, 12) }
        }
    }

    private func search() async {
        let asked = ask
        guard !asked.query.isEmpty || asked.kind != nil else {
            results = []
            cursor = nil
            phase = .idle
            return
        }
        // A keystroke is not a search: wait for the typing to settle.
        if !asked.query.isEmpty {
            try? await Task.sleep(for: .milliseconds(300))
            if Task.isCancelled { return }
        }
        phase = .searching
        do {
            let page = try await session.api.findFiles(query: asked.query, kinds: asked.kind.map { [$0.rawValue] } ?? [],
                                                       sort: .newest, limit: 40)
            guard !Task.isCancelled, asked == ask else { return }
            results = page.files
            cursor = page.cursor
            phase = .done
        } catch {
            guard !Session.isCancel(error), asked == ask else { return }
            phase = .failed(session.explain(error))
        }
    }

    private func more() async {
        guard let cursor, !loadingMore, phase == .done else { return }
        let asked = ask
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await session.api.findFiles(query: asked.query, kinds: asked.kind.map { [$0.rawValue] } ?? [],
                                                       sort: .newest, limit: 40, cursor: cursor)
            guard asked == ask else { return }
            let known = Set(results.map(\.id))
            results += page.files.filter { !known.contains($0.id) }
            self.cursor = page.cursor
        } catch {
            // The page on screen stays; the next scroll tries again.
        }
    }
}
