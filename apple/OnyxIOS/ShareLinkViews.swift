import OnyxKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// Share Link…: a link to a file or a folder, as the web's Share dialog makes
// them (app/components/ShareDialog.js) — who can open it, when it expires,
// whether the people it reaches may comment — and the links already made,
// to copy, send, change or revoke. Distinct from sending a copy of a file
// through the share sheet (SaveHandoff), which hands over the bytes; a link
// hands over a page on the web that can be taken back.
//
// The server decides everything. The list says what this person may make
// (LinkChoices) and what each link may be changed to, so only that is
// offered; whatever the server still refuses is shown in its own words.

/// What a Share Link sheet is for: a file, or a folder of a place.
enum LinkSubject: Identifiable {
    case file(FileItem)
    /// A folder's path in the place ("Footage/Day 1"), never its top.
    case folder(path: String, place: Place)

    var id: String {
        switch self {
        case let .file(file): "file:\(file.id)"
        case let .folder(path, place): "folder:\(place.id):\(path)"
        }
    }

    var target: LinkTarget {
        switch self {
        case let .file(file): .file(id: file.id)
        case let .folder(path, place): .folder(path: path, scope: place.scope)
        }
    }

    var name: String {
        switch self {
        case let .file(file): file.name
        case let .folder(path, _): (path as NSString).lastPathComponent
        }
    }

    var isFolder: Bool {
        if case .folder = self { return true }
        return false
    }

    /// "file" or "folder", in a sentence.
    var noun: String { isFolder ? "folder" : "file" }
}

/// One sheet's links and the link being made.
@MainActor @Observable
final class LinkSheetModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    let subject: LinkSubject
    private(set) var phase: Phase = .loading
    private(set) var links: [SharedLink] = []
    /// What may be made here: nothing, until the server has said.
    private(set) var choices: LinkChoices = .none

    var kind: LinkKind = .public
    var password = ""
    var expiry: LinkExpiry = .never
    var review: LinkReview = .view
    private(set) var creating = false
    /// Why the last link could not be made, in the server's words.
    var createProblem: String?
    /// The link just made, shown on its own until another is asked for.
    var fresh: SharedLink?
    /// Links being revoked or changed.
    private(set) var working: Set<String> = []
    /// What could not be done to the links, and why, for an alert.
    var problem: Problem?

    /// A failure, for an alert: what was being done, and the server's words.
    struct Problem: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    init(subject: LinkSubject) {
        self.subject = subject
    }

    var isVideo: Bool {
        if case let .file(file) = subject { return file.kind == "video" }
        return false
    }

    /// The level choice, where the server offers review links: a photo's or
    /// a video's, never a folder's.
    var offersReview: Bool { !subject.isFolder && !choices.review.isEmpty }

    /// Too short for the server, counted as it counts (UTF-16, as JavaScript does).
    var passwordShort: Bool { kind == .password && password.utf16.count < choices.passwordMin }

    var canCreate: Bool {
        choices.canMake && choices.kinds.contains(kind) && choices.expires.contains(expiry) && !passwordShort && !creating
    }

    private var request: LinkRequest {
        LinkRequest(kind: kind, password: kind == .password ? password : nil, expires: expiry,
                    review: choices.offersReview(for: kind) ? review : .view)
    }

    func load(_ session: Session) async {
        if links.isEmpty, phase != .loaded { phase = .loading }
        do {
            let list = try await session.api.links(to: subject.target)
            links = list.shares
            choices = list.choices
            // Only what may be made: the form starts at the first kind and
            // the default expiry the server allows.
            if !choices.kinds.contains(kind), let first = choices.kinds.first { kind = first }
            if !choices.expires.contains(expiry), let start = choices.defaultExpiry { expiry = start }
            if !choices.review.contains(review) { review = .view }
            phase = .loaded
        } catch {
            guard !Session.isCancel(error) else { return }
            let words = session.explain(error)
            // What is shown stays, when there is something to show.
            if phase == .loaded {
                problem = Problem(title: "Couldn’t Load the Links", message: words)
            } else {
                phase = .failed(words)
            }
        }
    }

    func make(_ session: Session) async {
        guard canCreate else { return }
        creating = true
        createProblem = nil
        defer { creating = false }
        do {
            let link = try await session.api.makeLink(to: subject.target, request)
            links.removeAll { $0.token == link.token }
            links.insert(link, at: 0)
            fresh = link
            password = ""
            announce(link.level == .view ? "Link created." : "Review link created.")
        } catch {
            guard !Session.isCancel(error) else { return }
            createProblem = session.explain(error)
            announce(createProblem ?? "")
        }
    }

    func revoke(_ link: SharedLink, _ session: Session) async {
        working.insert(link.token)
        defer { working.remove(link.token) }
        do {
            try await session.api.revokeLink(token: link.token, of: subject.target)
            links.removeAll { $0.token == link.token }
            if fresh?.token == link.token { fresh = nil }
            announce("Link revoked. It stops working now.")
        } catch {
            guard !Session.isCancel(error) else { return }
            problem = Problem(title: "Couldn’t Revoke the Link", message: session.explain(error))
        }
    }

    func setLevel(_ level: LinkReview, of link: SharedLink, _ session: Session) async {
        guard case let .file(file) = subject, level != link.level else { return }
        working.insert(link.token)
        defer { working.remove(link.token) }
        do {
            let changed = try await session.api.setLinkReview(level, token: link.token, fileId: file.id)
            if let changed, let at = links.firstIndex(where: { $0.token == link.token }) {
                links[at] = changed
                if fresh?.token == link.token { fresh = changed }
            } else if changed == nil {
                // Gone meanwhile: revoked from somewhere else.
                links.removeAll { $0.token == link.token }
            }
            announce(level == .view
                ? "The link is view only now. Comments already made stay on the file."
                : "People with the link \(level == .approve ? "can comment and approve" : "can comment") now.")
        } catch {
            guard !Session.isCancel(error) else { return }
            problem = Problem(title: "Couldn’t Change the Link", message: session.explain(error))
        }
    }

    private func announce(_ words: String) {
        guard !words.isEmpty else { return }
        AccessibilityNotification.Announcement(words).post()
    }
}

