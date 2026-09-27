import Foundation

/// The AppleDouble files (`._name`) macOS keeps an item's Finder info and
/// extended attributes in, on a volume that does not keep them itself. To
/// the kernel an onyxfs volume is one of those: its xattr handler names no
/// attributes (FSKit's "limited" support), so all of them go to `._` files —
/// which are macOS's, and stay on this Mac (LocalOnly). A folder's are in
/// `._<folder>` beside it; the root, with nothing beside it, has `._.`.
///
/// Only as much of the format as a disk's icon needs: a new file in the
/// layout the kernel writes itself (xnu's vfs_xattr.c, create_xattrfile),
/// and a Finder flag set in an existing one. Big-endian throughout.
enum AppleDouble {
    /// The root folder's.
    static let rootName = "._."
    /// Finder's "this item has an icon of its own" (kHasCustomIcon): for a
    /// disk, `.VolumeIcon.icns` at its root.
    static let hasCustomIcon: UInt16 = 0x0400

    static let magic: UInt32 = 0x0005_1607
    static let version: UInt32 = 0x0002_0000
    static let finderInfoEntry: UInt32 = 9
    static let resourceForkEntry: UInt32 = 2
    /// Where the Finder info starts: after the header and two entries.
    static let finderInfoOffset = 0x32
    static let size = 4096
    /// The empty resource fork's header, which ends the file.
    static let resourceForkLength = 286

    /// A `._` file whose Finder info carries `flags`, and nothing else: an
    /// attribute header with no attributes, and the empty resource fork,
    /// "intentionally left blank" — byte for byte what macOS writes.
    static func file(finderFlags flags: UInt16) -> Data {
        var d = Data(count: size)
        let fork = size - resourceForkLength
        d.put(magic, at: 0)
        d.put(version, at: 4)
        d.replaceSubrange(8..<24, with: Data("Mac OS X        ".utf8))
        d.put(UInt16(2), at: 24)
        d.put(finderInfoEntry, at: 26)
        d.put(UInt32(finderInfoOffset), at: 30)
        d.put(UInt32(fork - finderInfoOffset), at: 34)
        d.put(resourceForkEntry, at: 38)
        d.put(UInt32(fork), at: 42)
        d.put(UInt32(resourceForkLength), at: 46)
        d.put(flags, at: finderInfoOffset + 8)
        // The attribute header, after 32 bytes of Finder info and two of
        // padding: "ATTR", a tag, where the attributes end, where their data
        // starts (just past this header), and none of them.
        let attributes = finderInfoOffset + 34
        d.replaceSubrange(attributes..<attributes + 4, with: Data("ATTR".utf8))
        d.put(UInt32(fork), at: attributes + 8)
        d.put(UInt32(attributes + 36), at: attributes + 12)
        // The empty resource fork: data and map at 256, a 30-byte map, and
        // no types in it.
        d.put(UInt32(0x100), at: fork)
        d.put(UInt32(0x100), at: fork + 4)
        d.put(UInt32(30), at: fork + 12)
        d.replaceSubrange(fork + 16..<fork + 62, with: Data("This resource fork intentionally left blank   ".utf8))
        d.put(UInt32(0x100), at: fork + 256)
        d.put(UInt32(0x100), at: fork + 260)
        d.put(UInt32(30), at: fork + 268)
        d.put(UInt16(28), at: fork + 280)
        d.put(UInt16(30), at: fork + 282)
        d.put(UInt16(0xFFFF), at: fork + 284)
        return d
    }

    /// Where the Finder info's flags are in `data`; nil for anything but an
    /// AppleDouble file with Finder info.
    static func finderFlagsOffset(in data: Data) -> Int? {
        guard data.count >= 26, data.uint32(at: 0) == magic, data.uint32(at: 4) == version else { return nil }
        let count = Int(data.uint16(at: 24))
        for i in 0..<count {
            let entry = 26 + i * 12
            guard entry + 12 <= data.count else { return nil }
            guard data.uint32(at: entry) == finderInfoEntry else { continue }
            let offset = Int(data.uint32(at: entry + 4)), length = Int(data.uint32(at: entry + 8))
            guard length >= 32, offset + 32 <= data.count else { return nil }
            return offset + 8
        }
        return nil
    }

    static func finderFlags(of data: Data) -> UInt16? {
        finderFlagsOffset(in: data).map { data.uint16(at: $0) }
    }

    /// `data` with `flags` set among its Finder flags, the rest as it was;
    /// nil when it is not an AppleDouble file with Finder info.
    static func settingFinderFlags(_ flags: UInt16, in data: Data) -> Data? {
        guard let at = finderFlagsOffset(in: data) else { return nil }
        var d = data
        d.put(data.uint16(at: at) | flags, at: at)
        return d
    }
}

private extension Data {
    mutating func put<T: FixedWidthInteger>(_ value: T, at offset: Int) {
        Swift.withUnsafeBytes(of: value.bigEndian) {
            replaceSubrange(startIndex + offset..<startIndex + offset + MemoryLayout<T>.size, with: $0)
        }
    }

    func uint32(at offset: Int) -> UInt32 {
        self[startIndex + offset..<startIndex + offset + 4].reduce(0) { $0 << 8 | UInt32($1) }
    }

    func uint16(at offset: Int) -> UInt16 {
        self[startIndex + offset..<startIndex + offset + 2].reduce(0) { $0 << 8 | UInt16($1) }
    }
}
