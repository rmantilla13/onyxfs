import FileProvider
import OnyxKit
import os

/// The replicated File Provider extension, shared by macOS and iOS: one
/// instance per Finder location (a drive, or the library).
///
/// Milestone 5.2 — read-only: the location's tree, and each file's bytes
/// downloaded when it is opened. Writes wait for the conflict policy (5.5).
///
/// Each instance knows its drive only from its domain's identifier
/// (SyncDomain), and asks the server for that drive's changes alone, judged
/// by the same access rule as the web (/api/files/delta).
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    let domain: NSFileProviderDomain
    let api: OnyxAPI
    let engine: SyncEngine
    let log = Logger(subsystem: OnyxIdentifiers.fileProvider, category: "extension")

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        self.api = OnyxAPI()
        self.engine = SyncEngine(domainIdentifier: domain.identifier.rawValue, api: api)
        super.init()
    }

    func invalidate() {}

    // MARK: - Metadata

    func item(for identifier: NSFileProviderItemIdentifier,
              request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let rootName = domain.displayName
        Task {
            // Served from the replica: the system asks for items constantly,
            // and a round trip per stat is what a File Provider avoids.
            let replica = await engine.replica
            if let item = OnyxItem.item(for: identifier, in: replica, rootName: rootName) {
                completionHandler(item, nil)
            } else {
                completionHandler(nil, NSFileProviderError(.noSuchItem))
            }
        }
        return Progress()
    }

    // MARK: - Contents

    func fetchContents(for identifier: NSFileProviderItemIdentifier,
                       version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        Task {
            guard let file = await engine.replica.file(id: identifier.rawValue) else {
                completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
                return
            }
            do {
                // A fresh link for each open, checked against the same rule as
                // the web's detail view. Presigned links expire; one kept from
                // the delta would be dead by the time a file is opened.
                let link = try await api.contentLink(fileId: file.id)
                let temp = try await download(link.url, into: progress)
                completionHandler(temp, OnyxItem.file(file), nil)
            } catch {
                log.error("fetch failed for \(identifier.rawValue, privacy: .public): \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, nil, mapped(error))
            }
        }
        return progress
    }

    /// To a file, never into memory: the extension runs under a tight memory
    /// ceiling and this library is full of multi-gigabyte masters. The task's
    /// own progress is attached, so Finder shows the download as it goes.
    private func download(_ url: URL, into progress: Progress) async throws -> URL {
        let dir = (try? NSFileProviderManager(for: domain)?.temporaryDirectoryURL())
            ?? FileManager.default.temporaryDirectory
        return try await withCheckedThrowingContinuation { continuation in
            let task = URLSession.shared.downloadTask(with: url) { temp, response, error in
                if let error { continuation.resume(throwing: error); return }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard let temp, (200..<300).contains(status) else {
                    continuation.resume(throwing: OnyxError.http(status: status, message: "The storage refused the download."))
                    return
                }
                // The session deletes its file when this handler returns, so
                // it is moved somewhere the system can take it from.
                let kept = dir.appendingPathComponent(UUID().uuidString)
                do {
                    try FileManager.default.moveItem(at: temp, to: kept)
                    continuation.resume(returning: kept)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
            progress.addChild(task.progress, withPendingUnitCount: 100)
            task.resume()
        }
    }

    // MARK: - Writes (not yet)

    // Every item is read-only in its capabilities, so Finder does not offer
    // these. If the system asks anyway, the answer is "no permission": it
    // stops there, rather than retrying or treating the file as handed over.
    private var readOnly: Error { CocoaError(.fileWriteNoPermission) }

    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields,
                    contents url: URL?, options: NSFileProviderCreateItemOptions,
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        completionHandler(nil, [], false, readOnly)
        return Progress()
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion,
                    changedFields: NSFileProviderItemFields, contents newContents: URL?,
                    options: NSFileProviderModifyItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        completionHandler(nil, [], false, readOnly)
        return Progress()
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        completionHandler(readOnly)
        return Progress()
    }

    // MARK: - Enumeration

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                    request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        // No token: say so, which Finder shows as "Sign in", rather than
        // present an empty drive, which reads as "my files are gone".
        guard api.hasCredentials else { throw NSFileProviderError(.notAuthenticated) }
        let name = domain.displayName
        switch containerItemIdentifier {
        case .workingSet:
            return WorkingSetEnumerator(engine: engine, rootName: name)
        case .rootContainer:
            return FolderEnumerator(path: "", engine: engine, rootName: name)
        case .trashContainer:
            return FolderEnumerator(path: "\u{0}trash", engine: engine, rootName: name) // always empty
        default:
            guard let path = Replica.folderPath(ofID: containerItemIdentifier.rawValue) else {
                throw NSFileProviderError(.noSuchItem)
            }
            return FolderEnumerator(path: path, engine: engine, rootName: name)
        }
    }
}
