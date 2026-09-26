import Foundation
import SwiftUI
import OnyxKit

/// `Onyx --transcribe <file> [--language en-US] [--engine speechanalyzer|sfspeech]`:
/// transcribe a local file the way a job is transcribed — the same
/// AudioExtractor and SpeechEngine — print the result as JSON (the body a
/// job would PUT, less the source key) and exit. No window, no sign-in, no
/// server; for trying the speech side on its own. Progress goes to stderr.
/// `--engine` forces one engine, to try the older one on a newer Mac.
struct TranscribeCommand {
    let file: URL
    let language: String?
    let engine: SpeechEngine.Choice

    /// Nil unless the app was launched to transcribe.
    init?(arguments: [String]) {
        guard let i = arguments.firstIndex(of: "--transcribe") else { return nil }
        func value(_ flag: String) -> String? {
            guard let j = arguments.firstIndex(of: flag), j + 1 < arguments.count else { return nil }
            return arguments[j + 1]
        }
        guard i + 1 < arguments.count else {
            Self.fail("usage: Onyx --transcribe <file> [--language en-US] [--engine speechanalyzer|sfspeech]", code: 64)
        }
        file = URL(fileURLWithPath: arguments[i + 1])
        language = value("--language")
        guard let choice = SpeechEngine.Choice(rawValue: value("--engine") ?? "automatic") else {
            Self.fail("--engine is speechanalyzer or sfspeech", code: 64)
        }
        engine = choice
    }

    func runAndExit() -> Never {
        Task.detached {
            exit(await run())
        }
        dispatchMain()
    }

    private func run() async -> Int32 {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("onyx-transcribe-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let audio = folder.appendingPathComponent("audio.m4a")
            let duration = try await AudioExtractor.extract(from: file, to: audio)
            Self.log(String(format: "%@: %.1f s of audio", file.lastPathComponent, duration))
            let tenths = Tenths()
            let started = Date()
            let result = try await SpeechEngine.transcribe(
                audio: audio, duration: duration, language: language, using: engine,
                askPermission: Self.launchedAsApp,
                note: { Self.log($0) },
                progress: { p in if let step = tenths.passed(p) { Self.log("\(step * 10)%") } })
            Self.log(String(format: "%@, %@, %d segments in %.1f s", result.engine, result.language,
                            result.segments.count, Date().timeIntervalSince(started)))
            struct Output: Encodable { let engine: String; let resultLanguage: String; let segments: [TranscriptSegment] }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            let json = try encoder.encode(Output(engine: result.engine, resultLanguage: result.language,
                                                 segments: result.segments))
            FileHandle.standardOutput.write(json + Data("\n".utf8))
            return 0
        } catch SpeechEngine.Failure.notAsked {
            // Started from a shell, the terminal is the one macOS would ask,
            // and it kills a process whose terminal has no reason to give.
            let app = Bundle.main.bundleURL.path
            Self.log("""
                onyx: speech recognition has not been allowed for this app yet. From a terminal, macOS \
                would ask the terminal instead, so launch the app itself once to be asked:
                  open -W --stdout /dev/stdout --stderr /dev/stderr "\(app)" --args --transcribe "\(file.path)" --engine sfspeech
                """)
            return 1
        } catch {
            Self.log("onyx: \(error.localizedDescription)")
            return 1
        }
    }

    /// Opened by launchd (Finder, `open`) rather than from a shell: the app is
    /// then the one macOS asks about permissions, with its own usage text.
    static var launchedAsApp: Bool { getppid() == 1 }

    static func log(_ line: String) {
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }

    static func fail(_ line: String, code: Int32) -> Never {
        log(line)
        exit(code)
    }

    /// Progress as it crosses each tenth, once.
    private final class Tenths: @unchecked Sendable {
        private let lock = NSLock()
        private var last = 0
        func passed(_ p: Double) -> Int? {
            lock.lock(); defer { lock.unlock() }
            let step = Int(p * 10)
            guard step > last else { return nil }
            last = step
            return step
        }
    }
}

extension OnyxMacApp {
    /// Stands in front of SwiftUI's own `App.main()`, which `@main` would
    /// otherwise call: launched to transcribe a file, the app does that and
    /// exits before any of it starts — no window, no menu bar item, no
    /// sign-in. Otherwise the app starts as ever.
    static func main() {
        if let command = TranscribeCommand(arguments: CommandLine.arguments) { command.runAndExit() }
        startApp(OnyxMacApp.self)
    }
}

/// SwiftUI's `App.main()`. Called through a generic, it is the protocol
/// extension's, not the one above (which would call itself).
@MainActor
private func startApp<A: App>(_: A.Type) {
    A.main()
}
