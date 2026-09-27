import Foundation
import Testing
@testable import OnyxFSCore

/// The mount URL and the JSON are the contract with the app, which is written
/// separately: each is pinned to the letter.
struct WireTests {
    @Test func aMountURLGivesItsPartsWithoutSpendingTheTicket() throws {
        let url = URL(string: "onyxfs-drive://127.0.0.1:61234/drive.abc-123?ticket=T0k3n_-x&name=Client%20Deliverables%20%26%20Caf%C3%A9&v=1")!
        let resource = try FSMountResource(url: url)
        #expect(resource.host == "127.0.0.1")
        #expect(resource.port == 61234)
        #expect(resource.scope == "drive.abc-123")
        #expect(resource.ticket == "T0k3n_-x")
        #expect(resource.name == "Client Deliverables & Café")
        #expect(resource.bridgeURL.absoluteString == "http://127.0.0.1:61234")

        let library = try FSMountResource(url: URL(string: "onyxfs-drive://127.0.0.1:9/library?v=1&ticket=t")!)
        #expect(library.scope == "library")
        #expect(library.name == nil)
    }

    @Test(arguments: [
        "onyxfs://127.0.0.1:61234/drive.abc?ticket=t&v=1",           // the sign-in hand-off scheme
        "http://127.0.0.1:61234/drive.abc?ticket=t&v=1",
        "onyxfs-drive://192.168.1.20:61234/drive.abc?ticket=t&v=1",   // not this Mac
        "onyxfs-drive://evil.example:61234/drive.abc?ticket=t&v=1",
        "onyxfs-drive://127.0.0.1/drive.abc?ticket=t&v=1",            // no port
        "onyxfs-drive://127.0.0.1:61234/drive.abc?v=1",               // no ticket
        "onyxfs-drive://127.0.0.1:61234/drive.abc?ticket=&v=1",
        "onyxfs-drive://127.0.0.1:61234/drive.abc?ticket=t",          // no version
        "onyxfs-drive://127.0.0.1:61234/drive.abc?ticket=t&v=2",
        "onyxfs-drive://127.0.0.1:61234/?ticket=t&v=1",               // no scope
        "onyxfs-drive://127.0.0.1:61234/drive.?ticket=t&v=1",
        "onyxfs-drive://127.0.0.1:61234/photos?ticket=t&v=1",
        "onyxfs-drive://127.0.0.1:61234/drive.abc/more?ticket=t&v=1",
    ])
    func whatIsNotAMountIsRefused(_ string: String) {
        #expect(throws: FSBridgeError.self) { try FSMountResource(url: URL(string: string)!) }
    }

    @Test func anEntryDecodesWithAndWithoutPending() throws {
        let file = try JSONDecoder().decode(FSEntry.self, from: Data("""
            { "name": "Take 1.mov", "type": "file", "id": "f1", "size": 123, "mtime": 1790460000.5,
              "version": "abc", "local": false, "pending": true }
            """.utf8))
        #expect(file == FSEntry(name: "Take 1.mov", type: .file, id: "f1", size: 123, mtime: 1_790_460_000.5,
                                version: "abc", local: false, pending: true))
        #expect(file.modified == Date(timeIntervalSince1970: 1_790_460_000.5))

        let folder = try JSONDecoder().decode(FSEntry.self, from: Data("""
            { "name": "Shots", "type": "dir", "id": null, "size": 0, "mtime": 0, "version": "h", "local": false }
            """.utf8))
        #expect(folder.isDirectory && folder.id == nil && folder.pending == false)

        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(FSEntry.self, from: Data(#"{ "name": "x", "type": "symlink" }"#.utf8))
        }
    }

    @Test func aVolumeOfUnknownSizeNeverLooksFull() throws {
        let volume = try JSONDecoder().decode(FSVolumeInfo.self, from: Data("""
            { "scope": "drive.abc", "name": "Client Deliverables", "readOnly": true, "totalBytes": 0,
              "usedBytes": 123456, "fileCount": 1234 }
            """.utf8))
        #expect(volume.capacityBytes == 123_456 + (8 << 40))
        #expect(volume.freeBytes == 8 << 40)

        let sized = FSVolumeInfo(scope: "library", name: "Library", readOnly: false, totalBytes: 1000, usedBytes: 400)
        #expect(sized.capacityBytes == 1000 && sized.freeBytes == 600)

        // A drive that does not say it may be written to mounts read-only.
        let silent = try JSONDecoder().decode(FSVolumeInfo.self, from: Data(#"{ "scope": "library", "name": "L" }"#.utf8))
        #expect(silent.readOnly)
    }

    @Test func changesAndSourcesDecode() throws {
        let changes = try JSONDecoder().decode(FSChanges.self, from: Data(
            #"{ "generation": 43, "all": false, "paths": ["/a/b", "/"] }"#.utf8))
        #expect(changes == FSChanges(generation: 43, all: false, paths: ["/a/b", "/"]))

        let remote = try JSONDecoder().decode(FSSource.self, from: Data(#"""
            { "kind": "remote", "url": "https://bucket.s3.example/k/Take%201.mov?X-Amz-Signature=abc",
              "expiresAt": 1790460900, "size": 123, "version": "v" }
            """#.utf8))
        #expect(remote.kind == .remote && remote.expiresAt == 1_790_460_900 && remote.url?.host == "bucket.s3.example")
        let local = try JSONDecoder().decode(FSSource.self, from: Data(
            #"{ "kind": "local", "size": 123, "version": "v" }"#.utf8))
        #expect(local.kind == .local && local.url == nil)
    }

    @Test func errorsSayWhatTheFileSystemReports() {
        #expect(FSBridgeError.disconnected.posixCode == .ENOTCONN)
        #expect(FSBridgeError.notFound.posixCode == .ENOENT)
        #expect(FSBridgeError.forbidden("no").posixCode == .EACCES)
        #expect(FSBridgeError.conflict("no").posixCode == .EEXIST)
        #expect(FSBridgeError.quotaExceeded("no").posixCode == .EDQUOT)
        #expect(FSBridgeError.invalid("no").posixCode == .EINVAL)
        #expect(FSBridgeError.stale.posixCode == .ESTALE)
        #expect(FSBridgeError.storage(status: 500).posixCode == .EIO)
        #expect(FSBridgeError.network(.timedOut).posixCode == .ETIMEDOUT)
    }
}
