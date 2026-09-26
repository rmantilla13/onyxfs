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

    public func set(_ value: String?, for account: String = "bearer") throws {
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
