import SwiftUI
import AppKit
import OnyxKit

/// Onyx for macOS: the whole workspace in a window of its own, your drives in
/// Finder's sidebar, and a menu bar item that keeps them in sync while the
/// window is closed.
///
///   window       the web workspace, signed in from this Mac's device token
///                (WebController) — everything Onyx does, without a browser
///   Finder       each drive you choose as a location of its own, through the
///                File Provider extension: on-demand download, eviction, and
///                the same access rules as the web (/api/files/delta)
///   menu bar     a panel: sync status, what is moving, each drive and
///                whether it is in Finder, and "open Onyx"
///
/// Everything here goes through the server, which is the difference from the
/// Tauri app's rclone mount (desktop/): that one talks to the bucket directly,
/// so a file dropped into it never reaches the web's library, and a drive's
/// membership is only as good as an IAM policy. The mount stays for what a
/// File Provider cannot do — editing straight off the bucket, where opening a
/// 4K master must not wait for it to download — and for Windows.
@main
struct OnyxMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("Onyx", id: "main") {
            MainWindow()
                .environmentObject(model)
                .environmentObject(model.updater)
                .environmentObject(model.finder)
                .task { await Launch.once { await model.handleLaunchArguments() } }
        }
        // No title bar of SwiftUI's: the page's bar is it (WindowChrome).
        // Declared here, not only set on the NSWindow, because SwiftUI's
        // window lets clicks through to the page under the title bar only
        // when it knows its title bar is hidden.
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 820)
        .commands { OnyxCommands(model: model) }

        // A panel, not a menu: it shows the activity graphs and each drive
        // with its icon (MenuPanel).
        MenuBarExtra {
            MenuPanel().environmentObject(model).environmentObject(model.updater).environmentObject(model.finder)
        } label: {
            MenuBarIcon().environmentObject(model).environmentObject(model.finder).environmentObject(model.updater)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView().environmentObject(model).environmentObject(model.updater).environmentObject(model.finder)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Closing the window leaves Onyx in the menu bar, keeping Finder in sync
    /// — as ⌘Q does (OnyxCommands).
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// A SIGTERM (a logout, launchd, `kill`) quits the normal way, so the
    /// drives are unmounted instead of left for the next launch to clear.
    private var sigterm: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }
        source.resume()
        sigterm = source
        MainActor.assumeIsolated {
            // Here, as launching finishes: a click on a notice that opened
            // Onyx is heard only if the notices' delegate is set by then.
            SystemNotices.shared.start()
            let background = Background.shared
            background.registerOnFirstRun()
            // Opened at login: no window — just the menu bar, and the Dock
            // icon only if Settings keeps it there.
            if Background.launchedAtLogin {
                DispatchQueue.main.async { MainActor.assumeIsolated { background.openedAtLogin() } }
            }
            for name in [NSWindow.willCloseNotification, NSWindow.didBecomeKeyNotification] {
                NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                    // After the window has actually gone.
                    DispatchQueue.main.async { MainActor.assumeIsolated { background.windowsChanged() } }
                }
            }
        }
    }

    /// Quitting always quits: ⌥⌘Q, Quit in the menu bar's panel or the Dock,
    /// a logout or restart, a SIGTERM. (⌘Q does not come here: it only
    /// closes the windows, OnyxCommands.) AppKit refuses while a sheet is
    /// open (the update sheet, say) — which also left drives mounted after a
    /// logout — so any open sheet is closed first.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        for window in NSApp.windows {
            if let sheet = window.attachedSheet { window.endSheet(sheet) }
        }
        return .terminateNow
    }

    /// Clicking Onyx in Finder, Launchpad or the Dock (its icon kept there)
    /// while it runs in the menu bar opens its window, as any app would.
    /// Onyx's own windows are counted, not AppKit's `flag`: the note by the
    /// menu bar item is a window too.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        let none = MainActor.assumeIsolated { Background.windows.isEmpty }
        if none { NotificationCenter.default.post(name: .onyxOpenWindow, object: nil) }
        return true
    }
}

extension Notification.Name {
    static let onyxOpenWindow = Notification.Name("io.onyxfs.openWindow")
}

/// Launch arguments are for the first window only, not every reopen.
@MainActor
enum Launch {
    private static var done = false
    static func once(_ run: () async -> Void) async {
        guard !done else { return }
        done = true
        await run()
    }
}

struct OnyxCommands: Commands {
    @ObservedObject var model: AppModel
    @AppStorage(ActivityBar.setting) private var showsActivity = true

    var body: some Commands {
        // The same switch as Settings › General's.
        CommandGroup(after: .toolbar) {
            Toggle("Show Activity", isOn: $showsActivity)
        }
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") {
                Task { await model.updater.check(userInitiated: true) }
            }
        }
        // ⌘Q leaves Onyx in the menu bar, its drives in Finder and in sync;
        // ⌥⌘Q quits. Quit in the menu bar's panel or the Dock, a logout and
        // a SIGTERM quit as they always did: none of them come this way.
        CommandGroup(replacing: .appTermination) {
            Button("Close to Menu Bar") { Background.shared.closeToMenuBar() }
                .keyboardShortcut("q")
            Button("Quit Onyx") { NSApp.terminate(nil) }
                .keyboardShortcut("q", modifiers: [.command, .option])
        }
        CommandGroup(replacing: .newItem) {}
        CommandGroup(after: .newItem) {
            Button("Sync Drives Now") { Task { await model.syncNow() } }
                .keyboardShortcut("s", modifiers: [.command, .shift])
                .disabled(model.phase != .signedIn)
        }
        CommandMenu("Go") {
            Button("Back") { model.web.back() }.keyboardShortcut("[")
            Button("Forward") { model.web.forward() }.keyboardShortcut("]")
            Divider()
            Button("All Files") { model.web.go("/files") }.keyboardShortcut("f", modifiers: [.command, .shift])
            Button("Search…") { model.web.openSearch() }.keyboardShortcut("k")
            // Admin pages, for admins, as the web's own account menu has them.
            if model.isAdmin {
                Button("Storage") { model.web.go("/storage") }
                Button("Admin") { model.web.go("/admin") }
            }
            Divider()
            Button("Reload") { model.web.reload() }.keyboardShortcut("r")
        }
        CommandGroup(before: .systemServices) {
            Button("Sign Out") { Task { await model.signOut() } }
                .disabled(model.phase != .signedIn)
            Divider()
        }
    }
}
