import Foundation
@preconcurrency import AVFoundation
@preconcurrency import Speech
import OnyxKit

/// Speech to text, on this Mac and nowhere else: the owner chose that audio
/// never goes to a cloud service, Apple's included.
///
///   macOS 26 and later   SpeechAnalyzer with SpeechTranscriber: Apple's
///                        newer on-device model, made for long recordings,
///                        with a time on every word. Its model for a
///                        language is installed by the system the first time
///                        (AssetInventory).
///   macOS 14 and 15      SFSpeechRecognizer, with on-device recognition
///                        required. A language this Mac can only recognize
///                        on Apple's servers is refused, never sent there.
///
/// On macOS 26 a language SpeechTranscriber does not know is tried with the
/// older recognizer, on device all the same.
enum SpeechEngine {
    enum Choice: String {
        case automatic
        case speechAnalyzer = "speechanalyzer"
        case sfSpeech = "sfspeech"
    }

    struct Result: Sendable {
        let segments: [TranscriptSegment]
        /// The locale used, BCP-47.
        let language: String
        /// As the server records it.
        let engine: String
    }

    enum Failure: LocalizedError {
        case unsupportedLanguage(String)
        case notOnDevice(String)
        case notAuthorized
        case notAsked
        case modelUnavailable(String, String)
        case needsNewerMac

        var errorDescription: String? {
            switch self {
            case let .unsupportedLanguage(tag):
                return "Speech recognition on this Mac does not support \(SpeechEngine.name(of: tag))."
            case let .notOnDevice(tag):
                return "This Mac can recognize \(SpeechEngine.name(of: tag)) only on Apple's servers, and Onyx transcribes on the Mac alone."
            case .notAuthorized:
                return "Onyx is not allowed to use speech recognition. Allow it in System Settings → Privacy & Security → Speech Recognition."
            case .notAsked:
                return "Onyx has not been allowed to use speech recognition yet, and it may not ask from here."
            case let .modelUnavailable(tag, why):
                return "The speech model for \(SpeechEngine.name(of: tag)) could not be installed: \(why)"
            case .needsNewerMac:
                return "SpeechAnalyzer needs macOS 26 or later."
            }
        }
    }

    /// Transcribe `audio` (`duration` seconds long) in `language`, or in the
    /// Mac's own when that is nil. `note` hears what is worth telling a
    /// person waiting (a model downloading); `progress` hears 0…1, by audio
    /// time recognized. `askPermission` false: when the older recognizer
    /// needs a permission not yet given, fail rather than have macOS ask.
    /// Cancelling the task stops recognition.
    static func transcribe(audio: URL, duration: Double, language: String?, using choice: Choice = .automatic,
                           askPermission: Bool = true,
                           note: @escaping @Sendable (String) -> Void = { _ in },
                           progress: @escaping @Sendable (Double) -> Void) async throws -> Result {
        let requested = language.flatMap { $0.isEmpty ? nil : $0 } ?? macLanguage
        if #available(macOS 26, *), choice != .sfSpeech {
            if SpeechTranscriber.isAvailable, let locale = await Analyzer.locale(for: requested) {
                let words = try await Analyzer.transcribe(audio: audio, duration: duration, locale: locale,
                                                          note: note, progress: progress)
                return Result(segments: TranscriptSegmenter.segments(from: words),
                              language: locale.identifier(.bcp47), engine: "apple-speechanalyzer")
            }
            if choice == .speechAnalyzer { throw Failure.unsupportedLanguage(requested) }
        } else if choice == .speechAnalyzer {
            throw Failure.needsNewerMac
        }
        let locale = try Recognizer.locale(for: requested)
        let words = try await Recognizer.transcribe(audio: audio, duration: duration, locale: locale,
                                                    askPermission: askPermission, progress: progress)
        return Result(segments: TranscriptSegmenter.segments(from: words),
                      language: locale.identifier(.bcp47), engine: "apple-sfspeech")
    }

    /// What "the Mac's own language" means: the first of the person's
    /// preferred languages ("en-GB"), which is what they speak, not the
    /// region their Mac is set to.
    static var macLanguage: String { Locale.preferredLanguages.first ?? Locale.current.identifier }

    static func name(of tag: String) -> String {
        Locale.current.localizedString(forIdentifier: tag) ?? tag
    }

    /// Written without spaces between words, so none is put between results.
    static func usesSpaces(_ locale: Locale) -> Bool {
        !["zh", "ja", "th", "lo", "km", "my", "yue"].contains(locale.language.languageCode?.identifier ?? "")
    }
}

// MARK: - SpeechAnalyzer (macOS 26+)

