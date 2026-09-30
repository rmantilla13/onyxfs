import Foundation

/// A JPEG as small as its picture, for a placeholder
/// (ThumbnailRenderer.placeholder): ImageIO's own, less what a picture two
/// dozen pixels across has no use for.
///
/// ImageIO writes the standard Huffman tables (JPEG Annex K), 432 bytes of
/// them, and wraps the picture in Exif and Photoshop segments — and in a
/// colour profile, for anything not drawn in sRGB. For a thumbnail that is
/// nothing; for a placeholder it is most of it: some 800 bytes, 1,100
/// characters as a data URL, around a hundred or two of picture.
///
///   bare      the wrapping taken off: every APP1–APP15 segment, as the
///             server's compactor takes it off (lib/placeholder.js bareJpeg)
///   squeezed  that, and the picture's Huffman codes written again with
///             tables made for the symbols it uses (Annex K.2, as libjpeg
///             optimizes and jpegtran -optimize does): a hundred-odd bytes
///             of tables, and about 700 characters in all
///
/// Squeezing changes nothing about the picture: the same quantised
/// coefficients, under the same quantisation tables, in the same restart
/// intervals, decode to exactly the same pixels. Only a JPEG as ImageIO
/// writes one is squeezed — baseline, Huffman-coded, 8-bit, one scan of
/// every component — and anything else is nil, for the caller to keep what
/// it had. The caller checks the result decodes to the picture it had
/// anyway (ThumbnailRenderer.samePicture): a mistake here could cost a
/// placeholder its saving, never its picture.
enum TinyJPEG {
    /// `jpeg` without its APP1–APP15 segments — Exif, a colour profile,
    /// Photoshop's — as the server compacts one; nil when it is not a JPEG
    /// this can walk to its scan.
    static func bare(_ jpeg: Data) -> Data? {
        let b = [UInt8](jpeg)
        guard b.count >= 4, b[0] == 0xFF, b[1] == 0xD8 else { return nil }
        var out: [UInt8] = [0xFF, 0xD8]
        var i = 2
        while i + 4 <= b.count {
            guard b[i] == 0xFF else { return nil }
            let marker = b[i + 1]
            // The scan runs to the end of the file: from here, everything is kept.
            if marker == 0xDA { return Data(out + b[i...]) }
            let length = Int(b[i + 2]) << 8 | Int(b[i + 3])
            guard length >= 2, i + 2 + length <= b.count else { return nil }
            if !(0xE1...0xEF).contains(marker) { out += b[i..<(i + 2 + length)] }
            i += 2 + length
        }
        return nil
    }

    /// `jpeg` bare, and with Huffman tables made for its own symbols; nil
    /// when it is not a JPEG as ImageIO writes one.
    static func squeezed(_ jpeg: Data) -> Data? {
        let b = [UInt8](jpeg)
        guard b.count >= 4, b[0] == 0xFF, b[1] == 0xD8, let header = Header(b) else { return nil }
        var decoders: [UInt8: HuffmanDecoder] = [:]
        for (key, table) in header.tables {
            guard let decoder = HuffmanDecoder(counts: table.counts, symbols: table.symbols) else { return nil }
            decoders[key] = decoder
        }
        guard let symbols = Self.symbols(of: b, from: header.scanStart, header: header, decoders: decoders) else { return nil }

        // Tables for what the scan uses: how often each symbol comes, per table.
        var counts: [UInt8: [Int]] = [:]
        for symbol in symbols where symbol.table != Symbol.restart {
            counts[symbol.table, default: [Int](repeating: 0, count: 256)][Int(symbol.value)] += 1
        }
        var codes: [UInt8: HuffmanCodes] = [:]
        var tables: [UInt8] = []
        for key in counts.keys.sorted() {
            guard let table = optimalTable(counts[key]!) else { return nil }
            // Tc (DC 0, AC 1) and Th, as the key holds them.
            tables.append((key >> 2) << 4 | key & 3)
            tables += table.bits
            tables += table.symbols
            codes[key] = HuffmanCodes(bits: table.bits, symbols: table.symbols)
        }
        guard tables.count + 2 <= 0xFFFF else { return nil }

        var out = header.kept
        out.insert(contentsOf: [0xFF, 0xC4, UInt8((tables.count + 2) >> 8), UInt8((tables.count + 2) & 0xFF)] + tables,
                   at: header.tablesAt)
        out += header.scanHeader
        var writer = BitWriter(out: out)
        for symbol in symbols {
            if symbol.table == Symbol.restart {
                writer.restart(Int(symbol.value))
                continue
            }
            guard let code = codes[symbol.table]?.code(for: symbol.value) else { return nil }
            writer.put(code.bits, count: code.length)
            writer.put(Int(symbol.extra), count: Int(symbol.extraCount))
        }
        writer.finish()
        return Data(writer.out)
    }

