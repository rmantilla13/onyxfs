import Foundation
import AppKit
import Combine
import WebKit
import OnyxKit

/// The workspace window's web view: the whole of Onyx — files, search,
/// previews, sharing, drives, admin — as the web has it, signed in from this
/// Mac's device token.
///
/// What is native around it is what a browser tab cannot do: sign in without
/// a second email, keep the session alive by itself, save downloads where a
/// Mac saves them, open other sites in the default browser, and put drives in
/// Finder (the rest of the app).
@MainActor
final class WebController: NSObject, ObservableObject {
    weak var model: AppModel? {
        didSet {
            followFinder()
            downloads.transfers = model?.finder.transfers
        }
    }
    let webView: OnyxWebView
    /// What the web's Download buttons save, for the Activity bar to show.
    let downloads = WebDownloads()

    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false
    @Published private(set) var title = "Onyx"
    /// Set when the workspace could not be opened; the window says so, with a
    /// way to try again, rather than showing a blank page.
    @Published var failure: String?

    private var observations: [NSKeyValueObservation] = []
    private var lastHandoff: Date?
    /// The window's title bar, as the page lays its bar out to it.
    private var chrome: WindowChrome.Metrics?
    private var following: Set<AnyCancellable> = []

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // Appended to Safari's own user agent, so the web can tell it is in
        // the app without anything else about the page changing.
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        config.applicationNameForUserAgent = "OnyxMac/\(version)"
        config.preferences.isElementFullscreenEnabled = true
        // window.onyxMac: how the page, inside the app, keeps files offline
        // and puts drives in Finder. Defined before any page script runs.
        config.userContentController.addUserScript(Self.bridge(chrome: nil))
        let relay = MessageRelay()
        config.userContentController.add(relay, name: "onyx")
        webView = OnyxWebView(frame: .zero, configuration: config)
        super.init()
        relay.controller = self
        downloads.webView = webView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.setValue(false, forKey: "drawsBackground")
        observations = [
            webView.observe(\.canGoBack, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in self?.canGoBack = v.canGoBack; self?.publishOfflineState() }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in self?.canGoForward = v.canGoForward; self?.publishOfflineState() }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in self?.isLoading = v.isLoading }
            },
            webView.observe(\.title, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in
                    let title = (v.title?.isEmpty == false ? v.title : nil) ?? "Onyx"
                    self?.title = title
                    // Hidden in the window, but Mission Control and the
                    // Window menu name it by this (WindowChrome).
                    v.window?.title = title
                }
            },
        ]
    }

    private var server: URL? { model?.server }

    // MARK: - Session

    /// Open the workspace. A session from an earlier launch is used if it is
    /// still good; if the web answers with its sign-in page instead, the
    /// navigation delegate hands off from the device token (below).
    func signIn(path: String = "/files") {
        failure = nil
        go(path)
    }

    /// Mint a web session from the device token and load it: the one-time
    /// code, and its secret planted as a cookie first (WebHandoff).
    private func handoff(next: String) async {
        guard let model, let server else { return }
        lastHandoff = Date()
        do {
            let (secret, challenge) = WebHandoff.makeSecret()
            let link = try await model.api.webSession(challenge: challenge, next: next)
            guard let cookie = WebHandoff.cookie(secret: secret, server: server),
                  let url = link.resolved(against: server) else { return }
            await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
            webView.load(URLRequest(url: url))
            appLog.info("web: handing off to \(next, privacy: .public)")
        } catch OnyxError.notAuthenticated {
            await model.tokenRejected()
        } catch {
            failure = "Onyx could not open your workspace: \(error.localizedDescription)"
            appLog.error("web: handoff failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Forget the web session and everything the web view kept.
    func signOut() async {
        let store = webView.configuration.websiteDataStore
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let records = await store.dataRecords(ofTypes: types)
        await store.removeData(ofTypes: types, for: records)
        webView.loadHTMLString("", baseURL: nil)
        lastHandoff = nil
        // The blank page says nothing (it is not the server's): its
        // uploads, if any were under way, stopped with the page.
        WorkActivity.app.set(.pageUploads, false)
    }

    // MARK: - Navigation

    func go(_ path: String) {
        guard let server, let url = URL(string: path, relativeTo: server) else { return }
        webView.load(URLRequest(url: url))
    }

    func back() { webView.goBack() }
    func forward() { webView.goForward() }
    func reload() {
        failure = nil
        if webView.url == nil || webView.url?.absoluteString == "about:blank" { signIn() } else { webView.reload() }
    }

    /// The web's own ⌘K, from the menu bar: the page listens for the key.
    func openSearch() {
        webView.evaluateJavaScript("""
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
        """)
    }

    // MARK: - The page's bridge to the app

    /// `window.onyxMac` in the page. Calls post to the app; the app answers by
    /// pushing its state (`_update`), which fires an `onyxmac:state` event the
    /// page listens for. Present only in the app, so the web shows its
    /// offline and Finder actions only here.
    static func bridge(chrome: WindowChrome.Metrics?) -> WKUserScript {
        // Until the window is known, a unified title bar's usual size.
        let metrics = chrome ?? WindowChrome.Metrics(left: 78, height: 52, fullScreen: false)
        let json = (try? JSONSerialization.data(withJSONObject: metrics.json)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        return WKUserScript(source: bridgeScript.replacingOccurrences(of: "__CHROME__", with: json),
                            injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    private static let bridgeScript = """
    (() => {
      if (window.onyxMac) return;
      const post = (msg) => window.webkit.messageHandlers.onyx.postMessage(msg);
      const state = { pinned: [], mounted: [], pinnedFolders: [], chrome: null, nav: null, finder: null };
      // The bar is the window's title bar: laid out by CSS from the first
      // paint, so nothing shifts when the page's scripts arrive.
      const root = document.documentElement;
      const lay = (c) => {
        if (!root || !c) return;
        root.style.setProperty('--mac-left', `${c.left}px`);
        root.style.setProperty('--mac-bar-h', `${c.height}px`);
        root.toggleAttribute('data-mac-fullscreen', !!c.fullScreen);
      };
      root?.setAttribute('data-mac-app', '');
      lay(__CHROME__);
      window.onyxMac = {
        version: 2,
        get state() { return state; },
        pinFiles: (ids, drive) => post({ type: 'pinFiles', ids, drive: drive || null, on: true }),
        unpinFiles: (ids, drive) => post({ type: 'pinFiles', ids, drive: drive || null, on: false }),
        pinFolder: (path, drive, on = true) => post({ type: 'pinFolder', path, drive: drive || null, on }),
        showInFinder: (drive, name) => post({ type: 'mount', drive: drive || null, name: name || '', on: true }),
        setMounted: (drive, on, name) => post({ type: 'mount', drive: drive || null, name: name || '', on: !!on }),
        reveal: (drive) => post({ type: 'reveal', drive: drive || null }),
        syncNow: () => post({ type: 'syncNow' }),
        goBack: () => post({ type: 'navigate', to: 'back' }),
        goForward: () => post({ type: 'navigate', to: 'forward' }),
        // The bar and its controls, in CSS pixels: between the controls, a
        // drag moves the window.
        setBar: (bar, holes) => post({ type: 'bar', bar: bar || null, holes: holes || [] }),
        transcribe: (fileId) => post({ type: 'transcribe', fileId: String(fileId || '') }),
        // The page's own uploads under way, or not: the app stays out of
        // App Nap meanwhile, so they keep their speed with the window closed.
        uploading: (on) => post({ type: 'uploads', active: !!on }),
        _update: (next) => {
          Object.assign(state, next);
          if (next.chrome) lay(next.chrome);
          window.dispatchEvent(new CustomEvent('onyxmac:state', { detail: state }));
        },
      };
      post({ type: 'ready' });
    })();
    """

    /// Tell the page what is pinned and mounted now, and what this Mac is
    /// transcribing.
    func publishOfflineState() {
        guard let finder = model?.finder, let transcriber = model?.transcriber else { return }
        let folders = finder.pinRules.compactMap { rule -> [String: String]? in
            if case let .folder(path) = rule.target { return ["scope": rule.scope, "path": path] }
            return nil
        }
        var payload: [String: Any] = [
            "pinned": Array(finder.pinnedFiles),
            "pinnedFolders": folders,
            "mounted": finder.wantMounted.sorted(),
            "nav": ["canGoBack": webView.canGoBack, "canGoForward": webView.canGoForward],
            "finder": finderState(),
            "transcriber": ["enabled": transcriber.enabled, "busy": transcriber.busyFileId ?? NSNull()] as [String: Any],
        ]
        if let chrome { payload["chrome"] = chrome.json }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.onyxMac && window.onyxMac._update(\(json))")
    }

    /// The drives Finder can show and how each is doing, for the bar's
    /// Finder menu — the same list as the menu bar's.
    private func finderState() -> [String: Any] {
        guard let model else { return [:] }
        var states: [String: Any] = [:]
        for scope in [SyncDomain.library] + model.finderDrives.map({ SyncDomain.drive(id: $0.id) }) {
            switch model.finder.mountState(of: scope) {
            case .mounting?: states[scope.identifier] = ["state": "mounting"]
            case .mounted?: states[scope.identifier] = ["state": "mounted"]
            case let .failed(message)?: states[scope.identifier] = ["state": "failed", "message": message]
            case nil: break
            }
        }
        return [
            "drives": model.finderDrives.map { ["id": $0.id, "name": $0.name, "role": $0.role ?? ""] },
            "states": states,
            "busy": model.busy.sorted(),
        ]
    }

    /// Mounts starting, finishing and failing, and the drive list changing,
    /// reach the page's Finder menu — gathered, since one change fires many.
    private func followFinder() {
        following = []
        guard let model else { return }
        model.finder.objectWillChange.merge(with: model.objectWillChange)
            .debounce(for: .milliseconds(150), scheduler: RunLoop.main)
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.publishOfflineState() } }
            .store(in: &following)
    }

    /// The window moved into or out of full screen, or first appeared.
    func windowChanged(_ window: NSWindow) {
        WindowChrome.apply(to: window)
        window.title = title
        let next = WindowChrome.metrics(of: window)
        webView.titlebarHeight = next.height
        webView.needsLayout = true
        guard next != chrome else { return }
        chrome = next
        // The next page loaded lays its bar out right from the first paint.
        let scripts = webView.configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(Self.bridge(chrome: next))
        publishOfflineState()
    }

    fileprivate func received(_ body: Any) {
        guard let msg = body as? [String: Any], let type = msg["type"] as? String, let model else { return }
        let drive = msg["drive"] as? String
        let scope = drive.map { SyncDomain.drive(id: $0).identifier } ?? SyncDomain.library.identifier
        let on = msg["on"] as? Bool ?? true
        Task { @MainActor in
            switch type {
            case "ready":
                // A page of its own, with no uploads of its own yet: whatever
                // the one before said has gone with it.
                WorkActivity.app.set(.pageUploads, false)
                publishOfflineState()
            case "pinFiles":
                let ids = (msg["ids"] as? [Any] ?? []).compactMap { $0 as? String }.prefix(5000)
                await model.finder.pinFiles(Array(ids), scope: drive == nil ? nil : scope, on)
            case "pinFolder":
                guard let path = msg["path"] as? String else { return }
                let rule = PinRule(scope: scope, target: .folder(path: path))
                if on { await model.finder.pin(rule) } else { await model.finder.unpin(rule) }
            case "mount":
                let name = (msg["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? model.finderDrives.first { SyncDomain.drive(id: $0.id).identifier == scope }?.name ?? "Library"
                await model.setMounted(SyncDomain(identifier: scope) ?? .library, name: name, on)
            case "reveal":
                model.reveal(SyncDomain(identifier: scope) ?? .library)
            case "syncNow":
                await model.syncNow()
            case "navigate":
                if msg["to"] as? String == "forward" { forward() } else { back() }
                return
            case "bar":
                webView.bar = Self.rect(msg["bar"])
                webView.holes = (msg["holes"] as? [Any] ?? []).prefix(200).compactMap(Self.rect)
                return
            case "transcribe":
                // A nudge after the page asked for a transcript: the queue
                // is read now instead of at the next poll. The server says
                // which jobs there are, so the id is not needed here.
                model.transcriber.pollNow()
            case "uploads":
                // The page's uploads (window.onyxMac.uploading): work in
                // flight while it says so (WorkActivity).
                WorkActivity.app.set(.pageUploads, msg["active"] as? Bool ?? false)
                return
            default:
                break
            }
            publishOfflineState()
        }
    }

    /// `[x, y, width, height]` from the page.
    private static func rect(_ value: Any?) -> CGRect? {
        guard let n = value as? [NSNumber], n.count == 4 else { return nil }
        let r = CGRect(x: n[0].doubleValue, y: n[1].doubleValue, width: n[2].doubleValue, height: n[3].doubleValue)
        return r.width.isFinite && r.height.isFinite && r.width >= 0 && r.height >= 0 ? r : nil
    }

    fileprivate func acceptsMessages(from url: URL) -> Bool { isOnServer(url) }

    private func isOnServer(_ url: URL) -> Bool {
        guard let server else { return false }
        return url.host == server.host && url.port == server.port && url.scheme == server.scheme
    }
}

// MARK: - WKNavigationDelegate

extension WebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        guard let url = action.request.url else { return (.cancel, preferences) }
        if action.shouldPerformDownload { return (downloadPolicy(for: url), preferences) }

        // mailto:, tel:, another app's scheme: not the web view's to open.
        if let scheme = url.scheme?.lowercased(), !["http", "https", "about", "blob", "data"].contains(scheme) {
            NSWorkspace.shared.open(url)
            return (.cancel, preferences)
        }

        // The web's "Sign out" is a link to Auth.js's sign-out page. In the
        // app it signs this Mac out — otherwise the next page load would hand
        // straight back in from the device token and it would appear to do
        // nothing.
        if isOnServer(url), url.path.hasPrefix("/api/auth/signout") {
            if confirm("Sign out of Onyx on this Mac?",
                       detail: "Drives stay in Finder and ask you to sign in again.",
                       action: "Sign Out") {
                await model?.signOut()
            }
            return (.cancel, preferences)
        }

        // The web's download links — a file's, and a share link's — answer
        // with a redirect to the storage host. WebKit reports that redirect
        // as a clicked link to another site, which the rule below would send
        // to the browser — so the download is taken as one from the start,
        // and follows the redirect itself.
        if isOnServer(url), url.path.range(of: #"^/(api/files|s)/[^/]+/download$"#, options: .regularExpression) != nil {
            return (downloadPolicy(for: url), preferences)
        }

        // A link to somewhere else, clicked: the default browser, not here.
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        if mainFrame, action.navigationType == .linkActivated, !isOnServer(url) {
            NSWorkspace.shared.open(url)
            return (.cancel, preferences)
        }
        return (.allow, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if let http = response.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().hasPrefix("attachment") {
            return .download
        }
        if response.isForMainFrame, !response.canShowMIMEType { return .download }

        // The web sent us to its sign-in page: the session is missing or
        // expired. Hand off from the device token instead of showing a form
        // whose email link would open in some other browser. At most once a
        // minute, so a server that keeps refusing cannot loop us.
        if response.isForMainFrame, let url = response.response.url, isOnServer(url),
           url.path == "/signin" || url.path.hasPrefix("/signin/"), model?.phase == .signedIn {
            if lastHandoff.map({ Date().timeIntervalSince($0) > 60 }) ?? true {
                Task { await handoff(next: "/files") }
            } else {
                failure = "Onyx could not sign this window in. Try again, or sign out and back in."
            }
            return .cancel
        }
        return .allow
    }

    /// A download, unless that one is under way already: a second click
    /// shows it in the Activity bar rather than saving the file twice.
    private func downloadPolicy(for url: URL) -> WKNavigationActionPolicy {
        downloads.showIfRunning(url) ? .cancel : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads.adopt(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads.adopt(download)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failure = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        // A navigation cancelled on purpose (above) is not a failure.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return } // frame load interrupted by a download
        failure = ns.domain == NSURLErrorDomain
            ? "Onyx is not reachable at \(model?.serverLabel ?? "the server"): \(error.localizedDescription)"
            : error.localizedDescription
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Its uploads went with it.
        WorkActivity.app.set(.pageUploads, false)
        webView.reload()
    }
}

// MARK: - WKUIDelegate

extension WebController: WKUIDelegate {
    /// `<input type=file>`, including the web's "Upload folder".
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.prompt = "Upload"
        if let window = webView.window {
            panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    /// `target=_blank` and window.open: this site in this window, anything
    /// else in the default browser. The app has one workspace window.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isOnServer(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        confirm(message, detail: nil, action: "OK")
    }

    private func confirm(_ message: String, detail: String?, action: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        if let detail { alert.informativeText = detail }
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

/// WKUserContentController holds its handlers strongly; this breaks the
/// cycle it would make with the controller that owns the web view.
private final class MessageRelay: NSObject, WKScriptMessageHandler {
    weak var controller: WebController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the Onyx page, in the main frame, may ask for anything.
        guard message.frameInfo.isMainFrame else { return }
        let body = message.body
        MainActor.assumeIsolated {
            guard let controller, let url = message.frameInfo.request.url, controller.acceptsMessages(from: url) else { return }
            controller.received(body)
        }
    }
}
