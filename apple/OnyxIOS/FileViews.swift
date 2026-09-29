import OnyxKit
import SwiftUI

// How files and folders look in a folder: tiles for the icon layout, rows
// for the list — each with its picture, name and the one fact worth a
// glance (a video's length, a document's size, a folder's count).

struct FileTile: View {
    let file: FileItem
    /// A search's results come from anywhere beneath the folder: each says where.
    var showsFolder = false
    @Environment(\.fileSelection) private var selection

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Theme.tileCorner, style: .continuous) }

    var body: some View {
        let chosen = selection?.contains(file.id) == true
        VStack(alignment: .leading, spacing: 9) {
            // The picture fills the tile; a file without one is its kind's
            // glyph on dark grey (KindSymbol).
            Thumbnail(file: file, size: .card)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(shape)
                .overlay { shape.strokeBorder(Theme.edge, lineWidth: 0.5) }
                .overlay(alignment: .bottomTrailing) {
                    if let length = FileFormat.duration(file) {
                        Text(length)
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(.black.opacity(0.55), in: Capsule())
                            .padding(10)
                    }
                }
                .overlay(alignment: .topTrailing) { ReviewBadge(file: file).padding(10) }
                .overlay(alignment: .topLeading) {
                    if selection != nil { SelectionCheck(chosen: chosen).padding(10) }
                }
                .overlay {
                    if chosen { shape.strokeBorder(Theme.brand, lineWidth: 3) }
                }
                .scaleEffect(chosen ? 0.95 : 1)
                .animation(.spring(duration: 0.25, bounce: 0.2), value: chosen)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(showsFolder ? FileFormat.folderName(file) : FileFormat.when(file))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 4)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

struct FileRow: View {
    let file: FileItem
    var showsFolder = false
    @Environment(\.fileSelection) private var selection

    var body: some View {
        let chosen = selection?.contains(file.id) == true
        HStack(spacing: 14) {
            if selection != nil { SelectionCheck(chosen: chosen) }
            Thumbnail(file: file, size: .row)
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous)
                        .strokeBorder(Theme.edge, lineWidth: 0.5)
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(file.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(showsFolder ? "\(FileFormat.folderName(file)) · \(FileFormat.summary(file))" : FileFormat.summary(file))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            ReviewBadge(file: file)
            if selection == nil { FileMoreMenu(file: file) }
        }
        .contentShape(Rectangle())
        .listRowBackground(chosen ? AnyView(Rectangle().fill(Theme.selection)) : AnyView(Color.clear))
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

struct FolderTile: View {
    let node: FolderNode
    let items: Int
    @Environment(\.fileSelection) private var selection

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            RoundedRectangle(cornerRadius: Theme.tileCorner, style: .continuous)
                .fill(Color(.secondarySystemFill))
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    Image(systemName: "folder.fill")
                        .font(.system(size: 42, weight: .regular))
                        .foregroundStyle(.white.opacity(0.9))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.tileCorner, style: .continuous)
                        .strokeBorder(Theme.edge, lineWidth: 0.5)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(node.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(FileFormat.items(items))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
        }
        .contentShape(Rectangle())
        // Choosing files: a folder is not one of them.
        .opacity(selection == nil ? 1 : 0.4)
        .accessibilityElement(children: .combine)
    }
}

struct FolderRow: View {
    let node: FolderNode
    let items: Int
    @Environment(\.fileSelection) private var selection

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous)
                .fill(Color(.secondarySystemFill))
                .frame(width: 56, height: 56)
                .overlay {
                    Image(systemName: "folder.fill")
                        .font(.title3)
                        .foregroundStyle(.white.opacity(0.9))
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(node.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(FileFormat.items(items))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .opacity(selection == nil ? 1 : 0.4)
    }
}

/// Whether a file is among those chosen, while choosing.
struct SelectionCheck: View {
    let chosen: Bool

    var body: some View {
        ZStack {
            if chosen {
                Circle().fill(Theme.brand)
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(Theme.onAura)
            } else {
                Circle().fill(.black.opacity(0.28))
            }
            Circle().strokeBorder(.white.opacity(0.9), lineWidth: 1.5)
        }
        .frame(width: 24, height: 24)
        .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
        .accessibilityHidden(true)
    }
}

extension EnvironmentValues {
    /// The files chosen in the folder on screen, while choosing; nil when not.
    @Entry var fileSelection: Set<String>? = nil
}

/// Approved, changes asked for, and open comments: a file's review at a glance.
struct ReviewBadge: View {
    let file: FileItem

    var body: some View {
        HStack(spacing: 4) {
            if let comments = file.openComments, comments > 0 {
                CountBadge(text: "\(comments)", systemImage: "text.bubble.fill")
            }
            if let status = file.reviewStatus, let color = FileFormat.reviewColor(status) {
                Circle()
                    .fill(color)
                    .frame(width: 10, height: 10)
                    .overlay(Circle().strokeBorder(.white.opacity(0.9), lineWidth: 1.5))
                    .accessibilityLabel(FileFormat.reviewName(status))
            }
        }
    }
}

// MARK: - Pictures

enum ThumbnailSize {
    /// A list row's 44 points.
    case row
    /// A tile, up to about 200 points.
    case card
}

/// A file's picture — a sound's waveform — or its kind's symbol until there
/// is one (or if there is none). A picture already in memory is there on the first frame, so
/// scrolling back never flickers; and coming into view, it tells the
/// folder's prefetch where the eye is, so the next ones are ready too.
struct Thumbnail: View {
    let file: FileItem
    let size: ThumbnailSize
    @Environment(Session.self) private var session: Session?
    @State private var image: UIImage?

    init(file: FileItem, size: ThumbnailSize) {
        self.file = file
        self.size = size
        _image = State(initialValue: file.picture(size).flatMap { ThumbnailStore.shared.cached($0) })
    }

    var body: some View {
        Color(.secondarySystemFill)
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .transition(.opacity)
                } else if file.kind == "audio", let waveform = file.metadata?.waveform {
                    TileWaveform(waveform: waveform, compact: size == .row)
                } else {
                    KindSymbol(file: file, compact: size == .row)
                }
            }
            .clipped()
            .task(id: file.picture(size)) {
                ThumbnailPrefetcher.shared.appeared(file, size: size)
                guard let source = file.picture(size) else { image = nil; return }
                if let hit = ThumbnailStore.shared.cached(source) { image = hit; return }
                let loaded = await ThumbnailStore.shared.image(source, api: session?.api)
                if !Task.isCancelled, let loaded {
                    withAnimation(.easeOut(duration: 0.15)) { image = loaded }
                }
            }
    }
}

