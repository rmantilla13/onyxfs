import SwiftUI
import AppKit
import UniformTypeIdentifiers
import OnyxKit

// MARK: - The menu bar's panel

/// What the menu bar item opens: who is signed in and how Onyx is doing,
/// what is moving right now, the drives — each with the icon its disk has in
/// Finder, and whether it is there — and the few things to do from here. A
/// panel rather than a menu, so it can show the activity graphs and the
/// icons, laid out to be read at a glance.
struct MenuPanel: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var updater: Updater
    @EnvironmentObject var finder: DriveService
    @Environment(\.openWindow) private var openWindow

    static let width: CGFloat = 350

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if model.phase == .signedIn {
                Divider().padding(.horizontal, 12)
                activity
                Divider().padding(.horizontal, 12)
                drives
            }
            Divider().padding(.horizontal, 12)
            footer
        }
        .frame(width: Self.width)
    }

    // MARK: Header

    private var header: some View {
        let status = MenuBarStatus.of(model, finder)
        return HStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.phase == .signedIn ? (model.email ?? "Signed in") : "Onyx")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1).truncationMode(.middle)
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Circle().fill(status.tint).frame(width: 7, height: 7)
                    Text(status.line)
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                .help(status.line)
            }
            Spacer(minLength: 8)
            Button(model.phase == .signedIn ? "Open Onyx" : "Sign In…") { open() }
                .controlSize(.small)
                .keyboardShortcut("o")
        }
        .padding(12)
    }

    // MARK: Activity

    private var activity: some View {
        VStack(alignment: .leading, spacing: 8) {
            PanelTitle("Activity")
            ActivityTiles(clock: model.activity)
            // What is on its way: the window's downloads, the drives'
            // uploads, a transcript this Mac is making.
            PanelDownloads(downloads: model.web.downloads)
            PanelUploads(summary: finder.uploadSummary) { finder.retryUpload($0) }
            TranscriptionMenuLine(transcriber: model.transcriber)
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(12)
    }

    // MARK: Drives

    private var drives: some View {
        let rows = model.finderDrives.count + 1
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                PanelTitle("Drives")
                Spacer()
                PanelTitle("In Finder")
            }
            // A long list scrolls rather than running off the screen.
            if rows > 9 {
                ScrollView { driveRows }.frame(height: 9 * DriveRow.height)
            } else {
                driveRows
            }
            if finder.pinnedBytes > 0 {
                Text("\(ByteCountFormatter.string(fromByteCount: finder.pinnedBytes, countStyle: .file)) kept offline on this Mac")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
        }
        .padding(12)
    }

    private var driveRows: some View {
        VStack(spacing: 0) {
            if model.finderDrives.isEmpty {
                Text("No drives yet").font(.system(size: 12)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: DriveRow.height, alignment: .leading)
            }
            ForEach(model.finderDrives) { drive in
                DriveRow(scope: .drive(id: drive.id), name: drive.name, detail: Self.roleWord(drive.role),
                         icon: DriveIcons.image(for: drive))
            }
            DriveRow(scope: .library, name: "Library", detail: "files in no drive", icon: DriveIcons.library)
        }
    }

    static func roleWord(_ role: String?) -> String? {
        switch role {
        case "owner": return "owner"
        case "editor": return "can edit"
        case "viewer": return "can view"
        default: return nil
        }
    }

    // MARK: Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let release = updater.available {
                Button {
                    open()
                    updater.showSheet = true
                } label: {
                    HStack(spacing: 6) {
                        Image(lucide: "download", size: 13)
                        Text("Onyx \(release.version) is available")
                        Spacer()
                        Text("Update…").foregroundStyle(.secondary)
                    }
                    .font(.system(size: 12))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
            HStack(spacing: 12) {
                if model.phase == .signedIn {
                    Button {
                        Task { await model.syncNow() }
                    } label: {
                        Label { Text("Sync Now") } icon: { Image(lucide: "refresh-cw", size: 12) }
                    }
                    .buttonStyle(.plain)
                    .help("Bring every drive up to date with the web now")
                }
                Spacer()
                SettingsLink {
                    Label { Text("Settings…") } icon: { Image(lucide: "settings", size: 12) }
                }
                .buttonStyle(.plain)
                .keyboardShortcut(",")
                Button("Quit") { NSApp.terminate(nil) }
                    .buttonStyle(.plain)
                    .keyboardShortcut("q")
                    .help("Quit Onyx. Drives leave Finder until it opens again.")
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
        }
        .padding(12)
    }

    private func open() {
        Background.shared.comeForward()
        openWindow(id: "main")
    }
}

