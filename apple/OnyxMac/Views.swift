import SwiftUI
import WebKit
import OnyxKit

// MARK: - Main window

struct MainWindow: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var updater: Updater

    var body: some View {
        Group {
            switch model.phase {
            case .signedIn: WorkspaceView(web: model.web)
            case .signedOut, .signingIn:
                SignInView().overlay(alignment: .top) { TitlebarDragArea().frame(height: 52) }
            }
        }
        .frame(minWidth: 880, minHeight: 560)
        // No toolbar: the web's bar is the title bar (WindowChrome).
        .ignoresSafeArea(.container, edges: .top)
        .background(WindowReader { window in model.web.windowChanged(window) })
        .sheet(isPresented: $updater.showSheet) { UpdateSheet() }
    }
}

// MARK: - Updates

struct UpdateSheet: View {
    @EnvironmentObject var updater: Updater

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.headline)
                    Text(subtitle).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let release = updater.available, let notes = release.notes, !notes.isEmpty {
                ScrollView {
                    Text(notes).font(.callout).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }
                .frame(height: 140)
                .padding(8)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            }
            switch updater.state {
            case let .downloading(f):
                ProgressView(value: f) { Text("Downloading…").font(.caption) }
            case .installing:
                ProgressView { Text("Installing…").font(.caption) }
            default:
                EmptyView()
            }
            HStack {
                if let release = updater.available {
                    Button("Skip This Version") { updater.skip(release) }
                    Spacer()
                    Button("Later") { updater.dismiss() }.keyboardShortcut(.cancelAction)
                    if updater.canInstall {
                        Button("Install and Relaunch") { Task { await updater.install(release) } }
                            .keyboardShortcut(.defaultAction)
                    } else {
                        Button("Download") { updater.openDownload(release) }
                            .keyboardShortcut(.defaultAction)
                    }
                } else if case .downloading = updater.state {
                    Spacer()
                } else if case .installing = updater.state {
                    Spacer()
                } else {
                    Spacer()
                    Button("OK") { updater.dismiss() }.keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(22)
        .frame(width: 440)
    }

    private var title: String {
        switch updater.state {
        case let .available(r): return "Onyx \(r.version) is available"
        case .downloading, .installing: return "Updating Onyx"
        case .upToDate: return "Onyx is up to date"
        case .failed: return "The update did not work"
        default: return "Checking for updates…"
        }
    }

    private var subtitle: String {
        switch updater.state {
        case .available:
            return updater.canInstall
                ? "You have \(BuildInfo.version). It relaunches when it is done."
                : "You have \(BuildInfo.version). This copy cannot update itself in place, so the download opens in your browser."
        case .upToDate: return "You have the newest version, \(BuildInfo.version)."
        case let .failed(message): return message
        default: return ""
        }
    }
}

// MARK: - Signing in

/// A view's own editing state. (Not @State: in current SDKs that is a macro
/// whose plugin ships only with Xcode, and this app builds without it.)
final class FormState: ObservableObject {
    @Published var code = ""
    @Published var editingServer = false
    @Published var serverText = ""
}