@available(macOS 26, *)
private enum Analyzer {
    static func locale(for requested: String) async -> Locale? {
        if let equivalent = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: requested)) {
            return equivalent
        }
        let supported = await SpeechTranscriber.supportedLocales
        let tags = supported.map { $0.identifier(.bcp47) }
        guard let tag = SpeechLocale.match(requested, among: tags, preferredRegion: Locale.current.region?.identifier),
              let i = tags.firstIndex(of: tag) else { return nil }
        return supported[i]
    }

    static func transcribe(audio: URL, duration: Double, locale: Locale,
                           note: @escaping @Sendable (String) -> Void,
                           progress: @escaping @Sendable (Double) -> Void) async throws -> [TranscriptSegmenter.Word] {
        // Final results only, each word timed: captions need nothing more.
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [],
                                            attributeOptions: [.audioTimeRange])
        try await installModel(for: transcriber, locale: locale, note: note)
        let file = try AVAudioFile(forReading: audio)
        // Background work: behind whatever the person is doing, and the
        // model let go once the job is done rather than held for the next.
        let analyzer = SpeechAnalyzer(modules: [transcriber],
                                      options: .init(priority: .utility, modelRetention: .whileInUse))
        let spaced = SpeechEngine.usesSpaces(locale)
        let collecting = Task {
            var words: [TranscriptSegmenter.Word] = []
            var reached = 0.0
            for try await result in transcriber.results {
                words += Self.words(in: result, spaced: spaced)
                let end = result.range.end.seconds
                if end.isFinite, duration > 0, end / duration > reached {
                    reached = min(1, end / duration)
                    progress(reached)
                }
            }
            return words
        }
        return try await withTaskCancellationHandler {
            do {
                if let last = try await analyzer.analyzeSequence(from: file) {
                    try await analyzer.finalizeAndFinish(through: last)
                } else {
                    // No audio at all: nothing to finish.
                    await analyzer.cancelAndFinishNow()
                }
            } catch {
                collecting.cancel()
                await analyzer.cancelAndFinishNow()
                throw error
            }
            return try await collecting.value
        } onCancel: {
            collecting.cancel()
            Task { await analyzer.cancelAndFinishNow() }
        }
    }

    /// The language's model, installed by the system if this Mac does not
    /// have it yet — a download from Apple of the model, not an upload of
    /// anything.
    static func installModel(for transcriber: SpeechTranscriber, locale: Locale,
                             note: @Sendable (String) -> Void) async throws {
        let tag = locale.identifier(.bcp47)
        switch await AssetInventory.status(forModules: [transcriber]) {
        case .installed: return
        case .unsupported: throw SpeechEngine.Failure.unsupportedLanguage(tag)
        default: break
        }
        do {
            try await install(transcriber, tag: tag, note: note)
        } catch let error as SFSpeechError where error.code == .tooManyAssetLocalesAllocated {
            // An app may keep models for a few languages only. The one asked
            // for now matters more than the longest-kept other; that one is
            // let go (the system may remove it) and installed again if it is
            // wanted again.
            if let other = await AssetInventory.reservedLocales.first(where: { $0 != locale }) {
                await AssetInventory.release(reservedLocale: other)
            }
            do { try await install(transcriber, tag: tag, note: note) } catch {
                throw SpeechEngine.Failure.modelUnavailable(tag, error.localizedDescription)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SpeechEngine.Failure.modelUnavailable(tag, error.localizedDescription)
        }
    }

    private static func install(_ transcriber: SpeechTranscriber, tag: String, note: @Sendable (String) -> Void) async throws {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            note("Installing the speech model for \(SpeechEngine.name(of: tag))…")
            try await request.downloadAndInstall()
        }
    }

    /// A result's text, run by run: words carry their time, the spaces and
    /// marks between them do not (TranscriptSegmenter.words(from:)).
    static func words(in result: SpeechTranscriber.Result, spaced: Bool) -> [TranscriptSegmenter.Word] {
        let text = result.text
        let runs = text.runs.map { run -> TranscriptSegmenter.Run in
            let piece = String(text[run.range].characters)
            guard let range = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self] else { return .init(piece) }
            return .init(piece, start: range.start.seconds, end: range.end.seconds)
        }
        var words = TranscriptSegmenter.words(from: runs)
        let whole = String(text.characters)
        if words.isEmpty, !whole.allSatisfy(\.isWhitespace) {
            // No word came with a time: the result's own span, whole.
            words = [.init(whole, start: result.range.start.seconds, end: result.range.end.seconds)]
        }
        // One result follows another; they are joined by a space where the
        // language has them.
        if spaced, let first = words.first, first.text.first?.isWhitespace == false {
            words[0].text = " " + first.text
        }
        return words
    }
}

// MARK: - SFSpeechRecognizer (macOS 14 and 15)

private enum Recognizer {
    static func locale(for requested: String) throws -> Locale {
        let tags = SFSpeechRecognizer.supportedLocales().map { $0.identifier(.bcp47) }
        guard let tag = SpeechLocale.match(requested, among: tags, preferredRegion: Locale.current.region?.identifier) else {
            throw SpeechEngine.Failure.unsupportedLanguage(requested)
        }
        return Locale(identifier: tag)
    }

