import Foundation
import Testing
@testable import OnyxKit

/// The bridge's tree while Finder copies a great many files onto a disk:
/// thousands of them on their way at once (the overlay), and a change for
/// every file closed and every upload done (FSChangeLog). On 3 November a
/// copy of 618 into the owner's Portfolio drive made each change cost
/// 0.11 s, and with every answer waiting its turn, a delete waited 30 s and
/// Finder stopped.
struct FSViewScaleTests {
    static let staged = URL(fileURLWithPath: "/tmp/onyx-staged")

    static func pending(_ path: String, _ n: Int, size: Int64 = 10) -> FSNode {
        FSNode(path: path, name: (path as NSString).lastPathComponent, isFolder: false, fileId: "pending:\(n)",
               size: size, modified: Date(timeIntervalSince1970: 1_790_000_000), content: "pending:\(n):\(size)",
               pending: true, staged: staged)
    }

    /// `files` photos spread over `folders` folders, and `copies` empty
    /// folders a copy is going into (Finder makes them first).
    static func drive(files: Int, folders: Int, copies: Int) -> MirrorIndex {
        var items: [FileItem] = []
        items.reserveCapacity(files)
        for i in 0..<files {
            items.append(FSBridgeTests.item("id-\(i)", "IMG_\(i).jpg", in: "Models/Model \(i % folders)",
                                            hash: "h\(i)", updated: FSBridgeTests.t0 - Int64(i)))
        }
        var replica = Replica()
        replica.apply(changed: items, deleted: [], folders: (0..<copies).map { "Motion/Model \($0)" })
        return MirrorIndex(replica)
    }

    /// `count` files on their way into the copy's folders, round robin.
    static func copying(_ count: Int, into copies: Int, from first: Int = 0) -> [FSNode] {
        (first..<(first + count)).map { pending("Motion/Model \($0 % copies)/clip \($0).mov", $0) }
    }

    // MARK: - The same answers

    @Test func anIndexKnowsItsOwnBuild() {
        let replica = { () -> Replica in
            var r = Replica()
            r.apply(changed: FSBridgeTests.drive, deleted: [], folders: FSBridgeTests.folders)
            return r
        }()
        let index = MirrorIndex(replica)
        let copy = index
        #expect(index.isSame(as: copy))
        #expect(index.isSame(as: index.authoritative(!index.isAuthoritative)), "vouched for anew, the same tree")
        #expect(!index.isSame(as: MirrorIndex(replica)), "built again, even of the same replica, another")
    }

    /// Merged in one pass, a listing is the mirror's entries and the
    /// overlay's together in Finder's order, folders first — as placing the
    /// overlay's one by one made it.
    @Test func aFolderOfFilesOnTheirWayListsInFinderOrder() {
        var items: [FileItem] = []
        for i in stride(from: 1, through: 99, by: 2) {
            items.append(FSBridgeTests.item("m\(i)", "IMG_\(i).jpg", in: "Shoot", hash: "h\(i)"))
        }
        var replica = Replica()
        replica.apply(changed: items, deleted: [], folders: ["Shoot/Selects", "Shoot/RAW"])
        let index = MirrorIndex(replica)
        var nodes = stride(from: 2, through: 100, by: 2).map { Self.pending("Shoot/IMG_\($0).jpg", $0) }
        // One over a file the mirror has (new contents for it), one folder of
        // its own, and Finder's own names, never listed.
        nodes.append(Self.pending("Shoot/IMG_7.jpg", 7_000, size: 99))
        nodes.append(FSNode(path: "Shoot/Edits", name: "Edits", isFolder: true, fileId: nil, size: 0,
                            modified: Date(timeIntervalSince1970: 0), content: ""))
        nodes.append(Self.pending("Shoot/._IMG_2.jpg", 9_000))
        nodes.append(Self.pending("Shoot/.DS_Store", 9_001))
        let view = FSView(index: index, overlay: FSOverlay(nodes: nodes))

        let listed = view.children(of: "Shoot") ?? []
        let names = listed.map(\.name)
        let expected = (["Edits", "RAW", "Selects"] + (1...100).map { "IMG_\($0).jpg" })
        #expect(names == expected)
        #expect(listed.first { $0.name == "IMG_7.jpg" }?.size == 99, "the overlay's, not the mirror's")
        #expect(listed.filter(\.pending).count == 51)
        #expect(zip(listed, listed.dropFirst()).allSatisfy { FSView.listsBefore($0, $1) })
    }

