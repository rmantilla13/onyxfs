import Foundation
import Security

/// The bearer token, in the Keychain, in an access group both the app and the
/// File Provider extension can read.
///
/// `kSecAttrAccessibleAfterFirstUnlock` rather than `WhenUnlocked`: a File
/// Provider is asked to enumerate while the device is locked, and a token it
/// cannot read then looks to the system like an empty drive rather than an
/// error — the user sees their files vanish and come back.
public struct TokenStore: Sendable {
    let service: String
    let accessGroup: String?

    public init(service: String = OnyxIdentifiers.app,
                accessGroup: String? = OnyxIdentifiers.keychainAccessGroup) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func baseQuery(_ account: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func set(_ value: String?, for account: String = "bearer") throws {
        var q = baseQuery(account)
        SecItemDelete(q as CFDictionary)
        guard let value else { return }
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw keychainError(status) }
    }

    public func get(_ account: String = "bearer") -> String? {
        var q = baseQuery(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
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