    // MARK: - Reading

    /// What comes before the scan, as far as squeezing needs it: the
    /// segments kept as they are, where the new tables go, the frame, the
    /// tables the scan was written with, and the scan's own header.
    private struct Header {
        struct Component {
            let id: UInt8
            let h: Int
            let v: Int
        }

        /// SOI and every segment before the scan but APP1–APP15 and DHT.
        var kept: [UInt8] = [0xFF, 0xD8]
        /// Where in `kept` the first DHT was.
        var tablesAt = 0
        var width = 0
        var height = 0
        var components: [Component] = []
        /// Huffman tables by Tc << 2 | Th.
        var tables: [UInt8: (counts: [UInt8], symbols: [UInt8])] = [:]
        var restartInterval = 0
        /// Each of the scan's blocks, in its order: which DC and AC table.
        var scan: [(component: Int, dc: UInt8, ac: UInt8)] = []
        var scanHeader: [UInt8] = []
        var scanStart = 0

        init?(_ b: [UInt8]) {
            var i = 2
            var sawFrame = false, sawTables = false
            while true {
                guard i + 4 <= b.count, b[i] == 0xFF else { return nil }
                let marker = b[i + 1]
                let length = Int(b[i + 2]) << 8 | Int(b[i + 3])
                guard length >= 2, i + 2 + length <= b.count else { return nil }
                let segment = Array(b[i..<(i + 2 + length)])
                let body = Array(segment[4...])
                i += 2 + length
                switch marker {
                case 0xE1...0xEF:
                    continue
                case 0xC0:
                    // Baseline, 8-bit: nothing else is ImageIO's.
                    guard !sawFrame, body.count >= 6, body[0] == 8 else { return nil }
                    height = Int(body[1]) << 8 | Int(body[2])
                    width = Int(body[3]) << 8 | Int(body[4])
                    let n = Int(body[5])
                    guard width > 0, height > 0, (1...4).contains(n), body.count == 6 + 3 * n else { return nil }
                    for c in 0..<n {
                        let h = Int(body[7 + 3 * c] >> 4), v = Int(body[7 + 3 * c] & 15)
                        guard (1...4).contains(h), (1...4).contains(v) else { return nil }
                        components.append(Component(id: body[6 + 3 * c], h: h, v: v))
                    }
                    sawFrame = true
                    kept += segment
                case 0xC4:
                    var p = 0
                    while p < body.count {
                        guard p + 17 <= body.count else { return nil }
                        let tc = body[p] >> 4, th = body[p] & 15
                        guard tc <= 1, th <= 3 else { return nil }
                        let counts = Array(body[(p + 1)..<(p + 17)])
                        let total = counts.reduce(0) { $0 + Int($1) }
                        guard total <= 256, p + 17 + total <= body.count else { return nil }
                        tables[tc << 2 | th] = (counts, Array(body[(p + 17)..<(p + 17 + total)]))
                        p += 17 + total
                    }
                    if !sawTables { tablesAt = kept.count }
                    sawTables = true
                case 0xDD:
                    guard body.count == 2 else { return nil }
                    restartInterval = Int(body[0]) << 8 | Int(body[1])
                    kept += segment
                case 0xDA:
                    // One scan of every component, the whole of each block.
                    guard sawFrame, sawTables, body.count >= 1 else { return nil }
                    let n = Int(body[0])
                    guard n == components.count, body.count == 4 + 2 * n else { return nil }
                    for c in 0..<n {
                        guard let index = components.firstIndex(where: { $0.id == body[1 + 2 * c] }) else { return nil }
                        let t = body[2 + 2 * c]
                        guard t >> 4 <= 3, t & 15 <= 3 else { return nil }
                        scan.append((index, t >> 4, 1 << 2 | t & 15))
                    }
                    guard body[1 + 2 * n] == 0, body[2 + 2 * n] == 63, body[3 + 2 * n] == 0 else { return nil }
                    scanHeader = segment
                    scanStart = i
                    return
                case 0xE0, 0xDB, 0xFE:
                    // JFIF, the quantisation tables, a comment: as they are.
                    kept += segment
                default:
                    // Progressive, lossless, arithmetic-coded, or anything
                    // else ImageIO does not write here.
                    return nil
                }
            }
        }
    }