struct SignInView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var form = FormState()

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(nsImage: NSApp.applicationIconImage)
                .resizable().frame(width: 88, height: 88)
            VStack(spacing: 6) {
                Text("Sign in to Onyx").font(.title).fontWeight(.semibold)
                Text("Your drives, in Finder and in this window.")
                    .foregroundStyle(.secondary)
            }

            Button {
                Task { await model.signInWithBrowser() }
            } label: {
                Text("Sign in with your browser").frame(minWidth: 240)
            }
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(model.phase == .signingIn)

            HStack(spacing: 10) {
                VStack { Divider() }.frame(width: 80)
                Text("or use a pairing code").font(.caption).foregroundStyle(.secondary)
                VStack { Divider() }.frame(width: 80)
            }

            HStack(spacing: 8) {
                TextField("XXXX-XXXX-XXXX", text: $form.code)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .frame(width: 180)
                    .onSubmit(pair)
                Button("Pair", action: pair)
                    .disabled(form.code.filter { $0.isLetter || $0.isNumber }.count < 12 || model.phase == .signingIn)
            }
            Text("Make one at \(model.serverLabel)/space/pair, signed in on any browser.")
                .font(.caption).foregroundStyle(.secondary)

            if model.phase == .signingIn { ProgressView().controlSize(.small) }
            if let problem = model.problem {
                Text(problem).font(.callout).foregroundStyle(.red)
                    .multilineTextAlignment(.center).frame(maxWidth: 420)
            }
            Spacer()
            HStack(spacing: 4) {
                Text("Server:").foregroundStyle(.secondary)
                Button(model.serverLabel) { form.serverText = model.serverAddress; form.editingServer = true }
                    .buttonStyle(.link)
            }
            .font(.caption)
            .popover(isPresented: $form.editingServer) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Onyx server").font(.headline)
                    TextField("", text: $form.serverText, prompt: Text("onyxfs.io"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder).frame(width: 260)
                        .onSubmit(saveServer)
                    HStack {
                        Button("Use onyxfs.io") { form.serverText = "https://www.onyxfs.io"; saveServer() }
                        Spacer()
                        Button("Save", action: saveServer).keyboardShortcut(.defaultAction)
                    }
                }
                .padding(16)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func pair() {
        let c = form.code
        Task { await model.pair(code: c) }
    }

    private func saveServer() {
        Task { if await model.setServer(form.serverText) { form.editingServer = false } }
    }
}

// MARK: - The workspace

struct WorkspaceView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var web: WebController

    var body: some View {
        WebViewHost(webView: web.webView)
            .overlay {
                if let failure = web.failure {
                    VStack(spacing: 14) {
                        Image(lucide: "wifi-off", size: 34, strokeWidth: 1.5).foregroundStyle(.secondary)
                        Text(failure).multilineTextAlignment(.center).frame(maxWidth: 440)
                        Button("Try Again") { web.reload() }.keyboardShortcut(.defaultAction)
                    }
                    .padding(28)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
            .task { if web.webView.url == nil { web.signIn() } }
    }
}

/// Hosts the controller's one WKWebView, so it survives SwiftUI rebuilding
/// the view around it (a new web view would lose the page and its state).
struct WebViewHost: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

// MARK: - Finder

/// One entry per drive, and one for the library, in the menu bar item. (The
/// window's bar has the same menu, drawn by the page: FinderMenu.js.)
struct FinderItems: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var finder: DriveService

    var body: some View {
        Section("Show in Finder") {
            if model.finderDrives.isEmpty {
                Text("No drives yet")
            }
            ForEach(model.finderDrives) { drive in
                toggle(.drive(id: drive.id), name: drive.name, detail: roleWord(drive.role))
            }
            toggle(.library, name: "Library", detail: "files in no drive")
        }
        let open = model.finderDrives.filter { model.isMounted(.drive(id: $0.id)) }
        if !open.isEmpty || model.isMounted(.library) {
            Section("Open in Finder") {
                ForEach(open) { drive in
                    Button(drive.name) { model.reveal(.drive(id: drive.id)) }
                }
                if model.isMounted(.library) {
                    Button("Library") { model.reveal(.library) }
                }
            }
        }
        Divider()
        Button("Sync Now") { Task { await model.syncNow() } }
    }

    private func toggle(_ scope: SyncDomain, name: String, detail: String?) -> some View {
        Toggle(isOn: Binding(
            get: { finder.wantMounted.contains(scope.identifier) },
            set: { on in Task { await model.setMounted(scope, name: name, on) } }
        )) {
            Text(name) + Text(detail.map { "  \($0)" } ?? "").foregroundColor(.secondary)
        }
        .disabled(model.busy.contains(scope.identifier))
    }

    private func roleWord(_ role: String?) -> String? {
        switch role {
        case "owner": return "owner"
        case "editor": return "can edit"
        case "viewer": return "can view"
        default: return nil
        }
    }
}

