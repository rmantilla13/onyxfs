import Testing
import Foundation
@testable import OnyxKit

/// POST /fs/v1/unzip: a zip from the internet Archive Utility could not
/// unzip on a disk, handed to the app to unzip — for the session's own
/// drive, one this account may change, and never a place outside it.
extension FSBridgeTests {
    final class HeardUnzips: @unchecked Sendable {
        private let lock = NSLock()
        private var reports: [(scope: String, failure: FSUnzipFailure)] = []
        func add(_ scope: String, _ failure: FSUnzipFailure) { lock.withLock { reports.append((scope, failure)) } }
        var all: [(scope: String, failure: FSUnzipFailure)] { lock.withLock { reports } }
    }

    static let unzipReport: [String: Any] = [
        "folder": "/Footage", "zips": ["c4.zip", "plain.zip"], "unpacked": ["Walmart Ad Videos"],
        "unpackedCount": 1, "placeholders": ["Walmart Ad Videos"],
    ]

    @Test func anUnzipArchiveUtilityCouldNotDoReachesTheApp() async throws {
        let (rig, _) = try await writeRig()
        defer { rig.remove() }
        let heard = HeardUnzips()
        rig.bridge.onUnzipFailed { scope, failure in heard.add(scope, failure) }
        let r = try await post(rig, "unzip", Self.unzipReport)
        #expect(r.status == 200)
        #expect(heard.all.map(\.scope) == [Self.scope])
        #expect(heard.all.first?.failure == FSUnzipFailure(folder: "/Footage", zips: ["c4.zip", "plain.zip"],
                                                          unpacked: ["Walmart Ad Videos"], unpackedCount: 1,
                                                          placeholders: ["Walmart Ad Videos"]))
    }

    /// A drive this account may only view takes no unzip: it would fail.
    @Test func aViewOnlyDriveIsNotUnzippedInto() async throws {
        let rig = try await rig()
        defer { rig.remove() }
        let heard = HeardUnzips()
        rig.bridge.onUnzipFailed { scope, failure in heard.add(scope, failure) }
        #expect(try await post(rig, "unzip", Self.unzipReport).status == 403)
        #expect(heard.all.isEmpty)
    }

    /// Each a report with one thing wrong, as JSON: `change` over the good one.
    @Test(arguments: [
        #"{"folder": "Footage"}"#,
        #"{"folder": "/Footage/../Other"}"#,
        #"{"folder": "/./Footage"}"#,
        #"{"folder": "/Footage//x"}"#,
        #"{"zips": ["../c4.zip"]}"#,
        #"{"zips": ["a/b.zip"]}"#,
        #"{"zips": []}"#,
        #"{"unpacked": [".."]}"#,
        #"{"placeholders": ["../Walmart Ad Videos"]}"#,
        #"{"unpackedCount": 0}"#,
        #"{"unpackedCount": "one"}"#,
        "{\"unpacked\": [\"\(String(repeating: "a", count: 256))\"]}",
        "{\"zips\": [\((0...100).map { "\"z\($0).zip\"" }.joined(separator: ","))]}",
    ])
    func whatCouldNameAPlaceOutsideTheDriveIsRefused(_ change: String) async throws {
        let (rig, _) = try await writeRig()
        defer { rig.remove() }
        let heard = HeardUnzips()
        rig.bridge.onUnzipFailed { scope, failure in heard.add(scope, failure) }
        let changed = try #require(try JSONSerialization.jsonObject(with: Data(change.utf8)) as? [String: Any])
        let body = Self.unzipReport.merging(changed) { _, new in new }
        #expect(try await post(rig, "unzip", body).status == 400)
        #expect(heard.all.isEmpty)
    }

    @Test func onlyASessionTellsAndOnlyByPost() async throws {
        let (rig, _) = try await writeRig()
        defer { rig.remove() }
        let heard = HeardUnzips()
        rig.bridge.onUnzipFailed { scope, failure in heard.add(scope, failure) }
        let body = try JSONSerialization.data(withJSONObject: Self.unzipReport)
        let stranger = await rig.bridge.respond(to: DAVRequest(method: "POST", target: Self.target("unzip"),
                                                               headers: ["authorization": "Bearer nope"], body: body))
        #expect(stranger.status == 401)
        let get = await rig.bridge.respond(to: DAVRequest(method: "GET", target: Self.target("unzip"),
                                                          headers: ["authorization": "Bearer \(rig.key)"]))
        #expect(get.status == 405)
        #expect(heard.all.isEmpty)
    }
}
