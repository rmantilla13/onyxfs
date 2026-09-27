import CryptoKit
import FSKit
import Foundation
import OnyxFSCore

/// The extension's entry: FSKit asks it to recognise a resource and to load
/// it as a volume.
@available(macOS 27.0, *)
struct OnyxFSExtension: UnaryFileSystemExtension {
    let fileSystem = OnyxFileSystem()
}

/// One drive per process: the resource is
/// `onyxfs-drive://127.0.0.1:<port>/<drive>?ticket=…&name=…&v=1`
/// (apple/ONYXFS.md). Not `onyxfs:` — that is the app's sign-in hand-off
/// scheme, registered with the system, and must not be reused.
/// Probing only reads the URL — the ticket works once, and is kept for the
/// load — and loading exchanges it with the app for this volume's session.
@available(macOS 27.0, *)
final class OnyxFileSystem: FSUnaryFileSystem, FSUnaryFileSystemOperations, @unchecked Sendable {
    private var volume: OnyxVolume?

    func probeResource(resource: FSResource) async throws -> FSProbeResult {
        guard let url = (resource as? FSGenericURLResource)?.url, let parts = OnyxResource(url) else {
            return .notRecognized
        }
        return .usable(name: parts.name, containerID: FSContainerIdentifier(uuid: parts.uuid))
    }

    func loadResource(resource: FSResource, options: FSTaskOptions) async throws -> FSVolume {
        guard let url = (resource as? FSGenericURLResource)?.url, let parts = OnyxResource(url) else {
            throw fs_errorForPOSIXError(EINVAL)
        }
        let engine: any VolumeEngine
        do {
            engine = try await EngineFactory.connect(url)
        } catch let VolumeError.posix(code) {
            throw fs_errorForPOSIXError(code)
        }
        let volume = OnyxVolume(engine: engine, volumeID: FSVolume.Identifier(uuid: parts.uuid))
        self.volume = volume
        containerStatus = .ready
        return volume
    }

    func unloadResource(resource: FSResource, options: FSTaskOptions) async throws {
        await volume?.engine.shutdown()
        volume = nil
    }
}

/// The parts of a resource URL the file system needs before it connects.
struct OnyxResource {
    let scope: String
    let name: String

    init?(_ url: URL) {
        guard url.scheme?.lowercased() == "onyxfs-drive",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let scope = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !scope.isEmpty else { return nil }
        self.scope = scope
        name = components.queryItems?.first { $0.name == "name" }?.value.flatMap { $0.isEmpty ? nil : $0 } ?? scope
    }

    /// The same drive is the same container and volume every time it is
    /// mounted, whichever ticket brought it — and a different one in Onyx
    /// Dev, whose disk of the same drive may be mounted beside it.
    var uuid: UUID {
        var bytes = Array(SHA256.hash(data: Data("\(FileSystemKind.shortName):\(scope)".utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }
}
