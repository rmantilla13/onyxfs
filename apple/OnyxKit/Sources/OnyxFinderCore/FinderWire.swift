import Foundation

/// How the Finder extension and the app talk: requests over a Mach port the
/// app registers (FinderPort), and one Darwin notification the app posts
/// when what Finder should show has changed.
///
///   index    → the FinderIndex, as JSON: the extension asks as it starts
///              and after each notification, never per item
///   keep     { paths } → Keep Offline: the app makes the rules
///   remove   { paths } → Remove Offline Copy
///   show     { paths: [one] } → the item in the Onyx window
///   open     → the Onyx window
///
/// Every answer but `index` is a Reply; the work carries on in the app after
/// it, and what changes comes back as a new index.
///
/// The names come from the app's bundle identifier, so Onyx Dev
/// (io.onyxfs.app.dev) and Onyx never answer each other's extension. The
/// extension is sandboxed: it may look up the port only because its
/// entitlements name it (com.apple.security.temporary-exception.mach-lookup
/// .global-name, written by scripts/build-mac.sh).
public enum FinderWire {
    public enum Message: Int32, Sendable {
        case index = 1
        case keep = 2
        case remove = 3
        case show = 4
        case open = 5
    }

    public struct Request: Codable, Sendable, Equatable {
        public var paths: [String]
        public init(paths: [String]) { self.paths = paths }

        public func encoded() -> Data { (try? JSONEncoder().encode(self)) ?? Data() }

        /// Nil for anything that is not a request, or asks about more than
        /// `maxPaths` items.
        public static func decode(_ data: Data) -> Request? {
            guard let request = try? JSONDecoder().decode(Request.self, from: data),
                  request.paths.count <= maxPaths else { return nil }
            return request
        }
    }

    public struct Reply: Codable, Sendable, Equatable {
        public var ok: Bool
        /// Why not, in words, when not.
        public var message: String?
        public init(ok: Bool, message: String? = nil) { self.ok = ok; self.message = message }

        public func encoded() -> Data { (try? JSONEncoder().encode(self)) ?? Data() }
        public static func decode(_ data: Data) -> Reply? { try? JSONDecoder().decode(Reply.self, from: data) }
    }

    /// The most items one request may name: a Finder selection of every file
    /// in a big folder, and no more.
    public static let maxPaths = 10_000
    /// The largest request the app reads.
    public static let maxRequestBytes = 8 << 20

    /// The extension's bundle identifier is its app's with this after it.
    public static let extensionSuffix = ".findersync"

    /// The Mach port the app answers on: "io.onyxfs.app.finder".
    public static func portName(app: String) -> String { app + ".finder" }

    /// What the app posts when the index has changed.
    public static func changedNotification(app: String) -> String { app + ".finder.changed" }

    /// "io.onyxfs.app" for "io.onyxfs.app.findersync"; nil for anything else.
    public static func app(forExtension identifier: String) -> String? {
        guard identifier.hasSuffix(extensionSuffix), identifier.count > extensionSuffix.count else { return nil }
        return String(identifier.dropLast(extensionSuffix.count))
    }
}
