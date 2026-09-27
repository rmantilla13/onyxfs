import Testing
import Foundation
@testable import OnyxKit

/// The write side of the onyxfs bridge: PUT /fs/v1/file, mkdir, rename,
/// DELETE /fs/v1/item — each handed to the drive's writer, and answered
/// with the entry as a listing shows it afterwards.
extension FSBridgeTests {
    /// Takes each change, as DriveWriter would, and shows what it made in
    /// the source's overlay (so the answer can list it).
    actor FakeWriter: FSWriteTarget {
        let source: FakeSource
        var calls: [String] = []
        var refusal: DriveWriter.Failure?
        var nodes: [FSNode] = []

        init(source: FakeSource) { self.source = source }

        func refuseNext(_ failure: DriveWriter.Failure) { refusal = failure }

        private func check() throws {
            if let refusal { self.refusal = nil; throw refusal }
        }

        func write(path: String, from file: URL, modified: Date?) async throws {
            try check()
            let bytes = try Data(contentsOf: file)
            try FileManager.default.removeItem(at: file) // taken, as the upload queue takes it
            calls.append("write \(path) \(bytes.count) \(modified.map { Int($0.timeIntervalSince1970) } ?? 0)")
            let rel = String(path.dropFirst())
            nodes.append(FSNode(path: rel, name: (rel as NSString).lastPathComponent, isFolder: false,
                                fileId: "pending:1", size: Int64(bytes.count), modified: Date(timeIntervalSince1970: 1),
                                content: "p", pending: true, staged: nil))
            await source.show(FSBridgeTests.index(FSBridgeTests.drive, folders: FSBridgeTests.folders),
                              overlay: FSOverlay(nodes: nodes))
        }

        func makeFolder(path: String) async throws {
            try check()
            calls.append("mkdir \(path)")
            await source.show(FSBridgeTests.index(FSBridgeTests.drive, folders: FSBridgeTests.folders + [String(path.dropFirst())]))
        }

        func move(from: String, to: String, replace: Bool) async throws {
            try check()
            calls.append("move \(from) -> \(to)\(replace ? " replace" : "")")
            var items = FSBridgeTests.drive
            if let i = items.firstIndex(where: { "/" + ($0.folder.isEmpty ? "" : $0.folder + "/") + $0.name == from }) {
                let parts = to.split(separator: "/").map(String.init)
                items[i] = FSBridgeTests.item(items[i].id, parts.last!, in: parts.dropLast().joined(separator: "/"))
            }
            await source.show(FSBridgeTests.index(items, folders: FSBridgeTests.folders))
        }

        func remove(path: String) async throws {
            try check()
            calls.append("remove \(path)")
        }
    }

    func writeRig() async throws -> (Rig, FakeWriter) {
        let rig = try await rig()
        let writer = FakeWriter(source: rig.source)
        rig.bridge.setWriter(writer, for: Self.scope)
        return (rig, writer)
    }

    func put(_ rig: Rig, _ path: String, _ bytes: Data, mtime: Int? = nil) async throws -> (DAVResponse, URL) {
        let file = rig.dir.appendingPathComponent("spool-\(UUID().uuidString)")
        try bytes.write(to: file)
        var headers = ["authorization": "Bearer \(rig.key)"]
        if let mtime { headers["x-onyx-mtime"] = String(mtime) }
        let request = DAVRequest(method: "PUT", target: Self.target("file", ["path": path]), headers: headers, bodyFile: file)
        return (await rig.bridge.respond(to: request), file)
    }

    func post(_ rig: Rig, _ endpoint: String, _ body: [String: Any]) async throws -> DAVResponse {
        let data = try JSONSerialization.data(withJSONObject: body)
        return await rig.bridge.respond(to: DAVRequest(method: "POST", target: Self.target(endpoint),
                                                       headers: ["authorization": "Bearer \(rig.key)"], body: data))
    }