/// Share Link… as a sheet of its own, with Done.
struct ShareLinkSheet: View {
    let subject: LinkSubject
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ShareLinkView(subject: subject)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
    }
}

/// A file's or a folder's links: make one, and see, copy, send, change or
/// revoke the ones there are. Pushed from Get Info, or the body of
/// ShareLinkSheet.
struct ShareLinkView: View {
    @State private var model: LinkSheetModel
    @Environment(Session.self) private var session
    /// The link a revoke is being confirmed for.
    @State private var revoking: SharedLink?

    init(subject: LinkSubject) {
        _model = State(initialValue: LinkSheetModel(subject: subject))
    }

    var body: some View {
        Form {
            Section { SubjectHeader(subject: model.subject) }
                .glassRow()
            switch model.phase {
            case .loading:
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading links…").foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
                .glassRow()
            case let .failed(words):
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(words, systemImage: "exclamationmark.triangle.fill")
                            .symbolRenderingMode(.multicolor)
                        Button("Try Again") { Task { await model.load(session) } }
                            .glassButtonStyle()
                            .controlSize(.small)
                    }
                    .padding(.vertical, 6)
                }
                .glassRow()
            case .loaded:
                if let fresh = model.fresh {
                    FreshLinkSection(model: model, link: fresh, url: fresh.url(on: session.server))
                } else if model.choices.canMake {
                    LinkForm(model: model)
                } else {
                    Section {
                        Label(model.choices.reason ?? "You can’t make links here.", systemImage: "link")
                            .font(.subheadline)
                    } footer: {
                        if !model.links.isEmpty { Text("You can still copy and revoke the links here.") }
                    }
                    .glassRow()
                }
                linkList
            }
        }
        .sheetBackground()
        .navigationTitle("Share Link")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(session) }
        .refreshable { await model.load(session) }
        .confirmationDialog("Revoke this link?", isPresented: revokingShown, titleVisibility: .visible, presenting: revoking) { link in
            Button("Revoke Link", role: .destructive) { Task { await model.revoke(link, session) } }
        } message: { _ in
            Text("It stops working now: whoever has it can no longer open this \(model.subject.noun).")
        }
        .alert(model.problem?.title ?? "", isPresented: problemShown, presenting: model.problem) { _ in
            Button("OK", role: .cancel) {}
        } message: { problem in
            Text(problem.message)
        }
    }

    private var linkList: some View {
        Section {
            if model.links.isEmpty {
                Text(LinkWords.none(folder: model.subject.isFolder))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.links) { link in
                    LinkRow(link: link, url: link.url(on: session.server), subjectName: model.subject.name,
                            fresh: link.token == model.fresh?.token, working: model.working.contains(link.token),
                            setLevel: { level in Task { await model.setLevel(level, of: link, session) } },
                            revoke: { revoking = link })
                        .swipeActions {
                            // Not role .destructive: that takes the row away
                            // before the revoke is confirmed.
                            Button { revoking = link } label: { Label("Revoke", systemImage: "trash") }
                                .tint(.red)
                        }
                }
            }
        } header: {
            Text(model.subject.isFolder ? "Links to This Folder" : "Links to This File")
        }
        .glassRow()
    }

    private var revokingShown: Binding<Bool> {
        Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })
    }

    private var problemShown: Binding<Bool> {
        Binding(get: { model.problem != nil }, set: { if !$0 { model.problem = nil } })
    }
}

