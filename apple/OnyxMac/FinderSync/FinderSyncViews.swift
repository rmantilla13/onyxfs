import SwiftUI
import AppKit

/// Settings › Finder: Keep Offline in Finder's own right-click menu, and
/// whether it is switched on. Only the person can switch it on — it is their
/// system setting — so Onyx says where, opens the pane, and leaves it there:
/// no alert, no reminder.
struct FinderMenusRow: View {
    @ObservedObject var service: FinderSyncService

    var body: some View {
        if service.isBundled {
            let on = service.enabled == true
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(lucide: "download").foregroundStyle(.secondary)
                Text(on
                     ? "Onyx is in Finder's menus: right-click a file or folder on a drive and choose Keep Offline to have it on this Mac, or Remove Offline Copy to let it go. What is kept is marked with a tick."
                     : "Keep files offline from Finder, too: switch on Onyx's Finder extension in System Settings. Then right-click a file or folder on a drive and choose Keep Offline.")
                    .font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if !on {
                    Button("System Settings…") { service.openSettings() }
                }
            }
            .onAppear { service.checkEnabled() }
            // Back from System Settings, it may be on now.
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                service.checkEnabled()
            }
        }
    }
}
