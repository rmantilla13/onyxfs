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

public struct OnyxConfig: Sendable, Equatable {
    public let baseURL: URL

    public init(baseURL: URL) { self.baseURL = baseURL }

    public static let production = OnyxConfig(baseURL: URL(string: "https://www.onyxfs.io")!)

    /// The server this install talks to: the one chosen in Settings, else
    /// production. Read from the shared settings, so the app and its Finder
    /// extension can never be pointed at two different servers.
    public static var current: OnyxConfig {
        SharedSettings().serverURL.map(OnyxConfig.init(baseURL:)) ?? .production
    }

    public func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var c = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    /// A server address as someone would type it: "localhost:3000",
    /// "onyx.example.com", "https://onyx.example.com/". Nil for anything that
    /// is not an http(s) origin. Local addresses default to http, everything
    /// else to https.
    public static func normalizedServer(_ typed: String) -> URL? {
        var s = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") {
            let host = s.split(separator: "/").first.map(String.init) ?? s
            let local = host.hasPrefix("localhost") || host.hasPrefix("127.") || host.hasSuffix(".local")
            s = (local ? "http://" : "https://") + s
        }
        guard var c = URLComponents(string: s), let scheme = c.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = c.host, !host.isEmpty else { return nil }
        c.scheme = scheme
        c.path = ""
        c.query = nil
        c.fragment = nil
        return c.url
    }
}

/// Settings the app and its Finder extension share, in the app group.
///
/// Only what both sides need and neither holds secret: the token lives in the
/// Keychain (TokenStore), never here.
public struct SharedSettings: @unchecked Sendable {
    // UserDefaults is thread-safe; it just predates Sendable.
    let defaults: UserDefaults

    public init(suiteName: String = OnyxIdentifiers.appGroup) {
        defaults = UserDefaults(suiteName: suiteName) ?? .standard
    }

    /// Nil means production.
    public var serverURL: URL? {
        get { defaults.string(forKey: "server").flatMap(URL.init(string:)) }
        nonmutating set { defaults.set(newValue?.absoluteString, forKey: "server") }
    }

    /// The signed-in address, for display. The token decides whether you are
    /// signed in; this only says as whom.
    public var email: String? {
        get { defaults.string(forKey: "email") }
        nonmutating set { defaults.set(newValue, forKey: "email") }
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