/// Who can open it, a password, what they can do, when it expires, and
/// Create Link — each only as far as the server offers it.
private struct LinkForm: View {
    @Bindable var model: LinkSheetModel
    @Environment(Session.self) private var session
    @FocusState private var typing: Bool

    var body: some View {
        Section {
            Picker("Who can open it", selection: $model.kind) {
                ForEach(model.choices.kinds) { kind in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(LinkWords.title(kind))
                        Text(LinkWords.detail(kind, folder: model.subject.isFolder))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .tag(kind)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } header: {
            Text("Who Can Open It")
        }
        .glassRow()
        .onChange(of: model.kind) { model.createProblem = nil }

        if model.kind == .password {
            Section {
                // Plain text, as the web's: the sharer is choosing it to send
                // on, and needs to see what they typed.
                TextField("Password", text: $model.password, prompt: Text("At least \(model.choices.passwordMin) characters"))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .privacySensitive()
                    .focused($typing)
                    .submitLabel(.done)
                    .onSubmit { typing = false }
                    .onChange(of: model.password) { model.createProblem = nil }
            } header: {
                Text("Password")
            } footer: {
                Text("At least \(model.choices.passwordMin) characters. Whoever opens the link is asked for it.")
            }
            .glassRow()
        }

        if model.offersReview {
            Section {
                Picker("What they can do", selection: $model.review) {
                    ForEach([LinkReview.view] + model.choices.review) { level in
                        Text(LinkWords.choice(level)).tag(level)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .disabled(model.kind == .private)
            } header: {
                Text("What They Can Do")
            } footer: {
                Text(model.kind == .private
                    ? "A private link opens only for members, who comment on the file itself."
                    : LinkWords.levelDetail(model.review, video: model.isVideo))
            }
            .glassRow()
        }

        Section {
            Picker("Expires", selection: $model.expiry) {
                ForEach(model.choices.expires) { Text(LinkWords.expiry($0)).tag($0) }
            }
            .pickerStyle(.menu)
        } footer: {
            if let rule = LinkWords.maxExpiry(model.choices.maxExpiryDays) { Text(rule) }
        }
        .glassRow()

        Section {
            Button {
                typing = false
                Task { await model.make(session) }
            } label: {
                HStack(spacing: 8) {
                    if model.creating { ProgressView().tint(Theme.onAura) }
                    Text(model.creating ? "Creating…" : "Create Link")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(BrandButtonStyle(fullWidth: true))
            .disabled(!model.canCreate)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            if let problem = model.createProblem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                    .symbolRenderingMode(.multicolor)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
            }
        } footer: {
            if case let .folder(_, place) = model.subject {
                Text(LinkWords.folderNote(inDrive: !place.isLibrary))
            }
        }
    }
}

/// The link just made, to copy or send at once, and the way back to the form.
private struct FreshLinkSection: View {
    let model: LinkSheetModel
    let link: SharedLink
    let url: URL

    var body: some View {
        Section {
            VStack(spacing: 14) {
                Image(systemName: "link")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Theme.onAura)
                    .frame(width: 52, height: 52)
                    .background(BrandFill(shape: Circle(), glow: false))
                    .accessibilityHidden(true)
                Text(url.absoluteString)
                    .font(.callout.monospaced())
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .accessibilityLabel("Link")
                    .accessibilityValue(url.absoluteString)
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                VStack(spacing: 10) {
                    CopyLinkButton(url: url, prominent: true)
                    ShareLink(item: url, subject: Text(model.subject.name)) {
                        IconText("Share…", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .glassButtonStyle()
                    .accessibilityLabel("Share link")
                }
                .frame(maxWidth: 360)
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        } header: {
            Text("Link Created")
        }
        .glassRow()
        if model.choices.canMake {
            Section {
                Button { model.fresh = nil } label: { Label("Make Another Link", systemImage: "plus") }
            }
            .glassRow()
        }
    }

    /// "Password · Can comment · Expires in 7 days".
    private var summary: String {
        var parts: [String] = [link.kind.map(LinkWords.title) ?? "Link"]
        if link.level != .view { parts.append(LinkWords.level(link.level)) }
        parts.append(LinkWords.expires(link.expiresAt) ?? "Never expires")
        return parts.joined(separator: " · ")
    }
}

/// One of the links there are: what it is, where it opens, and what may be
/// done with it.
private struct LinkRow: View {
    let link: SharedLink
    let url: URL
    let subjectName: String
    let fresh: Bool
    let working: Bool
    let setLevel: (LinkReview) -> Void
    let revoke: () -> Void

    var body: some View {
        let expired = link.isExpired()
        VStack(alignment: .leading, spacing: 9) {
            // What it is, and Revoke — which an expired link is still
            // there for — where a row's own action goes in Settings.
            HStack(alignment: .top, spacing: 8) {
                tags
                Spacer(minLength: 0)
                status
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(url.absoluteString)
                    .font(.footnote.monospaced())
                    .foregroundStyle(expired ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(expired ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilitySummary)
            .accessibilitySortPriority(3)
            if !expired {
                // Each at its own width, on as many lines as it takes at
                // this text size — never squeezed.
                FlowLayout(spacing: 8, lineSpacing: 8) {
                    CopyLinkButton(url: url)
                    ShareLink(item: url, subject: Text(subjectName)) {
                        IconText("Share", systemImage: "square.and.arrow.up")
                    }
                    .glassButtonStyle()
                    .accessibilityLabel("Share link")
                    level
                }
                .controlSize(.small)
                .disabled(working)
                .accessibilitySortPriority(2)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }

    private var tags: some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            KindTag(kind: link.kind)
            if link.level != .view, !link.offersLevels() { LevelTag(level: link.level) }
            if fresh {
                Text("New")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.onAura)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Theme.brand, in: Capsule())
            }
        }
        // Said by the summary.
        .accessibilityHidden(true)
    }

    private var status: some View {
        HStack(spacing: 10) {
            if working { ProgressView().controlSize(.small) }
            Button(action: revoke) {
                Text("Revoke")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.red)
            .disabled(working)
            .accessibilityLabel("Revoke link")
            .accessibilitySortPriority(1)
        }
        .fixedSize()
    }

    /// What people with the link may do, where there is a choice.
    @ViewBuilder private var level: some View {
        if link.offersLevels(), let levels = link.levels {
            Menu {
                Picker("People with the link can", selection: Binding(get: { link.level }, set: setLevel)) {
                    ForEach(levels) { Text(LinkWords.level($0)).tag($0) }
                }
            } label: {
                IconText(LinkWords.level(link.level), systemImage: "text.bubble")
            }
            .glassButtonStyle()
            .accessibilityLabel("What people with this link can do")
            .accessibilityValue(LinkWords.level(link.level))
        }
    }

    /// "Expires in 3 days · 12 views · made Sep 5 · by ricky@…".
    private var meta: String {
        var parts: [String] = [LinkWords.expires(link.expiresAt) ?? "Never expires", LinkWords.views(link.viewCount)]
        if let made = link.createdAt?.date { parts.append("made \(made.formatted(date: .abbreviated, time: .omitted))") }
        if let by = link.createdBy { parts.append("by \(by)") }
        return parts.joined(separator: " · ")
    }

    private var accessibilitySummary: String {
        var parts = ["\(link.kind.map(LinkWords.title) ?? "A") link"]
        if link.level != .view { parts.append(LinkWords.level(link.level)) }
        if fresh { parts.append("new") }
        parts.append(meta)
        return parts.joined(separator: ", ")
    }
}

/// Copy: the link on the pasteboard, and a moment's "Copied".
private struct CopyLinkButton: View {
    let url: URL
    /// The primary action (the link just made): the brand's button, the
    /// width it is given.
    var prominent = false
    @State private var copied = false

    var body: some View {
        let button = Button {
            UIPasteboard.general.setItems([[UTType.url.identifier: url, UTType.plainText.identifier: url.absoluteString]])
            copied = true
            AccessibilityNotification.Announcement("Link copied").post()
            Task {
                try? await Task.sleep(for: .seconds(1.6))
                copied = false
            }
        } label: {
            IconText(copied ? "Copied" : (prominent ? "Copy Link" : "Copy"), systemImage: copied ? "checkmark" : "doc.on.doc")
                .frame(maxWidth: prominent ? .infinity : nil)
        }
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
        .accessibilityLabel(copied ? "Link copied" : "Copy link")
        if prominent {
            button.buttonStyle(BrandButtonStyle(fullWidth: true))
        } else {
            button.glassButtonStyle()
        }
    }
}

/// A symbol and its word, on one line. A Label, laid out by hand: in a
/// row's compact controls a Label could be given no room for its words.
private struct IconText: View {
    let title: String
    let systemImage: String

    init(_ title: String, systemImage: String) {
        self.title = title
        self.systemImage = systemImage
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .contentTransition(.symbolEffect(.replace))
            Text(title)
                .lineLimit(1)
        }
    }
}

/// Its subviews each at its own width, left to right, onto the next line
/// when the next one would not fit — as words run in a paragraph. So a row
/// of controls stays whole at any text size, rather than squeezing words
/// letter by letter.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let limit = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            let width = min(size.width, limit)
            if x > 0, x + width > limit {
                y += line + lineSpacing
                x = 0
                line = 0
            }
            x += width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, limit), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            let width = min(size.width, bounds.width)
            if x > bounds.minX, x + width > bounds.maxX {
                y += line + lineSpacing
                x = bounds.minX
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: width, height: size.height))
            x += width + spacing
            line = max(line, size.height)
        }
    }
}

/// A link's kind, as a small tag: public, password or private.
private struct KindTag: View {
    let kind: LinkKind?

