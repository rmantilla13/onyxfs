import AVFoundation
import OnyxKit
import SwiftUI

/// Onyx for iPhone and iPad: the drives, their folders and files, native.
///
/// Every list comes from the routes the web reads, authorized, filtered and
/// presigned by the server as the web's are — so what this account may see
/// here is exactly what it may see there.
@main
struct OnyxIOSApp: App {
    @State private var session = Session()

    init() {
        // Sound from a video or a song plays with the ring switch off, as
        // in any player.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        ThumbnailStore.trimInBackground()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                // A sign-in finished outside the sign-in sheet — the magic
                // link opened from Mail into Safari — comes back here.
                .onOpenURL { session.handle(callback: $0) }
                .task { await session.start(arguments: ProcessInfo.processInfo.arguments) }
        }
    }
}
