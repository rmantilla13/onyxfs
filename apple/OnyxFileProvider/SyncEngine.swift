import Foundation
import FileProvider
import OnyxKit
import os

/// One Finder location's replica, and the one path that changes it.
///
/// Every mutation of the replica goes through `catchUp()`, and every call of
/// `catchUp()` is followed by telling the system what it did — that is what
/// keeps the system's sync anchor and the replica describing the same state.
/// If they ever disagree, the enumerator answers `syncAnchorExpired` and the
/// system re-reads everything, which is slow but never wrong.
actor SyncEngine {
    let domain: SyncDomain?
    let api: OnyxAPI
    private let fileURL: URL?
    private(set) var replica: Replica
    private let log = Logger(subsystem: OnyxIdentifiers.fileProvider, category: "sync")

    /// The access fingerprint moved: the replica has been emptied and the
    /// system must re-read the location from scratch.
    struct ScopeChanged: Error {}

    init(domainIdentifier: String, api: OnyxAPI) {
        self.domain = SyncDomain(identifier: domainIdentifier)
        self.api = api
        // The extension's own container. The app never reads the replica, so
        // it does not need the shared one.
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Replicas", isDirectory: true)
        if let dir { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        let safe = domainIdentifier.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." ? $0 : "_" }
        fileURL = dir?.appendingPathComponent(String(safe) + ".json")
        replica = fileURL.flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode(Replica.self, from: $0) } ?? Replica()
    }

    var hasSynced: Bool { replica.scope != nil }

    /// Bring the replica up to the server's present and say what changed.
    ///
    /// Throws `ScopeChanged` when the server's access fingerprint differs from
    /// the one the replica was built under: someone joined or left a drive, a
    /// grant changed, a drive was created. None of that writes a file row, so
    /// no cursor can carry it; the only honest answer is to start again.
    func catchUp() async throws -> Replica.Diff {
        let sync = DeltaSync(api: api, cursor: replica.cursor, domain: domain)
        pending = Replica.Diff()
        defer { pending = Replica.Diff() }
        try await sync.drain { page in
            try await self.apply(page)
        }
        return pending
    }

    /// What the pass in progress has changed so far.
    private var pending = Replica.Diff()

    private func apply(_ page: DeltaSync.Page) throws {
        if let seen = replica.scope, let now = page.scope, seen != now {
            log.info("access changed (\(seen, privacy: .public) → \(now, privacy: .public)); starting over")
            replica.reset(scope: now)
            save()
            throw ScopeChanged()
        }
        if replica.scope == nil { replica.scope = page.scope ?? "" }
        let diff = replica.apply(changed: page.changed, deleted: page.deleted.map(\.id),
                                 folders: page.folders, cursor: page.cursor)
        pending.updated.append(contentsOf: diff.updated)
        pending.deleted.append(contentsOf: diff.deleted)
        // Saved after every page: a crash then costs at most one page, which
        // is re-read (idempotently) next time.
        save()
    }

    func reset() {
        replica.reset()
        save()
    }

    /// The anchor for where the replica stands: the scope it was built under
    /// and its cursor, so an anchor from before a scope change never matches.
    func anchor() -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data("\(replica.scope ?? "")|\(replica.cursor)".utf8))
    }

    func matches(_ anchor: NSFileProviderSyncAnchor) -> Bool {
        anchor.rawValue == self.anchor().rawValue
    }

    private func save() {
        guard let fileURL, let data = try? JSONEncoder().encode(replica) else { return }
        // Atomic: a half-written replica read at next launch would present a
        // truncated library as if it were the whole thing.
        try? data.write(to: fileURL, options: .atomic)
    }
}