    var body: some View {
        IconText(kind.map(LinkWords.title) ?? "Link", systemImage: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.16), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.3), lineWidth: 0.5))
    }

    private var symbol: String {
        switch kind {
        case .public: "globe"
        case .password: "lock.fill"
        case .private: "person.2.fill"
        case nil: "link"
        }
    }

    private var tint: Color {
        switch kind {
        case .public: Theme.auraCyan
        case .password: Theme.auraMagenta
        case .private, nil: .secondary
        }
    }
}

/// What a link's people may do past looking, when it is not a choice here.
private struct LevelTag: View {
    let level: LinkReview

    var body: some View {
        IconText(LinkWords.level(level), systemImage: "text.bubble")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.frost, in: Capsule())
    }
}

/// The file or folder, at the top of the sheet.
private struct SubjectHeader: View {
    let subject: LinkSubject

    var body: some View {
        HStack(spacing: 14) {
            picture
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous)
                        .strokeBorder(Theme.edge, lineWidth: 0.5)
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(subject.name)
                    .font(.headline)
                    .lineLimit(2)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var picture: some View {
        switch subject {
        case let .file(file):
            Thumbnail(file: file, size: .row)
        case .folder:
            Color(.secondarySystemFill)
                .overlay {
                    Image(systemName: "folder.fill")
                        .font(.title2)
                        .foregroundStyle(.white.opacity(0.9))
                }
                .accessibilityHidden(true)
        }
    }

    private var detail: String {
        switch subject {
        case let .file(file):
            return "\(FileFormat.kindName(file)) · \(FileFormat.size(file.size))"
        case let .folder(path, place):
            let parent = (path as NSString).deletingLastPathComponent
            let within = parent.isEmpty ? place.name : "\(place.name) / \(parent)"
            return "Folder in \(within)"
        }
    }
}
