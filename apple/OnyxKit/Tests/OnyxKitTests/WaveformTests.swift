import Testing
import Foundation
@testable import OnyxKit

/// Waveform is lib/waveform.js in Swift: the same stored string, the same
/// bars from it, the same resampling for drawing. The strings and levels
/// below are what lib/waveform.js itself wrote (test/waveform.test.js).
struct WaveformTests {
    // MARK: - The stored string

    @Test func readsWhatTheWebWrites() throws {
        let web = "1:AP8AADMAAAAKFB4oMjxGUA=="
        let waveform = try #require(Waveform(stored: web))
        #expect(waveform.bars == [0, 255, 0, 0, 51, 0, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80])
        #expect(waveform.stored == web, "and writes it back byte for byte")

        let ramp = try #require(Waveform(bars: (0...255).map { UInt8($0) }))
        #expect(ramp.stored.hasPrefix("1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKi"))
        #expect(ramp.stored.count == 346)
    }

    @Test func readsNothingElse() {
        for text in ["", "1:", "2:AP8AADMAAAAKFB4oMjxGUA==", "AP8AADMAAAAKFB4oMjxGUA==", "1:@@@@", "1:AAAA",
                     "1:" + String(repeating: "A", count: 5000)] {
            #expect(Waveform(stored: text) == nil, "\(text.prefix(12))")
        }
        #expect(Waveform(bars: [UInt8](repeating: 1, count: 8)) == nil, "too few bars to be a shape")
        #expect(Waveform(bars: [UInt8](repeating: 1, count: 2000)) == nil)
    }