    @Test func aFileBodyIsStreamedToDiskOnlyForASession() async throws {
        let (rig, _) = try await writeRig()
        defer { rig.remove() }
        #expect(rig.bridge.admit(method: "PUT", target: "/fs/v1/file?path=%2Fa", authorization: "Bearer \(rig.key)")
                == .acceptFile(maxBytes: FSBridge.maxFileBody))
        #expect(rig.bridge.admit(method: "PUT", target: "/fs/v1/file?path=%2Fa", authorization: "Bearer nope") == .refuse)
        #expect(rig.bridge.admit(method: "POST", target: "/fs/v1/mkdir", authorization: "Bearer \(rig.key)")
                == .accept(maxBody: FSBridge.maxRequestBody))
    }

    @Test func aPutFileIsHandedToTheWriterAndAnsweredAsListed() async throws {
        let (rig, writer) = try await writeRig()
        defer { rig.remove() }
        let (r, body) = try await put(rig, "/Campaigns/new cut.mov", Data(repeating: 7, count: 42), mtime: 1_790_000_000)
        #expect(r.status == 200)
        let entry = try #require(try json(r)["entry"] as? [String: Any])
        #expect(entry["name"] as? String == "new cut.mov")
        #expect(entry["pending"] as? Bool == true)
        #expect(entry["size"] as? Int == 42)
        #expect(await writer.calls == ["write /Campaigns/new cut.mov 42 1790000000"])
        #expect(!FileManager.default.fileExists(atPath: body.path))
    }

    @Test func foldersRenamesAndDeletesGoToTheWriter() async throws {
        let (rig, writer) = try await writeRig()
        defer { rig.remove() }
        let made = try await post(rig, "mkdir", ["path": "/Selects"])
        #expect(made.status == 200)
        #expect(try (json(made)["entry"] as? [String: Any])?["type"] as? String == "dir")
        let moved = try await post(rig, "rename", ["from": "/Readme.md", "to": "/Campaigns/Readme.md", "replace": false])
        #expect(moved.status == 200)
        let gone = await ask(rig, "item", ["path": "/Campaigns/a b.png"], method: "DELETE")
        #expect(gone.status == 200)
        #expect(try json(gone)["ok"] as? Bool == true)
        #expect(await writer.calls == ["mkdir /Selects", "move /Readme.md -> /Campaigns/Readme.md", "remove /Campaigns/a b.png"])
    }

    @Test func aViewersDriveRefusesBeforeTheWriterIsAsked() async throws {
        let (rig, writer) = try await writeRig()
        defer { rig.remove() }
        await rig.source.setInfo(FSVolumeInfo(name: "Client Deliverables", readOnly: true, cacheLimitBytes: 0))
        let (r, body) = try await put(rig, "/x.txt", Data([1]))
        #expect(r.status == 403)
        #expect(await writer.calls.isEmpty)
        // The body that was never taken is not left behind.
        #expect(!FileManager.default.fileExists(atPath: body.path))
        // No writer at all (the account's queue is not open): the same.
        rig.bridge.setWriter(nil, for: Self.scope)
        await rig.source.setInfo(FSVolumeInfo(name: "Client Deliverables", readOnly: false, cacheLimitBytes: 0))
        #expect(try await post(rig, "mkdir", ["path": "/Selects"]).status == 403)
    }

    @Test func theServersRefusalComesBackWithItsWords() async throws {
        let (rig, writer) = try await writeRig()
        defer { rig.remove() }
        await writer.refuseNext(.posix(EACCES, "Your role can view files but not delete them."))
        let refused = await ask(rig, "item", ["path": "/Readme.md"], method: "DELETE")
        #expect(refused.status == 403)
        #expect(try json(refused)["error"] as? String == "Your role can view files but not delete them.")
        await writer.refuseNext(.posix(EEXIST, nil))
        #expect(try await post(rig, "rename", ["from": "/Readme.md", "to": "/Pinned.bin"]).status == 409)
        await writer.refuseNext(.posix(ENOENT, nil))
        #expect(try await post(rig, "rename", ["from": "/nope", "to": "/also-nope"]).status == 404)
    }

    @Test func eachWriteRouteTakesOneMethod() async throws {
        let (rig, _) = try await writeRig()
        defer { rig.remove() }
        #expect(await ask(rig, "file", ["path": "/x"]).status == 405)
        #expect(await ask(rig, "mkdir").status == 405)
        #expect(await ask(rig, "item", ["path": "/x"], method: "POST").status == 405)
        #expect(try await post(rig, "rename", ["from": "/Readme.md"]).status == 400)
    }
}
