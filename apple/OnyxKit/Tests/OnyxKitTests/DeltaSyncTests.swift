import Testing
import Foundation
@testable import OnyxKit

/// The enumeration contract, tested against a stub server rather than the real
/// one — these are the cases that are hard to produce on demand in production
/// and catastrophic when wrong.
struct DeltaSyncTests {

    @Test func testEpochMillisAreNotDecodedAsSeconds() throws {
        // Every timestamp in this API is milliseconds. Read as seconds, a 2026
        // file lands in 1970 and the library sorts backwards — which reads as
        // a UI bug and gets looked for in the wrong place.
        let json = #"{"raw":1789957800000}"#.data(using: .utf8)!
        struct Box: Decodable { let raw: EpochMillis }
        let box = try JSONDecoder().decode(Box.self, from: json)
        let components = Calendar(identifier: .gregorian).dateComponents(
            in: TimeZone(identifier: "UTC")!, from: box.raw.date)
        #expect(components.year == 2026)
    }

    @Test func testFileItemDecodesServerShapeWithNulls() throws {
        // Fields shapeFile() can send as null must be Optional — one
        // non-optional that arrives null fails the WHOLE decode, so a single
        // file with no mime type empties the drive.
        let json = """
        {"id":"f1","name":"clip.mov","folder":"","kind":"video","mime":null,"size":null,
         "url":null,"storageKey":null,"thumbnailUrl":null,"tags":[],"notes":null,
         "caption":null,"visibility":"org","version":1,"contentHash":null,
         "createdBy":null,"createdAt":1789957800000,"updatedAt":1789957800000,
         "deletedAt":null,"seq":7}
        """.data(using: .utf8)!
        let item = try JSONDecoder().decode(FileItem.self, from: json)
        #expect(item.id == "f1")
        #expect(item.seq == 7)
        #expect(item.mime == nil)
    }

    @Test func testStaticCredentialsWithoutExpiryAreNotTreatedAsExpired() throws {
        // `expiration` is null for the static, filespace-static and B2 rungs.
        // Treating absent as "expired" re-mints on every single request;
        // treating it as a missing date crashes. Neither is acceptable.
        let json = """
        {"filespaceId":"fs1","name":"Main","role":"editor","accessKeyId":"A",
         "secretAccessKey":"S","sessionToken":null,"expiration":null,
         "bucket":"b","prefix":"files","region":"us-west-004","mode":"static","endpoint":null}
        """.data(using: .utf8)!
        let creds = try JSONDecoder().decode(SpaceCredentials.self, from: json)
        #expect(!(creds.isExpired()))
        #expect(creds.sigV4.sessionToken == nil)
    }

    @Test func testScopedCredentialsExpireWithSlack() throws {
        let expiry = Int64(Date().addingTimeInterval(60).timeIntervalSince1970 * 1000)
        let json = """
        {"filespaceId":"fs1","name":null,"role":null,"accessKeyId":"A","secretAccessKey":"S",
         "sessionToken":"T","expiration":\(expiry),"bucket":"b","prefix":null,
         "region":"r","mode":"assume-role","endpoint":null}
        """.data(using: .utf8)!
        let creds = try JSONDecoder().decode(SpaceCredentials.self, from: json)
        // Expires in a minute; with five minutes of slack it counts as expired
        // NOW, so a long download does not die holding a key that lapsed
        // halfway through.
        #expect(creds.isExpired())
        #expect(!(creds.isExpired(slack: 10)))
    }

    @Test func testCursorStoreRoundTrips() {
        let store = CursorStore(suiteName: "onyxkit.tests.\(UUID().uuidString)", key: "c")
        #expect(store.load() == 0, "never synced must read as 0, the correct first cursor")
        store.save(4_294_967_296)   // > UInt32, to catch a 32-bit truncation
        #expect(store.load() == 4_294_967_296)
    }
}
