import Foundation
import Testing
@testable import OnyxKit

/// Recent and Search with no All Files: every drive asked, one list newest
/// first, a page at a time — each file once, none skipped, in order.
@Suite struct AcrossDrivesTests {
    /// A pretend server: each drive's files, newest first, paged by an
    /// offset cursor of its own, never more than `cap` at once.
    final class Drives: @unchecked Sendable {
        let files: [String: [FileItem]]
        let cap: Int
        private(set) var asks: [(String, String?, Int)] = []
        private let lock = NSLock()
        init(_ files: [String: [FileItem]], cap: Int = 1000) { self.files = files; self.cap = cap }

        func fetch(_ scope: SyncDomain, _ cursor: String?, _ limit: Int) -> FilePage {
            lock.lock(); asks.append((scope.identifier, cursor, limit)); lock.unlock()
            let all = files[scope.identifier] ?? []
            let from = Int(cursor ?? "0") ?? 0
            let n = min(limit, cap)
            let page = Array(all.dropFirst(from).prefix(n))
            return FilePage(files: page, cursor: from + n < all.count ? String(from + n) : nil)
        }
    }

    static func file(_ id: String, _ at: Int64) -> FileItem {
        try! JSONDecoder().decode(FileItem.self, from: Data(#"{"id":"\#(id)","name":"\#(id).jpg","folder":"","kind":"image","tags":[],"version":1,"createdAt":\#(at)}"#.utf8))
    }

    /// `count` files in `drive`, at the times `times` (newest first).
    static func files(_ drive: String, _ times: [Int64]) -> [FileItem] {
        times.sorted(by: >).map { file("\(drive)-\($0)", $0) }
    }

    func everything(_ drives: Drives, scopes: [SyncDomain], limit: Int) async throws -> [[FileItem]] {
        var pages: [[FileItem]] = []
        var cursor: String?
        repeat {
            let page = try await AcrossDrives.page(scopes, limit: limit, cursor: cursor) { drives.fetch($0, $1, $2) }
            pages.append(page.files)
            cursor = page.cursor
            #expect(pages.count < 200, "it ends")
        } while cursor != nil && pages.count < 200
        return pages
    }

    let a = SyncDomain.drive(id: "a"), b = SyncDomain.drive(id: "b"), c = SyncDomain.drive(id: "c")

    @Test func interleavedDrivesComeOutAsOneListNewestFirstEachFileOnce() async throws {
        let drives = Drives([
            "drive.a": Self.files("a", Array(stride(from: 1000, to: 1, by: -7))),
            "drive.b": Self.files("b", Array(stride(from: 999, to: 1, by: -3))),
            "drive.c": Self.files("c", [500, 400]),
        ])
        let pages = try await everything(drives, scopes: [a, b, c], limit: 10)
        let all = pages.flatMap { $0 }
        let expected = (drives.files.values.flatMap { $0 }).sorted { AcrossDrives.newer($0, than: $1) }
        #expect(all.map(\.id) == expected.map(\.id), "every file, once, newest first")
        #expect(pages.dropLast().allSatisfy { !$0.isEmpty }, "no empty page while there is more")
        #expect(drives.asks.allSatisfy { $0.2 == 10 }, "every ask the same size")
    }

    @Test func aDriveWhosePageRunsOutStopsTheMergeRatherThanSkipAhead() async throws {
        // a's second page is newer than all of b: a page that took b's files
        // after a's first page ran out would put them before a's newer ones.
        let drives = Drives(["drive.a": Self.files("a", [100, 99, 98, 97]), "drive.b": Self.files("b", [10, 9, 8, 7])], cap: 2)
        let pages = try await everything(drives, scopes: [a, b], limit: 3)
        #expect(pages.flatMap { $0 }.map(\.id) == ["a-100", "a-99", "a-98", "a-97", "b-10", "b-9", "b-8", "b-7"])
    }

    @Test func aFileInADriveInsideAnotherIsListedOnce() async throws {
        let shared = Self.file("same", 50)
        let drives = Drives(["drive.a": [Self.file("a1", 60), shared], "drive.b": [shared, Self.file("b1", 40)]])
        let all = try await everything(drives, scopes: [a, b], limit: 10).flatMap { $0 }
        #expect(all.map(\.id) == ["a1", "same", "b1"])
    }

    @Test func noDrivesOrEmptyOnesEndAtOnce() async throws {
        let drives = Drives([:])
        let none = try await AcrossDrives.page([], limit: 10, cursor: nil) { drives.fetch($0, $1, $2) }
        #expect(none.files.isEmpty && none.cursor == nil)
        let empty = try await AcrossDrives.page([a, b], limit: 10, cursor: nil) { drives.fetch($0, $1, $2) }
        #expect(empty.files.isEmpty && empty.cursor == nil)
    }

    @Test func aDriveThatFailsFailsThePage() async throws {
        struct Down: Error {}
        await #expect(throws: Down.self) {
            _ = try await AcrossDrives.page([a, b], limit: 5, cursor: nil) { scope, _, _ in
                if scope == b { throw Down() }
                return FilePage(files: [], cursor: nil)
            }
        }
    }

    @Test func aCursorFromSomewhereElseStartsOver() {
        #expect(AcrossDrives.decode("not ours") == nil)
        #expect(AcrossDrives.decode("x.%%%") == nil)
        #expect(AcrossDrives.decode(nil) == nil)
    }
}
