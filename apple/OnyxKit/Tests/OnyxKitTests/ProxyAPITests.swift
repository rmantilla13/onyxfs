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

    /// How far apart the copy's key frames are is the server's to say, with
    /// the rest of the rendition; two seconds from one that does not.
    @Test func aClaimsSpecSaysHowFarApartKeyFramesAre() throws {
        func spec(_ body: String) throws -> ProxySpec {
            let json = #"{"fileId":"f1","name":"a.mov","downloadUrl":"https://s/a","uploadUrl":"https://s/b","spec":"#
                + body + "}"
            return try JSONDecoder().decode(ProxyClaim.self, from: Data(json.utf8)).spec
        }
        #expect(try spec(#"{"height":1080,"maxrateKbps":6000,"audioKbps":128,"keyframeSeconds":1}"#).keyframeSeconds == 1)
        #expect(try spec(#"{"height":1080,"maxrateKbps":6000,"audioKbps":128}"#).keyframeSeconds == 2, "a server from before")
        for odd in ["0", "-2", "3600", "\"soon\"", "null"] {
            #expect(try spec(#"{"height":1080,"keyframeSeconds":"# + odd + "}").keyframeSeconds == 2, "\(odd)")
        }
    }

    /// On battery or in Low Power Mode a Mac takes only what the size rule
    /// asks for; a smaller video, there for its codec, waits for power.
    @Test func aMacSavingPowerTakesOnlyTheJobsTheSizeRuleAsksFor() {
        let small: Int64 = 150 << 20
        #expect(ProxyRule.takesNow(size: small, savingPower: false))
        #expect(!ProxyRule.takesNow(size: small, savingPower: true))
        #expect(ProxyRule.takesNow(size: ProxyRule.minBytes, savingPower: true))
        #expect(ProxyRule.takesNow(size: 40 << 30, savingPower: true))
        #expect(ProxyRule.takesNow(size: nil, savingPower: true), "a size not said: taken, as every job was")
    }

    /// A Mac saving power asks for the large jobs alone, so the server can
    /// leave the rest out before the page is cut (app/api/proxies/queue).
    @Test func aMacSavingPowerAsksTheQueueForTheLargeJobsAlone() {
        let config = OnyxConfig(baseURL: URL(string: "https://onyx.example.com")!)
        #expect(OnyxAPI.proxyQueueURL(config, largeOnly: true).absoluteString == "https://onyx.example.com/api/proxies/queue?large=1")
        #expect(OnyxAPI.proxyQueueURL(config, largeOnly: false).absoluteString == "https://onyx.example.com/api/proxies/queue")
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

    /// And by what it is encoded as, at any size: lib/proxies.js shouldProxy
    /// over playsInEveryBrowser. A codec not known leaves the size to decide.
    @Test func theServerAsksForAProxyOfAVideoSomeBrowserWillNotPlayWhateverItsSize() {
        let big = ProxyRule.minBytes
        let small: Int64 = 150 << 20
        let hdr = VideoCodec(fourcc: "hvc1", bitDepth: 10, chroma: "4:2:0", hdr: true)
        let sdr = VideoCodec(fourcc: "hvc1", bitDepth: 8, chroma: "4:2:0", hdr: false)
        let prores = VideoCodec(fourcc: "apcn")
        let xavc = VideoCodec(fourcc: "avc1", bitDepth: 10, chroma: "4:2:2")
        let h264 = VideoCodec(fourcc: "avc1", bitDepth: 8, chroma: "4:2:0", hdr: false)
        let rows: [(name: String, mime: String?, size: Int64, codec: VideoCodec?, asked: Bool)] = [
            ("IMG_0042.MOV", "video/quicktime", small, hdr, true),
            ("IMG_0042.MOV", "video/quicktime", 1 << 20, hdr, true),
            ("DJI_0001.MP4", "video/mp4", small, sdr, true),
            ("A001_C002.mov", "video/quicktime", small, prores, true),
            ("C0001.MP4", "video/mp4", small, xavc, true),
            ("Export.mp4", "video/mp4", small, h264, false),           // every browser plays it
            ("Export.mp4", "video/mp4", big, h264, true),              // and it is big
            ("Before.mov", "video/quicktime", small, nil, false),      // not known: its size decides
            ("Before.mov", "video/quicktime", big, nil, true),
            ("still.heic", "image/heic", small, hdr, false),           // not a video, whatever it says
        ]
        for row in rows {
            #expect(ProxyRule.asksForProxy(name: row.name, mime: row.mime, size: row.size, codec: row.codec) == row.asked,
                    "\(row.name) \(row.size) \(String(describing: row.codec))")
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
