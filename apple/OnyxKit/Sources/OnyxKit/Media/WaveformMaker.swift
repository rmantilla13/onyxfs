import Foundation

/// Waveforms for the sounds this Mac uploads, drawn from the bytes still on
/// its disk — the cheapest they will ever be — as soon as the server has the
/// file, and recorded as a browser records one (PUT /api/files/<id>/waveform).
/// A sound that arrives another way gets its waveform from the browser of
/// whoever next looks at it (lib/waveform-client.js).
///
/// One at a time, at utility priority, holding nothing but the tally of the
/// sound in hand (WaveformReader). Best effort: a sound that cannot be read,
/// or a waveform the server refuses, is let go — the web's backfill is
/// still there for it.
public actor WaveformMaker {
    /// A sound this Mac has just uploaded.
    public struct Sound: Sendable, Equatable {
        public let fileId: String
        public let name: String
        /// A link of the maker's own to the bytes, removed once the sound is
        /// drawn, whatever came of it.
        public let url: URL

        public init(fileId: String, name: String, url: URL) {
            self.fileId = fileId; self.name = name; self.url = url
        }
    }

    /// What came of one sound, for the log.
    public enum Outcome: Sendable, Equatable {
        case made(bytes: Int)
        /// No sound in it, or too short to have a shape.
        case none
        case failed(String)
    }

    public typealias Read = @Sendable (URL) async throws -> Waveform?
    public typealias Record = @Sendable (_ fileId: String, _ waveform: Waveform) async throws -> Void

    private let read: Read
    private let record: Record
    private var queue: [Sound] = []
    private var running: Task<Void, Never>?
    private var stopped = false
    private var onReport: (@Sendable (Sound, Outcome) -> Void)?

    public init(read: @escaping Read = { try await WaveformReader.waveform(of: $0) }, record: @escaping Record) {
        self.read = read
        self.record = record
    }

    /// Told of each sound's end.
    public func observe(_ report: @escaping @Sendable (Sound, Outcome) -> Void) {
        onReport = report
    }

    /// A sound just uploaded: drawn next, from `sound.url`.
    public func offer(_ sound: Sound) {
        guard !stopped else {
            Self.remove(sound.url)
            return
        }
        queue.append(sound)
        guard running == nil else { return }
        running = Task(priority: .utility) { await self.drain() }
    }

    /// Sign-out, quit, or turned off: the sound in hand stops, and what is
    /// on disk for the rest goes.
    public func stop() {
        guard !stopped else { return }
        stopped = true
        running?.cancel()
        running = nil
        for sound in queue { Self.remove(sound.url) }
        queue = []
    }

    /// Returns once no sound is being drawn.
    public func idle() async {
        while let running { await running.value }
    }

    private func drain() async {
        while !stopped, !Task.isCancelled, !queue.isEmpty {
            let sound = queue.removeFirst()
            let outcome: Outcome
            do {
                if let waveform = try await read(sound.url) {
                    try await record(sound.fileId, waveform)
                    outcome = .made(bytes: waveform.bars.count)
                } else {
                    outcome = .none
                }
            } catch {
                outcome = .failed(error.localizedDescription)
            }
            Self.remove(sound.url)
            if !stopped { onReport?(sound, outcome) }
        }
        if !stopped { running = nil }
    }

    private static func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}

extension Waveform {
    /// Whether the server will call a file of this name and type a sound
    /// (lib/media.js fileKind): its type, or failing that its extension —
    /// a picture's or a video's first, as the server tests them.
    public static func isSound(name: String, mime: String?) -> Bool {
        let type = (mime ?? "").lowercased()
        let ext = (name as NSString).pathExtension.lowercased()
        if type.hasPrefix("image/") || ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "heic", "heif", "tif", "tiff"].contains(ext) {
            return false
        }
        if type.hasPrefix("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].contains(ext) { return false }
        return type.hasPrefix("audio/") || ["mp3", "wav", "m4a", "aac", "ogg", "flac"].contains(ext)
    }
}
