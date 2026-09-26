import Foundation
import OnyxFSCore

/// Connects a resource URL to its engine. Filled in with OnyxFSCore's
/// engine; until then no drive can load.
@available(macOS 27.0, *)
enum EngineFactory {
    static func connect(_ url: URL) async throws -> any VolumeEngine {
        throw VolumeError.posix(ENOTSUP)
    }
}
