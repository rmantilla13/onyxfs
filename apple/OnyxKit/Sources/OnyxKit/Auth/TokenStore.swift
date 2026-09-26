import Foundation
import Security

/// The bearer token, in the Keychain, where both the app and its Finder
/// extension can read it.
///
/// Shared through the app group, in the data-protection keychain. That needs
/// the build to be signed with the team's entitlements; an unsigned
/// development build has none, and the shared keychain refuses it with
/// -34018. Rather than fail to sign in at all, such a build falls back to the
/// app's own login-keychain item — the app window works, and only Finder,
/// which cannot work unsigned anyway, goes without.
///
/// `kSecAttrAccessibleAfterFirstUnlock` rather than `WhenUnlocked`: a File
/// Provider is asked to enumerate while the device is locked, and a token it
/// cannot read then looks to the system like an empty drive rather than an
/// error — the user sees their files vanish and come back.
public struct TokenStore: Sendable {
    let service: String
    let accessGroup: String?

    public init(service: String = OnyxIdentifiers.tokenService,
                accessGroup: String? = OnyxIdentifiers.keychainAccessGroup) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func query(_ account: String, shared: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if shared {
            q[kSecUseDataProtectionKeychain as String] = true
            if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        }
        return q
    }

    /// A development build ("Onyx Dev") is unsigned, and each rebuild is a
    /// new app to the Keychain — which then asks the person, on every
    /// rebuild, whether it may read the last build's token. So a dev build
    /// keeps its test sign-in in a file only this user can read instead.
    private func devFile(_ account: String) -> URL? {
        guard OnyxIdentifiers.isDevBuild, service == OnyxIdentifiers.tokenService else { return nil }
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(OnyxIdentifiers.folderName, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        return dir.appendingPathComponent("token-\(account)")
    }

    public func set(_ value: String?, for account: String = "bearer") throws {
        if let file = devFile(account) {
            guard let value else { try? FileManager.default.removeItem(at: file); return }
            try Data(value.utf8).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            return
        }
        SecItemDelete(query(account, shared: true) as CFDictionary)
        SecItemDelete(query(account, shared: false) as CFDictionary)
        guard let value else { return }

        var q = query(account, shared: true)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        var status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecMissingEntitlement {
            var local = query(account, shared: false)
            local[kSecValueData as String] = Data(value.utf8)
            local[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(local as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw keychainError(status) }
    }

    public func get(_ account: String = "bearer") -> String? {
        if let file = devFile(account) {
            return (try? String(contentsOf: file, encoding: .utf8)).flatMap { $0.isEmpty ? nil : $0 }
        }
        for shared in [true, false] {
            var q = query(account, shared: shared)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
               let data = out as? Data, let s = String(data: data, encoding: .utf8) {
                return s
            }
        }
        return nil
    }

    public func clear(_ account: String = "bearer") { try? set(nil, for: account) }

    private func keychainError(_ status: OSStatus) -> NSError {
        let message = SecCopyErrorMessageString(status, nil) as String?
        // -34018 is the one worth naming: it means the entitlement is missing
        // or the app is running unsigned, not that the token is wrong, and it
        // costs an afternoon if you go looking at the token instead.
        let hint = status == errSecMissingEntitlement
            ? " — the keychain access group is missing from this target's entitlements"
            : ""
        return NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [
            NSLocalizedDescriptionKey: (message ?? "Keychain error \(status)") + hint,
        ])
    }
}
