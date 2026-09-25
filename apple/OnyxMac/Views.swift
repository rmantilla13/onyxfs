import SwiftUI
import WebKit
import OnyxKit

// MARK: - Main window

struct MainWindow: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            switch model.phase {
            case .signedIn: WorkspaceView(web: model.web)
            case .signedOut, .signingIn: SignInView()
            }
        }
        .frame(minWidth: 880, minHeight: 560)
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
                Button(model.serverLabel) { form.serverText = model.serverLabel; form.editingServer = true }
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
                        Image(systemName: "wifi.exclamationmark").font(.system(size: 34)).foregroundStyle(.secondary)
                        Text(failure).multilineTextAlignment(.center).frame(maxWidth: 440)
                        Button("Try Again") { web.reload() }.keyboardShortcut(.defaultAction)
                    }
                    .padding(28)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
            .navigationTitle(web.title)
            .toolbar {
                ToolbarItemGroup(placement: .navigation) {
                    Button { web.back() } label: { Image(systemName: "chevron.left") }
                        .disabled(!web.canGoBack).help("Back")
                    Button { web.forward() } label: { Image(systemName: "chevron.right") }
                        .disabled(!web.canGoForward).help("Forward")
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    if web.isLoading { ProgressView().controlSize(.small) }
                    FinderMenu()
                    Button { web.reload() } label: { Image(systemName: "arrow.clockwise") }
                        .help("Reload")
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

/// The toolbar's drive menu: which drives appear in Finder, and a way there.
struct FinderMenu: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Menu {
            FinderItems()
        } label: {
            Label("Finder", systemImage: "externaldrive.connected.to.line.below")
        }
        .help("Show drives in Finder")
    }
}

/// One entry per drive, and one for the library, shared by the toolbar and
/// the menu bar item.
struct FinderItems: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Section("Show in Finder") {
            if !BuildInfo.canUseFinder {
                Text("Needs a signed build of Onyx")
            }
            if model.drives.isEmpty {
                Text("No drives yet")
            }
            ForEach(model.drives) { drive in
                toggle(.drive(id: drive.id), name: drive.name, detail: roleWord(drive.role))
            }
            toggle(.library, name: "Library", detail: "files in no drive")
        }
        if !model.inFinder.isEmpty {
            Section("Open in Finder") {
                ForEach(model.drives.filter { model.isInFinder(.drive(id: $0.id)) }) { drive in
                    Button(drive.name) { Task { await model.reveal(.drive(id: drive.id)) } }
                }
                if model.isInFinder(.library) {
                    Button("Library") { Task { await model.reveal(.library) } }
                }
            }
        }
        Divider()
        Button("Sync Now") { Task { await model.syncNow() } }
    }

    private func toggle(_ scope: SyncDomain, name: String, detail: String?) -> some View {
        Toggle(isOn: Binding(
            get: { model.isInFinder(scope) },
            set: { on in Task { await model.setInFinder(scope, name: name, on) } }
        )) {
            Text(name) + Text(detail.map { "  \($0)" } ?? "").foregroundColor(.secondary)
        }
        .disabled(model.busy.contains(scope.identifier) || !BuildInfo.canUseFinder)
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

struct MenuBarContent: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if model.phase == .signedIn {
            Text(model.email ?? "Signed in")
            Divider()
            Button("Open Onyx") { open() }
            FinderItems()
        } else {
            Button("Sign In…") { open() }
        }
        Divider()
        SettingsLink { Text("Settings…") }
        Button("Quit Onyx") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private func open() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}

// MARK: - Settings

struct SettingsView: View {
    var body: some View {
        TabView {
            AccountSettings().tabItem { Label("Account", systemImage: "person.crop.circle") }
            FinderSettings().tabItem { Label("Finder", systemImage: "externaldrive") }
        }
        .frame(width: 480, height: 320)
    }
}

struct AccountSettings: View {
    @EnvironmentObject var model: AppModel
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
                        .disabled(OnyxConfig.normalizedServer(form.serverText) == model.server)
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
        }
        .formStyle(.grouped)
        .onAppear { form.serverText = model.serverLabel }
    }
}

struct FinderSettings: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Each drive you turn on appears under Locations in Finder's sidebar. Files download when you open them, and stay until macOS needs the space.")
                .font(.callout).foregroundStyle(.secondary)
            if !BuildInfo.canUseFinder {
                Label("This copy of Onyx is unsigned, so macOS will not let Finder share its sign-in. Build it signed with your Apple Developer team to put drives in Finder (apple/README.md).",
                      systemImage: "exclamationmark.triangle")
                    .font(.callout)
            }
            List {
                ForEach(model.drives) { drive in row(.drive(id: drive.id), name: drive.name) }
                row(.library, name: "Library")
            }
            HStack {
                Text("Read-only in Finder for now; add and change files in the Onyx window.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Sync Now") { Task { await model.syncNow() } }
            }
            if let problem = model.problem { Text(problem).foregroundStyle(.red).font(.caption) }
        }
        .padding(20)
        .task { await model.refresh() }
    }

    private func row(_ scope: SyncDomain, name: String) -> some View {
        HStack {
            Toggle(name, isOn: Binding(
                get: { model.isInFinder(scope) },
                set: { on in Task { await model.setInFinder(scope, name: name, on) } }
            ))
            .disabled(model.busy.contains(scope.identifier) || model.phase != .signedIn || !BuildInfo.canUseFinder)
            Spacer()
            if model.isInFinder(scope) {
                Button("Show") { Task { await model.reveal(scope) } }.buttonStyle(.link)
            }
        }
    }
}