    /// Only the overlay moved: the folders found are exactly those the whole
    /// tree's comparison finds, whatever came, went or changed — a file over
    /// a mirror file, over a mirror folder, a folder of its own, Finder's own
    /// names, the drive's top, with collections shown and paths hidden.
    @Test func anOverlayOnlyChangeFindsWhatTheWholeTreeWould() {
        var items: [FileItem] = []
        for i in 0..<300 {
            items.append(FSBridgeTests.item("id-\(i)", "file \(i).jpg", in: i % 5 == 0 ? "" : "F\(i % 7)/G\(i % 3)",
                                            hash: "h\(i)"))
        }
        var replica = Replica()
        replica.apply(changed: items, deleted: [], folders: ["F1/G0/Deep", "Empty"])
        let index = MirrorIndex(replica)
        let collections = FSCollections([.init(id: "c", name: "Picks", entries: [index.file(id: "id-3")!])])
        let hidden: Set<String> = ["F2/G1"]

        var places: [String] = ["", "F1", "F1/G0", "F1/G0/Deep", "F2/G1", "F3/G2", "Empty", "Nowhere", "F4/G1/file 4.jpg"]
        places += ["F1/G1", "F6/G0"]
        var generator = SeededGenerator(seed: 7)
        func randomNode(_ n: Int) -> FSNode {
            let folder = places.randomElement(using: &generator)!
            let name: String
            switch Int.random(in: 0..<10, using: &generator) {
            case 0: name = ".DS_Store"
            case 1: name = "._clip \(n).mov"
            case 2: name = "file \(Int.random(in: 0..<300, using: &generator)).jpg"  // over a mirror file
            case 3: name = "G\(Int.random(in: 0..<3, using: &generator))"              // over a mirror folder
            default: name = "clip \(n).mov"
            }
            let path = folder.isEmpty ? name : folder + "/" + name
            if Int.random(in: 0..<12, using: &generator) == 0 {
                return FSNode(path: path, name: name, isFolder: true, fileId: nil, size: 0,
                              modified: Date(timeIntervalSince1970: 0), content: "")
            }
            return Self.pending(path, n, size: Int64.random(in: 1...3, using: &generator))
        }

        var current: [FSNode] = (0..<40).map(randomNode)
        for round in 0..<200 {
            var next = current
            switch Int.random(in: 0..<4, using: &generator) {
            case 0: next.append(randomNode(1_000 + round))
            case 1: if !next.isEmpty { next.remove(at: Int.random(in: 0..<next.count, using: &generator)) }
            case 2:
                // The same file, further on (its size, as an upload's would).
                if let at = next.indices.randomElement(using: &generator), !next[at].isFolder {
                    next[at] = Self.pending(next[at].path, 2_000 + round, size: next[at].size + 1)
                }
            default:
                next.append(randomNode(3_000 + round))
                if next.count > 2 { next.removeFirst() }
            }
            let old = FSView(index: index, overlay: FSOverlay(nodes: current, hidden: hidden), collections: collections)
            let new = FSView(index: index, overlay: FSOverlay(nodes: next, hidden: hidden), collections: collections)
            #expect(FSView.changedFolders(from: old, to: new) == FSView.everyChangedFolder(from: old, to: new),
                    "round \(round)")
            current = next
        }
    }

    /// Anything more than the overlay moving is the whole tree's comparison.
    @Test func theMirrorMovingComparesTheWholeTree() {
        let before = FSView(index: Self.drive(files: 200, folders: 20, copies: 2),
                            overlay: FSOverlay(nodes: Self.copying(10, into: 2)))
        var items = (0..<200).map {
            FSBridgeTests.item("id-\($0)", "IMG_\($0).jpg", in: "Models/Model \($0 % 20)", hash: "h\($0)",
                               updated: FSBridgeTests.t0 - Int64($0))
        }
        items[7] = FSBridgeTests.item("id-7", "IMG_7.jpg", in: "Models/Model 7", size: 5, hash: "h7-new",
                                      updated: FSBridgeTests.t0 - 7)
        var replica = Replica()
        replica.apply(changed: items, deleted: [], folders: (0..<2).map { "Motion/Model \($0)" })
        let after = FSView(index: MirrorIndex(replica), overlay: before.overlay)
        #expect(FSView.changedFolders(from: before, to: after) == ["Models/Model 7"])
    }

    // MARK: - At the size of a real copy

    /// The owner's copy, and then some: 20,000 files in 2,000 folders, 3,000
    /// on their way into 150 more. One more arriving is one folder compared;
    /// the mirror moving is the whole tree, once over each node.
    @Test func aBigCopyIsComparedQuickly() {
        let index = Self.drive(files: 20_000, folders: 2_000, copies: 150)
        let nodes = Self.copying(3_000, into: 150)
        let before = FSView(index: index, overlay: FSOverlay(nodes: nodes))
        let after = FSView(index: index, overlay: FSOverlay(nodes: nodes + Self.copying(1, into: 150, from: 3_000)))

        var started = ContinuousClock.now
        let changed = FSView.changedFolders(from: before, to: after)
        let quick = ContinuousClock.now - started
        #expect(changed == ["Motion/Model 0"])
        // Debug build: bounds to catch a pass over the whole tree, or over
        // every node for each folder, not to time it. Release measured on
        // the owner's Mac's shape: see ONYXFS.md, "Copying thousands".
        #expect(quick < .seconds(1), "one more on its way, compared in \(quick)")

        started = ContinuousClock.now
        let whole = FSView.everyChangedFolder(from: before, to: after)
        let slow = ContinuousClock.now - started
        #expect(whole == changed)
        #expect(slow < .seconds(20), "the whole tree compared in \(slow)")

        started = ContinuousClock.now
        let listed = after.children(of: "Motion/Model 0")
        let listing = ContinuousClock.now - started
        #expect(listed?.count == 21)
        #expect(listing < .seconds(1), "listed in \(listing)")
    }

    /// One folder taking a whole shoot: 1,500 files on their way, beside 200
    /// the mirror has. Placed one by one, from the top each time, listing it
    /// took half a second in a release build.
    @Test func aShootFolderOfFilesOnTheirWayListsQuickly() {
        var items: [FileItem] = []
        for i in 0..<200 { items.append(FSBridgeTests.item("m\(i)", "IMG_\(i * 10).jpg", in: "Shoot", hash: "h\(i)")) }
        var replica = Replica()
        replica.apply(changed: items, deleted: [], folders: [])
        let nodes = (0..<1_500).map { Self.pending("Shoot/IMG_\($0 * 10 + 5).jpg", $0) }
        let view = FSView(index: MirrorIndex(replica), overlay: FSOverlay(nodes: nodes))
        let started = ContinuousClock.now
        let listed = view.children(of: "Shoot") ?? []
        let took = ContinuousClock.now - started
        #expect(listed.count == 1_700)
        #expect(zip(listed, listed.dropFirst()).allSatisfy { FSView.listsBefore($0, $1) })
        #expect(took < .seconds(1), "listed in \(took)")
    }

    /// A file on its way found by its id: from the overlay's own record, not
    /// a look at every node.
    @Test func aFileOnItsWayIsFoundByItsId() {
        let index = Self.drive(files: 100, folders: 10, copies: 3)
        let view = FSView(index: index, overlay: FSOverlay(nodes: Self.copying(2_000, into: 3)))
        #expect(view.file(id: "pending:1234")?.path == "Motion/Model 1/clip 1234.mov")
        #expect(view.file(id: "id-5")?.path == "Models/Model 5/IMG_5.jpg")
        #expect(view.file(id: "pending:99999") == nil)
    }
}

/// The same numbers every run, for a test that wants many cases.
struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
