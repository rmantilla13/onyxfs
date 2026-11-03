import OnyxKit
import SwiftUI

/// Moving and deleting what is selected in a folder — several folders, and
/// any files picked with them — as the web does (lib/bulk-items.js): each
/// folder through the routes one folder takes (PATCH and DELETE
/// /api/files/folders), one after another, the files a few at a time, and
/// one sentence on how it went. The arithmetic and the words are OnyxKit's
/// BulkPlan; the server checks every change again.
@MainActor
enum BulkActions {
    /// How it went: what to say, and whether any of it failed.
    struct Outcome: Error {
        let message: String
        let failed: Bool
    }

    /// The drive's id for the write routes; nil for All Files.
    static func filespaceId(_ place: Place) -> String? {
        if case let .drive(id) = place.scope { return id }
        return nil
    }

    /// Whether this account may move and delete folders here: as Tags &
    /// Metadata is offered, anyone but a viewer of the drive. The server
    /// decides again.
    static func mayChangeFolders(in place: Place) -> Bool { place.role != "viewer" }

    static func move(folders: [String], files: [FileItem], to destination: String,
                     in place: Place, session: Session) async -> Outcome? {
        let plan = BulkPlan.planMove(folders, to: destination)
        let whereTo = destination.isEmpty ? place.name : BulkPlan.name(of: destination)
        if let inside = plan.into.first {
            return Outcome(message: "“\(BulkPlan.name(of: inside))” can't go into itself.", failed: true)
        }
        let fs = filespaceId(place)
        var moved = 0
        var problems: [String] = []
        for path in plan.move {
            let to = destination.isEmpty ? BulkPlan.name(of: path) : "\(destination)/\(BulkPlan.name(of: path))"
            do {
                try await session.api.moveFolderResumably(from: path, to: to, filespaceId: fs)
                moved += 1
            } catch {
                problems.append(sentence("“\(BulkPlan.name(of: path))” couldn't be moved: \(session.explain(error))"))
            }
        }
        let fileMoves = files.filter { $0.folder != destination }
        let api = session.api
        let failedFiles = await each(fileMoves) { try await api.updateFile(id: $0.id, folder: destination, filespaceId: fs) }
        if failedFiles.count > 0, let first = failedFiles.first {
            problems.append(sentence("\(failedFiles.count) of \(fileMoves.count) files couldn't be moved: \(session.explain(first))"))
        }
        await session.reloadStars()
        let done = BulkPlan.movedWords(folders: (moved, plan.move.count),
                                       files: (fileMoves.count - failedFiles.count, fileMoves.count), to: whereTo)
        let words = ([done].compactMap { $0 } + problems).joined(separator: " ")
        return words.isEmpty ? nil : Outcome(message: words, failed: !problems.isEmpty)
    }

    /// What a delete of `folders` would take, asked of them together; nil
    /// with the reason when any of them can't be read — then nothing goes.
    static func summaries(of folders: [String], in place: Place, session: Session) async -> Result<[BulkPlan.Summary], Outcome> {
        let fs = filespaceId(place)
        let api = session.api
        do {
            let list = try await withThrowingTaskGroup(of: (Int, BulkPlan.Summary).self) { group in
                for (i, path) in folders.enumerated() {
                    group.addTask { (i, try await api.folderSummary(path: path, filespaceId: fs)) }
                }
                var out = [BulkPlan.Summary](repeating: .init(), count: folders.count)
                for try await (i, s) in group { out[i] = s }
                return out
            }
            return .success(list)
        } catch {
            return .failure(Outcome(message: sentence("Nothing was deleted. \(session.explain(error))"), failed: true))
        }
    }

    static func delete(folders: [String], files: [FileItem], in place: Place, session: Session) async -> Outcome? {
        let fs = filespaceId(place)
        var gone = 0
        var problems: [String] = []
        for path in folders {
            do {
                try await session.api.deleteFolder(path: path, filespaceId: fs)
                gone += 1
            } catch {
                problems.append(sentence("“\(BulkPlan.name(of: path))” couldn't be deleted: \(session.explain(error))"))
            }
        }
        let api = session.api
        let failedFiles = await each(files) { try await api.deleteFile(id: $0.id) }
        if !failedFiles.isEmpty { problems.append("\(failedFiles.count) of \(files.count) files couldn't be deleted.") }
        await session.reloadStars()
        let done = BulkPlan.deletedWords(folders: (gone, folders.count), files: files.count - failedFiles.count)
        let words = ([done].compactMap { $0 } + problems).joined(separator: " ")
        return words.isEmpty ? nil : Outcome(message: words, failed: !problems.isEmpty)
    }

    /// `work` for each file, four at a time; the errors of those that failed.
    private static func each(_ files: [FileItem], _ work: @escaping @Sendable (FileItem) async throws -> Void) async -> [Error] {
        await withTaskGroup(of: Error?.self) { group in
            var errors: [Error] = []
            var next = 0
            func add() {
                guard next < files.count else { return }
                let f = files[next]
                next += 1
                group.addTask { do { try await work(f); return nil } catch { return error } }
            }
            for _ in 0..<4 { add() }
            while let result = await group.next() {
                if let result { errors.append(result) }
                add()
            }
            return errors
        }
    }

    private static func sentence(_ s: String) -> String {
        s.hasSuffix(".") || s.hasSuffix("!") || s.hasSuffix("?") ? s : s + "."
    }
}

/// Where a selection moves: every folder of the drive but those moving (and
/// what is in them), the one they are in shown as where they are.
struct MoveDestinationSheet: View {
    let place: Place
    let title: String
    let moving: [String]
    let current: String
    let chosen: (String) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var tree: [FolderNode] = []
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                row(path: "", name: place.name, depth: 0)
                ForEach(shown) { node in
                    row(path: node.folder, name: query.isEmpty ? node.name : node.folder, depth: query.isEmpty ? node.depth : 0)
                }
            }
            .searchable(text: $query, prompt: "Find a folder")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { tree = (try? await session.folders(in: place)) ?? [] }
        }
    }

    private var shown: [FolderNode] {
        tree.filter { node in
            !moving.contains { BulkPlan.isWithin(node.folder, $0) }
                && (query.isEmpty || node.folder.localizedCaseInsensitiveContains(query))
        }
        .sorted { $0.folder.localizedStandardCompare($1.folder) == .orderedAscending }
    }

    private func row(path: String, name: String, depth: Int) -> some View {
        Button {
            dismiss()
            chosen(path)
        } label: {
            HStack {
                FolderGlyph(tint: place.tint, size: 22)
                Text(name).lineLimit(1)
                Spacer()
                if path == current { Text("Current").font(.caption).foregroundStyle(.secondary) }
            }
            .padding(.leading, CGFloat(max(0, depth - 1)) * 16)
        }
        .disabled(path == current)
    }
}
