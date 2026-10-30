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
        // The material the system's own extras have (VibrantPanel): the
        // WindowServer draws it, so the once-a-second graphs cost no more
        // over it than over a flat colour.
        .background(VibrantPanel().ignoresSafeArea())
        // The drives as the web has them now, their colours and names; and,
        // while they are in ~/Onyx because the file system is off, whether
        // it has been switched on since.
        .task {
            await finder.checkFileSystemSwitch()
            await model.refreshIfOlder(than: 10)
        }
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
                    // The dot turns between states rather than snapping:
                    // a crossfade bound to the change, and still with
                    // Reduce Motion.
                    Circle().fill(status.tint).frame(width: 7, height: 7)
                        .animation(Motion.gated(Motion.quick), value: status)
                    Text(status.line)
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                .help(status.line)
            }
            Spacer(minLength: 8)
            // The panel's one lit action.
            Button(model.phase == .signedIn ? "Open Onyx" : "Sign In…") { open() }
                .prominent()
                .tint(Theme.accent)
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
            PanelUploads(summary: finder.uploadSummary, estimate: finder.uploadEstimate) { finder.retryUpload($0) }
            TranscriptionMenuLine(transcriber: model.transcriber)
                .font(.system(size: 11)).foregroundStyle(.secondary)
            ProxyMenuLine(proxies: model.proxies)
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(12)
    }

    // MARK: Drives

    private var drives: some View {
        let rows = model.finderDrives.count + 1
        return VStack(alignment: .leading, spacing: 6) {
            // Level with the rows' icons and switches, which sit 10pt
            // inside their group.
            HStack {
                PanelTitle("Drives")
                Spacer()
                PanelTitle("In Finder")
            }
            .padding(.horizontal, 10)
            // In ~/Onyx rather than disks of their own: said here, not only
            // in Settings, with the way to put it right.
            if let note = finder.fileSystemNote {
                FileSystemNoteRow(finder: finder, note: note)
            }
            // One inset group, as the system's extras list theirs. A long
            // list scrolls rather than running off the screen.
            Group {
                if rows > 9 {
                    ScrollView { driveRows }.frame(height: 9 * DriveRow.height)
                } else {
                    driveRows
                }
            }
            .padding(.vertical, 2)
            .panelGroup()
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
                // Nothing to list, said as a picture over a line — the
                // shape every empty state takes, on the web and the phone —
                // rather than a bare sentence where a row would be.
                VStack(spacing: 6) {
                    Image(lucide: "hard-drive", size: 24, strokeWidth: 1.5).foregroundStyle(.tertiary)
                    Text("No drives yet").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
            }
            ForEach(model.finderDrives) { drive in
                DriveRow(scope: .drive(id: drive.id), name: drive.name, detail: Self.roleWord(drive.role),
                         icon: DriveIcons.image(for: drive))
            }
            if !model.drivesOnly {
                DriveRow(scope: .library, name: "Library", detail: "files in no drive", icon: DriveIcons.library)
            }
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
        VStack(alignment: .leading, spacing: 8) {
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
                .foregroundStyle(Theme.accent)
                .padding(.horizontal, 4)
            }
            // The system's own bar buttons: a highlight under the pointer, a
            // focus ring, a hit area of their own — and Quit kept apart from
            // the rest by a line, so it is never one pixel from Settings.
            HStack(spacing: 2) {
                if model.phase == .signedIn {
                    Button {
                        Task { await model.syncNow() }
                    } label: {
                        Label { Text("Sync Now") } icon: { Image(lucide: "refresh-cw", size: 12) }
                    }
                    .help("Bring every drive up to date with the web now")
                }
                Spacer()
                SettingsLink {
                    Label { Text("Settings…") } icon: { Image(lucide: "settings", size: 12) }
                }
                .keyboardShortcut(",")
                Divider().frame(height: 14).padding(.horizontal, 6)
                // ⌥⌘Q, as in the app menu: ⌘Q never quits Onyx
                // (OnyxCommands), here any more than in its window.
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut("q", modifiers: [.command, .option])
                    .help("Quit Onyx (⌥⌘Q). Drives leave Finder until it opens again.")
            }
            .buttonStyle(.accessoryBar)
            .font(.system(size: 12))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
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
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            // A heading to VoiceOver, so the panel can be read section by section.
            .accessibilityAddTraits(.isHeader)
    }
}

