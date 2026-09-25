import Foundation
import FileProvider
import OnyxKit
import os

/// One Finder location's replica, and the one path that changes it.
///
/// The replica changes only in `step()`, which the working set's
/// `enumerateChanges` calls and whose result it reports before it answers —
/// so the anchor the system holds and the replica always describe the same
/// state. Listing (the working set's `enumerateItems`, every folder's) only
/// reads. When anchor and replica disagree anyway (a crash between the two),
/// the enumerator answers `syncAnchorExpired` and the system re-reads
/// everything: slow, never wrong.
actor SyncEngine {
    let domain: SyncDomain?
    private let fileURL: URL?
    private(set) var replica: Replica
    /// Whose replica this is. A replica built for one account on one server
    /// is never shown to another: a different person signing in on this Mac,
    /// or the app pointed at another server, starts it over.
    private var identity: Identity
    private var lastSave = Date.distantPast
    private let log = Logger(subsystem: OnyxIdentifiers.fileProvider, category: "sync")

    struct Identity: Codable, Equatable {
        let server: String
        let account: String

        static var current: Identity {
            Identity(server: OnyxConfig.current.baseURL.absoluteString,
                     account: (SharedSettings().email ?? "").lowercased())
        }
    }

    private struct Stored: Codable {
        let identity: Identity
        let replica: Replica
    }

    /// The access fingerprint, account or server moved: the replica has been
    /// emptied and the system must re-read the location from scratch.
    struct ScopeChanged: Error {}

    init(domainIdentifier: String) {
        self.domain = SyncDomain(identifier: domainIdentifier)
        // The extension's own container. The app never reads the replica.
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Replicas", isDirectory: true)
        if let dir { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        let safe = domainIdentifier.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." ? $0 : "_" }
        fileURL = dir?.appendingPathComponent(String(safe) + ".json")
        let stored = fileURL.flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode(Stored.self, from: $0) }
        let now = Identity.current
        identity = now
        replica = stored?.identity == now ? stored!.replica : Replica()
    }

    /// Where the replica stands: the access it was built under and its
    /// cursor, so an anchor from before a scope change never matches.
    func anchor() -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data("\(replica.scope ?? "")|\(replica.cursor)".utf8))
    }

    func matches(_ anchor: NSFileProviderSyncAnchor) -> Bool {
        anchor.rawValue == self.anchor().rawValue
    }

    struct Step {
        let diff: Replica.Diff
        let anchor: NSFileProviderSyncAnchor
        /// The server has more after this page: the system should ask again.
        let more: Bool
    }

    /// Apply one page of the server's changes and say what it did.
    ///
    /// One page, not the whole backlog: the system is told `moreComing` and
    /// asks again straight away, so no single report is enormous (the system
    /// enforces a ceiling) and nothing waits for the next nudge.
    ///
    /// Serialised: two passes interleaving at their network awaits could
    /// apply an older page after a newer one, or have one report the other's
    /// changes as nothing.
    func step() async throws -> Step {
        await acquire()
        defer { release() }

        let now = Identity.current
        if now != identity {
            log.info("account or server changed; starting over")
            identity = now
            replica.reset()
            save(force: true)
            throw ScopeChanged()
        }

        // Built per step, so a server change reaches a running extension.
        let api = OnyxAPI(config: .current)
        let page = try await api.delta(cursor: replica.cursor, domain: domain, folders: true)
        if let seen = replica.scope, let fresh = page.scope, seen != fresh {
            log.info("access changed; starting over")
            replica.reset(scope: fresh)
            save(force: true)
            throw ScopeChanged()
        }
        if replica.scope == nil { replica.scope = page.scope ?? "" }
        let diff = replica.apply(changed: page.changed, deleted: page.deleted.map(\.id),
                                 folders: page.folders, cursor: page.cursor)
        let more = !page.done
        save(force: !more)
        return Step(diff: diff, anchor: anchor(), more: more)
    }

    /// Written whole, atomically — so at the end of a pass, and otherwise at
    /// most every ten seconds: a first sync of a large library is hundreds of
    /// pages, and rewriting the file after each was most of its cost. A crash
    /// in between loses at most that much progress; the anchor check above
    /// then has the system re-read, and nothing is wrong, only slower.
    private func save(force: Bool) {
        guard force || Date().timeIntervalSince(lastSave) > 10 else { return }
        guard let fileURL, let data = try? JSONEncoder().encode(Stored(identity: identity, replica: replica)) else { return }
        try? data.write(to: fileURL, options: .atomic)
        lastSave = Date()
    }

    // MARK: - One pass at a time

    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    private func acquire() async {
        if busy {
            // Resumed by release(), which hands the turn over with busy still
            // set, so no third caller can slip in between.
            await withCheckedContinuation { waiting.append($0) }
        } else {
            busy = true
        }
    }

    private func release() {
        if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
    }
}
