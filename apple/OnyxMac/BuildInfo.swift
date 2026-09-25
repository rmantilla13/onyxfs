import Foundation
import Security

/// Facts about this build that change what the app can offer.
enum BuildInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    /// The Apple Developer team this copy is signed by, or nil for an unsigned
    /// (ad-hoc) development build.
    ///
    /// It matters because Finder needs it. The app and its extension share
    /// the sign-in through the app group and its keychain, and macOS grants
    /// those only to code signed by a team that holds them. An unsigned build
    /// runs the window perfectly well — and would show drives in Finder that
    /// can only ever ask you to sign in. So it does not offer them.
    static let teamID: String? = {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess
        else { return nil }
        return (info as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String
    }()

    static var canUseFinder: Bool { teamID != nil }
}