/// Why drives are in the Onyx folder rather than disks of their own
/// (DriveService.fileSystemNote), and the way to put it right. Switched off:
/// System Settings' switch, the one macOS lets people use — Onyx's own Turn
/// On beside it only where macOS may allow that (offersTurnOn); sent there
/// and still off, a restart is what it takes, and it says so. Not taken in by
/// macOS, or a disk that would not mount: what macOS said, and the restart.
private struct FileSystemNoteRow: View {
    @ObservedObject var finder: DriveService
    let note: DriveService.FileSystemNote

    var body: some View {
        // icons: hard-drive
        NoteCard(tone: tone, icon: "hard-drive", title: title, message: detail,
                 problem: note == .switchedOff ? finder.turnOnProblem : nil) {
            if note == .switchedOff {
                Button("System Settings…") { finder.openFileSystemSettings() }
                if finder.offersTurnOn {
                    Button(finder.turningOnDisks ? "Turning On…" : "Turn On") {
                        Task { await finder.turnOnDisks() }
                    }
                    .disabled(finder.turningOnDisks)
                }
            }
        }
    }

    /// Something to do, or — a disk that would not mount — something that
    /// went wrong.
    private var tone: NoteTone {
        if case .failed = note { return .problem }
        return .warning
    }

    private var title: String {
        switch note {
        case .switchedOff: return "Your drives aren't disks right now"
        case .needsRestart: return "Restart to make your drives disks again"
        case .failed: return "A drive is in the Onyx folder, not a disk"
        }
    }

    private var detail: String {
        switch note {
        case .needsRestart:
            return "macOS is still using an earlier copy of the Onyx file system, so your drives are in the Onyx folder until you restart your Mac."
        case .switchedOff where finder.switchDidNotTake:
            return "The Onyx file system is off, so your drives are in the Onyx folder. If Onyx won't stay switched on in System Settings, restart your Mac, then switch it on."
        case .switchedOff:
            return "The Onyx file system is off, so your drives are in the Onyx folder. Switch Onyx on in System Settings to make each one a disk again."
        case let .failed(why):
            return why
        }
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

    static let height: CGFloat = 36

    var body: some View {
        HStack(spacing: 9) {
            Image(nsImage: icon).resizable().interpolation(.high).frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 0) {
                Text(name).font(.system(size: 13)).lineLimit(1).truncationMode(.tail)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 6)
            // icons: triangle-alert folder-open
            switch finder.mountState(of: scope) {
            case .mounting?:
                ProgressView().controlSize(.small)
            case let .failed(message)?:
                Image(lucide: "triangle-alert", size: 13).foregroundStyle(Theme.warning).help(message)
            case .mounted?:
                // The system's bar button: it lights under the pointer and
                // takes a click a little around the glyph.
                Button { model.reveal(scope) } label: {
                    Image(lucide: "folder-open", size: 14)
                }
                .buttonStyle(.accessoryBar)
                .help("Open in Finder")
                .accessibilityLabel("Open \(name) in Finder")
            case nil:
                EmptyView()
            }
            Toggle(isOn: Binding(
                get: { finder.wantMounted.contains(scope.identifier) },
                set: { on in Task { await model.setMounted(scope, name: name, on) } }
            )) { Text("Show \(name) in Finder") }
                .toggleStyle(.switch)
                .controlSize(.small)
                .labelsHidden()
                .disabled(model.busy.contains(scope.identifier))
        }
        .padding(.horizontal, 10)
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
    let estimate: UploadPace.Estimate?
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
                Text(UploadWords.left(summary, estimate))
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    .monospacedDigit()
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

/// "1.2 GB of 4.5 GB left · about 3 min · 12 MB/s": how much is still to
/// send, and — once the pace is known — how long that should take.
enum UploadWords {
    static func left(_ summary: UploadSummary, _ estimate: UploadPace.Estimate?) -> String {
        let bytes = { (n: Int64) in ByteCountFormatter.string(fromByteCount: n, countStyle: .file) }
        var parts = ["\(bytes(summary.remainingBytes)) of \(bytes(summary.totalBytes)) left"]
        if let estimate {
            parts.append(time(estimate.secondsLeft))
            parts.append("\(bytes(Int64(estimate.bytesPerSecond)))/s")
        } else {
            parts.append("working out the time…")
        }
        return parts.joined(separator: " · ")
    }

    static func time(_ seconds: Double) -> String {
        if seconds < 60 { return "less than a minute" }
        let f = DateComponentsFormatter()
        f.unitsStyle = .short
        f.maximumUnitCount = seconds < 3600 ? 1 : 2
        f.allowedUnits = [.hour, .minute]
        // Rounded up to the minute: "about 1 min" for 61 s would undersell it.
        return "about " + (f.string(from: (seconds / 60).rounded(.up) * 60) ?? "")
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
