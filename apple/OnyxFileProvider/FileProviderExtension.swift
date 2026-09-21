import FileProvider
import OnyxKit
import os

/// The replicated File Provider extension, shared by macOS and iOS.
///
/// This is milestone 5.2: READ-ONLY enumeration and materialise-on-open. It
/// deliberately does not implement item creation or modification yet — the
/// enumeration contract is the hardest thing to change after devices are
/// syncing against it, so it goes first and alone.
///
/// Note what this is NOT for on macOS: editing straight off the drive. A File
/// Provider materialises a file when it is opened, which would stall a 4K
/// timeline mid-scrub. The rclone mount stays the editing path; this exists
/// for Finder and Files.app browsing, on-demand download, and iOS — none of
/// which FUSE can do.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    let domain: NSFileProviderDomain
    let api: OnyxAPI
    let cursors: CursorStore
    let log = Logger(subsystem: OnyxIdentifiers.fileProvider, category: "extension")

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        self.api = OnyxAPI()
        self.cursors = CursorStore()
        super.init()
    }

    func invalidate() {}

    // MARK: - Metadata

    func item(for identifier: NSFileProviderItemIdentifier,
              request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        if identifier == .rootContainer {
            completionHandler(OnyxItem.root, nil)
            return Progress()
        }
        // Served from the local mirror rather than the network: the system
        // asks for items constantly, and a round trip per stat is exactly
        // what a File Provider exists to avoid.
        if let item = ItemStore.shared.item(id: identifier.rawValue) {
            completionHandler(item, nil)
        } else {
            completionHandler(nil, NSFileProviderError(.noSuchItem))
        }
        return Progress()
    }

    // MARK: - Contents

    func fetchContents(for identifier: NSFileProviderItemIdentifier,
                       version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        guard let item = ItemStore.shared.item(id: identifier.rawValue),
              let key = item.storageKey else {
            completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
            return progress
        }

        Task {
            do {
                // Credentials are minted per filespace and cached until they
                // are near expiry; a static key reports no expiry at all and
                // is simply reused (see SpaceCredentials.isExpired).
                let creds = try await CredentialCache.shared.credentials(for: item.filespaceId, api: api)
                guard let host = creds.host else {
                    throw OnyxError.storageUnavailable("This filespace has no S3 endpoint configured.")
                }
                guard let url = SigV4.presignedGET(
                    host: host, path: "/\(creds.bucket)/\(key)",
                    region: creds.region ?? "auto", credentials: creds.sigV4, expiresIn: 3600
                ) else {
                    throw OnyxError.storageUnavailable("Could not sign a URL for this object.")
                }

                // Downloaded to a temporary file, not into memory. The
                // extension has roughly a 50 MB ceiling and this library is
                // full of multi-gigabyte masters; buffering one is not a
                // performance question, it is a crash.
                let (temp, response) = try await URLSession.shared.download(from: url)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(status) else {
                    throw OnyxError.http(status: status, message: "The object store refused the download.")
                }
                completionHandler(temp, item, nil)
            } catch {
                log.error("fetchContents failed for \(identifier.rawValue, privacy: .public): \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, nil, error)
            }
        }
        return progress
    }

    // MARK: - Writes (not yet)

    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields,
                    contents url: URL?, options: NSFileProviderCreateItemOptions,
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        // Refused explicitly rather than silently accepted. A File Provider
        // that accepts a write it cannot perform loses the file: the system
        // considers it handed over and removes its copy.
        completionHandler(nil, [], false, NSFileProviderError(.notAuthenticated))
        return Progress()
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion,
                    changedFields: NSFileProviderItemFields, contents newContents: URL?,
                    options: NSFileProviderModifyItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        completionHandler(nil, [], false, NSFileProviderError(.notAuthenticated))
        return Progress()
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        completionHandler(NSFileProviderError(.notAuthenticated))
        return Progress()
    }

    // MARK: - Enumeration

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                    request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        guard api.hasCredentials else { throw NSFileProviderError(.notAuthenticated) }
        return FileProviderEnumerator(container: containerItemIdentifier, api: api, cursors: cursors)
    }
}