    /// One coded symbol of the scan — a DC size, an AC run and size, an
    /// end of block — the table it was coded with, and the bits after it;
    /// or a restart marker, `value` its number.
    private struct Symbol {
        static let restart: UInt8 = 0xFF
        var table: UInt8
        var value: UInt8
        var extraCount: UInt8 = 0
        var extra: UInt16 = 0
    }

    /// Every symbol of the scan, in order, and the restarts between them;
    /// nil if the scan is not what its header says.
    private static func symbols(of b: [UInt8], from start: Int, header: Header,
                                decoders: [UInt8: HuffmanDecoder]) -> [Symbol]? {
        struct Block {
            let dcKey: UInt8, acKey: UInt8
            let dc: HuffmanDecoder, ac: HuffmanDecoder
        }
        func block(_ scan: (component: Int, dc: UInt8, ac: UInt8)) -> Block? {
            guard let dc = decoders[scan.dc], let ac = decoders[scan.ac] else { return nil }
            return Block(dcKey: scan.dc, acKey: scan.ac, dc: dc, ac: ac)
        }
        let hmax = header.components.map(\.h).max() ?? 1, vmax = header.components.map(\.v).max() ?? 1
        // An MCU: each component's blocks, H x V of them — or, one component
        // alone, a block (its sampling is then its own).
        var blocks: [Block] = []
        let mcus: Int
        if header.scan.count == 1 {
            let only = header.scan[0], c = header.components[only.component]
            let width = (header.width * c.h + hmax - 1) / hmax, height = (header.height * c.v + vmax - 1) / vmax
            mcus = ((width + 7) / 8) * ((height + 7) / 8)
            guard let one = block(only) else { return nil }
            blocks = [one]
        } else {
            mcus = ((header.width + 8 * hmax - 1) / (8 * hmax)) * ((header.height + 8 * vmax - 1) / (8 * vmax))
            for scan in header.scan {
                let c = header.components[scan.component]
                guard let each = block(scan) else { return nil }
                blocks += Array(repeating: each, count: c.h * c.v)
            }
        }
        // A placeholder is a few MCUs; a big picture is not this code's.
        guard mcus > 0, mcus <= 4096 else { return nil }

        var reader = BitReader(b: b, position: start)
        var out: [Symbol] = []
        out.reserveCapacity(mcus * blocks.count * 8)
        var restarts = 0
        for mcu in 0..<mcus {
            if header.restartInterval > 0, mcu > 0, mcu % header.restartInterval == 0 {
                guard reader.marker() == 0xD0 + UInt8(restarts % 8) else { return nil }
                out.append(Symbol(table: Symbol.restart, value: UInt8(restarts % 8)))
                restarts += 1
            }
            for block in blocks {
                // The DC difference: its size, then that many bits.
                guard let size = reader.symbol(block.dc), size <= 11, let bits = reader.bits(Int(size)) else { return nil }
                out.append(Symbol(table: block.dcKey, value: size, extraCount: size, extra: UInt16(bits)))
                // The ACs: runs of zeros and sizes, to an end of block or
                // the block's end.
                var k = 1
                while k < 64 {
                    guard let runSize = reader.symbol(block.ac) else { return nil }
                    let run = Int(runSize >> 4), size = runSize & 15
                    if size == 0 {
                        // End of block, or sixteen zeros; nothing else in a baseline scan.
                        guard run == 0 || run == 15 else { return nil }
                        out.append(Symbol(table: block.acKey, value: runSize))
                        if run == 0 { break }
                        k += 16
                    } else {
                        guard size <= 10, let bits = reader.bits(Int(size)) else { return nil }
                        out.append(Symbol(table: block.acKey, value: runSize, extraCount: size, extra: UInt16(bits)))
                        k += run + 1
                    }
                }
                guard k <= 64 else { return nil }
            }
        }
        // And then the end of the image, nothing more.
        guard reader.marker() == 0xD9 else { return nil }
        return out
    }

