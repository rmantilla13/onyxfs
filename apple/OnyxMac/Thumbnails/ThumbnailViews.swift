import SwiftUI

/// The setting, in Settings › General, beside the transcripts'.
struct ThumbnailSettings: View {
    @ObservedObject var thumbnailer: ThumbnailService

    var body: some View {
        Section("Thumbnails") {
            Toggle("Make thumbnails on this Mac", isOn: $thumbnailer.enabled)
            Text("Videos and photos with no thumbnail yet — a 4K clip straight from a camera, a RAW or HEIC a browser cannot draw — get one from this Mac, at the sizes the web makes, so every device shows them. For the drives in Finder or kept offline and what you copy onto them; only files you may change.")
                .font(.caption).foregroundStyle(.secondary)
            ThumbnailStatusLine(thumbnailer: thumbnailer)
                .font(.caption)
        }
    }
}

/// "Making a thumbnail of GX010042.MP4 — 3 more waiting" while it works;
/// how many it has made since, once it has; nothing before.
struct ThumbnailStatusLine: View {
    @ObservedObject var thumbnailer: ThumbnailService

    var body: some View {
        let status = thumbnailer.status
        if let name = status.working, !name.isEmpty {
            let more = status.waiting - 1
            Text("Making a thumbnail of \(TranscriptionMenuLine.shortened(name))" + (more > 0 ? " — \(more) more waiting" : ""))
        } else if status.made > 0 {
            Text(status.made == 1 ? "1 thumbnail made since Onyx opened." : "\(status.made) thumbnails made since Onyx opened.")
        }
    }
}