// MARK: - Menu bar

/// What Onyx is doing, at a glance, in the menu bar.
enum MenuBarStatus: Equatable {
    case signedOut, idle, mounted(Int), syncing, offline, attention(String)

    var symbol: String {
        switch self {
        // icons: hard-drive refresh-cw cloud-off triangle-alert cloud-download
        case .signedOut, .idle, .mounted: return "hard-drive"
        case .syncing: return "refresh-cw"
        case .offline: return "cloud-off"
        case .attention: return "triangle-alert"
        }
    }

    var line: String {
        switch self {
        case .signedOut: return "Not signed in"
        case .idle: return "Up to date"
        case let .mounted(n): return n == 1 ? "1 drive in Finder · up to date" : "\(n) drives in Finder · up to date"
        case .syncing: return "Syncing…"
        case .offline: return "Offline — Finder shows the last synced state; files kept offline still open"
        case let .attention(why): return why
        }
    }

    @MainActor
    static func of(_ model: AppModel, _ finder: DriveService) -> MenuBarStatus {
        guard model.phase == .signedIn else { return .signedOut }
        if let failed = finder.allMountStates.compactMap({ state -> String? in
            if case let .failed(why) = state { return why }
            return nil
        }).first {
            return .attention(failed)
        }
        if let problem = finder.problem ?? finder.offlineProblem { return .attention(problem) }
        if finder.isOffline { return .offline }
        if !finder.syncing.isEmpty || finder.downloading > 0 { return .syncing }
        let mounted = finder.allMountStates.filter { if case .mounted = $0 { return true } else { return false } }.count
        return mounted > 0 ? .mounted(mounted) : .idle
    }
}

/// The menu bar icon, which also opens the window when Onyx is reopened from
/// Finder or Launchpad while it runs in the background — it is the one view
/// that is always there to do it.
struct MenuBarIcon: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var finder: DriveService
    @EnvironmentObject var updater: Updater
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let status = MenuBarStatus.of(model, finder)
        Image(lucide: updater.available != nil && status == .idle ? "cloud-download" : status.symbol, size: 16)
            .accessibilityLabel("Onyx: \(status.line)")
            .onReceive(NotificationCenter.default.publisher(for: .onyxOpenWindow)) { _ in
                Background.shared.comeForward()
                openWindow(id: "main")
            }
    }
}

struct MenuBarContent: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var updater: Updater
    @EnvironmentObject var finder: DriveService
    @ObservedObject private var background = Background.shared
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let status = MenuBarStatus.of(model, finder)
        if model.phase == .signedIn {
            Text(model.email ?? "Signed in")
            Text(status.line)
            TranscriptionMenuLine(transcriber: model.transcriber)
            UploadsMenuLines(summary: finder.uploadSummary) { id in finder.retryUpload(id) }
            if finder.pinnedBytes > 0 {
                Text("Kept offline: \(ByteCountFormatter.string(fromByteCount: finder.pinnedBytes, countStyle: .file))")
            }
            Divider()
            Button("Open Onyx") { open() }.keyboardShortcut("o")
            FinderItems()
        } else {
            Text("Not signed in")
            Button("Sign In…") { open() }
        }
        Divider()
        if let release = updater.available {
            Button("Update to Onyx \(release.version)…") { open(); updater.showSheet = true }
        } else {
            Button("Check for Updates…") {
                open()
                Task { await updater.check(userInitiated: true) }
            }
        }
        Toggle("Open at Login", isOn: Binding(
            get: { background.opensAtLogin },
            set: { background.setOpensAtLogin($0) }
        ))
        SettingsLink { Text("Settings…") }.keyboardShortcut(",")
        Divider()
        Button("Quit Onyx") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private func open() {
        Background.shared.comeForward()
        openWindow(id: "main")
    }
}

