import Foundation
import Testing
@testable import OnyxKit

/// The mirror, pretend: a map of paths, and a count of refreshes.
private actor FakeTree: DriveTree {
    var items: [String: DriveItem] = [:]
    var refreshes = 0
    func item(at path: String) async -> DriveItem? { items[path] }
    func refresh() async { refreshes += 1 }
    func set(_ path: String, _ item: DriveItem?) { items[path] = item }
}

/// The server's write routes, pretend: what was called, and a refusal on command.
private actor FakeRoutes: DriveWriteAPI {
    var calls: [String] = []
    var refuse: [String: OnyxError] = [:]
    func log(_ call: String) throws {
        calls.append(call)
        if let error = refuse.removeValue(forKey: call) { throw error }
    }
    func setRefusal(_ call: String, _ error: OnyxError) { refuse[call] = error }
    func updateFile(id: String, name: String?, folder: String?, filespaceId: String?) async throws {
        try log("update \(id) name=\(name ?? "-") folder=\(folder ?? "-")")
    }
    func deleteFile(id: String) async throws { try log("delete \(id)") }
    func createFolder(path: String, filespaceId: String?) async throws { try log("mkdir \(path)") }
    func moveFolder(from: String, to: String, filespaceId: String?) async throws { try log("mvdir \(from) -> \(to)") }
    func deleteFolder(path: String, filespaceId: String?) async throws { try log("rmdir \(path)") }
}

private func writer(_ tree: FakeTree, _ routes: FakeRoutes, _ server: FakeServer, gate: Gate? = nil) throws -> (DriveWriter, UploadQueue) {
    let queue = try UploadQueue(directory: scratch(), transport: server, sleep: { _ in await gate?.wait() })
    return (DriveWriter(scope: "drive.d1", filespaceId: "d1", api: routes, tree: tree, uploads: queue), queue)
}

