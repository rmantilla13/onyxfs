import Foundation

/// What a video's picture is encoded as: the sample entry's four characters
/// (avc1, hvc1, apcn…), and — where its avcC or hvcC says — the bit depth and
/// chroma, and — where its colr says — whether it is HDR (a PQ or HLG
/// transfer).
///
/// lib/mp4-probe.js reads the same from the same boxes, in a browser at upload
/// and on the server, and the server keeps it on the file as
/// `metadata.videoCodec` (lib/media.js codecFacts). This Mac reads it from the
/// bytes it uploads, as each is recorded (UploadQueue): the server asks for a
/// proxy of a video some browser will not play, whatever its size
/// (lib/proxies.js shouldProxy), and knows only what it is told.
///
/// The container is walked as the JS walks it rather than opened with
/// AVFoundation. The queue keeps the bytes under a name with no extension,
/// which AVFoundation will not open; and what CoreMedia makes of a format — a
/// ProRes clip's 12 bits per component, say — is not what a browser's probe
/// records for the same file. Only box headers and the `moov` are read: a few
/// small reads, then the index, never the media.
public struct VideoCodec: Codable, Sendable, Equatable {
    public var fourcc: String
    public var bitDepth: Int?
    /// "4:2:0", "4:2:2", "4:4:4" or "4:0:0".
    public var chroma: String?
    public var hdr: Bool?

    public init(fourcc: String, bitDepth: Int? = nil, chroma: String? = nil, hdr: Bool? = nil) {
        self.fourcc = fourcc; self.bitDepth = bitDepth; self.chroma = chroma; self.hdr = hdr
    }

    /// As a record's `media.videoCodec` (lib/media.js codecFacts): what is
    /// known, and nothing for what is not.
    public var json: [String: Any] {
        var out: [String: Any] = ["fourcc": fourcc]
        if let bitDepth { out["bitDepth"] = bitDepth }
        if let chroma { out["chroma"] = chroma }
        if let hdr { out["hdr"] = hdr }
        return out
    }

    /// lib/proxies.js EVERY_BROWSER_CODECS: H.264, as avc1 or avc3.
    static let everyBrowserCodecs: Set<String> = ["avc1", "avc3"]

    /// lib/proxies.js playsInEveryBrowser: only 8-bit 4:2:0 H.264 that is not
    /// HDR. HEVC is not, at any depth: Chrome and Edge play it only where the
    /// machine decodes it, Firefox often not at all.
    public var playsInEveryBrowser: Bool {
        guard Self.everyBrowserCodecs.contains(fourcc) else { return false }
        if let bitDepth, bitDepth > 8 { return false }
        if let chroma, chroma != "4:2:0" { return false }
        return hdr != true
    }

    // MARK: - Reading a file

