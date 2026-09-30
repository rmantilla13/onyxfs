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
    /// `drives` is the server's answer, not the empty list before one: the
    /// server may have been out of reach when the app opened.
    private(set) var drivesLoaded = false
    /// Whether the server treats this account as an admin; only decides
    /// which menu items are offered — the server enforces it either way.
    @Published private(set) var isAdmin = false
    /// What this account may do in the library, as the server says (nil
    /// from an older server): whether its disk is writable.
    @Published private(set) var libraryCan: WriteCaps?
    /// Drives being mounted or unmounted right now.
    @Published private(set) var busy: Set<String> = []
    /// The last thing that went wrong, for the window to say.
    @Published var problem: String?
    /// What the last failed refresh() said, so the one that works clears it
    /// and nothing else.
    private var listingProblem: String?
    @Published private(set) var server: URL

    let web: WebController
    let updater = Updater()
    /// Drives in Finder (streaming mounts) and files kept offline.
    let finder = DriveService()
    /// Transcripts requested on the web, made on this Mac.
    let transcriber = TranscriptionService()
    /// Streamable versions of heavy videos, made on this Mac.
    let proxies = ProxyService()
    /// Thumbnails the web is missing, made on this Mac.
    let thumbnailer = ThumbnailService()
    /// What redraws the activity graphs, wherever they show (ActivityClock).
    lazy var activity = ActivityClock(transfers: finder.transfers)
    private let settings = SharedSettings()
    /// Signed in as the app opened: bringing the drives back, in the
    /// background. Launch arguments that need the drives wait for it.
    private var startup: Task<Void, Never>?

    init() {
        let settings = SharedSettings()
        server = OnyxConfig.current.baseURL
        email = settings.email
        phase = TokenStore().get() == nil ? .signedOut : .signedIn
        web = WebController()
        web.model = self
        updater.model = self
        thumbnailer.attach(to: self)
        // After the thumbnails: each hears this Mac's uploads as they finish.
        proxies.attach(to: self)
        if phase == .signedIn { startup = Task { await afterSignIn() } }
        // A notice's Open System Settings: the Onyx file system's switch,
        // watched for coming on.
        SystemNotices.shared.openFileSystemSettings = { [weak finder = self.finder] in finder?.openFileSystemSettings() }
        // Back to Onyx from the browser, say, where a drive may have changed:
        // the drive list, and the drives' own ticks, catch up. Or from System
        // Settings, where the Onyx file system may have been switched on.
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.finder.noteActivity()
                self.finder.cameForward()
                Task { await self.refreshIfOlder(than: 30) }
            }
        }
        // Quitting unmounts every drive, so none is left for the system to
        // reap, and takes away downloads cut short.
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification,
                                               object: nil, queue: .main) { [finder, transcriber, proxies, thumbnailer, web] _ in
            MainActor.assumeIsolated {
                transcriber.stop()
                proxies.stop()
                thumbnailer.stop()
                finder.quit()
                web.downloads.discardUnfinished()
            }
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
        // The server refused the sign-in (tokenRejected): signed out now,
        // so there is no one to put drives in Finder for.
        guard phase == .signedIn else { return }
        transcriber.start(model: self)
        proxies.start(model: self)
        // A sign-in kept from before the account was recorded (0.2.0 did not
        // record it): the drive list usually names it, and if the server
        // could not be asked yet, this does.
        if !knowsAccount, let who = try? await api.me() { adoptAccount(who) }
        // Before the drives open, so it hears each one's first pass.
        thumbnailer.start()
        await finder.start(model: self)
        // Finder stops short without an account; refresh() starts it again
        // once one is known.
        finderWaitingForAccount = !knowsAccount
    }

    private var knowsAccount: Bool { !(email ?? "").isEmpty }

    /// Set by afterSignIn when the Finder bridge could not start for want of
    /// an account, so the refresh that learns it can start it.
    private var finderWaitingForAccount = false

    /// Record the signed-in account as the server names it, when this Mac
    /// does not know it. Offline copies and drive mirrors are kept per
    /// account, so without one no drive can be shown in Finder. An account
    /// already known is never replaced here: the token decides who is signed
    /// in, and that only changes by signing in.
    @discardableResult
    private func adoptAccount(_ who: String?) -> Bool {
        guard !knowsAccount,
              let address = who?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !address.isEmpty else { return false }
        email = address
        settings.email = address
        appLog.info("signed-in account learned from the server")
        return true
    }

    func signOut() async {
        try? await api.signOut()
        settings.email = nil
        email = nil
        finderWaitingForAccount = false
        drives = []
        drivesLoaded = false
        isAdmin = false
        libraryCan = nil
        phase = .signedOut
        transcriber.stop()
        proxies.stop()
        thumbnailer.stop()
        finder.stop()
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
        guard let typedURL = OnyxConfig.normalizedServer(typed) else {
            problem = "That is not a server address. Try something like onyxfs.io or localhost:3000."
            return false
        }
        let url = await Self.canonical(typedURL)
        guard url != server else { return true }
        if phase == .signedIn { await signOut() }
        settings.serverURL = url == OnyxConfig.production.baseURL ? nil : url
        server = url
        problem = nil
        return true
    }

    /// Where a typed address really lives. "onyxfs.io" redirects to
    /// "www.onyxfs.io", and a redirect to another host drops the
    /// Authorization header — every signed-in request would come back 401 and
    /// look like a revoked sign-in. So the address is settled once, here, by
    /// following it. Unreachable: kept as typed.
    static func canonical(_ url: URL) async -> URL {
        var request = URLRequest(url: url.appendingPathComponent("signin"))
        request.timeoutInterval = 8
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let final = response.url, var c = URLComponents(url: final, resolvingAgainstBaseURL: false)
        else { return url }
        c.path = ""
        c.query = nil
        c.fragment = nil
        return c.url ?? url
    }

    /// The server as an editable address: the full origin, never the short
    /// display label (which drops "www." and would point somewhere else).
    var serverAddress: String {
        let s = server.absoluteString
        return s.hasSuffix("/") ? String(s.dropLast()) : s
    }

    /// Called when the server says the token is no good any more.
    func tokenRejected() async {
        guard phase == .signedIn else { return }
        TokenStore().clear()
        settings.email = nil
        email = nil
        drivesLoaded = false
        phase = .signedOut
        problem = "Your sign-in on this Mac has expired or was revoked. Sign in again."
        transcriber.stop()
        proxies.stop()
        thumbnailer.stop()
        finder.stop()
        await web.signOut()
    }

    // MARK: - Drives and Finder

    /// Whether the library's disk is offered writable: when the server says
    /// what this account may do there, whether it may do anything; an older
    /// server does not, and then only an admin's is (as before). The server
    /// checks every write whatever this says.
    var libraryWritable: Bool { libraryCan?.anyWrite ?? isAdmin }

    func refresh() async {
        guard phase == .signedIn else { return }
        let account = email
        do {
            let listing = try await api.drives()
            // Signed out, or in as someone else, while it was asked for.
            guard phase == .signedIn, email == account else { return }
            drives = listing.drives.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            isAdmin = listing.isAdmin
            libraryCan = listing.library
            if adoptAccount(listing.email), finderWaitingForAccount {
                finderWaitingForAccount = false
                thumbnailer.start()
                await finder.start(model: self)
            }
            drivesLoaded = true
            drivesRefreshedAt = Date()
            if problem == listingProblem { problem = nil }
            listingProblem = nil
        } catch OnyxError.notAuthenticated {
            // A sign-out meanwhile takes the token away too; only the
            // sign-in this was asked under is the one refused.
            guard email == account else { return }
            await tokenRejected()
            return
        } catch {
            guard email == account else { return }
            problem = error.localizedDescription
            listingProblem = problem
            return
        }
        // A drive with a new colour or name: its disk's icon follows.
        finder.drivesChanged()
        // The drives wanted in Finder that are not there yet — all of them,
        // when this is the first list since the server came within reach.
        await finder.mountWanted()
    }

    /// The drives Finder can show: the ones whose files are yours to see.
    var finderDrives: [Filespace] { drives.filter(\.isMember) }

    /// When the drive list last came.
    private(set) var drivesRefreshedAt = Date.distantPast

    /// The drive list again, if it is older than `age` seconds: a drive
    /// given a new colour or name on the web shows here, and on its disk in
    /// Finder, without a request each time the panel opens or Onyx comes
    /// forward.
    func refreshIfOlder(than age: TimeInterval) async {
        guard phase == .signedIn, drivesLoaded, Date().timeIntervalSince(drivesRefreshedAt) > age else { return }
        await refresh()
    }

    func isMounted(_ scope: SyncDomain) -> Bool { finder.isMounted(scope) }

    func setMounted(_ scope: SyncDomain, name: String, _ on: Bool) async {
        // Already on its way: a second "Show in Finder" from the page, sent
        // before the first had finished.
        guard !busy.contains(scope.identifier) else { return }
        busy.insert(scope.identifier)
        defer { busy.remove(scope.identifier) }
        await finder.setMounted(scope, name: name, on)
        if on, let reveal = finder.mountState(of: scope), case .mounted = reveal { finder.reveal(scope) }
    }

    func reveal(_ scope: SyncDomain) { finder.reveal(scope) }

    func syncNow() async {
        await refresh()
        await finder.syncNow()
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
        // `--keep-offline <drive.id|library>`: what the Offline checkbox does.
        if let scope = value("--keep-offline") {
            // Signed in already as the app opened: the store the rule goes
            // in opens as the drives come back (init), which is not done yet
            // as the window appears. Without the wait the rule would land
            // on no store at all.
            await startup?.value
            await finder.pin(PinRule(scope: scope, target: .folder(path: "")))
        }
        // `--mount <drive id>`: what Show in Finder does — a disk of its own
        // where this Mac can, else ~/Onyx — once the drives are listed.
        if let id = value("--mount") {
            await startup?.value
            if !drivesLoaded { await refresh() }
            if let drive = finderDrives.first(where: { $0.id == id }) {
                await setMounted(.drive(id: drive.id), name: drive.name, true)
            } else {
                appLog.error("--mount: no drive \(id, privacy: .public) to mount")
            }
        }
        // Where to look for updates, instead of the server — for trying the
        // updater against a local feed. What it installs is verified the same.
        updater.start(feed: value("--update-feed").flatMap(URL.init(string:)))
        #if DEBUG
        // `--demo-activity`: pretend traffic and downloads in the Activity
        // bar, for looking at it without disks (a debug build has none
        // unsigned).
        if args.contains("--demo-activity") {
            ActivityDemo.start(finder.transfers)
            web.downloads.demo()
        }
        // `--demo-work <seconds>`: work in flight for that long, then none —
        // for watching Onyx leave App Nap and go back (WorkActivity) with
        // nobody signed in.
        if let seconds = value("--demo-work").flatMap(Double.init) {
            let hold = WorkActivity.app.begin(.transfers)
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { hold.end() }
        }
        #endif
    }
}
