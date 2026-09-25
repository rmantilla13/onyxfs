import Foundation
import FileProvider
import AppKit
import OnyxKit

/// The app's side of Onyx in Finder: which drives are there, adding and
/// removing them, and nudging them to sync.
///
/// Each is a File Provider domain named after its drive (SyncDomain). The
/// extension does the work; this only registers the locations and asks the
/// system to look for changes.
enum FinderLocations {
    /// Domain identifiers currently in Finder.
    static func current() async -> Set<String> {
        Set(((try? await NSFileProviderManager.domains()) ?? []).map(\.identifier.rawValue))
    }

    static func add(_ scope: SyncDomain, name: String) async throws {
        let domain = NSFileProviderDomain(identifier: .init(scope.identifier), displayName: name)
        do {
            try await NSFileProviderManager.add(domain)
        } catch {
            throw explained(error)
        }
    }

    /// Takes the location out of Finder, and the downloaded copies with it.
    static func remove(_ identifier: String) async throws {
        guard let domain = try await NSFileProviderManager.domains().first(where: { $0.identifier.rawValue == identifier })
        else { return }
        try await NSFileProviderManager.remove(domain)
    }

    /// Open the location in a Finder window.
    static func reveal(_ identifier: String) async throws {
        guard let domain = try await NSFileProviderManager.domains().first(where: { $0.identifier.rawValue == identifier }),
              let manager = NSFileProviderManager(for: domain) else { return }
        let url = try await manager.getUserVisibleURL(for: .rootContainer)
        await MainActor.run { _ = NSWorkspace.shared.open(url) }
    }

    /// Ask every location to look for changes now. S3 cannot push, so this
    /// (on a timer, and after anything the app itself changed) is how a file
    /// uploaded on the web reaches Finder without waiting.
    static func syncAll() async {
        for domain in (try? await NSFileProviderManager.domains()) ?? [] {
            try? await NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet)
        }
    }

    /// The error an unsigned build gets is about provisioning, and reads as
    /// nonsense to anyone not expecting it. Say what it means.
    static func explained(_ error: Error) -> Error {
        let ns = error as NSError
        // providerNotFound (-2001), or applicationExtensionNotFound (-2014,
        // named only from macOS 14.1): the system found no extension it will
        // run for this app.
        let unsigned = ns.domain == NSFileProviderErrorDomain && (ns.code == -2001 || ns.code == -2014)
        guard unsigned else { return error }
        return NSError(domain: ns.domain, code: ns.code, userInfo: [
            NSLocalizedDescriptionKey: "Finder did not accept Onyx's drive extension. That needs a build signed with an Apple Developer team — see apple/README.md. The rest of the app works without it.",
            NSUnderlyingErrorKey: error,
        ])
    }
}
