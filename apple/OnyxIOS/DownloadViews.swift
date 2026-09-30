import OnyxKit
import SwiftUI

// The ways out of Onyx, on screen: the Save items a file's menus offer, the
// bar a selection saves from, and the tray that says how it is going.

/// One file's ways out, as menu items: Photos when it can take the file
/// (and why not, when it cannot), a folder in Files, the share sheet.
struct SaveActions: View {
    let file: FileItem
    var variant: SaveVariant = .original
    var streamable: StreamableCopy?
    @Environment(Session.self) private var session

    var body: some View {
        let photos: PhotosSupport = variant == .streamable ? .video : SavePlan.photosSupport(name: file.name, kind: file.kind)
        Button { save(.photos) } label: {
            Text("Save to Photos")
            if let reason = photos.reason { Text(reason) }
            Image(systemName: "photo.on.rectangle.angled")
        }
        .disabled(!photos.isSupported)
        Button { save(.files) } label: {
            Text("Save to Files")
            Image(systemName: "folder")
        }
        // A copy of the file, through the share sheet — not Share Link…,
        // which sends a link to it.
        Button { save(.share) } label: {
            Text("Send a Copy…")
            Image(systemName: "square.and.arrow.up")
        }
    }

    private func save(_ destination: SaveDestination) {
        DownloadCenter.shared.save([file], variant: variant, to: destination, api: session.api, streamable: streamable)
    }
}

/// A file's Save menu: its original, and a heavy video's streamable copy
/// beside it when it has one — each headed by what it is and how big.
struct SaveMenuContent: View {
    let file: FileItem
    var streamable: StreamableCopy?

    var body: some View {
        if let streamable {
            Section(Self.header("Original", size: file.size)) {
                SaveActions(file: file)
            }
            Section(Self.header("\(streamable.label) copy", size: streamable.size, fallback: "smaller, streams smoothly")) {
                SaveActions(file: file, variant: .streamable, streamable: streamable)
            }
        } else {
            Section(Self.header("Original", size: file.size)) {
                SaveActions(file: file)
            }
        }
    }

    static func header(_ what: String, size: Int64?, fallback: String? = nil) -> String {
        if let size = SavePlan.size(size) { return "\(what) · \(size)" }
        return fallback.map { "\(what) · \($0)" } ?? what
    }
}

/// A selection's ways out, floating at the foot of the folder: glass, with
/// Photos — what most people want of a camera's files — as the primary.
struct SelectionBar: View {
    let files: [FileItem]
    /// Called once a save has begun: the selection is done with.
    let started: () -> Void
    @Environment(Session.self) private var session

    var body: some View {
        let photos = files.filter { SavePlan.photosSupport(name: $0.name, kind: $0.kind).isSupported }
        let others = files.count - photos.count
        VStack(spacing: 8) {
            if !photos.isEmpty, others > 0 {
                Text(others == 1 ? "1 of these can't go to Photos; save it to Files." : "\(others) of these can't go to Photos; save them to Files.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .glassSurface(Capsule())
            }
            GlassGroup(spacing: 10) {
                HStack(spacing: 10) {
                    Button {
                        save(photos, to: .photos)
                    } label: {
                        Label(SavePlan.saveSelection(photos.count, to: .photos), systemImage: "photo.on.rectangle.angled")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(BrandButtonStyle(fullWidth: true))
                    .disabled(photos.isEmpty)

                    Button {
                        save(files, to: .files)
                    } label: {
                        Label("Files", systemImage: "folder")
                    }
                    .glassButtonStyle()
                    .accessibilityLabel(SavePlan.saveSelection(files.count, to: .files))
                    .disabled(files.isEmpty)

                    Button {
                        save(files, to: .share)
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                            .padding(.horizontal, 2)
                    }
                    .glassButtonStyle()
                    .accessibilityLabel("Share")
                    .disabled(files.isEmpty)
                }
                .labelStyle(.titleAndIcon)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .frame(maxWidth: 560)
    }

    private func save(_ chosen: [FileItem], to destination: SaveDestination) {
        guard !chosen.isEmpty else { return }
        DownloadCenter.shared.save(chosen, to: destination, api: session.api)
        started()
    }
}

// MARK: - The tray

/// What is being saved, at the foot of the screen: a glass pill saying how
/// it is going, which opens into the list — each download with its
/// progress, and a way to stop it, try it again or send it elsewhere.
struct DownloadTray: View {
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var center: DownloadCenter { .shared }

    var body: some View {
        let items = center.items
        let notice = center.notice
        ZStack {
            if expanded, !items.isEmpty {
                TrayCard(items: items, collapse: { toggle(false) })
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else if !items.isEmpty || notice != nil {
                TrayPill(items: items, notice: notice, expand: { toggle(true) })
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .bottom)))
            }
        }
        .frame(maxWidth: 560)
        .padding(.horizontal, 16)
        .padding(.bottom, items.isEmpty && notice == nil ? 0 : 8)
        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.18), value: expanded)
        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.18), value: items.isEmpty && notice == nil)
        .onChange(of: items.isEmpty) { if items.isEmpty { expanded = false } }
    }

    private func toggle(_ open: Bool) {
        expanded = open
    }
}

