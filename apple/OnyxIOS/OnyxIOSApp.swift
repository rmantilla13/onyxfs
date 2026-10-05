import AVFoundation
import OnyxKit
import SwiftUI
import UIKit

/// Onyx for iPhone and iPad: the drives, their folders and files, native.
///
/// Every list comes from the routes the web reads, authorized, filtered and
/// presigned by the server as the web's are — so what this account may see
/// here is exactly what it may see there.
@main
struct OnyxIOSApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = Session()
    @Environment(\.scenePhase) private var phase

    init() {
        // Sound from a video or a song plays with the ring switch off, as
        // in any player.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        // The pictures and previews kept, back under their caps, where
        // nothing waits on it.
        CacheFolder.trimAll(priority: .background)
        // Downloads the system carried on with while the app was away are
        // picked up, and taken where they were going.
        _ = DownloadCenter.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                // The web's dark scheme, always: near-black, the aura, glass.
                // Info.plist's UIUserInterfaceStyle does the same for what
                // UIKit shows (the share sheet, the Files picker, alerts).
                .preferredColorScheme(.dark)
                // A sign-in finished outside the sign-in sheet — the magic
                // link opened from Mail into Safari — comes back here.
                .onOpenURL { session.handle(callback: $0) }
                .task { await session.start(arguments: ProcessInfo.processInfo.arguments) }
        }
        // Out of sight, before the system may suspend the app or clear
        // caches for room: what was kept while browsing, trimmed.
        .onChange(of: phase) { _, now in
            if now == .background { CacheFolder.trimBeforeSuspending() }
            // Back in front: what changed on another device meanwhile.
            if now == .active { Task { await session.refreshOnReturn() } }
        }
    }
}

/// Woken by iOS for a background download's events — one it finished, or
/// that failed, while the app was suspended or ended.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == DownloadTransport.identifier else {
            completionHandler()
            return
        }
        DownloadCenter.shared.transport.handleBackgroundEvents(completionHandler)
    }
}
