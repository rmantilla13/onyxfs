import AuthenticationServices
import OnyxKit
import SwiftUI
import UIKit

/// A place to browse: a drive this account belongs to, or everything it may
/// see (the web's All Files).
struct Place: Hashable, Identifiable, Sendable {
    let scope: SyncDomain
    let name: String
    /// viewer | editor | owner, for a drive; nil for All Files.
    let role: String?
    /// The drive's own colour, "#RRGGBB" — the dot beside its name on the
    /// web. Nil for All Files, and from an older server.
    var color: String? = nil

    var id: String { scope.identifier }
    var isLibrary: Bool { scope == .library }

    static let library = Place(scope: .library, name: "All Files", role: nil)
}

/// Who is signed in, to which server, and the places they may open.
///
/// Sign-in is the device sign-in the Mac uses: the web's own page in a
/// sign-in sheet (PKCE, so a code caught on the way is useless), or a pairing
/// code made on the web. The token goes to the Keychain (TokenStore), where
/// the Files app extension can read it too.
@MainActor @Observable
final class Session {
    enum Phase { case signedOut, signedIn }

    private(set) var phase: Phase
    private(set) var server: URL
    private(set) var email: String?
    private(set) var drives: [Place] = []
    /// Starred folders, oldest first — the sidebar's shortcuts, the web's
    /// own (/api/stars). Only those in a place listed here show.
    private(set) var stars: [FolderStar] = []
    private(set) var isAdmin = false
    /// Whether this account may share by link at all: the `shares` flag as
    /// the web's menus read it for them (/api/space/filespaces). The other
    /// half is each file's or folder's own (mayLink).
    private(set) var sharing = false
    private(set) var loadingPlaces = false
    private(set) var placesLoaded = false
    private(set) var signingIn = false
    /// What went wrong last, in words for the screen it happened on.
    var problem: String?
    /// The account, with the name it gave itself, for the Home's greeting.
    private(set) var identity: Identity?
    /// What each place holds for this account (Place.id), as the listing
    /// counts it: the Home's cards and storage, the drive list's lines.
    private(set) var usage: [String: PlaceUsage] = [:]
    /// When the places were last counted, and which they were.
    private var usageAsked: (at: Date, places: Set<String>)?

    private(set) var api: OnyxAPI
    private var auth: AuthClient
    private let tokens = TokenStore()
    private let settings = SharedSettings()
    /// The sign-in sheet's work, until its code comes back.
    private var sheet: Task<Void, Never>?
    private var started = false
    /// Each place's folders: fetched on the first visit, again on refresh.
    private var trees: [String: [FolderNode]] = [:]

    /// Where a sign-in's PKCE verifier waits for its code. In the Keychain,
    /// not memory: on a phone the magic link opens from Mail into Safari,
    /// and the code comes back through onyxfs:// — perhaps after iOS has
    /// ended the app that asked for it.
    private static let verifierAccount = "pkce-verifier"

    init() {
        let config = OnyxConfig.current
        server = config.baseURL
        api = OnyxAPI(config: config)
        auth = AuthClient(config: config)
        phase = TokenStore().get() == nil ? .signedOut : .signedIn
        email = SharedSettings().email
    }

    /// "www.onyxfs.io", as a person would say it.
    var serverName: String { server.host() ?? server.absoluteString }

    /// What the device list on the web calls this one.
    static var deviceLabel: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

    // MARK: - Launch