/// A file's kind as one large glyph, centred on its dark tile — a waveform
/// for sound, a page for a document. The name beneath the tile says the rest.
struct KindSymbol: View {
    let file: FileItem
    var compact = false

    var body: some View {
        Image(systemName: FileFormat.symbol(file))
            .font(.system(size: compact ? 20 : 40, weight: .regular))
            .foregroundStyle(.white.opacity(0.88))
            .accessibilityHidden(true)
    }
}

extension FileItem {
    /// Where this file's picture comes from at a size, and what it is kept
    /// by: the thumbnail's own key and which of its sizes — never the link,
    /// which is signed afresh for every listing. The smallest picture that
    /// covers the size, and the next larger when a file lacks it.
    func thumbnail(_ size: ThumbnailSize) -> ThumbnailSource? {
        let key = thumbnailKey ?? "\(id)@\(version)"
        func source(_ link: String?, _ variant: String, _ pixels: Int) -> ThumbnailSource? {
            guard let link, let url = URL(string: link) else { return nil }
            return ThumbnailSource(url: url, key: "\(key)#\(variant)", maxPixels: pixels)
        }
        switch size {
        case .row:
            return source(xsUrl, "xs", 180) ?? source(smUrl, "sm", 180) ?? source(thumbnailUrl, "grid", 180)
        case .card:
            return source(smUrl, "sm", 600) ?? source(thumbnailUrl, "grid", 600)
        }
    }

