import Foundation
import AppKit
import ServiceManagement

/// Onyx lives in the menu bar. The drives it mounts in Finder, the offline
/// copies it keeps current and the update checks all need it running, so it
/// opens at login, quietly, and closing its window does not quit it.
///
///   window open    a Dock icon and a menu bar, like any app
///   window closed  only the menu bar icon; nothing in the Dock or ⌘-Tab
@MainActor
final class Background: ObservableObject {
    static let shared = Background()

    /// Registered as a login item (System Settings → General → Login Items).
    @Published private(set) var opensAtLogin = false
    /// macOS wants the person to allow it in System Settings first.
    @Published private(set) var needsApproval = false

    private init() { refresh() }

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

    /// The Dock icon follows the window: shown while one is open, gone when
    /// the last one closes.
    func windowsChanged() {
        let visible = NSApp.windows.contains { $0.isVisible && $0.canBecomeMain && !($0 is NSPanel) }
        let policy: NSApplication.ActivationPolicy = visible ? .regular : .accessory
        if NSApp.activationPolicy() != policy { NSApp.setActivationPolicy(policy) }
    }

    /// Bring Onyx forward with a Dock icon, for a window about to open.
    func comeForward() {
        if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
        NSApp.activate(ignoringOtherApps: true)
    }
}