/// A section's name, as macOS's own panels set them.
private struct PanelTitle: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
    }
}

/// One drive: its icon, as its disk has it in Finder; its name and what this
/// account may do in it; how its disk is doing; and a switch for whether it
/// is in Finder at all.
private struct DriveRow: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var finder: DriveService
    let scope: SyncDomain
    let name: String
    let detail: String?
    let icon: NSImage

    static let height: CGFloat = 34

    var body: some View {
        HStack(spacing: 9) {
            Image(nsImage: icon).resizable().interpolation(.high).frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 0) {
                Text(name).font(.system(size: 13)).lineLimit(1).truncationMode(.tail)
                if let detail {
                    Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 6)
            // icons: triangle-alert folder-open
            switch finder.mountState(of: scope) {
            case .mounting?:
                ProgressView().controlSize(.small)
            case let .failed(message)?:
                Image(lucide: "triangle-alert", size: 13).foregroundStyle(.orange).help(message)
            case .mounted?:
                Button { model.reveal(scope) } label: {
                    Image(lucide: "folder-open", size: 14).frame(width: 22, height: 22).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Open in Finder")
            case nil:
                EmptyView()
            }
            Toggle(isOn: Binding(
                get: { finder.wantMounted.contains(scope.identifier) },
                set: { on in Task { await model.setMounted(scope, name: name, on) } }
            )) { Text("Show \(name) in Finder") }
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .disabled(model.busy.contains(scope.identifier))
        }
        .frame(height: Self.height)
    }
}

/// The window's downloads: the one under way, or the last, as the bar at
/// the foot of the window shows it.
private struct PanelDownloads: View {
    @ObservedObject var downloads: WebDownloads

    var body: some View {
        if let item = downloads.shown {
            DownloadRow(item: item, downloads: downloads)
        }
    }
}

/// Files on their way to Onyx from the drives, and any that did not make it,
/// to try again.
private struct PanelUploads: View {
    let summary: UploadSummary
    let retry: (UUID) -> Void

    var body: some View {
        if summary.waiting > 0 {
            let percent = Int((summary.fraction * 100).rounded())
            VStack(alignment: .leading, spacing: 4) {
                Text(summary.waiting == 1
                     ? "Uploading \(summary.current ?? "a file") — \(percent)%"
                     : "Uploading \(summary.waiting) files — \(percent)%")
                    .font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                ProgressLine(fraction: summary.fraction)
            }
        }
        ForEach(summary.failed) { job in
            HStack(spacing: 6) {
                Image(lucide: "triangle-alert", size: 12).foregroundStyle(.orange)
                Text("“\(job.name)” did not upload").font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                    .help(job.lastError ?? "")
                Spacer()
                Button("Retry") { retry(job.id) }.controlSize(.small)
            }
        }
    }
}

/// Each drive's icon as Finder shows it on its disk — the drive's initial in
/// its colour from the web, on the logo's tile (DriveIcon), the drawing the
/// file system extension puts on the disk — so the panel, Settings and
/// Finder agree. Drawn once per colour and name, at the one size shown.
@MainActor
enum DriveIcons {
    private static var cache: [String: NSImage] = [:]

    static func image(for drive: Filespace) -> NSImage {
        let key = "\(drive.color ?? "")\u{0}\(drive.name)"
        if let hit = cache[key] { return hit }
        let image = DriveIcon.image(color: drive.color, name: drive.name, pixels: 64)
            .map { NSImage(cgImage: $0, size: NSSize(width: 32, height: 32)) }
            ?? NSWorkspace.shared.icon(for: .volume)
        cache[key] = image
        return image
    }

    /// The library's disk: the app's own icon, as Finder has it.
    static var library: NSImage { NSApp.applicationIconImage }
}
