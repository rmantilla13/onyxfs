import AppKit
import UserNotifications

/// What Onyx says in Notification Center: what the person needs to know while
/// Onyx is only in the menu bar. One thing so far — their drives are in the
/// Onyx folder, not disks of their own, because the Onyx file system is off
/// or waits for a restart. Posted once each time that happens to drives that
/// were disks (FileSystemSwitch), never for a switch the person turned off
/// while Onyx watched.
///
/// The first notice asks macOS for permission (the system's own prompt). Not
/// allowed, nothing is posted; the menu bar's panel says it all the same.
@MainActor
final class SystemNotices: NSObject, UNUserNotificationCenterDelegate {
    static let shared = SystemNotices()

    /// The notice's Open System Settings, or the notice itself clicked: the
    /// File System Extensions switch (set by AppModel: DriveService's
    /// openFileSystemSettings, which then watches for it coming on).
    var openFileSystemSettings: (() -> Void)?

    nonisolated private static let switchedOff = "onyxfs.switchedOff"
    nonisolated private static let openSettings = "onyxfs.openSettings"

    /// As Onyx finishes launching, before anything is posted: the delegate
    /// that hears a click — one that opened Onyx included, which is only
    /// heard if it is set by then — and the notice's button.
    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let open = UNNotificationAction(identifier: Self.openSettings, title: "Open System Settings", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.switchedOff, actions: [open], intentIdentifiers: []),
        ])
    }

    func fileSystemOff(needsRestart: Bool) {
        let content = UNMutableNotificationContent()
        if needsRestart {
            content.title = "Restart your Mac to make your drives disks again"
            content.body = "macOS is still using an earlier copy of the Onyx file system, so your drives are in the Onyx folder for now."
        } else {
            content.title = "Your drives aren't disks right now"
            content.body = "The Onyx file system was switched off, so your drives are in the Onyx folder. Switch Onyx back on in System Settings. If it won't stay on, restart your Mac first."
            content.categoryIdentifier = Self.switchedOff
        }
        Task { await post(content, id: "onyxfs.fileSystemOff") }
    }

    private func post(_ content: UNNotificationContent, id: String) async {
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            do {
                guard try await center.requestAuthorization(options: [.alert]) else {
                    appLog.info("notices: not allowed; the menu bar's panel says it instead")
                    return
                }
            } catch {
                appLog.error("notices: permission not asked: \(error.localizedDescription, privacy: .public)")
                return
            }
        case .denied:
            appLog.info("notices: notifications are off for Onyx; the menu bar's panel says it instead")
            return
        default:
            break
        }
        do {
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        } catch {
            appLog.error("notices: not posted: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        guard response.notification.request.content.categoryIdentifier == Self.switchedOff,
              response.actionIdentifier != UNNotificationDismissActionIdentifier else { return }
        await MainActor.run { SystemNotices.shared.openFileSystemSettings?() }
    }

    /// Shown while Onyx is in front too.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }
}