    /// The large picture a preview shows first: a video's poster, or an
    /// image's preview of up to 2400 pixels.
    var posterSource: ThumbnailSource? {
        guard let posterUrl, let url = URL(string: posterUrl) else { return nil }
        return ThumbnailSource(url: url, key: "\(posterKey ?? "\(id)@\(version)")#poster", maxPixels: 2400)
    }
}

// MARK: - Words

/// What a file's facts read as, the way Finder and the web say them.
enum FileFormat {
    static func size(_ bytes: Int64?) -> String {
        guard let bytes else { return "—" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    static func items(_ count: Int) -> String {
        count == 1 ? "1 item" : "\(count.formatted()) items"
    }

    /// "1:05", "1:02:07": a video's or a song's length.
    static func duration(_ file: FileItem) -> String? {
        guard file.kind == "video" || file.kind == "audio", let seconds = file.metadata?.duration else { return nil }
        let total = Int(seconds.rounded())
        let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// "20m ago", "Sep 5": when it last changed, as a tile says it.
    static func when(_ file: FileItem) -> String {
        guard let date = (file.updatedAt ?? file.createdAt)?.date else { return size(file.size) }
        return RelativeTime.short(date)
    }

    /// "4.2 MB · 20m ago · MOV", for a list row.
    static func summary(_ file: FileItem) -> String {
        var parts: [String] = []
        parts.append(size(file.size))
        if let date = (file.updatedAt ?? file.createdAt)?.date {
            parts.append(RelativeTime.short(date))
        }
        if let length = duration(file) { parts.append(length) }
        if let format = format(file) { parts.append(format) }
        return parts.joined(separator: " · ")
    }

    /// The folder a file is in, as its own name ("Day 1"), for a search result.
    static func folderName(_ file: FileItem) -> String {
        file.folder.isEmpty ? "Top level" : (file.folder as NSString).lastPathComponent
    }

    /// "MOV", "PDF": the name's extension, as a format.
    static func format(_ file: FileItem) -> String? {
        let ext = (file.name as NSString).pathExtension
        return ext.isEmpty || ext.count > 5 ? nil : ext.uppercased()
    }

    static func symbol(_ file: FileItem) -> String {
        switch file.kind {
        case "image": return "photo"
        case "video": return "film"
        case "audio": return "waveform"
        case "doc":
            switch (file.name as NSString).pathExtension.lowercased() {
            case "pdf": return "doc.richtext"
            case "txt", "md", "rtf": return "doc.text"
            case "key", "ppt", "pptx": return "rectangle.on.rectangle"
            case "numbers", "xls", "xlsx", "csv": return "tablecells"
            default: return "doc"
            }
        default:
            switch (file.name as NSString).pathExtension.lowercased() {
            case "zip", "rar", "7z", "gz", "tar": return "doc.zipper"
            default: return "doc"
            }
        }
    }

    static func kindName(_ file: FileItem) -> String {
        switch file.kind {
        case "image": return "Image"
        case "video": return "Video"
        case "audio": return "Audio"
        case "doc": return "Document"
        default: return "File"
        }
    }

    /// lib/review.js's statuses (STATUS_LABELS).
    static func reviewColor(_ status: String) -> Color? {
        switch status {
        case "approved": return .green
        case "changes_requested": return .orange
        case "in_review": return .yellow
        default: return nil
        }
    }

    static func reviewName(_ status: String) -> String {
        switch status {
        case "approved": return "Approved"
        case "changes_requested": return "Changes requested"
        default: return "In review"
        }
    }

    /// "3840 × 2160".
    static func dimensions(_ file: FileItem) -> String? {
        guard let w = file.metadata?.width, let h = file.metadata?.height else { return nil }
        return "\(Int(w)) × \(Int(h))"
    }
}
