import OnyxKit
import SwiftUI

/// A file's facts, as the web's info panel has them, the ways to save it,
/// and its links.
struct FileInfoView: View {
    let file: FileItem
    /// Where it was opened from, when that is known.
    let place: Place?
    @Environment(\.dismiss) private var dismiss
    @Environment(Session.self) private var session

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        Thumbnail(file: file, size: .row)
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Theme.edge, lineWidth: 0.5)
                            }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(file.name).font(.headline).lineLimit(3)
                            Text(FileFormat.kindName(file) + (FileFormat.format(file).map { " · \($0)" } ?? ""))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    .glassRow()
                }
                Section {
                    HStack(spacing: 10) {
                        let photos = SavePlan.photosSupport(name: file.name, kind: file.kind)
                        saveButton("Photos", systemImage: "photo.on.rectangle.angled", to: .photos)
                            .disabled(!photos.isSupported)
                            .accessibilityHint(photos.reason ?? "")
                        saveButton("Files", systemImage: "folder", to: .files)
                        saveButton("Send", systemImage: "square.and.arrow.up", to: .share)
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    if let reason = SavePlan.photosSupport(name: file.name, kind: file.kind).reason,
                       file.kind == "image" || file.kind == "video" {
                        Text(reason)
                    }
                }
                // A link, where one is theirs to make or manage: pushed
                // here, so Info's own Done still closes the sheet.
                if session.mayLink(file) {
                    Section {
                        NavigationLink {
                            ShareLinkView(subject: .file(file))
                        } label: {
                            Label("Share Link…", systemImage: "link")
                        }
                    } footer: {
                        Text("Make a link to this file, or copy, send or revoke the links it has.")
                    }
                    .glassRow()
                }
                Section {
                    LabeledContent("Size", value: FileFormat.size(file.size))
                    if let dimensions = FileFormat.dimensions(file) { LabeledContent("Dimensions", value: dimensions) }
                    if let length = FileFormat.duration(file) { LabeledContent("Duration", value: length) }
                    if let place { LabeledContent("Drive", value: place.name) }
                    LabeledContent("Folder", value: file.folder.isEmpty ? "Top level" : file.folder)
                }
                .glassRow()
                Section {
                    if let added = file.createdAt?.date {
                        LabeledContent("Added", value: added.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let changed = file.updatedAt?.date {
                        LabeledContent("Modified", value: changed.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let by = file.createdBy { LabeledContent("Added by", value: by) }
                }
                .glassRow()
                if let status = file.reviewStatus {
                    Section("Review") {
                        LabeledContent("Status", value: FileFormat.reviewName(status))
                        if let comments = file.openComments, comments > 0 {
                            LabeledContent("Open comments", value: comments.formatted())
                        }
                    }
                    .glassRow()
                }
                if !file.tags.isEmpty {
                    Section("Tags") { Text(file.tags.joined(separator: ", ")) }
                        .glassRow()
                }
                if let notes = file.notes, !notes.isEmpty {
                    Section("Notes") { Text(notes) }
                        .glassRow()
                }
            }
            .sheetBackground()
            .navigationTitle("Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// Saving starts, and the sheet goes, so the tray beneath can show it.
    private func saveButton(_ title: String, systemImage: String, to destination: SaveDestination) -> some View {
        Button {
            DownloadCenter.shared.save([file], to: destination, api: session.api)
            dismiss()
        } label: {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .frame(height: 24)
                Text(title)
                    .font(.caption.weight(.medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tint)
        .glassSurface(RoundedRectangle(cornerRadius: 18, style: .continuous), interactive: true)
        .accessibilityLabel(destination == .share ? "Send a Copy" : "Save to \(title)")
    }
}

/// Who is signed in, where, and what is kept on this device.
struct AccountView: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var kept: Int64?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        Mark(size: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(session.email ?? "—")
                                .font(.headline)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text(session.serverName)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Signed in as \(session.email ?? "unknown"), on \(session.serverName)")
                }
                .glassRow()
                Section {
                    LabeledContent("Pictures kept", value: kept.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "…")
                    Button("Clear Pictures") {
                        Task {
                            await ThumbnailStore.shared.removeAll()
                            PreviewFiles.removeAll()
                            kept = 0
                        }
                    }
                } footer: {
                    Text("Thumbnails and downloaded previews, kept so folders open at once. They come back as you browse.")
                }
                .glassRow()
                Section {
                    Button("Sign Out", role: .destructive) { confirmingSignOut = true }
                }
                .glassRow()
                Section {
                    LabeledContent("Version", value: Self.version)
                }
                .glassRow()
            }
            .sheetBackground()
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Sign out of Onyx on this \(Session.deviceLabel)?", isPresented: $confirmingSignOut,
                                titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) {
                    Task {
                        await session.signOut()
                        dismiss()
                    }
                }
            } message: {
                Text("What this \(Session.deviceLabel) kept of your drives is removed.")
            }
            .task { kept = await Task.detached(priority: .utility) { ThumbnailStore.bytesOnDisk() }.value }
        }
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }
}
