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
                .overlay { shape.strokeBorder(Theme.edge, lineWidth: Theme.hairline) }
                .overlay(alignment: .bottomTrailing) {
                    if let length = FileFormat.duration(file) {
                        Text(length)
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Theme.scrim, in: Capsule())
                            .padding(10)
                    }
                }
                .overlay(alignment: .topTrailing) { ReviewBadge(file: file).padding(10) }
                .overlay(alignment: .topLeading) {
                    if selection != nil { SelectionCheck(chosen: chosen).padding(10) }
                }
                .overlay {
                    if chosen { shape.strokeBorder(Theme.brand, lineWidth: 2) }
                }
                .scaleEffect(chosen ? 0.97 : 1)
                .animation(Theme.motion(.arrive), value: chosen)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(Theme.Text.tile)
                    .lineLimit(1)
                Text(showsFolder ? FileFormat.folderName(file) : FileFormat.when(file))
                    .font(Theme.Text.meta)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, Theme.Space.s1)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

struct FileRow: View {
    let file: FileItem
    var showsFolder = false
    /// Share Link… for it, when that is offered.
    var share: (() -> Void)?
    @Environment(\.fileSelection) private var selection

    var body: some View {
        let chosen = selection?.contains(file.id) == true
        HStack(spacing: 14) {
            if selection != nil { SelectionCheck(chosen: chosen) }
            Thumbnail(file: file, size: .row)
                .frame(width: 52, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous)
                        .strokeBorder(Theme.edge, lineWidth: Theme.hairline)
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(file.name)
                    .font(Theme.Text.row)
                    .lineLimit(1)
                Text(showsFolder ? "\(FileFormat.folderName(file)) · \(FileFormat.summary(file))" : FileFormat.summary(file))
                    .font(Theme.Text.detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            ReviewBadge(file: file)
            if selection == nil { FileMoreMenu(file: file, share: share) }
        }
        .contentShape(Rectangle())
        .listRowBackground(chosen ? AnyView(Rectangle().fill(Theme.selection)) : AnyView(Color.clear))
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

struct FolderTile: View {
    let node: FolderNode
    let items: Int
    /// The drive's colour, which its folders are drawn in.
    var tint: Color = .accentColor
    @Environment(\.fileSelection) private var selection

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            RoundedRectangle(cornerRadius: Theme.tileCorner, style: .continuous)
                .fill(Theme.card)
                .aspectRatio(1, contentMode: .fit)
                .overlay { FolderGlyph(tint: tint, size: 66) }
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.tileCorner, style: .continuous)
                        .strokeBorder(Theme.edge, lineWidth: Theme.hairline)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(node.name)
                    .font(Theme.Text.tile)
                    .lineLimit(1)
                Text(FileFormat.items(items))
                    .font(Theme.Text.meta)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, Theme.Space.s1)
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
    var tint: Color = .accentColor
    @Environment(\.fileSelection) private var selection

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous)
                .fill(Theme.card)
                .frame(width: 52, height: 52)
                .overlay { FolderGlyph(tint: tint, size: 28) }
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.rowCorner, style: .continuous)
                        .strokeBorder(Theme.edge, lineWidth: Theme.hairline)
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(node.name)
                    .font(Theme.Text.row)
                    .lineLimit(1)
                Text(FileFormat.items(items))
                    .font(Theme.Text.detail)
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
            Circle().fill(chosen ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Theme.dim))
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .heavy))
                .foregroundStyle(Theme.onAura)
                .opacity(chosen ? 1 : 0)
                .bounce(on: chosen)
            Circle().strokeBorder(Theme.rim, lineWidth: 1.5)
        }
        .frame(width: 24, height: 24)
        .elevation(.low)
        .accessibilityHidden(true)
    }
}

/// A folder, drawn solid in the drive's colour: a back panel with its tab,
/// a lighter front panel over it — as the web draws one (FolderGlyph,
/// --folder-back/--folder-front in the dark scheme) — so a folder reads as
/// a folder beside the files' pictures, in any drive's colour. Two fills,
/// no picture.
struct FolderGlyph: View {
    var tint: Color = .accentColor
    /// Its width; the kit's folder is 24 wide by 17 and a bit tall.
    var size: CGFloat = 64

    var body: some View {
        let unit = size / 24
        ZStack(alignment: .topLeading) {
            FolderBack().fill(tint.opacity(0.46))
            // The front panel over the body (x 1.6–22.4, y 8.3–20.4 of 24).
            RoundedRectangle(cornerRadius: unit * 2.2, style: .continuous)
                .fill(tint.opacity(0.80))
                .overlay(alignment: .top) {
                    // Its lit top edge.
                    Capsule().fill(Theme.highlight)
                        .frame(height: 1)
                        .padding(.horizontal, unit * 2.2)
                        .padding(.top, 1)
                }
                .frame(width: unit * 20.8, height: unit * 12.1)
                .offset(x: unit * 1.6, y: unit * 5.3)
        }
        .frame(width: size, height: unit * 17.4, alignment: .topLeading)
        .accessibilityHidden(true)
    }
}

