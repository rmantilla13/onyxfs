import Foundation

/// Identifiers compiled into every install. Changing one after release
/// orphans existing users' data, so they are fixed here once.
public enum OnyxIdentifiers {
    public static let app = "io.onyxfs.app"
    public static let fileProvider = "io.onyxfs.app.fileprovider"
    /// Shared container for the app and its extension.
    public static let appGroup = "group.io.onyxfs"
    /// Keychain access group. The extension reads the token the app wrote, so
    /// this must be listed in BOTH targets' entitlements or the extension
    /// silently finds no credentials and enumerates an empty drive.
    public static let keychainAccessGroup = "group.io.onyxfs"
    /// Registered for the PKCE redirect.
    public static let urlScheme = "onyxfs"
}

public struct OnyxConfig: Sendable {
    public let baseURL: URL

    public init(baseURL: URL) { self.baseURL = baseURL }

    public static let production = OnyxConfig(baseURL: URL(string: "https://www.onyxfs.io")!)

    public func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var c = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }
}

public enum OnyxError: LocalizedError {
    case http(status: Int, message: String?)
    case notAuthenticated
    case decoding(String)
    case storageUnavailable(String)

    public var errorDescription: String? {
        switch self {
        case let .http(status, message):
            return message ?? "The server returned \(status)."
        case .notAuthenticated:
            return "Not signed in."
        case let .decoding(detail):
            return "The server sent something unexpected: \(detail)"
        case let .storageUnavailable(detail):
            return detail
        }
    }
}
