import Foundation
import OnyxKit

/// Per-filespace S3 credentials, held until they are near expiry.
///
/// Minting is a round trip to /api/space/sts and, on the AssumeRole rung, a
/// round trip from there to AWS. Doing that per object would make opening a
/// folder of fifty files fifty credential mints.
///
/// Refresh happens at five minutes before expiry rather than at expiry: a
/// large download must not die holding a key that lapsed halfway through.
/// `expiration` is null on the static rungs and those are simply kept — see
/// SpaceCredentials.isExpired.
actor CredentialCache {
    static let shared = CredentialCache()

    private var cache: [String: SpaceCredentials] = [:]
    /// One in-flight mint per filespace. Without this, opening a folder starts
    /// one request per file and they all race to overwrite each other.
    private var inFlight: [String: Task<SpaceCredentials, Error>] = [:]

    func credentials(for filespaceId: String, api: OnyxAPI) async throws -> SpaceCredentials {
        if let cached = cache[filespaceId], !cached.isExpired() { return cached }
        if let existing = inFlight[filespaceId] { return try await existing.value }

        let task = Task<SpaceCredentials, Error> {
            try await api.credentials(filespaceId: filespaceId)
        }
        inFlight[filespaceId] = task
        defer { inFlight[filespaceId] = nil }

        let minted = try await task.value
        cache[filespaceId] = minted
        return minted
    }

    func invalidate(_ filespaceId: String? = nil) {
        if let filespaceId { cache.removeValue(forKey: filespaceId) } else { cache.removeAll() }
    }
}
