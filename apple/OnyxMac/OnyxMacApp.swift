import SwiftUI
import FileProvider
import OnyxKit
import AuthenticationServices
#if canImport(AppKit)
import AppKit
#endif

/// The macOS menu-bar app.
///
/// Its job is narrow on purpose: sign in, register the File Provider domain,
/// and say what state things are in. It does NOT mount the drive for editing —
/// the rclone/FUSE mount in desktop/ keeps that job, because a File Provider
/// materialises a file when it is opened and that would stall a 4K timeline
/// mid-scrub. The two coexist: FUSE for editing, File Provider for Finder
/// browsing and on-demand download.
@main
struct OnyxMacApp: App {
    @StateObject private var model = MacModel()

    var body: some Scene {
        MenuBarExtra("Onyx", systemImage: "externaldrive.connected.to.line.below") {
            if model.isSignedIn {
                Text(model.email ?? "Signed in").font(.caption)
                Divider()
                Button(model.domainRegistered ? "Showing in Finder" : "Show in Finder") {
                    Task { await model.registerDomain() }
                }
                .disabled(model.domainRegistered)
                Button("Sync now") { Task { await model.syncNow() } }
                if let status = model.status { Text(status).font(.caption) }
                Divider()
                Button("Sign out") { Task { await model.signOut() } }
            } else {
                Button("Sign in…") { Task { await model.signIn() } }
            }
            Divider()
            Button("Quit Onyx") { NSApplication.shared.terminate(nil) }
        }
        .menuBarExtraStyle(.menu)
    }
}

@MainActor
final class MacModel: ObservableObject {
    @Published var email: String?
    @Published var status: String?
    @Published var domainRegistered = false

    private let api = OnyxAPI()
    private let auth = AuthClient()
    private let cursors = CursorStore()

    var isSignedIn: Bool { auth.isSignedIn }

    init() {
        Task { domainRegistered = await Self.domainExists() }
    }

    func signIn() async {
        do {
            let anchor = NSApplication.shared.keyWindow ?? ASPresentationAnchor()
            let token = try await auth.signIn(label: Host.current().localizedName ?? "Mac", anchor: anchor)
            email = token.email
            await registerDomain()
        } catch {
            if (error as NSError).code != ASWebAuthenticationSessionError.canceledLogin.rawValue {
                status = error.localizedDescription
            }
        }
    }

    func registerDomain() async {
        let domain = NSFileProviderDomain(identifier: .init(rawValue: "io.onyxfs.default"),
                                          displayName: "Onyx")
        do {
            try await NSFileProviderManager.add(domain)
            domainRegistered = true
            status = nil
        } catch {
            status = "Could not add the Finder drive: \(error.localizedDescription)"
        }
    }

    /// Ask the system to re-enumerate. The extension does the work; this is
    /// only the nudge, so a person who just uploaded on the web does not have
    /// to wait for the next scheduled pass.
    func syncNow() async {
        let identifier = NSFileProviderDomainIdentifier(rawValue: "io.onyxfs.default")
        guard let domain = try? await NSFileProviderManager.domains().first(where: { $0.identifier == identifier }),
              let manager = NSFileProviderManager(for: domain) else {
            status = "The Finder drive is not registered yet."
            return
        }
        do {
            try await manager.signalEnumerator(for: .rootContainer)
            status = "Syncing…"
        } catch {
            status = error.localizedDescription
        }
    }

    func signOut() async {
        try? await api.signOut()
        email = nil
        // Leave the domain registered: removing it deletes the local mirror,
        // and signing back in is far commoner than wanting the drive gone.
        status = nil
    }

    private static func domainExists() async -> Bool {
        ((try? await NSFileProviderManager.domains()) ?? [])
            .contains { $0.identifier.rawValue == "io.onyxfs.default" }
    }
}
