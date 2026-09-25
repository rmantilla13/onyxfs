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
///   menu bar     sync status, the drive list, and "open Onyx"
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
                .task { await Launch.once { await model.handleLaunchArguments() } }
        }
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .defaultSize(width: 1280, height: 820)
        .commands { OnyxCommands(model: model) }

        MenuBarExtra("Onyx", systemImage: "externaldrive.connected.to.line.below") {
            MenuBarContent().environmentObject(model)
        }
        .menuBarExtraStyle(.menu)

        Settings {
            SettingsView().environmentObject(model)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Closing the window leaves Onyx in the menu bar, keeping Finder in sync.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
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

    var body: some Commands {
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