    /// Canonical Huffman decoding (Annex F.2.2.3), from a DHT's counts and
    /// symbols.
    private struct HuffmanDecoder {
        private var maxCode = [Int](repeating: -1, count: 17)
        private var firstIndex = [Int](repeating: 0, count: 17)
        private var firstCode = [Int](repeating: 0, count: 17)
        private let symbols: [UInt8]

        init?(counts: [UInt8], symbols: [UInt8]) {
            guard counts.count == 16 else { return nil }
            self.symbols = symbols
            var code = 0, k = 0
            for length in 1...16 {
                let n = Int(counts[length - 1])
                firstIndex[length] = k
                firstCode[length] = code
                code += n
                k += n
                if n > 0 { maxCode[length] = code - 1 }
                // More codes than a length has room for: not a table.
                guard code <= 1 << length else { return nil }
                code <<= 1
            }
            guard k == symbols.count else { return nil }
        }

        func symbol(for code: Int, length: Int) -> UInt8? {
            guard code <= maxCode[length] else { return nil }
            return symbols[firstIndex[length] + code - firstCode[length]]
        }
    }

    /// The scan's bits: a stuffed 0xFF 0x00 is 0xFF; any other marker ends
    /// them, and is read only where one is due.
    private struct BitReader {
        let b: [UInt8]
        var position: Int
        private var byte = 0
        private var left = 0

        init(b: [UInt8], position: Int) {
            self.b = b
            self.position = position
        }

        mutating func bit() -> Int? {
            if left == 0 {
                guard position < b.count else { return nil }
                let next = b[position]
                if next == 0xFF {
                    guard position + 1 < b.count, b[position + 1] == 0 else { return nil }
                    position += 2
                } else {
                    position += 1
                }
                byte = Int(next)
                left = 8
            }
            left -= 1
            return (byte >> left) & 1
        }

        mutating func bits(_ count: Int) -> Int? {
            var value = 0
            for _ in 0..<count {
                guard let bit = bit() else { return nil }
                value = value << 1 | bit
            }
            return value
        }

        mutating func symbol(_ decoder: HuffmanDecoder) -> UInt8? {
            var code = 0
            for length in 1...16 {
                guard let bit = bit() else { return nil }
                code = code << 1 | bit
                if let symbol = decoder.symbol(for: code, length: length) { return symbol }
            }
            return nil
        }

        /// The marker next, past the padding of the byte in hand and any
        /// fill: its code.
        mutating func marker() -> UInt8? {
            left = 0
            guard position + 1 < b.count, b[position] == 0xFF else { return nil }
            while position + 1 < b.count, b[position + 1] == 0xFF { position += 1 }
            guard position + 1 < b.count else { return nil }
            let code = b[position + 1]
            position += 2
            return code
        }
    }

    // MARK: - Writing

