import Foundation
import Testing
@testable import OnyxKit

/// Masters kept on this Mac for their proxies (ProxySources): the bytes of
/// an upload outlive the queue's copy, only a copy that is provably the
/// claim's master is ever used, and what is held is let go of the moment it
/// can no longer be, and never grows past its bounds.
@Suite struct ProxySourcesTests {
    static let size: Int64 = 1000

    final class Disk: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes: Int64?
        private var time = Date(timeIntervalSince1970: 1_790_000_000)
        var free: Int64? {
            get { lock.withLock { bytes } }
            set { lock.withLock { bytes = newValue } }
        }
        var now: Date {
            get { lock.withLock { time } }
            set { lock.withLock { time = newValue } }
        }
    }

    struct Setup {
        let root: URL
        let disk: Disk
        let sources: ProxySources

        /// A file the upload queue has staged: `size` bytes of `seed`.
        func staged(_ name: String, size: Int64 = ProxySourcesTests.size, seed: UInt8 = 1) throws -> URL {
            let url = root.appendingPathComponent("queue", isDirectory: true).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(repeating: seed, count: Int(size)).write(to: url)
            return url
        }

        /// As ProxyService does when an upload finishes: a link at once,
        /// then kept or let go of.
        func hold(_ file: URL, _ fileId: String, key: String, size: Int64 = ProxySourcesTests.size,
                  name: String = "Take 1.mov") async -> Bool {
            guard let link = sources.link(file, name: name) else { return false }
            return await sources.hold(link, fileId: fileId, key: key, size: size)
        }
    }

    func setUp(maxBytes: Int64 = 10_000, spare: Int64 = 0) throws -> Setup {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ProxySources-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let disk = Disk()
        let sources = ProxySources(folder: root.appendingPathComponent("held"), maxAge: 24 * 3600, maxBytes: maxBytes,
                                   spareSpace: spare, freeSpace: { _ in disk.free }, now: { disk.now })
        return Setup(root: root, disk: disk, sources: sources)
    }

    func claim(_ fileId: String = "f1", size: Int64? = ProxySourcesTests.size,
               key: String? = "files/Take 1.mov") throws -> ProxyClaim {
        var object: [String: Any] = ["fileId": fileId, "name": "Take 1.mov", "mime": "video/quicktime",
                                     "downloadUrl": "https://s3.test/master", "uploadUrl": "https://s3.test/proxy"]
        if let size { object["size"] = size }
        if let key { object["sourceKey"] = key }
        return try JSONDecoder().decode(ProxyClaim.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func files(in folder: URL) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    }

    @Test func anUploadsBytesAreTheMasterOfItsProxy() async throws {
        let s = try setUp()
        defer { try? FileManager.default.removeItem(at: s.root) }
        let staged = try s.staged("upload-1", seed: 7)
        #expect(await s.hold(staged, "f1", key: "files/Take 1.mov"))

        // The queue lets go of its copy once the server has the file: the
        // bytes stay, under the store's own name, with the file's extension.
        try FileManager.default.removeItem(at: staged)
        let master = try #require(await s.sources.master(for: try claim()))
        #expect(master.pathExtension == "mov")
        #expect(try Data(contentsOf: master) == Data(repeating: 7, count: Int(Self.size)))

        // The job reads a link of its own, which keeps the bytes when the
        // store lets go of them.
        let job = s.root.appendingPathComponent("job", isDirectory: true)
        try FileManager.default.createDirectory(at: job, withIntermediateDirectories: true)
        let source = job.appendingPathComponent("source.mov")
        #expect(ProxySources.place(master, at: source, size: Self.size))
        await s.sources.release("f1")
        #expect(!FileManager.default.fileExists(atPath: master.path))
        #expect(await s.sources.all.isEmpty)
        #expect(try Data(contentsOf: source) == Data(repeating: 7, count: Int(Self.size)))
    }

    @Test func aClaimForOtherBytesIsDownloadedAndWhatWasHeldGoes() async throws {
        let s = try setUp()
        defer { try? FileManager.default.removeItem(at: s.root) }
        let mismatches: [(String, ProxyClaim)] = [
            ("the file has new contents, of another size", try claim(size: Self.size + 1)),
            ("renamed or replaced: another object", try claim(key: "files/Take 1 (2).mov")),
            ("a server that does not say which object", try claim(key: nil)),
            ("nor how large", try claim(size: nil)),
        ]
        for (why, other) in mismatches {
            #expect(await s.hold(try s.staged("upload"), "f1", key: "files/Take 1.mov"))
            #expect(await s.sources.master(for: other) == nil, "\(why)")
            #expect(await s.sources.all.isEmpty, "\(why): no claim will match it now")
        }
        #expect(files(in: s.sources.folder).isEmpty, "and its bytes go with it")

        // Another file's claim leaves it be.
        #expect(await s.hold(try s.staged("upload"), "f1", key: "files/Take 1.mov"))
        #expect(await s.sources.master(for: try claim("f2")) == nil)
        #expect(await s.sources.all.keys.sorted() == ["f1"])

        // Cut short on disk since: not the master.
        let link = try #require(await s.sources.all["f1"]?.url)
        let handle = try FileHandle(forWritingTo: link)
        try handle.truncate(atOffset: 10)
        try handle.close()
        #expect(await s.sources.master(for: try claim()) == nil)
        #expect(await s.sources.all.isEmpty)
    }

    @Test func aNewerUploadOfTheFileTakesThePlaceOfTheOlder() async throws {
        let s = try setUp()
        defer { try? FileManager.default.removeItem(at: s.root) }
        #expect(await s.hold(try s.staged("first", seed: 1), "f1", key: "files/a.mov"))
        let old = try #require(await s.sources.all["f1"]?.url)
        #expect(await s.hold(try s.staged("second", seed: 2), "f1", key: "files/a (2).mov"))
        #expect(!FileManager.default.fileExists(atPath: old.path))
        let master = try #require(await s.sources.master(for: try claim(key: "files/a (2).mov")))
        #expect(try Data(contentsOf: master) == Data(repeating: 2, count: Int(Self.size)))
    }

    @Test func whatIsHeldStaysUnderItsLimitAndLeavesTheDiskRoom() async throws {
        let s = try setUp(maxBytes: 2500, spare: 5000)
        defer { try? FileManager.default.removeItem(at: s.root) }
        s.disk.free = 100_000
        #expect(await s.hold(try s.staged("a"), "a", key: "k/a"))
        s.disk.now += 1
        #expect(await s.hold(try s.staged("b"), "b", key: "k/b"))
        // A third would put 3000 bytes on hold, over the limit: it is
        // downloaded when its job comes, and the two before it stay.
        #expect(await !s.hold(try s.staged("c"), "c", key: "k/c"))
        #expect(await s.sources.bytes == 2 * Self.size)
        #expect(files(in: s.sources.folder).count == 2, "the refused link is not left behind")

        // Not the size the upload said: not held.
        #expect(await !s.hold(try s.staged("d"), "d", key: "k/d", size: 400))

        // The disk short of room: nothing more is held, and what is held
        // goes, newest first, until there is room again.
        s.disk.free = 4000
        #expect(await !s.hold(try s.staged("d", size: 400), "d", key: "k/d", size: 400))
        #expect(await s.sources.all.isEmpty, "nothing here frees room, so all of it goes")
        #expect(files(in: s.sources.folder).isEmpty)
    }

    @Test func theNewestGoFirstWhenTheDiskIsShort() async throws {
        let disk = Disk()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ProxySources-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        // Each master let go of frees its bytes, as it does once the queue
        // has let go of its copy.
        let held = root.appendingPathComponent("held")
        let sources = ProxySources(folder: held, maxAge: 24 * 3600, maxBytes: 10_000, spareSpace: 2500,
                                   freeSpace: { _ in disk.free.map { $0 - Int64(held.fileCount) * 1000 } }, now: { disk.now })
        let s = Setup(root: root, disk: disk, sources: sources)
        disk.free = 6000
        for name in ["old", "middle", "new"] {
            #expect(await s.hold(try s.staged(name), name, key: "k/\(name)"))
            disk.now += 1
        }
        // 6000 less the three held is 3000 free: room to spare. A fourth
        // file on the disk leaves 2000, under the 2500 kept free.
        disk.free = 5000
        await sources.prune()
        #expect(await sources.all.keys.sorted() == ["middle", "old"], "the newest went, and that was enough")
    }

    @Test func aMasterIsHeldADayAtMost() async throws {
        let s = try setUp()
        defer { try? FileManager.default.removeItem(at: s.root) }
        #expect(await s.hold(try s.staged("a"), "f1", key: "files/Take 1.mov"))
        s.disk.now += 23 * 3600
        #expect(await s.sources.master(for: try claim()) != nil)
        s.disk.now += 3600
        #expect(await s.sources.master(for: try claim()) == nil)
        #expect(await s.sources.all.isEmpty)
    }

    @Test func aQueueWithNoJobForAMasterLetsItGo() async throws {
        // Nothing queued for it when the whole queue was read — no proxies
        // on this server, or another Mac has the job — so nothing will come.
        let s = try setUp()
        defer { try? FileManager.default.removeItem(at: s.root) }
        #expect(await s.hold(try s.staged("a"), "a", key: "k/a"))
        #expect(await s.hold(try s.staged("b"), "b", key: "k/b"))
        s.disk.now += 1
        let asked = s.disk.now
        s.disk.now += 1
        // Held after the queue was asked: its job may have been asked for
        // after the queue answered, and it stays.
        #expect(await s.hold(try s.staged("c"), "c", key: "k/c"))
        await s.sources.queueSeen(["a"], askedAt: asked)
        #expect(await s.sources.all.keys.sorted() == ["a", "c"])
    }

    @Test func nothingOutlivesTheApp() async throws {
        let s = try setUp()
        defer { try? FileManager.default.removeItem(at: s.root) }
        #expect(await s.hold(try s.staged("a"), "a", key: "k/a"))
        let folder = s.sources.folder
        #expect(files(in: folder).count == 1)
        // Opened again, as at the next launch: the jobs it held for are not
        // coming to it now.
        _ = ProxySources(folder: folder)
        #expect(!FileManager.default.fileExists(atPath: folder.path))

        let t = try setUp()
        defer { try? FileManager.default.removeItem(at: t.root) }
        #expect(await t.hold(try t.staged("a"), "a", key: "k/a"))
        await t.sources.clear()
        #expect(await t.sources.all.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: t.sources.folder.path))
    }

    @Test func theJobReadsAHardLinkOrElseASymbolicOne() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ProxySources-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        // On the same disk: a hard link, the same bytes whatever becomes of
        // the name it came from.
        let master = root.appendingPathComponent("f1-0123456789ab")
        try Data([9, 9]).write(to: master)
        let source = root.appendingPathComponent("source.mov")
        #expect(ProxySources.place(master, at: source, size: 2))
        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: source.path)) == nil)
        let inode = { (url: URL) in try FileManager.default.attributesOfItem(atPath: url.path)[.systemFileNumber] as? Int }
        #expect(try inode(source) == inode(master))

        // Where a hard link is refused — across disks, as an offline copy's
        // may be — a symbolic link to it.
        let other = root.appendingPathComponent("Other disk", isDirectory: true)
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let kept = other.appendingPathComponent("f2-0123456789ab")
        try Data([1, 2, 3]).write(to: kept)
        try FileManager.default.setAttributes([.immutable: true], ofItemAtPath: kept.path)   // no hard link to it
        defer { try? FileManager.default.setAttributes([.immutable: false], ofItemAtPath: kept.path) }
        let linked = root.appendingPathComponent("source 2.mov")
        #expect(ProxySources.place(kept, at: linked, size: 3))
        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: linked.path)) == kept.path)

        // Not the size the claim says, as the transcode would find it: taken
        // away again. And nothing is put over what is there.
        let short = root.appendingPathComponent("source 3.mov")
        #expect(!ProxySources.place(master, at: short, size: 3))
        #expect(!FileManager.default.fileExists(atPath: short.path))
        #expect(!ProxySources.place(master, at: source, size: 2))
    }
}

private extension URL {
    /// Files directly in this folder; 0 when there is no folder.
    var fileCount: Int { ((try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []).count }
}
