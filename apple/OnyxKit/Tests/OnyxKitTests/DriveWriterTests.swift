import Foundation
import Testing
@testable import OnyxKit

/// The mirror, pretend: a map of paths, and a count of refreshes.
private actor FakeTree: DriveTree {
    var items: [String: DriveItem] = [:]
    var dates: [String: Date] = [:]
    /// Folders shown under a name of their own: shown path (no leading
    /// slash, as the writer asks) → the server's.
    var serverNames: [String: String] = [:]
    var refreshes = 0
    func item(at path: String) async -> DriveItem? { items[path] }
    func changed(at path: String) async -> Date? { dates[path] }
    func refresh() async { refreshes += 1 }
    func serverPath(at path: String) async -> String? { serverNames[path] }
    func set(_ path: String, _ item: DriveItem?, changed: Date? = nil) {
        items[path] = item
        dates[path] = changed
    }
    func show(_ path: String, as server: String) { serverNames[path] = server }
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
    let queue = try UploadQueue(directory: scratch(), transport: server, settle: 0, sleep: { _ in await gate?.wait() })
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

    /// Saved over: the same file, new bytes — its id, and so its comments,
    /// tags and links on the web, stay. Listed as pending until the mirror
    /// shows the change itself, not merely the file (which it always did).
    @Test func savingOverAFileGivesItNewContents() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/notes.txt", .file(id: "notes"), changed: Date(timeIntervalSince1970: 1))
        let (drive, queue) = try writer(tree, routes, server)
        await queue.observe { job in Task { await drive.uploadChanged(job) } }
        try await drive.putFile(path: "/notes.txt", from: try source(Data("v2".utf8)))
        await settle(queue)
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(await server.calls == ["presign for notes", "put notes.txt", "swap notes <- drive/notes-new"])
        #expect(await routes.calls.isEmpty)
        // The mirror still has the old bytes (changed at 1 s; the swap was at 2 s).
        await drive.mirrorChanged()
        #expect(await drive.pending(at: "/notes.txt") != nil)
        await tree.set("/notes.txt", .file(id: "notes"), changed: Date(timeIntervalSince1970: 2))
        await drive.mirrorChanged()
        #expect(await drive.pending(at: "/notes.txt") == nil)
    }

    /// How apps save: a new copy under a temporary name, moved over the
    /// document. The move comes before anything is sent, so the copy goes
    /// up once — as the document's new contents.
    @Test func anAppsSaveBecomesTheDocumentsNewContents() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/Script.fdx", .file(id: "script"))
        let gate = Gate()
        let queue = try UploadQueue(directory: scratch(), transport: server, settle: 1, sleep: { _ in await gate.wait() })
        let drive = DriveWriter(scope: "drive.d1", filespaceId: "d1", api: routes, tree: tree, uploads: queue)
        try await drive.putFile(path: "/.Script.fdx.sb-1a2b", from: try source(Data("draft 2".utf8)))
        try await drive.rename(from: "/.Script.fdx.sb-1a2b", to: "/Script.fdx", replace: true)
        #expect(await drive.pending(at: "/Script.fdx")?.replaceOf == "script")
        await gate.open()
        await settle(queue)
        #expect(await server.calls == ["presign for script", "put Script.fdx", "swap script <- drive/script-new"])
        #expect(await routes.calls.isEmpty) // nothing deleted, nothing renamed
    }

    /// Moved over the document after its bytes had started up as a new
    /// file: it starts again as the document's contents — the key a new
    /// file was given cannot be swapped into another.
    @Test func aSaveMovedOverTheDocumentLateStartsAgainAsItsContents() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/Script.fdx", .file(id: "script"))
        await server.setFailure("record /.tmp-save", URLError(.networkConnectionLost), times: 50)
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        try await drive.putFile(path: "/.tmp-save", from: try source(Data("draft 2".utf8)))
        var tries = 0
        while await !server.calls.contains("record /.tmp-save"), tries < 500 {
            tries += 1
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        try await drive.rename(from: "/.tmp-save", to: "/Script.fdx", replace: true)
        await gate.open()
        await settle(queue)
        let calls = await server.calls
        #expect(calls.suffix(3) == ["presign for script", "put Script.fdx", "swap script <- drive/script-new"])
        #expect(await routes.calls.isEmpty)
    }

    /// Deleted in Finder while its new contents were on their way: the file
    /// goes on the server too, or its old contents would come back.
    @Test func deletingAFileMidSaveDeletesIt() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/notes.txt", .file(id: "notes"))
        await server.setFailure("presign for notes", URLError(.notConnectedToInternet))
        let gate = Gate()
        let (drive, queue) = try writer(tree, routes, server, gate: gate)
        try await drive.putFile(path: "/notes.txt", from: try source(Data("v2".utf8)))
        try await drive.delete(path: "/notes.txt")
        await gate.open()
        await settle(queue)
        #expect(await routes.calls == ["delete notes"])
        #expect(await server.calls.filter { $0.hasPrefix("swap") }.isEmpty)
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
        // The mirror is brought up to date before the bridge reads the new
        // folder's entry back from it.
        #expect(await tree.refreshes == 1)
        await tree.set("/Footage/Day 1", .folder)
        try await drive.mkdir(path: "/Footage/Day 1") // already there: nothing to do
        #expect(await tree.refreshes == 1)
        try await drive.delete(path: "/Footage/Day 1")
        #expect(await routes.calls == ["mkdir Footage/Day 1", "rmdir Footage/Day 1"])
        await tree.set("/a.txt", .file(id: "x"))
        await #expect(throws: DriveWriter.Failure.posix(EEXIST, nil)) { try await drive.mkdir(path: "/a.txt") }
    }

    /// A folder the mirror shows under a name of its own — "photos (2)"
    /// beside "Photos", which the server keeps apart — is changed by the
    /// server's name for it, and so is what is made or moved into it.
    @Test func aFolderShownUnderANameOfItsOwnIsChangedByTheServersName() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/photos (2)", .folder)
        await tree.show("photos (2)", as: "photos")
        await tree.set("/x.jpg", .file(id: "x"))
        let (drive, _) = try writer(tree, routes, server)
        try await drive.mkdir(path: "/photos (2)/New")
        try await drive.rename(from: "/x.jpg", to: "/photos (2)/x.jpg", replace: false)
        try await drive.rename(from: "/photos (2)", to: "/Old", replace: false)
        try await drive.delete(path: "/photos (2)")
        #expect(await routes.calls == [
            "mkdir photos/New", "update x name=- folder=photos", "mvdir photos -> Old", "rmdir photos",
        ])
    }

    /// The server refuses to delete a folder holding files this account
    /// cannot see, and deletes nothing: Finder is told it is not empty.
    @Test func aFolderWithFilesNotShownHereIsNotEmpty() async throws {
        let tree = FakeTree(), routes = FakeRoutes(), server = FakeServer()
        await tree.set("/Shared", .folder)
        await routes.setRefusal("rmdir Shared", OnyxError.http(status: 409, message: "“Shared” holds 1 file you cannot see."))
        let (drive, _) = try writer(tree, routes, server)
        await #expect(throws: DriveWriter.Failure.posix(ENOTEMPTY, "“Shared” holds 1 file you cannot see.")) {
            try await drive.delete(path: "/Shared")
        }
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