@Suite struct DriveWriterTests {
    @Test func aCopiedFileIsListedAtOnceAndLeavesPendingOnceTheMirrorHasIt() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet)) // hold it pending a moment
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        let seen = await queue
        await seen.observe { job in Task { await drive.uploadChanged(job) } }

        let entry = try await drive.putFile(path: "/Footage/Take 1.mov", from: try source(Data("frames".utf8)))
        #expect(entry.size == 6)
        #expect(await drive.pending(at: "/Footage/Take 1.mov") != nil)

        await gate.open()
        await settle(queue)
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(await server.calls.last == "record /Footage/Take 1.mov")
        // Uploaded, but not yet in the mirror: still listed.
        #expect(await drive.pending(at: "/Footage/Take 1.mov") != nil)
        await tree.set("/Footage/Take 1.mov", .file(id: "file-Take 1.mov"))
        await drive.mirrorChanged()
        #expect(await drive.pending(at: "/Footage/Take 1.mov") == nil)
    }

    @Test func savingOverAFileReplacesIt() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/notes.txt", .file(id: "old"))
        let (drive, queue) = try writer(tree, routes, server)
        await queue.observe { job in Task { await drive.uploadChanged(job) } }
        try await drive.putFile(path: "/notes.txt", from: try source(Data("v2".utf8)))
        await settle(queue)
        try await Task.sleep(nanoseconds: 30_000_000)
        // The new copy recorded, then the old one gone (until the server can
        // replace bytes in place).
        #expect(await routes.calls == ["delete old"])
    }

    @Test func renamedOrDeletedWhileUploadingNeverReachesTheServerAsItWas() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await server.setFailure("presign", URLError(.notConnectedToInternet), times: 2)
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        try await drive.putFile(path: "/untitled.txt", from: try source(Data([1])))
        try await drive.putFile(path: "/scratch.txt", from: try source(Data([2])))
        try await drive.rename(from: "/untitled.txt", to: "/Notes/ideas.txt", replace: false)
        try await drive.delete(path: "/scratch.txt")
        #expect(await drive.pending(at: "/Notes/ideas.txt") != nil)
        #expect(await drive.pending(at: "/untitled.txt") == nil)
        await gate.open()
        await settle(queue)
        let calls = await server.calls
        #expect(calls.contains("record /Notes/ideas.txt"))
        #expect(!calls.contains { $0.contains("scratch") })
        #expect(await routes.calls.isEmpty)
    }

    @Test func renamesAndMovesAreTheServersOwn() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/a.mov", .file(id: "f1"))
        await tree.set("/Old", .folder)
        let (drive, _) = try writer(tree, routes, server)
        try await drive.rename(from: "/a.mov", to: "/b.mov", replace: false)
        try await drive.rename(from: "/a.mov", to: "/Cuts/a.mov", replace: false)
        try await drive.rename(from: "/a.mov", to: "/Cuts/final.mov", replace: false)
        try await drive.rename(from: "/Old", to: "/New", replace: false)
        #expect(await routes.calls == [
            "update f1 name=b.mov folder=-",
            "update f1 name=- folder=Cuts",
            "update f1 name=- folder=Cuts", "update f1 name=final.mov folder=-",
            "mvdir Old -> New",
        ])
        #expect(await tree.refreshes == 4)
    }

    @Test func moveOverAnExistingFileOnlyWhenAskedTo() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/draft.doc", .file(id: "new"))
        await tree.set("/final.doc", .file(id: "old"))
        let (drive, _) = try writer(tree, routes, server)
        await #expect(throws: DriveWriter.Failure.posix(EEXIST, nil)) {
            try await drive.rename(from: "/draft.doc", to: "/final.doc", replace: false)
        }
        try await drive.rename(from: "/draft.doc", to: "/final.doc", replace: true)
        #expect(await routes.calls == ["delete old", "update new name=final.doc folder=-"])
    }

    @Test func theServersRefusalIsFindersPermissionError() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/a.mov", .file(id: "f1"))
        await routes.setRefusal("delete f1", OnyxError.http(status: 403, message: "Your role can view files but not delete them."))
        let (drive, _) = try writer(tree, routes, server)
        await #expect(throws: DriveWriter.Failure.posix(EACCES, "Your role can view files but not delete them.")) {
            try await drive.delete(path: "/a.mov")
        }
    }

    @Test func foldersAreMadeOnceAndGoWhole() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        let (drive, _) = try writer(tree, routes, server)
        try await drive.mkdir(path: "/Footage/Day 1")
        await tree.set("/Footage/Day 1", .folder)
        try await drive.mkdir(path: "/Footage/Day 1") // already there: nothing to do
        try await drive.delete(path: "/Footage/Day 1")
        #expect(await routes.calls == ["mkdir Footage/Day 1", "rmdir Footage/Day 1"])
        await tree.set("/a.txt", .file(id: "x"))
        await #expect(throws: DriveWriter.Failure.posix(EEXIST, nil)) { try await drive.mkdir(path: "/a.txt") }
    }

    @Test func pathsAreCheckedBeforeAnythingHappens() throws {
        #expect(throws: DriveWriter.Failure.posix(EINVAL, nil)) { try DriveWriter.split("/a/../b") }
        #expect(throws: DriveWriter.Failure.posix(EINVAL, nil)) { try DriveWriter.split("/") }
        let split = try DriveWriter.split("/Footage/Day 1/Take.mov")
        #expect(split.folder == "Footage/Day 1" && split.name == "Take.mov")
        #expect(DriveWriter.relative("/Footage/Day 1/") == "Footage/Day 1")
    }
}

@Suite struct DriveWriterRaceTests {
    /// Finder deletes (or renames) a file the instant it finished uploading,
    /// before anything told the writer: the change reaches the file it became.
    @Test func aChangeRightAfterTheUploadFinishedReachesTheFile() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        let (drive, queue) = try writer(tree, routes, server)
        try await drive.putFile(path: "/a.txt", from: try source(Data([1])))
        try await drive.putFile(path: "/b.txt", from: try source(Data([2])))
        await settle(queue)
        try await drive.delete(path: "/a.txt")
        try await drive.rename(from: "/b.txt", to: "/c.txt", replace: false)
        #expect(await routes.calls == ["delete file-a.txt", "update file-b.txt name=c.txt folder=-"])
        #expect(await drive.pending(at: "/c.txt") == nil)
    }
}