    @Test func drawnAtASizeAsTheWebDrawsIt() throws {
        let waveform = try #require(Waveform(stored: "1:AP8AADMAAAAKFB4oMjxGUA=="))
        let four = waveform.levels(4)
        let web = [1, 0.2, 0.21479315980594751, 0.5172904297361929]
        #expect(four.count == 4)
        for (a, b) in zip(four, web) { #expect(abs(a - b) < 1e-12) }
        #expect(waveform.levels(40).count == 16, "more than there are is the bars as they are")
    }

    @Test func barsFromEnergyAreScaledToTheLoudest() throws {
        let waveform = try #require(Waveform.fromEnergy(sums: Array(repeating: 1, count: 15) + [64], counts: Array(repeating: 1, count: 16)))
        #expect(waveform.bars.last == 255)
        #expect(waveform.bars.first == 32, "a stretch an eighth as loud")
        let silence = try #require(Waveform.fromEnergy(sums: Array(repeating: 0, count: 16), counts: Array(repeating: 1, count: 16)))
        #expect(silence.bars.allSatisfy { $0 == 0 })
    }

    // MARK: - In a file's metadata

    @Test func aListingsWaveformIsReadAndABadOneIsNone() throws {
        func decode(_ json: String) throws -> FileMetadata {
            try JSONDecoder().decode(FileMetadata.self, from: Data(json.utf8))
        }
        let read = try decode(#"{ "duration": 30, "waveform": "1:AP8AADMAAAAKFB4oMjxGUA==" }"#)
        #expect(read.duration == 30)
        #expect(read.waveform?.bars.count == 16)
        let bad = try decode(#"{ "duration": 30, "waveform": "junk" }"#)
        #expect(bad == FileMetadata(duration: 30), "the rest of the metadata still reads")
        #expect(try decode(#"{ "waveform": 7 }"#) == FileMetadata())

        // A replica keeps it across launches.
        let again = try JSONDecoder().decode(FileMetadata.self, from: JSONEncoder().encode(read))
        #expect(again == read)
    }

    @Test func soundsAreWhatTheServerCallsSounds() {
        #expect(Waveform.isSound(name: "Take 3.m4a", mime: "audio/mp4"))
        #expect(Waveform.isSound(name: "Mix.WAV", mime: nil))
        #expect(Waveform.isSound(name: "Room tone.aiff", mime: "audio/aiff"))
        #expect(!Waveform.isSound(name: "Room tone.aiff", mime: nil), "the server knows AIFF by its type only")
        #expect(!Waveform.isSound(name: "Clip.mp4", mime: "video/mp4"))
        #expect(!Waveform.isSound(name: "Cover.jpg", mime: "audio/mpeg"), "a picture's name wins, as fileKind tests it first")
        #expect(!Waveform.isSound(name: "notes.txt", mime: "text/plain"))
    }

    // MARK: - Reading a sound

    @Test func aWavIsReadIntoItsShape() async throws {
        let url = try Self.wav(seconds: [(2, 0.8), (2, 0.1)])
        defer { try? FileManager.default.removeItem(at: url) }
        let waveform = try #require(try await WaveformReader.waveform(of: url))
        #expect(waveform.bars.count == Waveform.barCount)
        let loud = waveform.bars.prefix(120)
        let quiet = waveform.bars.suffix(120)
        // A 10 ms window holds a sine's cycles and a part of one, so its
        // loudness wobbles by a few percent either way.
        #expect(loud.allSatisfy { $0 >= 240 }, "\(Array(loud.prefix(8)))")
        #expect(quiet.allSatisfy { abs(Int($0) - 32) <= 4 }, "an eighth as loud: \(Array(quiet.prefix(8)))")
    }

    @Test func aLongTallyFoldsWithoutLosingItsShape() throws {
        var tally = WaveformReader.Tally()
        let loud = [Float](repeating: 0.5, count: 80 * 1000)
        let quiet = [Float](repeating: 0.05, count: 80 * 1000)
        for _ in 0..<50 { tally.add(loud) }
        for _ in 0..<50 { tally.add(quiet) }
        #expect(tally.sums.count < WaveformReader.maxWindows, "folded as it grew")
        #expect(tally.window > WaveformReader.firstWindow)
        let waveform = try #require(tally.waveform(bars: 16))
        #expect(waveform.bars == [255, 255, 255, 255, 255, 255, 255, 255, 26, 26, 26, 26, 26, 26, 26, 26])
    }

    @Test func somethingThatIsNotASoundHasNoShape() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        try Data("not a sound".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let result = try? await WaveformReader.waveform(of: url)
        #expect(result == nil)
    }

    // MARK: - The Mac's queue

    @Test func eachSoundIsDrawnRecordedAndLetGo() async throws {
        let recorded = Recorded()
        let maker = WaveformMaker(read: { url in
            url.lastPathComponent.hasPrefix("empty") ? nil : Waveform(bars: [UInt8](repeating: 9, count: 32))
        }, record: { id, waveform in await recorded.add(id, waveform) })
        let one = try Self.scratch("one.m4a")
        let empty = try Self.scratch("empty.m4a")
        await maker.offer(.init(fileId: "f1", name: "one.m4a", url: one))
        await maker.offer(.init(fileId: "f2", name: "empty.m4a", url: empty))
        await maker.idle()
        #expect(await recorded.ids == ["f1"], "nothing recorded for a file with no sound in it")
        #expect(await recorded.waveforms.first??.bars.count == 32)
        #expect(!FileManager.default.fileExists(atPath: one.path), "the link goes once it is drawn")
        #expect(!FileManager.default.fileExists(atPath: empty.path))
    }

    @Test func aRefusalIsLetGoAndStopDropsWhatWaits() async throws {
        let gate = AsyncStream<Void>.makeStream()
        let maker = WaveformMaker(read: { _ in
            for await _ in gate.stream { break }
            return Waveform(bars: [UInt8](repeating: 1, count: 16))
        }, record: { _, _ in throw OnyxError.http(status: 403, message: "No access") })
        let first = try Self.scratch("a.wav")
        let waiting = try Self.scratch("b.wav")
        await maker.offer(.init(fileId: "a", name: "a.wav", url: first))
        await maker.offer(.init(fileId: "b", name: "b.wav", url: waiting))
        await maker.stop()
        #expect(!FileManager.default.fileExists(atPath: waiting.path), "what waited is removed at once")
        gate.continuation.finish()
        await maker.idle()
        let late = try Self.scratch("c.wav")
        await maker.offer(.init(fileId: "c", name: "c.wav", url: late))
        #expect(!FileManager.default.fileExists(atPath: late.path), "nothing is taken after a stop")
    }

    // MARK: - Helpers

    actor Recorded {
        var ids: [String] = []
        var waveforms: [Waveform?] = []
        func add(_ id: String, _ waveform: Waveform?) {
            ids.append(id)
            waveforms.append(waveform)
        }
    }

    static func scratch(_ name: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name.split(separator: ".")[0])-\(UUID().uuidString).\(name.split(separator: ".")[1])")
        try Data([1, 2, 3]).write(to: url)
        return url
    }

    /// A mono 16-bit 8 kHz WAV of sines, `(seconds, amplitude)` after one another.
    static func wav(seconds parts: [(Double, Double)]) throws -> URL {
        var samples = [Int16]()
        for (seconds, amplitude) in parts {
            for i in 0..<Int(seconds * 8000) {
                samples.append(Int16((amplitude * sin(Double(i) / 3) * 32767).rounded()))
            }
        }
        var data = Data()
        func put<T: FixedWidthInteger>(_ v: T) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36 + samples.count * 2))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(8000)); put(UInt32(16000)); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(UInt32(samples.count * 2))
        for s in samples { put(s) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        try data.write(to: url)
        return url
    }
}
