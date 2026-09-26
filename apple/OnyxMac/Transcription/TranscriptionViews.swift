import SwiftUI

/// "Transcribing Interview.mov — 42%", in the menu bar menu while this Mac
/// is making a transcript; nothing otherwise.
struct TranscriptionMenuLine: View {
    @ObservedObject var transcriber: TranscriptionService

    var body: some View {
        if let name = transcriber.busyName {
            Text("Transcribing \(Self.shortened(name)) — \(Int(transcriber.progress * 100))%")
        }
    }

    /// A long file name, cut in the middle so its extension still shows.
    static func shortened(_ name: String, to limit: Int = 40) -> String {
        guard name.count > limit else { return name }
        let half = (limit - 1) / 2
        return name.prefix(half) + "…" + name.suffix(limit - 1 - half)
    }
}

/// The setting, in Settings → Account.
struct TranscriptionSettings: View {
    @ObservedObject var transcriber: TranscriptionService

    var body: some View {
        Section("Transcripts") {
            Toggle("Transcribe videos on this Mac", isOn: $transcriber.enabled)
            Text("When someone asks for a transcript on the web, this Mac makes it while Onyx is running. The speech is recognized here; the audio is never sent anywhere else.")
                .font(.caption).foregroundStyle(.secondary)
            TranscriptionMenuLine(transcriber: transcriber)
                .font(.caption)
        }
    }
}
