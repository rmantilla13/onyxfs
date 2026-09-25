import Foundation
import AppKit
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
    weak var model: AppModel?
    let webView: WKWebView

    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false
    @Published private(set) var title = "Onyx"
    /// Set when the workspace could not be opened; the window says so, with a
    /// way to try again, rather than showing a blank page.
    @Published var failure: String?
    /// The last download, for a moment of feedback.
    @Published private(set) var lastDownload: URL?

    private var observations: [NSKeyValueObservation] = []
    private var lastHandoff: Date?

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // Appended to Safari's own user agent, so the web can tell it is in
        // the app without anything else about the page changing.
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        config.applicationNameForUserAgent = "OnyxMac/\(version)"
        config.preferences.isElementFullscreenEnabled = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.setValue(false, forKey: "drawsBackground")
        observations = [
            webView.observe(\.canGoBack, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in self?.canGoBack = v.canGoBack }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in self?.canGoForward = v.canGoForward }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in self?.isLoading = v.isLoading }
            },
            webView.observe(\.title, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in self?.title = (v.title?.isEmpty == false ? v.title : nil) ?? "Onyx" }
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
            guard let cookie = WebHandoff.cookie(secret: secret, server: server) else { return }
            await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
            webView.load(URLRequest(url: link.url))
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
        if action.shouldPerformDownload { return (.download, preferences) }

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

        // A link to somewhere else, clicked: the default browser, not here.
        // (Not redirects or subresources — a download that bounces through
        // the storage's own host must still happen in the view.)
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

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
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

// MARK: - WKDownloadDelegate

extension WebController: WKDownloadDelegate {
    /// Into Downloads, as Safari would, never over an existing file.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let name = suggestedFilename.isEmpty ? "Download" : suggestedFilename
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        lastDownload = candidate
        return candidate
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = lastDownload else { return }
        // Bounces the Downloads stack in the Dock, as a finished download
        // in Safari does.
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"),
                                                     object: file.resolvingSymlinksInPath().path)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        model?.problem = "The download did not finish: \(error.localizedDescription)"
    }
}