private struct TrayPill: View {
    let items: [DownloadItem]
    let notice: DownloadCenter.Notice?
    let expand: () -> Void

    var body: some View {
        let active = items.filter(\.isActive)
        let failed = items.filter { $0.failure != nil }
        Button(action: expand) {
            HStack(spacing: 12) {
                leading(active: active, failed: failed)
                    .frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title(active: active, failed: failed))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    if let detail = detail(active: active, failed: failed) {
                        Text(detail)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if !items.isEmpty {
                    Image(systemName: "chevron.up")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.leading, 12)
            .padding(.trailing, 16)
            .padding(.vertical, 10)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(items.isEmpty)
        .glassSurface(Capsule(), interactive: true)
        .shadow(color: Theme.drop, radius: 14, y: 6)
        .accessibilityHint(items.isEmpty ? "" : "Shows each download")
    }

    @ViewBuilder
    private func leading(active: [DownloadItem], failed: [DownloadItem]) -> some View {
        if !active.isEmpty {
            GradientRing(fraction: Self.fraction(of: active))
        } else if let notice, !notice.failed {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(Theme.meter)
        } else if !failed.isEmpty || notice?.failed == true {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title3)
                .foregroundStyle(.orange)
        } else {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(Theme.meter)
        }
    }

    private func title(active: [DownloadItem], failed: [DownloadItem]) -> String {
        if active.count == 1 { return active[0].name }
        if active.count > 1 {
            let destinations = Set(active.map(\.destination))
            if destinations == [.photos] { return "Saving \(active.count) to Photos" }
            if destinations == [.files] { return "Saving \(active.count) to Files" }
            return "Saving \(active.count) files"
        }
        if let notice { return notice.text }
        if !failed.isEmpty { return failed.count == 1 ? "Couldn't save \(failed[0].name)" : "Couldn't save \(failed.count) files" }
        return items.last?.state.doneText ?? ""
    }

    private func detail(active: [DownloadItem], failed: [DownloadItem]) -> String? {
        if active.count == 1 { return TrayRow.status(active[0]) }
        if active.count > 1 {
            let received = active.reduce(Int64(0)) { $0 + $1.received }
            let expected = active.allSatisfy { $0.expected != nil } ? active.reduce(Int64(0)) { $0 + ($1.expected ?? 0) } : nil
            var text = SavePlan.progress(received: received, expected: expected)
            if !failed.isEmpty { text += " · \(failed.count) failed" }
            return text
        }
        if notice == nil, !failed.isEmpty { return failed.count == 1 ? failed[0].failure?.message : "Tap to see why" }
        return nil
    }

    static func fraction(of active: [DownloadItem]) -> Double? {
        guard active.allSatisfy({ $0.expected != nil }) else {
            return active.count == 1 ? nil : Double(active.filter { $0.state == .saving || $0.state == .ready }.count) / Double(active.count)
        }
        let expected = active.reduce(Int64(0)) { $0 + ($1.expected ?? 0) }
        let received = active.reduce(Int64(0)) { $0 + min($1.received, $1.expected ?? 0) }
        return SavePlan.fraction(received: received, expected: expected)
    }
}

private struct TrayCard: View {
    let items: [DownloadItem]
    let collapse: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("Downloads")
                    .font(.headline)
                Spacer()
                if items.contains(where: { !$0.isActive }) {
                    Button("Clear") { DownloadCenter.shared.clearFinished() }
                        .font(.subheadline.weight(.medium))
                }
                Button(action: collapse) {
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.bold))
                        .frame(width: 30, height: 30)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Hide Downloads")
            }
            .padding(.leading, 18)
            .padding(.trailing, 10)
            .padding(.vertical, 10)

            Rectangle().fill(Theme.edge).frame(height: 0.5)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(items.reversed()) { item in
                        TrayRow(item: item)
                        if item.id != items.first?.id {
                            Rectangle().fill(Theme.edge.opacity(0.6)).frame(height: 0.5).padding(.leading, 66)
                        }
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 340)
            .fixedSize(horizontal: false, vertical: true)
        }
        .glassSurface(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous))
        .shadow(color: Theme.drop, radius: 18, y: 8)
    }
}

