import Foundation
import AppKit
import AuthenticationServices
import OnyxKit
import os

let appLog = Logger(subsystem: OnyxIdentifiers.app, category: "app")

/// Everything the app's windows and menu bar item show: who is signed in,
/// which server, which drives there are and which of them are in Finder.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case signedOut, signingIn, signedIn }

    @Published private(set) var phase: Phase
    @Published private(set) var email: String?
    @Published private(set) var drives: [Filespace] = []
    /// Whether the server treats this account as an admin; only decides
    /// which menu items are offered — the server enforces it either way.
    @Published private(set) var isAdmin = false
    /// Domain identifiers currently in Finder.
    @Published private(set) var inFinder: Set<String> = []
    /// Locations being added or removed right now.
    @Published private(set) var busy: Set<String> = []
    /// The last thing that went wrong, for the window to say.
    @Published var problem: String?
    @Published private(set) var server: URL

    let web: WebController
    private let settings = SharedSettings()
    private var syncTimer: Timer?

    init() {
        let settings = SharedSettings()
        server = OnyxConfig.current.baseURL
        email = settings.email
        phase = TokenStore().get() == nil ? .signedOut : .signedIn
        web = WebController()
        web.model = self
        if phase == .signedIn { Task { await afterSignIn() } }
        // S3 has no push; this is how the web's changes reach Finder without
        // anyone asking. Cheap: a delta with nothing new is one small query.
        syncTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { await FinderLocations.syncAll() }
        }
    }

    var config: OnyxConfig { OnyxConfig(baseURL: server) }
    var api: OnyxAPI { OnyxAPI(config: config) }
    private var auth: AuthClient { AuthClient(config: config) }
    private var deviceLabel: String { Host.current().localizedName ?? "Mac" }

    /// "onyxfs.io" rather than "https://www.onyxfs.io".
    var serverLabel: String {
        let host = server.host ?? server.absoluteString
        let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        return server.port.map { "\(bare):\($0)" } ?? bare
    }

    // MARK: - Signing in and out

    func signInWithBrowser() async {
        phase = .signingIn
        problem = nil
        do {
            let anchor = NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible) ?? ASPresentationAnchor()
            let token = try await auth.signIn(label: deviceLabel, anchor: anchor)
            await signedIn(as: token.email)
        } catch {
            phase = .signedOut
            let cancelled = (error as NSError).domain == ASWebAuthenticationSessionErrorDomain
                && (error as NSError).code == ASWebAuthenticationSessionError.canceledLogin.rawValue
            if !cancelled { problem = error.localizedDescription }
        }
    }

    func pair(code: String) async {
        phase = .signingIn
        problem = nil
        do {
            let token = try await auth.pair(code: code, label: deviceLabel)
            await signedIn(as: token.email)
        } catch {
            phase = .signedOut
            problem = error.localizedDescription
        }
    }

    private func signedIn(as address: String) async {
        email = address
        settings.email = address
        phase = .signedIn
        appLog.info("signed in as \(address, privacy: .private)")
        await afterSignIn()
    }

    private func afterSignIn() async {
        web.signIn()
        await refresh()
    }

    func signOut() async {
        try? await api.signOut()
        settings.email = nil
        email = nil
        drives = []
        isAdmin = false
        phase = .signedOut
        await web.signOut()
        // Finder locations stay: removing one deletes its downloaded copies,
        // and signing back in is far commoner than wanting them gone. The
        // extension answers "sign in" meanwhile.
        appLog.info("signed out")
    }

    /// Point the app at another server. A token belongs to the server that
    /// issued it, so changing servers signs you out.
    @discardableResult
    func setServer(_ typed: String) async -> Bool {
        guard let url = OnyxConfig.normalizedServer(typed) else {
            problem = "That is not a server address. Try something like onyxfs.io or localhost:3000."
            return false
        }
        guard url != server else { return true }
        if phase == .signedIn { await signOut() }
        settings.serverURL = url == OnyxConfig.production.baseURL ? nil : url
        server = url
        problem = nil
        return true
    }

    /// Called when the server says the token is no good any more.
    func tokenRejected() async {
        guard phase == .signedIn else { return }
        TokenStore().clear()
        settings.email = nil
        email = nil
        phase = .signedOut
        problem = "Your sign-in on this Mac has expired or was revoked. Sign in again."
        await web.signOut()
    }

    // MARK: - Drives and Finder

    func refresh() async {
        guard phase == .signedIn else { return }
        do {
            let listing = try await api.drives()
            drives = listing.drives.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            isAdmin = listing.isAdmin
        } catch OnyxError.notAuthenticated {
            await tokenRejected()
            return
        } catch {
            problem = error.localizedDescription
        }
        inFinder = await FinderLocations.current()
        await removeOrphans()
    }

    func isInFinder(_ scope: SyncDomain) -> Bool { inFinder.contains(scope.identifier) }

    func setInFinder(_ scope: SyncDomain, name: String, _ on: Bool) async {
        let id = scope.identifier
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            if on {
                try await FinderLocations.add(scope, name: name)
                appLog.info("finder: added \(id, privacy: .public)")
            } else {
                try await FinderLocations.remove(id)
                appLog.info("finder: removed \(id, privacy: .public)")
            }
            problem = nil
        } catch {
            appLog.error("finder: \(id, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            problem = error.localizedDescription
        }
        inFinder = await FinderLocations.current()
    }

    func reveal(_ scope: SyncDomain) async {
        do { try await FinderLocations.reveal(scope.identifier) }
        catch { problem = error.localizedDescription }
    }

    func syncNow() async {
        await FinderLocations.syncAll()
        await refresh()
    }

    /// A drive you are no longer in (or that was deleted) should not linger
    /// in Finder as a location that can only ever say "no access".
    private func removeOrphans() async {
        let live = Set(drives.map { SyncDomain.drive(id: $0.id).identifier } + [SyncDomain.library.identifier])
        for id in inFinder where !live.contains(id) && SyncDomain(identifier: id) != nil {
            try? await FinderLocations.remove(id)
            appLog.info("finder: removed \(id, privacy: .public), no longer a drive of yours")
        }
        inFinder = await FinderLocations.current()
    }

    // MARK: - Launch arguments, for scripted testing

    /// `--server <address>` and `--pair <code>`: sign in without a click, so
    /// a build can be exercised end to end from a script. A pairing code is
    /// single-use and can only come from a signed-in web session, so this
    /// grants nothing that typing it into the window would not.
    func handleLaunchArguments(_ args: [String] = CommandLine.arguments) async {
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        if let s = value("--server") { await setServer(s) }
        if let code = value("--pair") { await pair(code: code) }
    }
}
