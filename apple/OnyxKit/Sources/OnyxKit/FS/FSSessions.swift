import Foundation
import Security

/// Who may talk to the onyxfs half of the bridge, and about which drive.
///
/// A drive mounted as a disk is handed to FSKit as a resource URL, and
/// `mount` shows that URL to every account on this Mac. So the URL carries a
/// ticket, not a key: good for one exchange, for two minutes. The extension
/// trades it (`exchange`) for a session key that only the two processes ever
/// hold, and sends that with every request after. A session answers for the
/// one drive its ticket was issued for, and lasts until that drive is
/// unmounted (`end(scope:)`) or the app quits — nothing is written down, so
/// an app that restarts has to be mounted again.
///
/// That closes what the NFS mounts leave open: any local account can mount
/// rclone's NFS port, which has no authentication (apple/README.md).
///
/// Secrets are kept as their SHA-256 digests and looked up by them, so no
/// comparison ever runs over a secret a byte at a time.
public final class FSSessions: @unchecked Sendable {
    public static let ticketLifetime: TimeInterval = 120

    /// One session, as the bridge knows it: which drive it may read, and a
    /// handle for counting what it has under way (never the key itself).
    public struct Session: Sendable, Hashable {
        public let id: String
        public let scope: String
    }

    private struct Ticket {
        let scope: String
        let expires: Date
    }

    private let lock = NSLock()
    /// By the digest of the ticket.
    private var tickets: [String: Ticket] = [:]
    /// Scope, by the digest of the key.
    private var sessions: [String: String] = [:]
    private let clock: @Sendable () -> Date

    /// `clock` stands in for the time of day, for tests.
    public init(clock: @escaping @Sendable () -> Date = { Date() }) {
        self.clock = clock
    }

    /// A ticket for mounting `scope` (a SyncDomain identifier): 32 random
    /// bytes, base64url, spent by one exchange or two minutes, whichever is
    /// first.
    public func issueTicket(for scope: String) -> String {
        let ticket = Self.secret()
        let now = clock()
        lock.withLock {
            tickets = tickets.filter { $0.value.expires > now }
            tickets[Self.digest(ticket)] = Ticket(scope: scope, expires: now.addingTimeInterval(Self.ticketLifetime))
        }
        return ticket
    }

    /// A new session for the ticket's drive, and which drive that is; nil for
    /// a ticket that is unknown, spent or expired. Trying spends it, so a
    /// ticket read out of `mount` after the extension used it buys nothing.
    public func exchange(_ ticket: String) -> (session: String, scope: String)? {
        guard !ticket.isEmpty else { return nil }
        let now = clock()
        let key = Self.secret()
        return lock.withLock {
            tickets = tickets.filter { $0.value.expires > now }
            guard let held = tickets.removeValue(forKey: Self.digest(ticket)) else { return nil }
            sessions[Self.digest(key)] = held.scope
            return (key, held.scope)
        }
    }

    /// The session an Authorization header carries (`Bearer <key>`), or nil
    /// for none, a malformed one, or a key that is not (or no longer) one.
    public func session(for authorization: String?) -> Session? {
        guard let key = Self.bearer(authorization) else { return nil }
        let digest = Self.digest(key)
        return lock.withLock { sessions[digest].map { Session(id: digest, scope: $0) } }
    }

    /// One session ends: its key opens nothing from now on.
    public func revoke(_ key: String) {
        let digest = Self.digest(key)
        lock.withLock { _ = sessions.removeValue(forKey: digest) }
    }

    /// The drive is unmounted, or no longer this account's: its sessions end
    /// and its unspent tickets with them.
    public func end(scope: String) {
        lock.withLock {
            sessions = sessions.filter { $0.value != scope }
            tickets = tickets.filter { $0.value.scope != scope }
        }
    }

    /// Signed out: nothing more is answered for anyone.
    public func endAll() {
        lock.withLock {
            sessions = [:]
            tickets = [:]
        }
    }

    /// Sessions open now; for tests.
    var sessionCount: Int { lock.withLock { sessions.count } }

    // MARK: - Secrets

    /// The key in `Bearer <key>`, as DAVResponder takes its token: blanks
    /// around the whole value are forgiven, anything else is not.
    static func bearer(_ authorization: String?) -> String? {
        guard let value = authorization?.trimmingCharacters(in: CharacterSet(charactersIn: " \t")),
              value.hasPrefix("Bearer ") else { return nil }
        let key = value.dropFirst("Bearer ".count)
        return key.isEmpty ? nil : String(key)
    }

    /// 32 random bytes, base64url without padding (43 characters): safe in a
    /// URL's path, query and a header as they are.
    static func secret() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            // Never seen; the system generator is a CSPRNG too.
            var generator = SystemRandomNumberGenerator()
            for i in bytes.indices { bytes[i] = generator.next() }
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func digest(_ secret: String) -> String { SigV4.sha256Hex(secret) }
}
