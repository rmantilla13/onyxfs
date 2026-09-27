import Foundation
import OnyxFSCore

/// Connects a resource URL to its engine: the ticket exchanged with the app
/// for a session, then the drive's engine over it, with its chunk cache,
/// the staging area for files being written, and what macOS keeps on the
/// disk for itself — the drive's icon among it.
@available(macOS 27.0, *)
enum EngineFactory {
    static func connect(_ url: URL) async throws -> any VolumeEngine {
        do {
            let resource = try FSMountResource(url: url)
            let client = try await FSBridgeClient.connect(to: resource)
            let folder = Self.folder(for: resource.scope)
            // Bytes read are a cache (the system may clear it); files being
            // written and macOS's own files are not.
            let store = try ChunkStore(directory: try Self.directory(.cachesDirectory, folder, "chunks"),
                                       limitBytes: client.session.cacheLimitBytes)
            let staging = try StagingArea(directory: try Self.directory(.applicationSupportDirectory, folder, "staging"))
            let local = try LocalStore(directory: try Self.directory(.applicationSupportDirectory, folder, "local"))
            // The drive's icon, on the disk before Finder first looks at it.
            // Without one (the app has none, or it could not be put there) the
            // disk mounts as it would have: an icon is not worth a failed mount.
            if let icon = try? await client.volumeIcon() {
                try? await local.placeVolumeIcon(icon)
            }
            let bridge = ClientBridge(client: client, store: store)
            let volume = bridge.initialVolume
            let engine = DriveEngine(bridge: bridge, volume: volume, staging: staging, local: local)
            return EngineVolume(engine: engine, volume: volume)
        } catch let error as FSBridgeError {
            throw VolumeError.posix(Int32(error.posixCode.rawValue))
        } catch let error as VolumeError {
            throw error
        } catch {
            throw VolumeError.posix(EIO)
        }
    }

    /// One folder per drive, whatever characters its scope has.
    static func folder(for scope: String) -> String {
        let safe = scope.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || "-_.".unicodeScalars.contains($0) ? String($0) : "_" }
        return "onyxfs/" + safe.joined()
    }

    private static func directory(_ base: FileManager.SearchPathDirectory, _ folder: String, _ name: String) throws -> URL {
        let root = try FileManager.default.url(for: base, in: .userDomainMask, appropriateFor: nil, create: true)
        let url = root.appendingPathComponent(folder, isDirectory: true).appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