    /// Canonical codes (Annex C) from a table's counts and symbols.
    private struct HuffmanCodes {
        private var codes = [(bits: Int, length: Int)?](repeating: nil, count: 256)

        init(bits: [UInt8], symbols: [UInt8]) {
            var code = 0, k = 0
            for length in 1...16 {
                for _ in 0..<Int(bits[length - 1]) {
                    codes[Int(symbols[k])] = (code, length)
                    code += 1
                    k += 1
                }
                code <<= 1
            }
        }

        func code(for symbol: UInt8) -> (bits: Int, length: Int)? { codes[Int(symbol)] }
    }

    /// Bits into bytes, a 0xFF stuffed with a 0x00 after it, and each
    /// restart and the end padded with ones.
    private struct BitWriter {
        var out: [UInt8]
        private var byte = 0
        private var filled = 0

        init(out: [UInt8]) { self.out = out }

        mutating func put(_ value: Int, count: Int) {
            guard count > 0 else { return }
            for shift in stride(from: count - 1, through: 0, by: -1) {
                byte = byte << 1 | (value >> shift) & 1
                filled += 1
                if filled == 8 {
                    out.append(UInt8(byte))
                    if byte == 0xFF { out.append(0) }
                    byte = 0
                    filled = 0
                }
            }
        }

        private mutating func pad() {
            if filled > 0 { put((1 << (8 - filled)) - 1, count: 8 - filled) }
        }

        mutating func restart(_ number: Int) {
            pad()
            out += [0xFF, 0xD0 + UInt8(number)]
        }

        mutating func finish() {
            pad()
            out += [0xFF, 0xD9]
        }
    }

    /// Code lengths for symbols used `counts` times (Annex K.2), as
    /// libjpeg's jpeg_gen_optimal_table makes them: Huffman's procedure with
    /// a reserved code point, so no code is all ones, and lengths over 16
    /// folded back as the standard says. The counts of codes of each length
    /// 1–16, and the symbols in code order; nil were a length past 32.
    static func optimalTable(_ counts: [Int]) -> (bits: [UInt8], symbols: [UInt8])? {
        guard counts.count == 256 else { return nil }
        var frequency = counts + [1]
        var codeSize = [Int](repeating: 0, count: 257)
        var others = [Int](repeating: -1, count: 257)
        while true {
            // The two least frequent, the larger symbol on a tie.
            var c1 = -1, least = Int.max
            for i in 0...256 where frequency[i] > 0 && frequency[i] <= least {
                least = frequency[i]
                c1 = i
            }
            var c2 = -1
            least = Int.max
            for i in 0...256 where frequency[i] > 0 && frequency[i] <= least && i != c1 {
                least = frequency[i]
                c2 = i
            }
            if c2 < 0 { break }
            frequency[c1] += frequency[c2]
            frequency[c2] = 0
            codeSize[c1] += 1
            while others[c1] >= 0 {
                c1 = others[c1]
                codeSize[c1] += 1
            }
            others[c1] = c2
            codeSize[c2] += 1
            while others[c2] >= 0 {
                c2 = others[c2]
                codeSize[c2] += 1
            }
        }
        var bits = [Int](repeating: 0, count: 33)
        for i in 0...256 where codeSize[i] > 0 {
            guard codeSize[i] <= 32 else { return nil }
            bits[codeSize[i]] += 1
        }
        var i = 32
        while i > 16 {
            while bits[i] > 0 {
                var j = i - 2
                while bits[j] == 0 { j -= 1 }
                bits[i] -= 2
                bits[i - 1] += 1
                bits[j + 1] += 2
                bits[j] -= 1
            }
            i -= 1
        }
        // The reserved code point goes, from the longest length in use.
        while bits[i] == 0 { i -= 1 }
        bits[i] -= 1
        var symbols: [UInt8] = []
        for length in 1...32 {
            for s in 0...255 where codeSize[s] == length { symbols.append(UInt8(s)) }
        }
        return (bits[1...16].map { UInt8($0) }, symbols)
    }
}
