import Foundation
@preconcurrency import AVFoundation

/// The sound of a video (or of an audio file) as a plain .m4a, which both
/// speech engines read as a file. A 4K master is gigabytes of pictures around
/// a few megabytes of speech; this is what is kept of it while it is
/// transcribed.
enum AudioExtractor {
    enum Failure: LocalizedError {
        case noAudio
        case unreadable(String)
        case exportFailed(String)

        var errorDescription: String? {
            switch self {
            case .noAudio:
                return "This file has no audio track, so there is nothing to transcribe."
            case let .unreadable(why):
                return "Onyx could not read this file as audio or video: \(why)"
            case let .exportFailed(why):
                return "Onyx could not take the audio out of this file: \(why)"
            }
        }
    }

    /// Writes the audio of `source` to `destination` (.m4a, replaced if it
    /// exists) and returns how long it is, in seconds. Every audio track is
    /// mixed in, as a player would play them. Cancelling the task stops it.
    static func extract(from source: URL, to destination: URL) async throws -> Double {
        let asset = AVURLAsset(url: source)
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .audio)
        } catch {
            throw Failure.unreadable(error.localizedDescription)
        }
        guard !tracks.isEmpty else { throw Failure.noAudio }
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw Failure.exportFailed("this kind of file cannot be converted.")
        }
        try? FileManager.default.removeItem(at: destination)
        if #available(macOS 15, *) {
            do {
                try await session.export(to: destination, as: .m4a)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                throw Failure.exportFailed(error.localizedDescription)
            }
        } else {
            session.outputURL = destination
            session.outputFileType = .m4a
            await withTaskCancellationHandler {
                await session.export()
            } onCancel: {
                session.cancelExport()
            }
            try Task.checkCancellation()
            guard session.status == .completed else {
                throw Failure.exportFailed(session.error?.localizedDescription ?? "the export stopped.")
            }
        }
        let seconds = try await AVURLAsset(url: destination).load(.duration).seconds
        return seconds.isFinite ? seconds : 0
    }
}
