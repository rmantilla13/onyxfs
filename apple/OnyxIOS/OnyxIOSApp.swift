import SwiftUI
import FileProvider
import OnyxKit
import AuthenticationServices
#if canImport(UIKit)
import UIKit
#endif

@main
struct OnyxIOSApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model)
                // The PKCE callback comes back as onyxfs://callback?code=…
                // when the flow completes outside ASWebAuthenticationSession
                // (a password manager, or the person switching to Safari).
                .onOpenURL { model.handle(callback: $0) }
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var email: String?
    @Published var files: [FileItem] = []
    @Published var error: String?
    @Published var busy = false

    let api = OnyxAPI()
    let auth = AuthClient()
    private var pendingVerifier: String?

    var isSignedIn: Bool { auth.isSignedIn }

    func signIn(anchor: ASPresentationAnchor) async {
        busy = true; defer { busy = false }
        do {
            let token = try await auth.signIn(label: deviceLabel(), anchor: anchor)
            email = token.email
            await registerFileProviderDomain()
            await refresh()
        } catch {
            // A cancelled sign-in is a choice, not a failure worth reporting.
            if (error as NSError).code != ASWebAuthenticationSessionError.canceledLogin.rawValue {
                self.error = error.localizedDescription
            }
        }
    }

    func handle(callback url: URL) {
        guard let code = AuthClient.code(from: url), let verifier = pendingVerifier else { return }
        pendingVerifier = nil
        Task {
            do { email = try await auth.exchange(code: code, verifier: verifier, label: deviceLabel()).email }
            catch { self.error = error.localizedDescription }
        }
    }

    func refresh() async {
        busy = true; defer { busy = false }
        do {
            // Cursor 0 for the browse list: the app shows what is there, while
            // the extension is the thing that maintains an incremental mirror.
            files = try await api.delta(cursor: 0, limit: 200).changed.filter { $0.deletedAt == nil }
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    func signOut() async {
        try? await api.signOut()
        email = nil; files = []
    }

    /// Shown in the device list, so it has to say which device this is.
    private func deviceLabel() -> String {
        #if os(iOS)
        return UIDevice.current.name
        #else
        return Host.current().localizedName ?? "Mac"
        #endif
    }

    /// Registering the domain is what makes Onyx appear in Files.app. It is
    /// idempotent, and doing it before there is a token would show an empty
    /// drive with no way to sign in.
    private func registerFileProviderDomain() async {
        let domain = NSFileProviderDomain(
            identifier: .init(rawValue: "io.onyxfs.default"),
            displayName: "Onyx")
        try? await NSFileProviderManager.add(domain)
    }
}