/// One download in the tray.
struct TrayRow: View {
    let item: DownloadItem
    @Environment(Session.self) private var session

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            picture
                .frame(width: 40, height: 40)
                .clipShape(RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(item.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if item.state == .downloading || item.state == .preparing {
                    GradientProgressBar(fraction: item.state == .preparing ? nil : item.fraction)
                }
                Text(Self.status(item))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(item.failure == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.orange))
                    .lineLimit(2)
                if let failure = item.failure, failure.offerFiles || failure.offerSettings {
                    HStack(spacing: 8) {
                        if failure.offerFiles {
                            Button("Save to Files") { DownloadCenter.shared.saveToFiles(item.id, api: session.api) }
                        }
                        if failure.offerSettings {
                            Button("Settings") { Handoff.openSettings() }
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .glassButtonStyle()
                    .controlSize(.small)
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 4)
            trailing
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if item.failure?.canRetry == true {
                Button("Try Again") { DownloadCenter.shared.retry(item.id, api: session.api) }
            }
            if item.state != .saving {
                Button(item.isActive ? "Cancel" : "Remove") { DownloadCenter.shared.cancel(item.id) }
            }
        }
    }

    @ViewBuilder private var picture: some View {
        if let file = DownloadCenter.shared.source(for: item.id) {
            Thumbnail(file: file, size: .row)
        } else {
            ZStack {
                Theme.frost
                Image(systemName: Self.symbol(item.kind))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var trailing: some View {
        switch item.state {
        case .saving:
            ProgressView().controlSize(.small)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(Theme.meter)
                .accessibilityHidden(true)
        case let .failed(failure):
            HStack(spacing: 6) {
                if failure.canRetry {
                    iconButton("arrow.clockwise", label: "Try Again") {
                        DownloadCenter.shared.retry(item.id, api: session.api)
                    }
                }
                iconButton("xmark", label: "Remove") { DownloadCenter.shared.cancel(item.id) }
            }
        default:
            iconButton("xmark", label: "Cancel") { DownloadCenter.shared.cancel(item.id) }
        }
    }

    private func iconButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.footnote.weight(.bold))
                .frame(width: 30, height: 30)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .background(Theme.frost, in: Circle())
        .accessibilityLabel(label)
    }

    static func status(_ item: DownloadItem) -> String {
        switch item.state {
        case .preparing:
            return "Starting…"
        case .downloading:
            return SavePlan.progress(received: item.received, expected: item.expected)
        case .saving:
            return "Adding to Photos…"
        case .ready:
            return item.destination == .files ? "Downloaded · ready for Files" : "Downloaded · ready to share"
        case let .done(text):
            return text
        case let .failed(failure):
            return failure.message
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "image": return "photo"
        case "video": return "film"
        case "audio": return "waveform"
        default: return "doc"
        }
    }
}
