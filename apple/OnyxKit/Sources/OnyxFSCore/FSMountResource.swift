import Foundation

/// The resource a drive is mounted from:
/// `onyxfs-drive://127.0.0.1:<bridgePort>/<scope>?ticket=<ticket>&name=<drive name>&v=1`.
///
/// Not `onyxfs:`, which is the app's sign-in hand-off scheme, registered with
/// the system and compiled into the desktop bundle.
///
/// Every local account can read it in `mount` output, so it carries a
/// one-time ticket and never a lasting secret. Parsing it spends nothing:
/// FSKit probes a resource before loading it, and only `FSBridgeClient.connect`
/// exchanges the ticket. `name` is there for the probe, which names the
/// volume before any session exists.
public struct FSMountResource: Sendable, Hashable {
    public static let scheme = "onyxfs-drive"
    public static let protocolVersion = 1

    public let host: String
    public let port: Int
    /// `drive.<id>` or `library` (SyncDomain.identifier in OnyxKit).
    public let scope: String
    public let ticket: String
    /// The drive's name, when the URL carries one.
    public let name: String?

    /// Only loopback: the ticket, and the session after it, must never be
    /// handed to another machine, whatever a mount command was given.
    static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1"]

    public init(url: URL) throws {
        guard url.scheme?.lowercased() == Self.scheme else {
            throw FSBridgeError.invalidResource("the scheme is not \(Self.scheme)")
        }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw FSBridgeError.invalidResource("unreadable URL")
        }
        guard let host = components.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")),
              Self.loopbackHosts.contains(host.lowercased()) else {
            throw FSBridgeError.invalidResource("the bridge must be on this Mac (127.0.0.1)")
        }
        guard let port = components.port, (1...65535).contains(port) else {
            throw FSBridgeError.invalidResource("no bridge port")
        }
        let segments = components.path.split(separator: "/", omittingEmptySubsequences: true)
        guard segments.count == 1 else { throw FSBridgeError.invalidResource("the path must be one scope") }
        let scope = String(segments[0])
        guard scope == "library" || (scope.hasPrefix("drive.") && scope.count > "drive.".count) else {
            throw FSBridgeError.invalidResource("unknown scope \(scope)")
        }
        let items = components.queryItems ?? []
        guard let version = items.first(where: { $0.name == "v" })?.value, version == String(Self.protocolVersion) else {
            throw FSBridgeError.invalidResource("unsupported protocol version")
        }
        guard let ticket = items.first(where: { $0.name == "ticket" })?.value, !ticket.isEmpty else {
            throw FSBridgeError.invalidResource("no ticket")
        }
        self.host = host
        self.port = port
        self.scope = scope
        self.ticket = ticket
        let name = items.first(where: { $0.name == "name" })?.value
        self.name = (name?.isEmpty ?? true) ? nil : name
    }

    /// Where the bridge answers: plain HTTP on loopback.
    public var bridgeURL: URL {
        let bracketed = host.contains(":") ? "[\(host)]" : host
        return URL(string: "http://\(bracketed):\(port)")!
    }
}
