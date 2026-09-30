import Testing
import Foundation
@testable import OnyxKit

/// Whether Onyx has Full Disk Access (FullDiskAccessProbe): the first file
/// that is there decides — opened, on; refused, off — and with none there it
/// is not known, never "off". Its answers are checked against a stand-in for
/// open(2), which also shows what was tried.
@Suite struct FullDiskAccessProbeTests {
    static let home = "/Users/someone"
    static let system = "/Library/Application Support/com.apple.TCC/TCC.db"
    static let own = "/Users/someone/Library/Application Support/com.apple.TCC/TCC.db"
    static let safari = "/Users/someone/Library/Safari"

    /// Each path's outcome, and every path asked, in order.
    final class Opener {
        var outcomes: [String: FullDiskAccessProbe.Outcome]
        var asked: [String] = []
        init(_ outcomes: [String: FullDiskAccessProbe.Outcome]) { self.outcomes = outcomes }
        func open(_ path: String) -> FullDiskAccessProbe.Outcome {
            asked.append(path)
            return outcomes[path] ?? .missing
        }
    }

    func answer(_ outcomes: [String: FullDiskAccessProbe.Outcome]) -> (FullDiskAccessProbe.Answer, [String]) {
        let opener = Opener(outcomes)
        return (FullDiskAccessProbe.answer(home: Self.home, open: opener.open), opener.asked)
    }

    @Test func theMacsPrivacyDatabaseIsAskedFirst() {
        #expect(FullDiskAccessProbe.candidates(home: Self.home) == [Self.system, Self.own, Self.safari])
    }

    @Test func openedIsOn() {
        let (answer, asked) = answer([Self.system: .opened])
        #expect(answer == .granted)
        #expect(asked == [Self.system])
    }

    @Test func refusedIsOffWhateverComesAfter() {
        let (answer, asked) = answer([Self.system: .refused, Self.own: .opened, Self.safari: .opened])
        #expect(answer == .notGranted)
        #expect(asked == [Self.system], "the privacy database has said; a later file opening would be the wrong answer")
    }

    @Test func onMacOS27Point0Point1TheAccountsOwnIsGone() {
        // What 0.5.18 asked, alone: gone there, so it said "off" to everyone.
        #expect(answer([Self.own: .missing, Self.system: .opened]).0 == .granted)
        #expect(answer([Self.own: .missing, Self.system: .refused]).0 == .notGranted)
    }

    @Test func beforeThatTheAccountsOwnAnswers() {
        let (answer, asked) = answer([Self.system: .missing, Self.own: .refused, Self.safari: .opened])
        #expect(answer == .notGranted)
        #expect(asked == [Self.system, Self.own])
        #expect(self.answer([Self.system: .missing, Self.own: .opened]).0 == .granted)
    }

    @Test func safariAnswersWhenNeitherDatabaseIsThere() {
        #expect(answer([Self.safari: .opened]).0 == .granted)
        #expect(answer([Self.safari: .refused]).0 == .notGranted)
    }

    @Test func nothingThereIsNotKnownNotOff() {
        let (answer, asked) = answer([:])
        #expect(answer == .unknown)
        #expect(asked == [Self.system, Self.own, Self.safari])
        #expect(self.answer([Self.system: .failed(EIO), Self.own: .failed(EMFILE)]).0 == .unknown,
                "a failure that is not a refusal says nothing")
    }

    @Test func errnoMeansWhatItSays() {
        #expect(FullDiskAccessProbe.Outcome(errno: EPERM) == .refused)
        #expect(FullDiskAccessProbe.Outcome(errno: EACCES) == .refused)
        #expect(FullDiskAccessProbe.Outcome(errno: ENOENT) == .missing)
        #expect(FullDiskAccessProbe.Outcome(errno: ENOTDIR) == .missing)
        #expect(FullDiskAccessProbe.Outcome(errno: EIO) == .failed(EIO))
    }

    @Test func theRealOpenOpensAndCloses() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("onyx-fda-\(UUID().uuidString)")
        try Data("x".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        #expect(FullDiskAccessProbe.open(file.path) == .opened)
        #expect(FullDiskAccessProbe.open(file.path + "-not-there") == .missing)
        #expect(FullDiskAccessProbe.open(file.path + "/under-a-file") == .missing)
    }
}
