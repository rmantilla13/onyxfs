import OnyxKit
import SwiftUI

// A file as a row outside a folder — Home's Recent Files, Search's results —
// with its picture, name, and the ⋯ menu that saves it.

/// One file: a rounded picture, its name, its size and when it came, and a
/// ⋯ menu with the ways to save it.
struct FileListRow: View {
    let file: FileItem
    /// Say which folder it is in (search results come from anywhere).
    var showsFolder = false
    let open: () -> Void
    var info: (() -> Void)?
    /// Share Link… for it, when that is offered (Session.mayLink).
    var share: (() -> Void)?

    var body: some View {
        HStack(spacing: 4) {
            Button(action: open) {
                HStack(spacing: 14) {
                    Thumbnail(file: file, size: .row)
                        .frame(width: 58, height: 58)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous)
                                .strokeBorder(Theme.edge, lineWidth: 0.5)
                        }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(file.name)
                            .font(.body.weight(.medium))
                            .lineLimit(1)
                        Text(detail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    ReviewBadge(file: file)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens it full screen")
            FileMoreMenu(file: file, info: info, share: share)
        }
    }

    private var detail: String {
        var parts: [String] = []
        if showsFolder { parts.append(FileFormat.folderName(file)) }
        parts.append(FileFormat.size(file.size))
        if let when = (file.createdAt ?? file.updatedAt)?.date { parts.append(RelativeTime.short(when)) }
        return parts.joined(separator: " · ")
    }
}

/// ⋯: the ways to save a file, a link to it where one is theirs to make or
/// manage, and its details.
struct FileMoreMenu: View {
    let file: FileItem
    var info: (() -> Void)?
    var share: (() -> Void)?

    var body: some View {
        Menu {
            SaveMenuContent(file: file)
            if let share {
                Section {
                    Button(action: share) { Label("Share Link…", systemImage: "link") }
                }
            }
            if let info {
                Button(action: info) { Label("Get Info", systemImage: "info.circle") }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.bold))
                .foregroundStyle(.secondary)
                .frame(width: 40, height: 44)
                .contentShape(Rectangle())
        }
        // Monochrome, as all the chrome is: colour is the media's.
        .tint(.secondary)
        .accessibilityLabel("More for \(file.name)")
    }
}

/// A card that gives a little under a finger.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}