    /// Asked once; macOS remembers the answer. (SpeechAnalyzer needs no
    /// such permission for a file.)
    static func authorize(ask: Bool) async throws {
        var status = SFSpeechRecognizer.authorizationStatus()
        if status == .notDetermined {
            guard ask else { throw SpeechEngine.Failure.notAsked }
            status = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
        }
        guard status == .authorized else { throw SpeechEngine.Failure.notAuthorized }
    }

    static func transcribe(audio: URL, duration: Double, locale: Locale, askPermission: Bool,
                           progress: @escaping @Sendable (Double) -> Void) async throws -> [TranscriptSegmenter.Word] {
        let tag = locale.identifier(.bcp47)
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            throw SpeechEngine.Failure.unsupportedLanguage(tag)
        }
        // Without this, requiresOnDeviceRecognition is ignored and the audio
        // goes to Apple's servers. Refused instead.
        guard recognizer.supportsOnDeviceRecognition else { throw SpeechEngine.Failure.notOnDevice(tag) }
        try await authorize(ask: askPermission)
        // Results on a queue of their own, not the main thread.
        recognizer.queue = OperationQueue()
        let request = SFSpeechURLRecognitionRequest(url: audio)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        let recognition = Recognition(duration: duration, progress: progress)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                recognition.begin(continuation) {
                    recognizer.recognitionTask(with: request) { recognition.handle($0, $1) }
                }
            }
        } onCancel: {
            recognition.cancel()
        }
    }
}

/// One SFSpeechRecognizer run, as the words it settles on.
///
/// On device, the recognizer starts afresh after a pause: each utterance
/// arrives on its own, marked settled by its metadata, and the final result
/// may hold only the last one — or everything again. So words are kept as
/// each utterance settles, and a word is new only if it starts after the
/// last one kept. Called on the recognizer's queue and cancelled from
/// anywhere, so all of it is under a lock.
private final class Recognition: @unchecked Sendable {
    private let lock = NSLock()
    private let duration: Double
    private let progress: @Sendable (Double) -> Void
    private var continuation: CheckedContinuation<[TranscriptSegmenter.Word], Error>?
    private var task: SFSpeechRecognitionTask?
    private var cancelled = false
    private var words: [TranscriptSegmenter.Word] = []
    private var reached = 0.0

    init(duration: Double, progress: @escaping @Sendable (Double) -> Void) {
        self.duration = duration
        self.progress = progress
    }

    func begin(_ continuation: CheckedContinuation<[TranscriptSegmenter.Word], Error>,
               start: () -> SFSpeechRecognitionTask) {
        lock.lock()
        if cancelled {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        lock.unlock()
        let started = start()
        lock.lock()
        task = started
        let stop = cancelled
        lock.unlock()
        if stop { started.cancel() }
    }

    func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        var outcome: Swift.Result<[TranscriptSegmenter.Word], Error>?
        var report: Double?
        lock.lock()
        if let result {
            let heard = Self.words(in: result.bestTranscription)
            // Partial results carry no times; settled ones do.
            if let end = heard.map(\.end).max(), duration > 0, end / duration > reached {
                reached = min(1, end / duration)
                report = reached
            }
            if result.isFinal || result.speechRecognitionMetadata != nil {
                let after = words.last?.start ?? -1
                words += heard.filter { $0.start > after }
            }
            if result.isFinal { outcome = .success(words) }
        }
        if outcome == nil, let error {
            // Silence is an empty transcript, not a failure.
            outcome = Self.isNoSpeech(error) ? .success(words) : .failure(error)
        }
        let continuation = outcome == nil ? nil : self.continuation
        if outcome != nil { self.continuation = nil }
        lock.unlock()
        if let report { progress(report) }
        if let continuation, let outcome { continuation.resume(with: outcome) }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = task
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        task?.cancel()
        continuation?.resume(throwing: CancellationError())
    }

    /// Each segment with what separates it from the one before, as the
    /// formatted string has it (a space, or none in Japanese).
    static func words(in transcription: SFTranscription) -> [TranscriptSegmenter.Word] {
        let formatted = transcription.formattedString as NSString
        var previousEnd = 0
        return transcription.segments.map { segment in
            let range = segment.substringRange
            let gap = range.location > previousEnd && range.location <= formatted.length
                ? formatted.substring(with: NSRange(location: previousEnd, length: range.location - previousEnd))
                : ""
            previousEnd = range.location + range.length
            return .init(gap + segment.substring, start: segment.timestamp, end: segment.timestamp + segment.duration)
        }
    }

    /// "No speech detected", from the recognizer's service.
    static func isNoSpeech(_ error: Error) -> Bool {
        let e = error as NSError
        return e.domain == "kAFAssistantErrorDomain" && e.code == 1110
    }
}
