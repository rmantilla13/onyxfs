import Foundation
import Testing
@testable import OnyxKit

// Finder's writes against a running server: the real mirror of a real drive,
// the writer the bridge hands Finder's changes to, and the server's own
// routes. DriveWriterTests fakes the server; this is the check that the two
// agree about names — above all about a folder the mirror shows under a
// name of its own ("photos (2)" beside "Photos"), whose changes must reach
// the server's "photos".
//
// Off unless pointed at a server, which it writes to:
//
//   ONYX_LIVE_SERVER   the server, e.g. http://localhost:3000 (npm run dev:local)
//   ONYX_LIVE_TOKEN    a device token: a code from /space/pair, redeemed at
//                      POST /api/desktop/token {"grant_type":"pairing_code"}
//   ONYX_LIVE_DRIVE    the id of a drive that account may change
//
// Everything it makes is under one folder named for the run, deleted at the
// end. The token is kept in a Keychain item of the run's own, removed too.

private enum Live {
    static let env = ProcessInfo.processInfo.environment
    static var configured: Bool {
        ["ONYX_LIVE_SERVER", "ONYX_LIVE_TOKEN", "ONYX_LIVE_DRIVE"].allSatisfy { !(env[$0] ?? "").isEmpty }
    }
}

@Suite(.serialized, .enabled(if: Live.configured))
struct LiveServerTests {
    @Test func aFolderShownUnderANameOfItsOwnIsChangedOnTheServerUnderItsOwn() async throws {
        let server = try #require(URL(string: Live.env["ONYX_LIVE_SERVER"] ?? ""))
        let drive = Live.env["ONYX_LIVE_DRIVE"] ?? ""
        let tokens = TokenStore(service: "io.onyxfs.live-test.\(UUID().uuidString)", accessGroup: nil)
        try tokens.set(Live.env["ONYX_LIVE_TOKEN"])
        defer { tokens.clear() }
        let api = OnyxAPI(config: OnyxConfig(baseURL: server), tokens: tokens)
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("onyx-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: scratch) }

        // What this account may do, as the server says it now (#60).
        let listing = try await api.drives()
        let mine = try #require(listing.drives.first { $0.id == drive }, "not a drive this account may open")
        #expect(mine.can != nil, "the server says what this account may do in the drive")
        #expect(mine.mayAddFiles, "the drive's disk would mount read-only")
        #expect(listing.library != nil, "the server says what this account may do in the library")

        // Two folders the server keeps apart and a Mac cannot: they differ
        // only in case.
        let top = "live-\(UUID().uuidString.prefix(8).lowercased())"
        try await api.createFolder(path: "\(top)/Photos", filespaceId: drive)
        try await api.createFolder(path: "\(top)/photos", filespaceId: drive)
        do {
            try await changeTheTwin(api: api, server: server, drive: drive, account: listing.email ?? "live",
                                    top: top, scratch: scratch)
        } catch {
            try? await api.deleteFolder(path: top, filespaceId: drive)
            throw error
        }
        try await api.deleteFolder(path: top, filespaceId: drive)
        let left = try await api.folders(in: .drive(id: drive)).map(\.folder)
        #expect(!left.contains { $0 == top || $0.hasPrefix(top + "/") }, "the run's folder is gone")
    }

    private func changeTheTwin(api: OnyxAPI, server: URL, drive: String, account: String,
                               top: String, scratch: URL) async throws {
        let mirror = DriveMirror(scope: .drive(id: drive), directory: scratch.appendingPathComponent("mirror"),
                                 server: server, account: account, api: { api })
        _ = try await mirror.sync()
        let shown = try #require(await mirror.index.children(of: top))
        #expect(shown.count == 2, "both folders are in the mirror")
        // One is shown under a name of its own, and keeps the server's.
        let twin = try #require(shown.first { $0.name.hasSuffix(" (2)") }, "no folder shown as \" (2)\"")
        let serverPath = twin.apiPath
        #expect(serverPath != twin.path)
        #expect(serverPath.lowercased() == "\(top)/photos")

        let uploads = try UploadQueue(directory: scratch.appendingPathComponent("uploads"),
                                      transport: APIUploadTransport(api: api), settle: 0)
        let tree = MirrorTree(mirror: mirror) { _ = try? await mirror.sync() }
        let writer = DriveWriter(scope: SyncDomain.drive(id: drive).identifier, filespaceId: drive,
                                 api: api, tree: tree, uploads: uploads)
        await uploads.observe { job in Task { await writer.uploadChanged(job) } }

        func serverFolders() async throws -> [String: Int] {
            Dictionary(try await api.folders(in: .drive(id: drive)).map { ($0.folder, $0.count) },
                       uniquingKeysWith: { first, _ in first })
        }
        // As Finder names it: "/live-…/photos (2)".
        let finder = "/" + twin.path

        // A folder made in it is made in the server's folder…
        try await writer.mkdir(path: "\(finder)/Made Here")
        var folders = try await serverFolders()
        #expect(folders["\(serverPath)/Made Here"] != nil)
        #expect(folders[twin.path] == nil, "a folder the server did not have was made")

        // …renamed there…
        try await writer.rename(from: "\(finder)/Made Here", to: "\(finder)/Renamed", replace: false)
        folders = try await serverFolders()
        #expect(folders["\(serverPath)/Renamed"] != nil)
        #expect(folders["\(serverPath)/Made Here"] == nil)

        // …a file copied in lands in it…
        let source = scratch.appendingPathComponent("hello.txt")
        try Data("hello from LiveServerTests\n".utf8).write(to: source)
        let pending = try await writer.putFile(path: "\(finder)/hello.txt", from: source)
        await uploads.resume()
        let deadline = Date().addingTimeInterval(60)
        while await uploads.job(pending.job)?.state != .done {
            if let job = await uploads.job(pending.job), job.state == .failed {
                Issue.record("the upload failed: \(job.lastError ?? "no reason given")")
                return
            }
            guard Date() < deadline else { Issue.record("the upload never finished"); return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        folders = try await serverFolders()
        #expect(folders[serverPath] == 1, "the file is not in the server's folder")

        // …and deleting a folder in it deletes the server's.
        try await writer.delete(path: "\(finder)/Renamed")
        folders = try await serverFolders()
        #expect(folders["\(serverPath)/Renamed"] == nil)
    }
}
