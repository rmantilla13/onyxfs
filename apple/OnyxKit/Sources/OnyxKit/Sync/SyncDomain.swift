import Foundation

/// Which part of the workspace one Finder location shows.
///
/// Each drive appears in Finder as a location of its own — "Onyx — Brand",
/// "Onyx — Clients" — the way the web shows each drive as its own place, with
/// its own members. The library (files in no drive) can be one too. The app
/// names a File Provider domain after the scope, and the extension, which is
/// handed only the domain, reads the scope back out of its identifier.
///
/// The identifier is compiled into every device's domain list: changing its
/// shape orphans every location already added to Finder.
public enum SyncDomain: Hashable, Sendable {
    case library
    case drive(id: String)

    private static let drivePrefix = "drive."

    /// The File Provider domain identifier.
    public var identifier: String {
        switch self {
        case .library: return "library"
        case let .drive(id): return Self.drivePrefix + id
        }
    }

    public init?(identifier: String) {
        if identifier == "library" { self = .library; return }
        guard identifier.hasPrefix(Self.drivePrefix) else { return nil }
        let id = String(identifier.dropFirst(Self.drivePrefix.count))
        guard !id.isEmpty else { return nil }
        self = .drive(id: id)
    }

    /// The `drive=` parameter of /api/files/delta.
    public var deltaParameter: String {
        switch self {
        case .library: return "library"
        case let .drive(id): return id
        }
    }
}