    /// `--server <address>` and `--pair <code>`: sign in without a tap, so a
    /// build can be exercised from a script (`xcrun simctl launch … --pair
    /// CODE`), as the Mac app can. A pairing code is single-use and only a
    /// signed-in web session can make one, so this grants nothing that
    /// typing it would not.
    func start(arguments: [String]) async {
        guard !started else { return }
        started = true
        func value(_ flag: String) -> String? {
            guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }
            return arguments[i + 1]
        }
        if let typed = value("--server"), let url = OnyxConfig.normalizedServer(typed), url != server {
            // A token is for the server that issued it.
            if phase == .signedIn { forget() }
            setServer(typed)
        }
        if let code = value("--pair"), phase == .signedOut { await pair(code: code) }
        if phase == .signedIn { await loadPlaces() }
    }

    // MARK: - Server

    /// Point this install at another Onyx — a self-hosted one, or a test
    /// server. Only while signed out: a token is good at its own server only.
    @discardableResult
    func setServer(_ typed: String) -> Bool {
        guard phase == .signedOut, let url = OnyxConfig.normalizedServer(typed) else { return false }
        settings.serverURL = url == OnyxConfig.production.baseURL ? nil : url
        let config = OnyxConfig(baseURL: url)
        server = url
        api = OnyxAPI(config: config)
        auth = AuthClient(config: config)
        problem = nil
        return true
    }

    // MARK: - Signing in

    /// The web's sign-in in a sheet. The magic link may instead be opened
    /// from Mail, in Safari; its code then comes back through onyxfs://
    /// (handle(callback:)), and this sheet is closed for the person.
    func signIn(with web: WebAuthenticationSession) {
        guard !signingIn else { return }
        problem = nil
        let (url, verifier) = auth.authorizeURL(label: Self.deviceLabel)
        try? tokens.set(verifier, for: Self.verifierAccount)
        signingIn = true
        sheet = Task {
            defer { signingIn = false; sheet = nil }
            do {
                let callback = try await web.authenticate(using: url, callback: .customScheme(OnyxIdentifiers.urlScheme),
                                                          preferredBrowserSession: .shared, additionalHeaderFields: [:])
                await finish(callback)
            } catch {
                // Closed by the person — or by a sign-in finished in Safari.
                if phase == .signedOut, !Self.isCancel(error) { problem = Self.words(for: error) }
            }
        }
    }

    /// onyxfs://callback?code=…, from a sign-in finished outside the sheet.
    func handle(callback url: URL) {
        guard url.scheme == OnyxIdentifiers.urlScheme, phase == .signedOut else { return }
        Task { await finish(url) }
    }

    private func finish(_ callback: URL) async {
        guard phase == .signedOut, let code = AuthClient.code(from: callback) else { return }
        guard let verifier = tokens.get(Self.verifierAccount) else {
            problem = "That sign-in was started somewhere else. Sign in again from here."
            return
        }
        tokens.clear(Self.verifierAccount)
        do {
            let token = try await auth.exchange(code: code, verifier: verifier, label: Self.deviceLabel)
            signedIn(as: token.email)
        } catch {
            problem = Self.words(for: error)
        }
    }

    /// A code from the web's pairing page (/space/pair).
    func pair(code: String) async {
        guard phase == .signedOut, !signingIn else { return }
        problem = nil
        signingIn = true
        defer { signingIn = false }
        do {
            let token = try await auth.pair(code: code, label: Self.deviceLabel)
            signedIn(as: token.email)
        } catch {
            problem = Self.words(for: error)
        }
    }

    private func signedIn(as address: String) {
        email = address
        phase = .signedIn
        sheet?.cancel()
        Task { await loadPlaces() }
    }

    /// Signs this device out on the server too, so its token stops working
    /// everywhere, then forgets everything it kept.
    func signOut() async {
        try? await api.signOut()
        forget()
        await ThumbnailStore.shared.removeAll()
        await PreviewLinks.shared.removeAll()
        PreviewFiles.removeAll()
        DownloadCenter.shared.removeAll()
    }

    /// Everything of the signed-in account, forgotten here.
    private func forget() {
        tokens.clear()
        settings.email = nil
        email = nil
        drives = []
        stars = []
        isAdmin = false
        sharing = false
        trees = [:]
        identity = nil
        usage = [:]
        usageAsked = nil
        placesLoaded = false
        phase = .signedOut
    }

    // MARK: - Places

    func loadPlaces() async {
        guard phase == .signedIn, !loadingPlaces else { return }
        loadingPlaces = true
        defer { loadingPlaces = false }
        do {
            let (list, admin, address, _, shares) = try await api.drives()
            drives = list.filter(\.isMember)
                .map { Place(scope: .drive(id: $0.id), name: $0.name, role: $0.role, color: $0.color) }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            isAdmin = admin
            sharing = shares
            if let address {
                email = address
                settings.email = address
            }
            placesLoaded = true
            problem = nil
        } catch {
            failed(error)
            return
        }
        // Stars are shortcuts: without them the drives still open, so a
        // failure here keeps the last list rather than saying anything.
        if let list = try? await api.stars() { stars = list }
    }

    // MARK: - Starred folders

    /// The place a star opens in, while it is one of this account's.
    func place(for star: FolderStar) -> Place? {
        star.scope == .library ? .library : drives.first { $0.scope == star.scope }
    }

    func isStarred(_ route: FolderRoute) -> Bool {
        stars.contains(FolderStar(scope: route.place.scope, folder: route.folder))
    }

    /// Star or unstar a folder. It shows at once, and goes back if the server
    /// refuses; the refusal comes back in words.
    func setStarred(_ route: FolderRoute, _ starred: Bool) async -> String? {
        let star = FolderStar(scope: route.place.scope, folder: route.folder)
        let before = stars
        if starred { if !stars.contains(star) { stars.append(star) } }
        else { stars.removeAll { $0 == star } }
        do {
            stars = try await api.setStar(star, starred: starred)
            return nil
        } catch {
            stars = before
            return explain(error)
        }
    }

    /// Who is signed in, and what every place holds: asked together, each
    /// place at once — at most once a minute for the same places, unless
    /// `refresh`. A place that cannot be counted keeps what it last said.
    func loadOverview(refresh: Bool = false) async {
        guard phase == .signedIn, placesLoaded else { return }
        let places = drives + [Place.library]
        let ids = Set(places.map(\.id))
        if !refresh, let asked = usageAsked, asked.places == ids, Date().timeIntervalSince(asked.at) < 60 { return }
        usageAsked = (Date(), ids)
        let api = api
        async let who = try? api.identity()
        let counted = await withTaskGroup(of: (String, PlaceUsage?).self) { group in
            for place in places {
                group.addTask { (place.id, try? await api.usage(of: place.scope)) }
            }
            var out: [String: PlaceUsage] = [:]
            for await (id, usage) in group { if let usage { out[id] = usage } }
            return out
        }
        usage.merge(counted) { _, new in new }
        if let identity = await who { self.identity = identity }
    }

    /// Whether to offer Share Link… for a file: this account may share at
    /// all, and the file's links are theirs to manage (the listing's
    /// `can.share` — write access to it, as the link routes require). What
    /// kind of link, if any, may then be made is the sheet's to ask.
    func mayLink(_ file: FileItem) -> Bool { sharing && file.can?.share == true }

    /// The same for a folder, whose half is the tree's (`share`).
    func mayLink(_ folder: FolderNode) -> Bool { sharing && folder.share == true }

    /// Every folder in `place`, from the first visit on; asked again only
    /// when `refresh`.
    func folders(in place: Place, refresh: Bool = false) async throws -> [FolderNode] {
        if !refresh, let tree = trees[place.id] { return tree }
        let tree = try await api.folders(in: place.scope)
        trees[place.id] = tree
        return tree
    }

    // MARK: - Errors

    /// An error from a request made while signed in, in words for the
    /// screen it happened on. A 401 means the token no longer works — signed
    /// out or revoked on the web — so this signs out here too, rather than
    /// show drives with nothing in them.
    func explain(_ error: Error) -> String {
        if case OnyxError.notAuthenticated = error {
            forget()
            problem = "You were signed out. Sign in again to see your drives."
            return problem ?? ""
        }
        return Self.words(for: error)
    }

    private func failed(_ error: Error) {
        problem = explain(error)
    }

    static func words(for error: Error) -> String {
        switch error {
        case let OnyxError.http(status, message):
            if let message, !message.isEmpty { return message }
            return status == 0 ? "Onyx could not be reached." : "Onyx answered \(status)."
        case let url as URLError:
            switch url.code {
            case .notConnectedToInternet, .networkConnectionLost: return "You're offline."
            case .timedOut: return "Onyx took too long to answer."
            case .cannotFindHost, .cannotConnectToHost: return "Onyx could not be reached."
            default: return url.localizedDescription
            }
        default:
            return error.localizedDescription
        }
    }

    static func isCancel(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let auth = error as? ASWebAuthenticationSessionError, auth.code == .canceledLogin { return true }
        return (error as? URLError)?.code == .cancelled
    }
}
