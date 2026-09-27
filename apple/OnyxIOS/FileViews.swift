import OnyxKit
import SwiftUI

// How files and folders look in a folder: tiles for the icon layout, rows
// for the list — each with its picture, name and the one fact worth a
// glance (a video's length, a document's size, a folder's count).

struct FileTile: View {
    let file: FileItem
    /// A search's results come from anywhere beneath the folder: each says where.
    var showsFolder = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Thumbnail(file: file, size: .card)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(.separator.opacity(0.5), lineWidth: 0.5)
                }
                .overlay(alignment: .bottomTrailing) {
                    if let length = FileFormat.duration(file) {
                        Text(length)
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(.black.opacity(0.55), in: Capsule())
                            .padding(6)
                    }
                }
                .overlay(alignment: .topTrailing) { ReviewBadge(file: file).padding(6) }
            Text(file.name)
                .font(.caption)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Text(showsFolder ? FileFormat.folderName(file) : FileFormat.size(file.size))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct FileRow: View {
    let file: FileItem
    var showsFolder = false

    var body: some View {
        HStack(spacing: 12) {
            Thumbnail(file: file, size: .row)
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(file.name).lineLimit(1)
                Text(showsFolder ? "\(FileFormat.folderName(file)) · \(FileFormat.summary(file))" : FileFormat.summary(file))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            ReviewBadge(file: file)
        }
        .contentShape(Rectangle())
    }
}

struct FolderTile: View {
    let node: FolderNode
    let items: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    Image(systemName: "folder.fill")
                        .resizable()
                        .scaledToFit()
                        .padding(18)
                        .foregroundStyle(.tint)
                        .symbolRenderingMode(.hierarchical)
                }
            Text(node.name)
                .font(.caption)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Text(FileFormat.items(items))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct FolderRow: View {
    let node: FolderNode
    let items: Int

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "folder.fill")
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(node.name).lineLimit(1)
                Text(FileFormat.items(items))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Approved, changes asked for, and open comments: a file's review at a glance.
struct ReviewBadge: View {
    let file: FileItem

    var body: some View {
        HStack(spacing: 4) {
            if let comments = file.openComments, comments > 0 {
                Label("\(comments)", systemImage: "text.bubble.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.accentColor, in: Capsule())
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

/// A file's picture, or its kind's symbol until there is one (or if there
/// is none). A picture already in memory is there on the first frame, so
/// scrolling back never flickers.
struct Thumbnail: View {
    let file: FileItem
    let size: ThumbnailSize
    @State private var image: UIImage?

    init(file: FileItem, size: ThumbnailSize) {
        self.file = file
        self.size = size
        _image = State(initialValue: file.thumbnail(size).flatMap { ThumbnailStore.shared.cached($0) })
    }

    var body: some View {
        Color(.secondarySystemFill)
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .transition(.opacity)
                } else {
                    KindSymbol(file: file, compact: size == .row)
                }
            }
            .clipped()
            .task(id: file.thumbnail(size)) {
                guard let source = file.thumbnail(size) else { image = nil; return }
                if let hit = ThumbnailStore.shared.cached(source) { image = hit; return }
                let loaded = await ThumbnailStore.shared.image(source)
                if !Task.isCancelled, let loaded {
                    withAnimation(.easeOut(duration: 0.15)) { image = loaded }
                }
            }
    }
}

/// A file's kind as a symbol, with its format beneath on a tile ("PDF").
struct KindSymbol: View {
    let file: FileItem
    var compact = false

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: FileFormat.symbol(file))
                .font(compact ? .title3 : .system(size: 30))
                .foregroundStyle(.secondary)
            if !compact, let format = FileFormat.format(file) {
                Text(format)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
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

    /// "Sep 5, 2026 · 4.2 MB · MOV", for a list row.
    static func summary(_ file: FileItem) -> String {
        var parts: [String] = []
        if let date = (file.updatedAt ?? file.createdAt)?.date {
            parts.append(date.formatted(date: .abbreviated, time: .omitted))
        }
        if let length = duration(file) { parts.append(length) }
        parts.append(size(file.size))
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