// MARK: - Settings

struct SettingsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        TabView {
            AccountSettings().tabItem { Label { Text("Account") } icon: { Image(lucide: "circle-user") } }
            FinderSettings(finder: model.finder).tabItem { Label { Text("Finder") } icon: { Image(lucide: "hard-drive") } }
            StorageSettings(finder: model.finder).tabItem { Label { Text("Storage") } icon: { Image(lucide: "database") } }
        }
        .frame(width: 480, height: 420)
    }
}

struct AccountSettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var updater: Updater
    @ObservedObject private var background = Background.shared
    @StateObject private var form = FormState()

    var body: some View {
        Form {
            LabeledContent("Signed in as") {
                Text(model.phase == .signedIn ? (model.email ?? "—") : "Not signed in")
            }
            LabeledContent("Server") {
                HStack {
                    TextField("", text: $form.serverText, prompt: Text("onyxfs.io"))
                        .labelsHidden()
                        .frame(width: 200)
                        .onSubmit { Task { await model.setServer(form.serverText) } }
                    Button("Change") { Task { await model.setServer(form.serverText) } }
                        .disabled(form.serverText == model.serverAddress)
                }
            }
            if model.phase == .signedIn {
                LabeledContent("") {
                    Button("Sign Out") { Task { await model.signOut() } }
                }
            }
            if let problem = model.problem {
                Text(problem).foregroundStyle(.red).font(.callout)
            }
            Section {
                Text("Changing servers signs you out: a sign-in belongs to the server that issued it.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("In the background") {
                Toggle("Open at login", isOn: Binding(
                    get: { background.opensAtLogin },
                    set: { background.setOpensAtLogin($0) }
                ))
                if background.needsApproval {
                    Text("Allow Onyx in System Settings → General → Login Items.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("Onyx keeps running in the menu bar when its window is closed, so your drives stay in Finder and offline files stay current. Quit it from the menu bar icon.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            TranscriptionSettings(transcriber: model.transcriber)
            Section("Updates") {
                LabeledContent("Version") {
                    Text(BuildInfo.build.map { "\(BuildInfo.version) (\($0))" } ?? BuildInfo.version)
                }
                Toggle("Check for updates automatically", isOn: $updater.automatic)
                LabeledContent("") {
                    Button("Check Now") { Task { await updater.check(userInitiated: true) } }
                        .disabled(updater.state == .checking)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { form.serverText = model.serverAddress }
    }
}

struct FinderSettings: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var finder: DriveService
    @ObservedObject var mounts: MountManager

    init(finder: DriveService) {
        _finder = ObservedObject(wrappedValue: finder)
        _mounts = ObservedObject(wrappedValue: finder.mounts)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(finder.drivesAreDisks
                 ? "Each drive you turn on is a disk of its own in Finder, under Locations and on the Desktop. It is exactly what the web shows you, files stream as you open them, and what you copy onto it is uploaded to Onyx."
                 : "Each drive you turn on appears in Finder, in your Onyx folder and under Locations. It is exactly what the web shows you, and files stream as you open them — nothing downloads until something reads it.")
                .font(.callout).foregroundStyle(.secondary)
            DiskModeNote(finder: finder)
            FullDiskAccessRow()
            List {
                ForEach(model.finderDrives) { drive in
                    row(.drive(id: drive.id), name: drive.name)
                }
                row(.library, name: "Library")
            }
            HStack {
                Text(finder.drivesAreDisks
                     ? "Copy, rename, move and delete in Finder as on any disk; the web shows the same. A drive you can only view is read-only."
                     : "Read-only in Finder for now; add and change files in the Onyx window.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Sync Now") { Task { await model.syncNow() } }
            }
            if let problem = finder.problem ?? model.problem {
                Text(problem).foregroundStyle(.red).font(.caption)
            }
        }
        .padding(20)
        .task { await model.refresh() }
    }

    private func row(_ scope: SyncDomain, name: String) -> some View {
        let pinnedDrive = PinRule(scope: scope.identifier, target: .folder(path: ""))
        return HStack(spacing: 12) {
            Toggle(name, isOn: Binding(
                get: { finder.wantMounted.contains(scope.identifier) },
                set: { on in Task { await model.setMounted(scope, name: name, on) } }
            ))
            .disabled(model.busy.contains(scope.identifier) || model.phase != .signedIn)
            Spacer()
            switch finder.mountState(of: scope) {
            case .mounting?:
                ProgressView().controlSize(.small)
            case let .failed(message)?:
                Image(lucide: "triangle-alert").foregroundStyle(.orange).help(message)
            case .mounted?:
                Button("Show") { model.reveal(scope) }.buttonStyle(.link)
            case nil:
                EmptyView()
            }
            Toggle("Offline", isOn: Binding(
                get: { finder.pinRules.contains(pinnedDrive) },
                set: { on in Task { if on { await finder.pin(pinnedDrive) } else { await finder.unpin(pinnedDrive) } } }
            ))
            .toggleStyle(.checkbox)
            .help("Keep every file in this drive on this Mac, to open without a connection")
            .disabled(model.phase != .signedIn)
        }
    }
}

/// Where streamed and pinned files are kept, and how much streaming may keep.
struct StorageSettings: View {
    @ObservedObject var finder: DriveService

    private let limits = [10, 25, 50, 100, 250, 500, 0]

    var body: some View {
        Form {
            LabeledContent("Cache location") {
                VStack(alignment: .trailing, spacing: 4) {
                    Text(finder.cacheRoot.path).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle).frame(maxWidth: 260, alignment: .trailing)
                    HStack {
                        if finder.relocating { ProgressView().controlSize(.small) }
                        Button("Show") { NSWorkspace.shared.activateFileViewerSelecting([finder.cacheRoot]) }
                        Button("Change…") { choose() }.disabled(finder.relocating)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Picker("Streaming cache, per drive", selection: $finder.cacheLimitGB) {
                    ForEach(limits, id: \.self) { gb in
                        Text(gb == 0 ? "No limit" : "\(gb) GB").tag(gb)
                    }
                }
                // rclone holds each drive's cache to the size it was given
                // when that drive mounted.
                Text("Each drive in Finder keeps its own streaming cache, up to this size. A new size applies as each drive next mounts; Clear Streaming Cache remounts them now.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            LabeledContent("In use") {
                Text("\(size(finder.streamingBytes)) streamed · \(size(finder.pinnedBytes)) kept offline")
            }
            Section("Kept offline") {
                if finder.pinRules.isEmpty {
                    Text("Nothing yet. In the Onyx window, right-click a file or folder and choose Keep Offline on This Mac, or turn on Offline for a whole drive in Finder settings.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(finder.pinRules, id: \.self) { rule in
                    HStack {
                        Text(describe(rule)).lineLimit(1).truncationMode(.middle)
                        if finder.unresolvedPins.contains(rule) {
                            Text("Not found").font(.caption).foregroundStyle(.orange)
                                .help("This folder is not in the drive now: it was renamed or deleted on the web. What was kept offline from it stays until you remove this.")
                        }
                        Spacer()
                        Button("Remove") { Task { await finder.unpin(rule) } }.buttonStyle(.link)
                    }
                }
            }
            Section {
                Button("Clear Streaming Cache") { Task { await finder.clearStreamingCache() } }
                Text("Streamed files download again when opened. Files kept offline stay.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let problem = finder.relocationProblem ?? finder.problem ?? finder.offlineProblem {
                Text(problem).foregroundStyle(.red).font(.caption)
            }
        }
        .formStyle(.grouped)
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Use This Folder"
        panel.message = "Choose where Onyx keeps streamed and offline files. An external disk works."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await finder.relocateCache(to: url.appendingPathComponent("Onyx Cache", isDirectory: true)) }
    }

    private func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private func describe(_ rule: PinRule) -> String {
        let drive = rule.scope == SyncDomain.library.identifier ? "Library" : "Drive"
        switch rule.target {
        case let .file(id): return "\(drive) · file \(id.prefix(8))…"
        case let .folder(path): return path.isEmpty ? "\(drive) · everything" : "\(drive) · \(path)"
        }
    }
}

// MARK: - onyxfs

/// Settings › Finder: whether drives mount as disks of their own, and when
/// they could but the extension is off, the way to switch it on.
struct DiskModeNote: View {
    @ObservedObject var finder: DriveService

    var body: some View {
        switch finder.diskMode {
        case .disks:
            if let failure = finder.diskFailure {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(lucide: "hard-drive").foregroundStyle(.secondary)
                    Text("A drive could not be a disk of its own, so it is in your Onyx folder instead: \(failure)")
                        .font(.caption)
                    Spacer()
                }
                .padding(10)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            }
        case .needsEnabling:
            // Turn On asks macOS from Onyx itself; System Settings' own switch
            // is the way round when that is refused (DiskMounter.enableExtension).
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(lucide: "hard-drive").foregroundStyle(.secondary)
                    Text("Each drive can be a disk of its own, under Locations and on the Desktop. Turn on the Onyx file system to have them there.")
                        .font(.caption)
                    Spacer()
                    Button(finder.turningOnDisks ? "Turning On…" : "Turn On") {
                        Task { await finder.turnOnDisks() }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(finder.turningOnDisks)
                    Button("System Settings…") { finder.openFileSystemSettings() }
                }
                if let problem = finder.turnOnProblem {
                    Text(problem).font(.caption).foregroundStyle(.red)
                }
            }
            .padding(10)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
        case .folder:
            EmptyView()
        }
    }
}

/// Settings › Finder: whether Onyx has Full Disk Access, and the way to the
/// pane that grants it. Only the person can grant it; Onyx only says where.
struct FullDiskAccessRow: View {
    @StateObject private var access = FullDiskAccess()

    var body: some View {
        let granted = access.granted
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(lucide: granted ? "shield-check" : "shield").foregroundStyle(.secondary) /* icons: shield-check shield */
            Text(granted
                 ? "Full Disk Access is on: Onyx can reach files anywhere on this Mac you point it to."
                 : "Full Disk Access is off. Turn it on for Onyx to reach files in every folder on this Mac.")
                .font(.caption)
            Spacer()
            if !granted {
                Button("Privacy & Security…") { FullDiskAccess.openSettings() }
            }
        }
        // Back from System Settings, it may be on now.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            access.check()
        }
    }
}

@MainActor
final class FullDiskAccess: ObservableObject {
    @Published private(set) var granted = FullDiskAccess.probe()

    func check() { granted = Self.probe() }

    /// Whether this app may open a file only Full Disk Access opens: the
    /// privacy database itself, opened and closed, nothing read.
    nonisolated static func probe() -> Bool {
        let fd = open(NSHomeDirectory() + "/Library/Application Support/com.apple.TCC/TCC.db", O_RDONLY)
        guard fd >= 0 else { return false }
        close(fd)
        return true
    }

    static func openSettings() {
        let pane = URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")!
        NSWorkspace.shared.open(pane)
    }
}

/// The menu bar's lines for files on their way to Onyx.
struct UploadsMenuLines: View {
    let summary: UploadSummary
    let retry: (UUID) -> Void

    var body: some View {
        if summary.waiting > 0 {
            let percent = Int((summary.fraction * 100).rounded())
            Text(summary.waiting == 1
                 ? "Uploading \(summary.current ?? "a file") — \(percent)%"
                 : "Uploading \(summary.waiting) files — \(percent)%")
        }
        ForEach(summary.failed) { job in
            Button("Retry “\(job.name)”: \(job.lastError ?? "did not upload")") { retry(job.id) }
        }
    }
}
