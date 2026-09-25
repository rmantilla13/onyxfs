import Foundation

/// The newest Mac release, as `/api/desktop/mac/latest` describes it
/// (lib/mac-release.js on the server).
public struct MacRelease: Codable, Sendable, Equatable {
    public let version: String
    public let build: String?
    public let minimumSystemVersion: String?
    public let notes: String?
    public let publishedAt: String?
    /// For people: a disk image to open and drag to Applications.
    public let dmgUrl: URL?
    /// For the updater: the app, zipped, with its checksum.
    public let zipUrl: URL?
    public let zipSha256: String?
    public let zipSize: Int64?
    public let pageUrl: URL?

    public init(version: String, build: String? = nil, minimumSystemVersion: String? = nil, notes: String? = nil,
                publishedAt: String? = nil, dmgUrl: URL? = nil, zipUrl: URL? = nil, zipSha256: String? = nil,
                zipSize: Int64? = nil, pageUrl: URL? = nil) {
        self.version = version; self.build = build; self.minimumSystemVersion = minimumSystemVersion
        self.notes = notes; self.publishedAt = publishedAt; self.dmgUrl = dmgUrl; self.zipUrl = zipUrl
        self.zipSha256 = zipSha256; self.zipSize = zipSize; self.pageUrl = pageUrl
    }

    /// Can this Mac run it?
    public func runs(on os: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion) -> Bool {
        guard let min = minimumSystemVersion else { return true }
        let need = AppVersion.parts(min)
        let have = [os.majorVersion, os.minorVersion, os.patchVersion]
        return AppVersion.compare(have, need) >= 0
    }
}

/// Version arithmetic for updates: "0.10.0" is newer than "0.9.9", which a
/// string comparison gets backwards.
public enum AppVersion {
    static func parts(_ s: String) -> [Int] {
        s.trimmingCharacters(in: .whitespaces)
            .drop(while: { $0 == "v" })
            .split(whereSeparator: { $0 == "." || $0 == "-" })
            .map { Int($0) ?? 0 }
    }

    static func compare(_ a: [Int], _ b: [Int]) -> Int {
        for i in 0..<max(a.count, b.count) {
            let d = (i < a.count ? a[i] : 0) - (i < b.count ? b[i] : 0)
            if d != 0 { return d }
        }
        return 0
    }

    /// Is `version` (with `build`) newer than what is running? The version
    /// decides; the build breaks a tie, so a rebuilt release of the same
    /// version still reaches people who have the earlier build of it.
    public static func isNewer(_ version: String, build: String?, than current: String, currentBuild: String?) -> Bool {
        let c = compare(parts(version), parts(current))
        if c != 0 { return c > 0 }
        guard let build, let currentBuild, let b = Int64(build), let cb = Int64(currentBuild) else { return false }
        return b > cb
    }
}