    /// The first video track's, from a QuickTime or ISO-BMFF file on disk;
    /// nil for any other file, or one this cannot make sense of.
    public static func read(_ file: URL) async -> VideoCodec? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd(), let moov = Self.moov(handle, size: size) else { return nil }
        return Self(moov: Bytes(moov))
    }

    /// A moov bigger than this is not read (lib/mp4-probe.js MAX_MOOV_BYTES):
    /// a day of footage, and past it a misread size is likelier than a real file.
    static let maxMoovBytes: UInt64 = 64 << 20
    /// Top-level boxes walked before giving up. A real file has a handful.
    static let maxTopLevelBoxes = 256

    /// The top-level `moov`'s contents, after its header: one 16-byte read per
    /// box before it, so one at the tail of a 40 GB master costs three or four.
    static func moov(_ handle: FileHandle, size: UInt64) -> [UInt8]? {
        var at: UInt64 = 0
        var walked = 0
        while walked < maxTopLevelBoxes, at + 8 <= size {
            walked += 1
            guard let head = read(handle, at: at, count: Int(min(16, size - at))), head.count >= 8 else { return nil }
            let b = Bytes(head)
            var length = UInt64(b.u32(0))
            let type = b.type(4)
            var header: UInt64 = 8
            if length == 1 {
                guard head.count >= 16 else { return nil }
                length = b.u64(8)
                header = 16
            } else if length == 0 {
                length = size - at
            }
            // The first box must look like one, or this is not an MP4 at all.
            if walked == 1, !Self.isPrintable(type) { return nil }
            // Against what is left, not `at + length`: a 64-bit size that
            // lies would overflow the sum, and a trap is a crash.
            guard length >= header, length <= size - at else { return nil }
            if type == "moov" {
                guard length - header <= maxMoovBytes,
                      let body = read(handle, at: at + header, count: Int(length - header)),
                      body.count == Int(length - header) else { return nil }
                return body
            }
            at += length
        }
        return nil
    }

    private static func read(_ handle: FileHandle, at offset: UInt64, count: Int) -> [UInt8]? {
        guard (try? handle.seek(toOffset: offset)) != nil, let data = try? handle.read(upToCount: count) else { return nil }
        return [UInt8](data)
    }

    /// The first video track's sample entry, from a moov's contents.
    init?(moov b: Bytes) {
        let entry = Self.children(b, 0, b.count).lazy
            .filter { $0.type == "trak" && Self.handler(b, $0) == "vide" }
            .compactMap { Self.path(b, $0, "mdia", "minf", "stbl").flatMap { Self.firstSampleEntry(b, $0) } }
            .first
        guard let entry, Self.isPrintable(entry.type) else { return nil }
        self.init(entry: entry, in: b)
    }

    // MARK: - The sample entry

    /// A VisualSampleEntry's own fields — SampleEntry (8), then pre-defined
    /// and reserved, the size, resolution, frame count, compressor name and
    /// depth (70) — are this long in ISO-BMFF and QuickTime alike; its boxes
    /// follow.
    static let visualEntryHeader = 78

    static let chromas = ["4:0:0", "4:2:0", "4:2:2", "4:4:4"]

    /// An H.264 profile's bit depth and chroma (as an index into `chromas`)
    /// when its avcC leaves them out (lib/mp4-probe.js AVC_PROFILES).
    static let avcProfiles: [Int: (Int?, Int)] = [
        66: (8, 1), 77: (8, 1), 88: (8, 1), 100: (8, 1), 110: (10, 1), 122: (10, 2), 244: (nil, 3), 44: (nil, 3),
    ]
    /// Profiles whose avcC carries chroma and depth after its PPS list.
    static let avcExtended: Set<Int> = [100, 110, 122, 144]

    init(entry: Box, in b: Bytes) {
        self.init(fourcc: entry.type)
        guard entry.body + Self.visualEntryHeader <= entry.end else { return }
        for box in Self.children(b, entry.body + Self.visualEntryHeader, entry.end) {
            switch box.type {
            case "avcC": (bitDepth, chroma) = Self.avc(b, box)
            case "hvcC": (bitDepth, chroma) = Self.hevc(b, box)
            case "colr" where hdr == nil: hdr = Self.hdr(b, box)
            default: break
            }
        }
    }

    /// avcC: the depth and chroma after the SPS and PPS lists for High and
    /// above; the profile's own when a muxer left them out.
    static func avc(_ b: Bytes, _ box: Box) -> (Int?, String?) {
        // Within the box, not merely the moov: a record cut short is not
        // read on into whatever follows it.
        func has(_ at: Int, _ n: Int) -> Bool { at >= 0 && at + n <= box.end }
        let o = box.body
        guard has(o, 6) else { return (nil, nil) }
        let profile = Int(b.u8(o + 1))
        var at = o + 5
        let sps = Int(b.u8(at) & 0x1f)
        at += 1
        for _ in 0..<sps where has(at, 2) { at += 2 + Int(b.u16(at)) }
        let pps = has(at, 1) ? Int(b.u8(at)) : 0
        at += 1
        for _ in 0..<pps where has(at, 2) { at += 2 + Int(b.u16(at)) }
        if avcExtended.contains(profile), has(at, 3) {
            return (Int(b.u8(at + 1) & 0x07) + 8, chromas[Int(b.u8(at) & 0x03)])
        }
        guard let (depth, chroma) = avcProfiles[profile] else { return (nil, nil) }
        return (depth, chromas[chroma])
    }

    /// hvcC: the depth and chroma at fixed places, always there.
    static func hevc(_ b: Bytes, _ box: Box) -> (Int?, String?) {
        let o = box.body
        guard o + 18 <= box.end else { return (nil, nil) }
        return (Int(b.u8(o + 17) & 0x07) + 8, chromas[Int(b.u8(o + 16) & 0x03)])
    }

    /// colr: HDR when the transfer is PQ (16) or HLG (18). An ICC profile, or
    /// a transfer left unspecified (2), says nothing.
    static func hdr(_ b: Bytes, _ box: Box) -> Bool? {
        let o = box.body
        guard o + 10 <= box.end else { return nil }
        let kind = b.type(o)
        guard kind == "nclx" || kind == "nclc" else { return nil }
        let transfer = b.u16(o + 6)
        guard transfer != 0, transfer != 2 else { return nil }
        return transfer == 16 || transfer == 18
    }

    // MARK: - Boxes

    struct Box {
        let type: String
        let start: Int
        let end: Int
        /// Where the contents begin, after the 8- or 16-byte header.
        let body: Int
    }

    /// The child boxes of [start, end). Stops at the first malformed header
    /// rather than guessing past it.
    static func children(_ b: Bytes, _ start: Int, _ end: Int) -> [Box] {
        var out: [Box] = []
        var o = start
        while o + 8 <= end {
            var size = Int(b.u32(o))
            let type = b.type(o + 4)
            var header = 8
            if size == 1 {
                guard o + 16 <= end else { break }
                let wide = b.u64(o + 8)
                guard wide <= UInt64(end - o) else { break }
                size = Int(wide)
                header = 16
            } else if size == 0 {
                size = end - o
            }
            guard size >= header, o + size <= end else { break }
            out.append(Box(type: type, start: o, end: o + size, body: o + header))
            o += size
        }
        return out
    }

    static func child(_ b: Bytes, _ box: Box, _ type: String) -> Box? {
        children(b, box.body, box.end).first { $0.type == type }
    }

    static func path(_ b: Bytes, _ box: Box, _ types: String...) -> Box? {
        var current: Box? = box
        for type in types { current = current.flatMap { child(b, $0, type) } }
        return current
    }

    static func handler(_ b: Bytes, _ trak: Box) -> String? {
        // FullBox (4) + pre-defined (4), then the handler type.
        guard let hdlr = path(b, trak, "mdia", "hdlr"), hdlr.body + 12 <= hdlr.end else { return nil }
        return b.type(hdlr.body + 8)
    }

    /// stsd's first entry: FullBox (4) and a count (4), then the entries.
    static func firstSampleEntry(_ b: Bytes, _ stbl: Box) -> Box? {
        guard let stsd = child(b, stbl, "stsd"), stsd.body + 8 <= stsd.end, b.u32(stsd.body + 4) >= 1 else { return nil }
        return children(b, stsd.body + 8, stsd.end).first
    }

    static func isPrintable(_ type: String) -> Bool {
        type.utf8.count == 4 && type.utf8.allSatisfy { (0x20...0x7e).contains($0) }
    }

    /// Big-endian reads, each in bounds by the caller's check — or 0 past the
    /// end, so a box that lies about its size cannot crash a read.
    struct Bytes {
        let raw: [UInt8]
        init(_ raw: [UInt8]) { self.raw = raw }
        var count: Int { raw.count }

        func u8(_ o: Int) -> UInt8 { o >= 0 && o < raw.count ? raw[o] : 0 }
        func u16(_ o: Int) -> UInt16 { UInt16(u8(o)) << 8 | UInt16(u8(o + 1)) }
        func u32(_ o: Int) -> UInt32 { UInt32(u16(o)) << 16 | UInt32(u16(o + 2)) }
        func u64(_ o: Int) -> UInt64 { UInt64(u32(o)) << 32 | UInt64(u32(o + 4)) }
        func type(_ o: Int) -> String {
            String(decoding: (0..<4).map { u8(o + $0) }, as: UTF8.self)
        }
    }
}
