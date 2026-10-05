import AVFoundation
import Foundation
import Testing
@testable import OnyxKit

/// What a video's picture is encoded as, read from the file's own boxes as
/// lib/mp4-probe.js reads them (test/mp4-probe.test.js has the same cases):
/// what decides whether the server asks for a proxy of a video under
/// PROXY_MIN_BYTES.
@Suite struct VideoCodecTests {
    // MARK: - Boxes, as cameras and phones write them

    @Test func anIPhonesHDRClipIs10BitHEVCInHLG() async throws {
        let codec = try await read("hvc1", hvcC(depth: 10), nclx(9, 18, 9))
        #expect(codec == VideoCodec(fourcc: "hvc1", bitDepth: 10, chroma: "4:2:0", hdr: true))
        #expect(!codec.playsInEveryBrowser)
    }

    @Test func eightBitHEVCInBT709IsNotHDRAndSaysSo() async throws {
        let codec = try await read("hev1", hvcC(profile: 1, depth: 8), nclx(1, 1, 1))
        #expect(codec == VideoCodec(fourcc: "hev1", bitDepth: 8, chroma: "4:2:0", hdr: false))
        #expect(!codec.playsInEveryBrowser, "HEVC at any depth: Chrome and Firefox cannot be relied on")
    }

    @Test func aCamerasTenBit422HEVCInPQ() async throws {
        #expect(try await read("hvc1", hvcC(chroma: 2, depth: 10), nclx(9, 16, 9))
                == VideoCodec(fourcc: "hvc1", bitDepth: 10, chroma: "4:2:2", hdr: true))
    }

    @Test func h264HighWithItsExtensionIs8Bit420AndPlaysEverywhere() async throws {
        let codec = try await read("avc1", avcC(profile: 100, ext: (chroma: 1, depth: 8)))
        #expect(codec == VideoCodec(fourcc: "avc1", bitDepth: 8, chroma: "4:2:0", hdr: nil))
        #expect(codec.playsInEveryBrowser)
    }

    @Test func xavcIs10Bit422H264() async throws {
        let codec = try await read("avc1", avcC(profile: 122, ext: (chroma: 2, depth: 10)), nclc(1, 1, 1))
        #expect(codec == VideoCodec(fourcc: "avc1", bitDepth: 10, chroma: "4:2:2", hdr: false))
        #expect(!codec.playsInEveryBrowser)
    }

    @Test func anAvcCWithoutTheExtensionHasItsProfilesDepthAndChroma() async throws {
        #expect(try await read("avc1", avcC(profile: 77)) == VideoCodec(fourcc: "avc1", bitDepth: 8, chroma: "4:2:0"))
        #expect(try await read("avc1", avcC(profile: 110)) == VideoCodec(fourcc: "avc1", bitDepth: 10, chroma: "4:2:0"))
        #expect(try await read("avc1", avcC(profile: 244)) == VideoCodec(fourcc: "avc1", bitDepth: nil, chroma: "4:4:4"))
        #expect(try await read("avc1", avcC(profile: 1)) == VideoCodec(fourcc: "avc1"))
    }

    @Test func proResSaysOnlyItsColourInQuickTimesNclc() async throws {
        #expect(try await read("apch", nclc(1, 1, 1)) == VideoCodec(fourcc: "apch", hdr: false))
        #expect(try await read("ap4h", nclc(9, 16, 9)) == VideoCodec(fourcc: "ap4h", hdr: true))
        #expect(try await read("apcn") == VideoCodec(fourcc: "apcn"))
    }

    @Test func aColrThatDoesNotSayIsNoAnswer() async throws {
        #expect(try await read("apcn", nclc(2, 2, 2)).hdr == nil, "unspecified")
        #expect(try await read("apcn", box("colr", Data("prof".utf8), Data(count: 64))).hdr == nil, "an ICC profile")
        #expect(try await read("apcn", box("colr", Data("nclx".utf8), u16(9))).hdr == nil, "cut short")
    }

    @Test func recordsCutShortLeaveTheDepthUnknownAndTheCodecRead() async throws {
        #expect(try await read("hvc1", box("hvcC", Data([1, 2, 0, 0]))) == VideoCodec(fourcc: "hvc1"))
        #expect(try await read("avc1", box("avcC", Data([1, 100]))) == VideoCodec(fourcc: "avc1"))
        // High with an SPS whose length runs past the record: the profile's own.
        let runaway = box("avcC", Data([1, 100, 0, 40, 0xff, 0xe1]), u16(400), Data([0x67]))
        #expect(try await read("avc1", runaway) == VideoCodec(fourcc: "avc1", bitDepth: 8, chroma: "4:2:0"))
    }

    @Test func theMoovIsFoundAtTheTailPastA64BitMdat() async throws {
        // A camera's file: ftyp, a large mdat with a 64-bit size, then moov.
        let ftyp = box("ftyp", Data("qt  ".utf8), Data(count: 4))
        let media = Data(count: 1000)
        let mdat = u32(1) + Data("mdat".utf8) + u64(UInt64(16 + media.count)) + media
        let file = try write(ftyp + mdat + moov(sampleEntry("hvc1", [hvcC(depth: 10)])))
        defer { try? FileManager.default.removeItem(at: file) }
        #expect(await VideoCodec.read(file) == VideoCodec(fourcc: "hvc1", bitDepth: 10, chroma: "4:2:0"))
    }

    @Test func theFirstVideoTrackIsReadNotTheTimecodeOrTheSound() async throws {
        let sound = box("trak", box("mdia", hdlr("soun"), box("minf", box("stbl", stsd(box("mp4a", Data(count: 28)))))))
        let ftyp = box("ftyp", Data("isom".utf8), Data(count: 4))
        let file = try write(ftyp + box("moov", sound, trak(sampleEntry("apcn"))))
        defer { try? FileManager.default.removeItem(at: file) }
        #expect(await VideoCodec.read(file) == VideoCodec(fourcc: "apcn"))
    }

    @Test func whatIsNotAnMP4IsNothing() async throws {
        for bytes in [Data("not a movie at all, just some text".utf8), Data(count: 8),
                      Data([0x1a, 0x45, 0xdf, 0xa3]) + Data(count: 60),   // WebM
                      box("ftyp", Data("isom".utf8)) + box("free", Data(count: 8)),
                      // 64-bit sizes that lie, at the top and inside the moov: nothing, and no crash.
                      u32(1) + Data("ftyp".utf8) + u64(.max) + Data(count: 16),
                      box("ftyp", Data("isom".utf8)) + box("moov", u32(1) + Data("trak".utf8) + u64(.max))] {
            let file = try write(bytes)
            defer { try? FileManager.default.removeItem(at: file) }
            #expect(await VideoCodec.read(file) == nil)
        }
        #expect(await VideoCodec.read(URL(fileURLWithPath: "/nonexistent/\(UUID().uuidString)")) == nil)
        // A sound file has no picture to say anything about.
        let sound = box("trak", box("mdia", hdlr("soun"), box("minf", box("stbl", stsd(box("mp4a", Data(count: 28)))))))
        let file = try write(box("ftyp", Data("M4A ".utf8)) + box("moov", sound))
        defer { try? FileManager.default.removeItem(at: file) }
        #expect(await VideoCodec.read(file) == nil)
    }

    // MARK: - Files this Mac writes

    @Test func aClipFromThisMacsEncoderReadsAsWhatItIs() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("codec-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let h264 = dir.appendingPathComponent("h264.mov")
        try await Clip.make(at: h264, width: 640, height: 360, fps: 30, seconds: 0.5, codec: .h264, audio: true)
        let hevc = dir.appendingPathComponent("hevc.mp4")
        try await Clip.make(at: hevc, width: 640, height: 360, fps: 30, seconds: 0.5, codec: .hevc, audio: false)
        // As the upload queue keeps them: under a name with no extension.
        let staged = dir.appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: h264, to: staged)

        let avc = try #require(await VideoCodec.read(staged))
        #expect(avc.fourcc == "avc1" && avc.bitDepth == 8 && avc.chroma == "4:2:0" && avc.hdr != true)
        #expect(avc.playsInEveryBrowser)
        let hvc = try #require(await VideoCodec.read(hevc))
        #expect(["hvc1", "hev1"].contains(hvc.fourcc) && hvc.bitDepth == 8 && hvc.chroma == "4:2:0")
        #expect(!hvc.playsInEveryBrowser)
        // The same four characters AVFoundation reports.
        let track = try #require(try await AVURLAsset(url: hevc).loadTracks(withMediaType: .video).first)
        let format = try #require(try await track.load(.formatDescriptions).first)
        let subtype = CMFormatDescriptionGetMediaSubType(format)
        #expect(hvc.fourcc == String(decoding: [24, 16, 8, 0].map { UInt8(subtype >> $0 & 0xff) }, as: UTF8.self))
    }

    // MARK: - The rule and the record

    /// lib/proxies.js playsInEveryBrowser, case for case.
    @Test func onlyEightBit420SDRH264PlaysInEveryBrowser() {
        let rows: [(VideoCodec, Bool)] = [
            (VideoCodec(fourcc: "avc1"), true),
            (VideoCodec(fourcc: "avc1", bitDepth: 8, chroma: "4:2:0", hdr: false), true),
            (VideoCodec(fourcc: "avc3", bitDepth: 8, chroma: "4:2:0"), true),
            (VideoCodec(fourcc: "avc1", bitDepth: 10, chroma: "4:2:0"), false),
            (VideoCodec(fourcc: "avc1", bitDepth: 10, chroma: "4:2:2"), false),
            (VideoCodec(fourcc: "avc1", bitDepth: 8, chroma: "4:2:2"), false),
            (VideoCodec(fourcc: "avc1", bitDepth: 8, chroma: "4:2:0", hdr: true), false),
            (VideoCodec(fourcc: "hvc1", bitDepth: 8, chroma: "4:2:0", hdr: false), false),
            (VideoCodec(fourcc: "hvc1", bitDepth: 10, chroma: "4:2:0", hdr: true), false),
            (VideoCodec(fourcc: "hev1"), false), (VideoCodec(fourcc: "dvh1"), false),
            (VideoCodec(fourcc: "apcn"), false), (VideoCodec(fourcc: "ap4h"), false), (VideoCodec(fourcc: "AVdh"), false),
            (VideoCodec(fourcc: "av01"), false), (VideoCodec(fourcc: "vp09"), false), (VideoCodec(fourcc: "mp4v"), false),
        ]
        for (codec, plays) in rows { #expect(codec.playsInEveryBrowser == plays, "\(codec)") }
    }

    @Test func itIsSentAsLibMediaCodecFactsReadsIt() throws {
        let full = VideoCodec(fourcc: "hvc1", bitDepth: 10, chroma: "4:2:0", hdr: true).json
        #expect(full["fourcc"] as? String == "hvc1" && full["bitDepth"] as? Int == 10)
        #expect(full["chroma"] as? String == "4:2:0" && full["hdr"] as? Bool == true)
        // What is not known is left out, not sent as null.
        let bare = VideoCodec(fourcc: "apcn").json
        #expect(bare.count == 1 && bare["fourcc"] as? String == "apcn")
        #expect(JSONSerialization.isValidJSONObject(full))
    }

    // MARK: - Building files

    private func read(_ fourcc: String, _ boxes: Data...) async throws -> VideoCodec {
        let ftyp = box("ftyp", Data("isom".utf8), Data(count: 4))
        let file = try write(ftyp + moov(sampleEntry(fourcc, boxes)))
        defer { try? FileManager.default.removeItem(at: file) }
        return try #require(await VideoCodec.read(file))
    }

    private func write(_ bytes: Data) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("codec-\(UUID().uuidString)")
        try bytes.write(to: url)
        return url
    }

    private func u16(_ v: UInt16) -> Data { Data([UInt8(v >> 8), UInt8(v & 0xff)]) }
    private func u32(_ v: UInt32) -> Data { Data([24, 16, 8, 0].map { UInt8(v >> $0 & 0xff) }) }
    private func u64(_ v: UInt64) -> Data { Data([56, 48, 40, 32, 24, 16, 8, 0].map { UInt8(v >> UInt64($0) & 0xff) }) }

    private func box(_ type: String, _ body: Data...) -> Data {
        let contents = body.reduce(Data(), +)
        return u32(UInt32(contents.count + 8)) + Data(type.utf8) + contents
    }

    private func hdlr(_ kind: String) -> Data { box("hdlr", Data(count: 8), Data(kind.utf8), Data(count: 12)) }
    private func stsd(_ entry: Data) -> Data { box("stsd", Data(count: 4), u32(1), entry) }

    /// A VisualSampleEntry: SampleEntry (8), 16 reserved, width, height, the
    /// other 50, then its boxes.
    private func sampleEntry(_ fourcc: String, _ boxes: [Data] = []) -> Data {
        box(fourcc, Data(count: 24), u16(1920), u16(1080), Data(count: 50), boxes.reduce(Data(), +))
    }

    private func trak(_ entry: Data) -> Data {
        let mdhd = box("mdhd", Data(count: 12), u32(30000), u32(30030), Data(count: 4))
        let stts = box("stts", Data(count: 4), u32(1), u32(30), u32(1001))
        return box("trak", box("mdia", mdhd, hdlr("vide"), box("minf", box("stbl", stsd(entry), stts))))
    }

    private func moov(_ entry: Data) -> Data { box("moov", trak(entry)) }

    /// AVCDecoderConfigurationRecord: one SPS and one PPS, then the
    /// High-profile extension when given.
    private func avcC(profile: UInt8, ext: (chroma: UInt8, depth: UInt8)? = nil) -> Data {
        var body = Data([1, profile, 0, 40, 0xff, 0xe1]) + u16(4) + Data([0x67, profile, 0, 40]) + Data([1]) + u16(2) + Data([0x68, 0xce])
        if let ext { body += Data([0xfc | ext.chroma, 0xf8 | (ext.depth - 8), 0xf8 | (ext.depth - 8), 0]) }
        return box("avcC", body)
    }

    /// HEVCDecoderConfigurationRecord with no parameter-set arrays.
    private func hvcC(profile: UInt8 = 2, chroma: UInt8 = 1, depth: UInt8 = 10) -> Data {
        box("hvcC", Data([1, profile]), Data(count: 10), Data([153]), u16(0xf000), Data([0xfc, 0xfc | chroma,
            0xf8 | (depth - 8), 0xf8 | (depth - 8)]), u16(0), Data([0x0f, 0]))
    }

    private func nclx(_ primaries: UInt16, _ transfer: UInt16, _ matrix: UInt16) -> Data {
        box("colr", Data("nclx".utf8), u16(primaries), u16(transfer), u16(matrix), Data([0]))
    }

    private func nclc(_ primaries: UInt16, _ transfer: UInt16, _ matrix: UInt16) -> Data {
        box("colr", Data("nclc".utf8), u16(primaries), u16(transfer), u16(matrix))
    }
}