/// The kit's folder outline, filled: the tab at its top left over its body
/// (lucide 'folder': x 2–22, y 3–20 of 24, here from y 0).
private struct FolderBack: Shape {
    func path(in rect: CGRect) -> Path {
        let u = rect.width / 24
        let corner = CGSize(width: 2 * u, height: 2 * u)
        var path = Path()
        path.addRoundedRect(in: CGRect(x: rect.minX + 2 * u, y: rect.minY, width: 10 * u, height: 6 * u),
                            cornerSize: corner, style: .continuous)
        path.addRoundedRect(in: CGRect(x: rect.minX + 2 * u, y: rect.minY + 3 * u, width: 20 * u, height: 14 * u),
                            cornerSize: corner, style: .continuous)
        return path
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
                    .overlay(Circle().strokeBorder(Theme.rim, lineWidth: 1.5))
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
///
/// Until the picture has come, its placeholder (PlaceholderImages): the
/// thumbnail two dozen pixels across, from the file's own row, softened —
/// the picture the moment the tile is drawn, not once its request comes
/// back. The picture fades in over it, and then it goes. One not decoded
/// yet is asked for beside the picture, never ahead of it, and the tile
/// shows its plain ground for the frame or two that takes, not a symbol it
/// would take back at once.
struct Thumbnail: View {
    let file: FileItem
    let size: ThumbnailSize
    @Environment(Session.self) private var session: Session?
    @State private var image: UIImage?
    /// The placeholder, under the picture until the picture has faded in.
    @State private var still: UIImage?
    /// A placeholder is on its way: nothing is drawn meanwhile.
    @State private var stillComing: Bool

    init(file: FileItem, size: ThumbnailSize) {
        self.file = file
        self.size = size
        let shown = file.picture(size).flatMap { ThumbnailStore.shared.cached($0) }
        let still = shown == nil ? PlaceholderImages.shared.cached(file) : nil
        _image = State(initialValue: shown)
        _still = State(initialValue: still)
        _stillComing = State(initialValue: shown == nil && still == nil && file.metadata?.placeholder != nil)
    }

    var body: some View {
        // The ground under a picture, and the tile of a file without one: the
        // card's grey, as a folder's tile and the Storage card are.
        Theme.card
            .overlay {
                ZStack {
                    if let still {
                        Image(uiImage: still)
                            .resizable()
                            .scaledToFill()
                            .accessibilityHidden(true)
                    }
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .transition(.opacity)
                    } else if still == nil, !stillComing {
                        if file.kind == "audio", let waveform = file.metadata?.waveform {
                            TileWaveform(waveform: waveform, compact: size == .row)
                        } else {
                            KindSymbol(file: file, compact: size == .row)
                        }
                    }
                }
            }
            .clipped()
            .task(id: file.picture(size)) { await show() }
    }

    /// The picture, from memory, disk or storage, and meanwhile its
    /// placeholder: both asked for at once, and each shown as it comes — the
    /// placeholder only while the picture has not, so it never holds the
    /// picture up.
    private func show() async {
        ThumbnailPrefetcher.shared.appeared(file, size: size)
        guard let source = file.picture(size) else {
            image = nil
            still = nil
            stillComing = false
            return
        }
        if let hit = ThumbnailStore.shared.cached(source) {
            image = hit
            still = nil
            stillComing = false
            return
        }
        let api = session?.api, file = self.file
        let wantsStill = image == nil && still == nil && file.metadata?.placeholder != nil
        await withTaskGroup(of: Arrival.self) { group in
            group.addTask { .picture(await ThumbnailStore.shared.image(source, api: api)) }
            if wantsStill { group.addTask { .still(await PlaceholderImages.shared.image(for: file)) } }
            for await arrival in group {
                guard !Task.isCancelled else { return }
                switch arrival {
                case let .still(tiny):
                    if image == nil { still = tiny }
                    stillComing = false
                case let .picture(loaded):
                    // None to be had: the placeholder, if one is coming, stays.
                    guard let loaded else { continue }
                    stillComing = false
                    withAnimation(.easeOut(duration: 0.15)) {
                        image = loaded
                    } completion: {
                        // Covered now: a layer less to draw.
                        still = nil
                    }
                }
            }
        }
    }

    private enum Arrival: Sendable {
        case picture(UIImage?)
        case still(UIImage?)
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
