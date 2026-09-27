import OnyxKit
import SwiftUI

/// A file's facts, as the web's info panel has them.
struct FileInfoView: View {
    let file: FileItem
    /// Where it was opened from, when that is known.
    let place: Place?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        Thumbnail(file: file, size: .row)
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(file.name).font(.headline).lineLimit(3)
                            Text(FileFormat.kindName(file) + (FileFormat.format(file).map { " · \($0)" } ?? ""))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    LabeledContent("Size", value: FileFormat.size(file.size))
                    if let dimensions = FileFormat.dimensions(file) { LabeledContent("Dimensions", value: dimensions) }
                    if let length = FileFormat.duration(file) { LabeledContent("Duration", value: length) }
                    if let place { LabeledContent("Drive", value: place.name) }
                    LabeledContent("Folder", value: file.folder.isEmpty ? "Top level" : file.folder)
                }
                Section {
                    if let added = file.createdAt?.date {
                        LabeledContent("Added", value: added.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let changed = file.updatedAt?.date {
                        LabeledContent("Modified", value: changed.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let by = file.createdBy { LabeledContent("Added by", value: by) }
                }
                if let status = file.reviewStatus {
                    Section("Review") {
                        LabeledContent("Status", value: FileFormat.reviewName(status))
                        if let comments = file.openComments, comments > 0 {
                            LabeledContent("Open comments", value: comments.formatted())
                        }
                    }
                }
                if !file.tags.isEmpty {
                    Section("Tags") { Text(file.tags.joined(separator: ", ")) }
                }
                if let notes = file.notes, !notes.isEmpty {
                    Section("Notes") { Text(notes) }
                }
            }
            .navigationTitle("Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
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
                    LabeledContent("Signed in as", value: session.email ?? "—")
                    LabeledContent("Server", value: session.serverName)
                }
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
                Section {
                    Button("Sign Out", role: .destructive) { confirmingSignOut = true }
                }
                Section {
                    LabeledContent("Version", value: Self.version)
                }
            }
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
