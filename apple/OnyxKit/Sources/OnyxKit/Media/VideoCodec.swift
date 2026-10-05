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
/// records for the same file. Only box headers are read, one small read
/// apiece, down to the sample entry, and then the entry itself: never the
/// index beside it (stsz, stco — megabytes, for a long clip), nor the media.
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
    public static func read(_ url: URL) async -> VideoCodec? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd() else { return nil }
        let file = File(handle: handle, size: size)
        guard let moov = file.moov() else { return nil }
        // The first video track with a sample entry, as the JS takes it.
        var found: (type: String, bytes: [UInt8], body: Int)?
        _ = file.first(in: moov) { trak in
            guard trak.type == "trak", file.handler(trak) == "vide",
                  let stbl = file.path(trak, "mdia", "minf", "stbl"),
                  let entry = file.firstSampleEntry(stbl) else { return false }
            found = entry
            return true
        }
        guard let found, Self.isPrintable(found.type) else { return nil }
        let b = Bytes(found.bytes)
        return Self(entry: Box(type: found.type, start: 0, end: b.count, body: found.body), in: b)
    }

    /// Boxes walked at one level before giving up. A real file has a handful.
    static let maxBoxes = 256
    /// A sample entry is its own fields and a few small boxes — a few hundred
    /// bytes. Past this much of one, the rest is not read.
    static let maxEntryBytes: UInt64 = 64 << 10

    /// The file, a box header at a time.
    struct File {
        let handle: FileHandle
        let size: UInt64

        /// A box where it lies in the file.
        struct Place {
            let type: String
            let start: UInt64
            let end: UInt64
            /// Where the contents begin, after the 8- or 16-byte header.
            let body: UInt64
        }

        /// The top-level `moov`: one 16-byte read per box before it, so one
        /// at the tail of a 40 GB master costs three or four.
        func moov() -> Place? {
            // The first box must look like one, or this is not an MP4 at all.
            guard let head = box(at: 0, end: size), VideoCodec.isPrintable(head.type) else { return nil }
            return first(from: 0, to: size) { $0.type == "moov" }
        }

        /// The first box among `parent`'s children that `match` takes.
        func first(in parent: Place, where match: (Place) -> Bool) -> Place? {
            first(from: parent.body, to: parent.end, where: match)
        }

        /// The first box in [start, end) that `match` takes, reading only the
        /// headers of those before it. Stops at the first malformed header
        /// rather than guessing past it.
        func first(from start: UInt64, to end: UInt64, where match: (Place) -> Bool) -> Place? {
            var at = start
            for _ in 0..<VideoCodec.maxBoxes {
                guard let box = box(at: at, end: end) else { return nil }
                if match(box) { return box }
                at = box.end
            }
            return nil
        }

        func path(_ box: Place, _ types: String...) -> Place? {
            var current: Place? = box
            for type in types { current = current.flatMap { parent in first(in: parent) { $0.type == type } } }
            return current
        }

        func handler(_ trak: Place) -> String? {
            // FullBox (4) + pre-defined (4), then the handler type.
            guard let hdlr = path(trak, "mdia", "hdlr"), hdlr.body + 12 <= hdlr.end,
                  let bytes = read(at: hdlr.body + 8, count: 4), bytes.count == 4 else { return nil }
            return Bytes(bytes).type(0)
        }

        /// stsd's first entry, read whole (up to maxEntryBytes): FullBox (4)
        /// and a count (4), then the entries. `body` is where its contents
        /// begin in `bytes`.
        func firstSampleEntry(_ stbl: Place) -> (type: String, bytes: [UInt8], body: Int)? {
            guard let stsd = first(in: stbl, where: { $0.type == "stsd" }), stsd.body + 8 <= stsd.end,
                  let head = read(at: stsd.body, count: 8), head.count == 8, Bytes(head).u32(4) >= 1,
                  let entry = box(at: stsd.body + 8, end: stsd.end) else { return nil }
            let count = Int(min(entry.end - entry.start, VideoCodec.maxEntryBytes))
            guard let bytes = read(at: entry.start, count: count), bytes.count == count else { return nil }
            return (entry.type, bytes, Int(entry.body - entry.start))
        }

        /// The box whose header is at `at`, inside [at, end): nil for one that
        /// is malformed, or that says it runs past `end`.
        func box(at: UInt64, end: UInt64) -> Place? {
            guard at < end, end - at >= 8,
                  let head = read(at: at, count: Int(min(16, end - at))), head.count >= 8 else { return nil }
            let b = Bytes(head)
            var length = UInt64(b.u32(0))
            var header: UInt64 = 8
            if length == 1 {
                guard head.count >= 16 else { return nil }
                length = b.u64(8)
                header = 16
            } else if length == 0 {
                length = end - at
            }
            // Against what is left, not `at + length`: a 64-bit size that
            // lies would overflow the sum, and a trap is a crash.
            guard length >= header, length <= end - at else { return nil }
            return Place(type: b.type(4), start: at, end: at + length, body: at + header)
        }

        private func read(at offset: UInt64, count: Int) -> [UInt8]? {
            guard (try? handle.seek(toOffset: offset)) != nil, let data = try? handle.read(upToCount: count) else { return nil }
            return [UInt8](data)
        }
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
