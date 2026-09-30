import Foundation
import AppKit
import ServiceManagement
import OnyxKit

/// Onyx lives in the menu bar. The drives it mounts in Finder, the offline
/// copies it keeps current and the update checks all need it running, so it
/// opens at login, quietly, and neither closing its window nor ⌘Q quits it.
///
///   window open    a Dock icon and a menu bar, like any app
///   window closed  only the menu bar icon; nothing in the Dock or ⌘-Tab —
///                  unless Settings › General keeps the Dock icon
///   ⌘Q             the windows close and Onyx stays in the menu bar
///   ⌥⌘Q, Quit      it quits: the menu bar panel's Quit, the Dock's, a
///                  logout or restart, a SIGTERM
@MainActor
final class Background: ObservableObject {
    static let shared = Background()

    /// Registered as a login item (System Settings → General → Login Items).
    @Published private(set) var opensAtLogin = false
    /// macOS wants the person to allow it in System Settings first.
    @Published private(set) var needsApproval = false
    /// The Dock icon stays while Onyx runs, its window open or not (Settings
    /// › General). Off, as it always was: only while a window is open.
    @Published var keepsDockIcon: Bool {
        didSet {
            guard keepsDockIcon != oldValue else { return }
            UserDefaults.standard.set(keepsDockIcon, forKey: Keys.keepsDockIcon)
            windowsChanged()
        }
    }

    private enum Keys {
        static let keepsDockIcon = "background.keepsDockIcon"
        static let closeNoticeShown = "background.closeToMenuBarNoticeShown"
    }

    private init() {
        keepsDockIcon = UserDefaults.standard.bool(forKey: Keys.keepsDockIcon)
        refresh()
    }

    func refresh() {
        let status = SMAppService.mainApp.status
        opensAtLogin = status == .enabled
        needsApproval = status == .requiresApproval
    }

    func setOpensAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            appLog.error("login item: \(error.localizedDescription, privacy: .public)")
        }
        refresh()
    }

    /// On first launch, open at login unless the person has said otherwise:
    /// drives vanish from Finder whenever Onyx is not running.
    func registerOnFirstRun() {
        // A development build never adds itself to the person's login items.
        guard !OnyxIdentifiers.isDevBuild else { return }
        let key = "background.loginItemOffered"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        if SMAppService.mainApp.status == .notRegistered { setOpensAtLogin(true) }
    }

    /// Started by the login item, not by a person: stay in the menu bar.
    static var launchedAtLogin: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
        return event.eventID == kAEOpenApplication
            && event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    /// Opened at login: no window — the one SwiftUI opens is closed, shown
    /// yet or not — and in the Dock only if it is kept there.
    func openedAtLogin() {
        for window in NSApp.windows where window.canBecomeMain && !(window is NSPanel) { window.close() }
        windowsChanged()
    }

    /// The Dock icon follows the window: shown while one is open, gone when
    /// the last one closes — or kept all along, if Settings says so.
    func windowsChanged() {
        let policy: NSApplication.ActivationPolicy = keepsDockIcon || !Self.windows.isEmpty ? .regular : .accessory
        if NSApp.activationPolicy() != policy { NSApp.setActivationPolicy(policy) }
    }

    /// Bring Onyx forward with a Dock icon, for a window about to open. The
    /// note by the menu bar item, if it is up, has done its job.
    func comeForward() {
        StillRunningNote.dismiss(animated: true)
        if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Onyx's own windows on screen: the workspace, Settings. Not the menu
    /// bar's panel, nor the note below, nor the menu bar item itself.
    static var windows: [NSWindow] {
        NSApp.windows.filter { $0.isVisible && $0.canBecomeMain && !($0 is NSPanel) }
    }

    // MARK: - ⌘Q

    /// ⌘Q (Close to Menu Bar): every window of Onyx's closes, a sheet on one
    /// first, and Onyx steps back as a quit app would — the app before it
    /// comes forward — while it goes on in the menu bar: the drives stay in
    /// Finder, and keep syncing. ⌥⌘Q quits.
    ///
    /// The first time, a note by the menu bar item says where Onyx went.
    func closeToMenuBar() {
        let open = Self.windows
        for window in open {
            if let sheet = window.attachedSheet { window.endSheet(sheet) }
            window.close()
        }
        windowsChanged()
        // Hidden and shown again, without coming forward: the app that was
        // behind Onyx comes forward, as it would had Onyx quit, and Onyx is
        // not left hidden — the menu bar item's panel opens as ever, and a
        // Dock icon kept there opens the window. Also with no window left to
        // close, when Onyx is in front all the same (its Dock icon kept);
        // not while the menu bar's panel has the keyboard: that closes by
        // itself.
        if NSApp.isActive, !(NSApp.keyWindow is NSPanel) {
            NSApp.hide(nil)
            NSApp.unhideWithoutActivation()
        }
        guard !open.isEmpty, !UserDefaults.standard.bool(forKey: Keys.closeNoticeShown) else { return }
        UserDefaults.standard.set(true, forKey: Keys.closeNoticeShown)
        StillRunningNote.show()
    }
}

// MARK: - Work in flight

extension WorkActivity {
    /// The app's one: every kind of work Onyx does says here when it starts
    /// and ends, and Onyx is kept out of App Nap between (WorkActivity).
    /// Said in the log as it begins and ends, with what for.
    static let app: WorkActivity = {
        let work = WorkActivity()
        work.onChange = { held, reasons in
            if held {
                let what = reasons.map(\.rawValue).joined(separator: ", ")
                appLog.info("work: out of App Nap for \(what, privacy: .public)")
            } else {
                appLog.info("work: all done; App Nap allowed again")
            }
        }
        return work
    }()
}
