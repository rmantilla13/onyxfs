import Foundation
import Testing
@testable import OnyxKit

/// The proxy routes' answers as the server sends them
/// (app/api/proxies/queue, app/api/files/[id]/proxy/claim), and a content
/// link that carries a video's streamable copy.
@Suite struct ProxyAPITests {
    @Test func aClaimCarriesTheSpecAndBothLinks() throws {
        let json = """
        {"fileId":"f1","name":"GX010042.MP4","mime":"video/mp4","size":"4294967296","sourceKey":"files/a/GX010042.MP4",
         "sourceHeight":2160,"spec":{"height":1080,"crf":23,"maxrateKbps":6000,"audioKbps":128,"container":"mp4","mime":"video/mp4"},
         "maxBytes":5368709120,"downloadUrl":"https://s3.example.com/master?sig=1","uploadUrl":"https://s3.example.com/proxy?sig=2",
         "proxyKey":"_proxies/abc.mp4","leaseSeconds":600}
        """
        let claim = try JSONDecoder().decode(ProxyClaim.self, from: Data(json.utf8))
        #expect(claim.size == 4_294_967_296, "a BIGINT that arrives as a string")
        #expect(claim.spec == ProxySpec(height: 1080, maxrateKbps: 6000, audioKbps: 128))
        #expect(claim.maxBytes == 5_368_709_120)
        #expect(claim.uploadUrl.absoluteString == "https://s3.example.com/proxy?sig=2")
        #expect(claim.leaseSeconds == 600)
        #expect(claim.sourceKey == "files/a/GX010042.MP4", "which object the master is")
        #expect(claim.contentHash == nil, "not sent")
    }

    @Test func aClaimWithoutASpecGetsTheServersDefault() throws {
        let json = #"{"fileId":"f1","name":"a.mov","downloadUrl":"https://s/a","uploadUrl":"https://s/b"}"#
        let claim = try JSONDecoder().decode(ProxyClaim.self, from: Data(json.utf8))
        #expect(claim.spec == ProxySpec(height: 1080, maxrateKbps: 6000, audioKbps: 128))
        #expect(claim.maxBytes == nil)
        #expect(claim.sourceKey == nil && claim.contentHash == nil)
    }

    @Test func whatSaysWhichBytesTheMasterIsNeverFailsAClaim() throws {
        // Only a copy on this Mac is checked against them: odd ones mean a
        // download, as before, not a job that cannot start.
        let odd = #"{"fileId":"f1","name":"a.mov","sourceKey":"","contentHash":42,"downloadUrl":"https://s/a","uploadUrl":"https://s/b"}"#
        let claim = try JSONDecoder().decode(ProxyClaim.self, from: Data(odd.utf8))
        #expect(claim.sourceKey == nil && claim.contentHash == nil)
        let hashed = #"{"fileId":"f1","name":"a.mov","contentHash":"9b2cf535f27731c974343645a3985328-4","downloadUrl":"https://s/a","uploadUrl":"https://s/b"}"#
        #expect(try JSONDecoder().decode(ProxyClaim.self, from: Data(hashed.utf8)).contentHash
                == "9b2cf535f27731c974343645a3985328-4")
    }

    /// lib/proxies.js shouldProxy over lib/media.js fileKind, for what this
    /// Mac uploads: each row as the server decides it.
    @Test func theServerAsksForAProxyOfALargeVideo() {
        let big = ProxyRule.minBytes
        let rows: [(name: String, mime: String?, size: Int64, asked: Bool)] = [
            ("GX010042.MP4", "video/mp4", big, true),
            ("A001_C002.mov", "video/quicktime", 40 << 30, true),
            ("clip.mov", nil, big, true),                           // by its name
            ("clip", "video/x-matroska", big, true),                // by its type
            ("clip.webm", "application/octet-stream", big, true),   // the name decides
            ("clip.m4v", "", big, true),
            ("clip.ogv", nil, big, true),
            ("GX010042.MP4", "video/mp4", big - 1, false),          // under PROXY_MIN_BYTES
            ("still.heic", "video/quicktime", big, false),          // an image's extension wins
            ("frame.mov", "image/png", big, false),                 // and an image's type
            ("clip.mkv", nil, big, false),                          // neither says video
            ("sound.wav", "audio/wav", big, false),
        ]
        for row in rows {
            #expect(ProxyRule.asksForProxy(name: row.name, mime: row.mime, size: row.size) == row.asked,
                    "\(row.name) \(row.mime ?? "nil") \(row.size)")
        }
    }

    @Test func theQueueListsJobsWithTheSourcesHeightWhenKnown() throws {
        struct Wrapper: Decodable { let jobs: [ProxyJob] }
        let json = #"{"jobs":[{"fileId":"f1","name":"a.mp4","mime":"video/mp4","size":1073741824,"height":2160,"requestedAt":"2026-09-29T01:00:00Z"},{"fileId":"f2","name":"b.mov","size":"300000000","height":null}]}"#
        let jobs = try JSONDecoder().decode(Wrapper.self, from: Data(json.utf8)).jobs
        #expect(jobs.map(\.fileId) == ["f1", "f2"])
        #expect(jobs[0].height == 2160 && jobs[1].height == nil)
        #expect(jobs[1].size == 300_000_000)
    }

    @Test func conflictsAreToldApartByTheirCode() {
        #expect(ProxyConflict.from(status: 409, data: Data(#"{"code":"taken"}"#.utf8)) == .taken)
        #expect(ProxyConflict.from(status: 409, data: Data(#"{"code":"lost"}"#.utf8)) == .lost)
        #expect(ProxyConflict.from(status: 409, data: Data(#"{"error":"exists"}"#.utf8)) == nil)
        #expect(ProxyConflict.from(status: 404, data: Data(#"{"code":"taken"}"#.utf8)) == nil)
    }

    @Test func aContentLinkMayCarryTheStreamableCopy() throws {
        let with = #"{"id":"f1","url":"https://s/master","proxyUrl":"https://s/proxy","expiresAt":1790000000000,"version":2,"contentHash":null}"#
        #expect(try JSONDecoder().decode(ContentLink.self, from: Data(with.utf8)).proxyUrl?.absoluteString == "https://s/proxy")
        let without = #"{"id":"f1","url":"https://s/master","proxyUrl":null}"#
        #expect(try JSONDecoder().decode(ContentLink.self, from: Data(without.utf8)).proxyUrl == nil)
        let older = #"{"id":"f1","url":"https://s/master"}"#
        #expect(try JSONDecoder().decode(ContentLink.self, from: Data(older.utf8)).proxyUrl == nil, "a server from before")
    }
}
