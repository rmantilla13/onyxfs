import Testing
import Foundation
@testable import OnyxKit

/// POST /fs/v1/activity: what a disk moved, as its extension counts it,
/// handed to the app for the Activity window — for the session's own drive,
/// read-only disks too, and nothing that is not a report.
extension FSBridgeTests {
    final class Heard: @unchecked Sendable {
        private let lock = NSLock()
        private var reports: [(scope: String, moved: FSActivity)] = []
        func add(_ scope: String, _ moved: FSActivity) { lock.withLock { reports.append((scope, moved)) } }
        var all: [(scope: String, moved: FSActivity)] { lock.withLock { reports } }
    }

    @Test func aDisksReportReachesTheAppForItsOwnDriveEvenReadOnly() async throws {
        // The plain rig has no writer: the drive is one this account may only view.
        let rig = try await rig()
        defer { rig.remove() }
        let heard = Heard()
        rig.bridge.onActivity { scope, moved in heard.add(scope, moved) }
        let r = try await post(rig, "activity", ["read": 1_048_576, "download": 524_288, "write": 0])
        #expect(r.status == 200)
        #expect(heard.all.count == 1)
        #expect(heard.all.first?.scope == Self.scope)
        #expect(heard.all.first?.moved == FSActivity(read: 1_048_576, download: 524_288, write: 0))
    }

    @Test func aFieldLeftOutIsNothingMoved() async throws {
        let rig = try await rig()
        defer { rig.remove() }
        let heard = Heard()
        rig.bridge.onActivity { scope, moved in heard.add(scope, moved) }
        let r = try await post(rig, "activity", ["write": 4096])
        #expect(r.status == 200)
        #expect(heard.all.first?.moved == FSActivity(write: 4096))
    }

    /// What the disk's cache holds rides along (`cache`), a level rather
    /// than bytes moved, so a report of nothing moved may carry it alone. An
    /// extension that does not say leaves it unknown, not 0.
    @Test func aDisksCacheSizeComesWithItsReport() async throws {
        let rig = try await rig()
        defer { rig.remove() }
        let heard = Heard()
        rig.bridge.onActivity { scope, moved in heard.add(scope, moved) }
        #expect(try await post(rig, "activity", ["read": 0, "download": 0, "write": 0, "cache": 3_145_760]).status == 200)
        #expect(try await post(rig, "activity", ["read": 4096]).status == 200)
        #expect(heard.all.map(\.moved) == [FSActivity(cache: 3_145_760), FSActivity(read: 4096)])
        #expect(heard.all.last?.moved.cache == nil)
        // Past a tebibyte is a cache, not a second's reading.
        #expect(try await post(rig, "activity", ["cache": Int64(2) << 40]).status == 200)
    }

    @Test(arguments: [
        #"{"read": -1}"#,
        #"{"cache": -1}"#,
        #"{"cache": 2251799813685249}"#,
        #"{"download": 1099511627777}"#,
        #"{"read": "a lot"}"#,
        #"["read", 1]"#,
        "",
    ])
    func whatIsNotAReportIsRefused(_ body: String) async throws {
        let rig = try await rig()
        defer { rig.remove() }
        let heard = Heard()
        rig.bridge.onActivity { scope, moved in heard.add(scope, moved) }
        let r = await rig.bridge.respond(to: DAVRequest(method: "POST", target: Self.target("activity"),
                                                        headers: ["authorization": "Bearer \(rig.key)"],
                                                        body: Data(body.utf8)))
        #expect(r.status == 400)
        #expect(heard.all.isEmpty)
    }

    @Test func onlyASessionReportsAndOnlyByPost() async throws {
        let rig = try await rig()
        defer { rig.remove() }
        let heard = Heard()
        rig.bridge.onActivity { scope, moved in heard.add(scope, moved) }
        let body = Data(#"{"read": 1}"#.utf8)
        let stranger = await rig.bridge.respond(to: DAVRequest(method: "POST", target: Self.target("activity"),
                                                               headers: ["authorization": "Bearer nope"], body: body))
        #expect(stranger.status == 401)
        let get = await rig.bridge.respond(to: DAVRequest(method: "GET", target: Self.target("activity"),
                                                          headers: ["authorization": "Bearer \(rig.key)"]))
        #expect(get.status == 405)
        #expect(heard.all.isEmpty)
    }
}
