import Foundation
import AppKit
import CryptoKit
import Security
import OnyxKit

/// Keeping Onyx up to date.
///
/// Asks the server it is pointed at for the newest Mac release
/// (`/api/desktop/mac/latest`), at launch and every six hours, and whenever
/// someone chooses Check for Updates. A newer one is offered in the window;
/// installing it downloads the zipped app and replaces this one in place,
/// then relaunches.
///
/// Nothing is installed on the feed's word alone. The download must match
/// the checksum the release published, and the app inside it must be signed
/// by the same Apple Developer team as the copy that is running, with the
/// same bundle identifier — the same test Gatekeeper applies, so a
/// compromised feed or a swapped file cannot slip in something else. An
/// unsigned build cannot make that check about anything, so it only offers
/// to open the download.
@MainActor
final class Updater: ObservableObject {
    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case available(MacRelease)
        case downloading(Double)
        case installing
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    /// Whether the window should show the update sheet.
    @Published var showSheet = false
    @Published var automatic: Bool {
        didSet { defaults.set(automatic, forKey: "update.automatic") }
    }

    weak var model: AppModel?
    private let defaults = UserDefaults.standard
    private var timer: Timer?
    private var feedOverride: URL?

    init() {
        automatic = defaults.object(forKey: "update.automatic") as? Bool ?? true
    }

    var available: MacRelease? {
        if case let .available(r) = state { return r }
        return nil
    }

    /// Whether an update can be installed in place, rather than downloaded.
    var canInstall: Bool { requirement != nil && installLocationWritable }

    func start(feed: URL? = nil) {
        feedOverride = feed
        // Not at the very moment of launch: signing in and opening the
        // workspace come first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            Task { await self?.check(userInitiated: false) }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 6 * 60 * 60, repeats: true) { [weak self] _ in
            Task { await self?.check(userInitiated: false) }
        }
    }

    // MARK: - Checking

    func check(userInitiated: Bool) async {
        if !userInitiated && !automatic { return }
        switch state {
        case .checking, .downloading, .installing: return
        default: break
        }
        state = .checking
        do {
            guard let release = try await fetchLatest(), release.runs() else {
                state = .upToDate
                if userInitiated { showSheet = true }
                return
            }
            let newer = AppVersion.isNewer(release.version, build: release.build,
                                           than: BuildInfo.version, currentBuild: BuildInfo.build)
            guard newer else {
                state = .upToDate
                if userInitiated { showSheet = true }
                return
            }
            state = .available(release)
            // A version someone chose to skip is still offered when they ask.
            if userInitiated || defaults.string(forKey: "update.skipped") != release.version {
                showSheet = true
            }
            appLog.info("update: \(release.version, privacy: .public) is available")
        } catch {
            state = userInitiated ? .failed("Could not check for updates: \(error.localizedDescription)") : .idle
            if userInitiated { showSheet = true }
        }
    }

    private func fetchLatest() async throws -> MacRelease? {
        if let feedOverride {
            let (data, _) = try await URLSession.shared.data(from: feedOverride)
            return try JSONDecoder().decode(MacRelease.self, from: data)
        }
        guard let model else { return nil }
        return try await model.api.latestMacRelease()
    }

    func skip(_ release: MacRelease) {
        defaults.set(release.version, forKey: "update.skipped")
        showSheet = false
    }

    func dismiss() {
        showSheet = false
        if case .failed = state { state = .idle }
        if state == .upToDate { state = .idle }
    }

    /// For a build that cannot install in place: the disk image, in the browser.
    func openDownload(_ release: MacRelease) {
        if let url = release.dmgUrl ?? release.pageUrl ?? release.zipUrl { NSWorkspace.shared.open(url) }
        showSheet = false
    }

    // MARK: - Installing

    func install(_ release: MacRelease) async {
        guard let requirement, installLocationWritable else { openDownload(release); return }
        guard let zipURL = release.zipUrl, Self.allowedDownload(zipURL), let expected = release.zipSha256 else {
            state = .failed("This release has no verifiable download. Download it from the website instead.")
            return
        }
        do {
            state = .downloading(0)
            let zip = try await download(zipURL)
            guard try Self.sha256(of: zip) == expected.lowercased() else {
                throw UpdateError("The download does not match its published checksum, so it was not installed.")
            }

            state = .installing
            // Unpacked beside the running app, on the same volume, so the swap
            // below is a rename rather than a copy.
            let staging = try FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                                      appropriateFor: Bundle.main.bundleURL, create: true)
            try Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, staging.path])
            guard let newApp = try FileManager.default.contentsOfDirectory(at: staging, includingPropertiesForKeys: nil)
                .first(where: { $0.pathExtension == "app" }) else {
                throw UpdateError("The download did not contain the app.")
            }
            try Self.verify(newApp, requirement: requirement, version: release.version)
            try relaunch(replacing: Bundle.main.bundleURL, with: newApp)
        } catch {
            appLog.error("update failed: \(error.localizedDescription, privacy: .public)")
            state = .failed(error.localizedDescription)
        }
    }

    /// Swap the bundles once this process has exited, then open the new one.
    /// A detached shell does it: an app cannot replace itself while running.
    private func relaunch(replacing current: URL, with fresh: URL) throws {
        let script = """
        pid="$1"; current="$2"; fresh="$3"
        while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
        old="$(dirname "$fresh")/previous.app"
        mv "$current" "$old" && mv "$fresh" "$current" && rm -rf "$old"
        [ -d "$current" ] || mv "$old" "$current"
        open "$current"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script, "onyx-update", String(ProcessInfo.processInfo.processIdentifier),
                       current.path, fresh.path]
        try p.run()
        appLog.info("update: relaunching into the new version")
        // AppKit will not terminate while a sheet is up, so it goes first.
        // exit() is the backstop: the swap is waiting on this process, and a
        // quit that stalls for any other reason must not leave it waiting.
        showSheet = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            NSApp.terminate(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(0) }
        }
    }

    private func download(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            var observation: NSKeyValueObservation?
            let task = URLSession.shared.downloadTask(with: url) { temp, response, error in
                observation?.invalidate()
                if let error { continuation.resume(throwing: error); return }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard let temp, (200..<300).contains(status) else {
                    continuation.resume(throwing: UpdateError("The download failed (HTTP \(status))."))
                    return
                }
                // The session deletes its file when this returns.
                let kept = FileManager.default.temporaryDirectory.appendingPathComponent("Onyx-\(UUID().uuidString).zip")
                do { try FileManager.default.moveItem(at: temp, to: kept); continuation.resume(returning: kept) }
                catch { continuation.resume(throwing: error) }
            }
            observation = task.progress.observe(\.fractionCompleted) { [weak self] progress, _ in
                let f = progress.fractionCompleted
                Task { @MainActor in if case .downloading = self?.state { self?.state = .downloading(f) } }
            }
            task.resume()
        }
    }

    // MARK: - Trust

    /// What a replacement must satisfy: this bundle identifier, signed
    /// through Apple by this team. Nil for an unsigned build, which cannot
    /// vouch for anything — except in a development build, where an unsigned
    /// copy may replace an unsigned copy, so the path can be exercised.
    private var requirement: String? {
        if let team = BuildInfo.teamID {
            return #"identifier "io.onyxfs.app" and anchor apple generic and certificate leaf[subject.OU] = "\#(team)""#
        }
        #if DEBUG
        return #"identifier "io.onyxfs.app""#
        #else
        return nil
        #endif
    }

    private var installLocationWritable: Bool {
        let bundle = Bundle.main.bundleURL
        // Running from a disk image or a translocated copy: nowhere to install to.
        if bundle.path.hasPrefix("/Volumes/") || bundle.path.contains("/AppTranslocation/") { return false }
        return FileManager.default.isWritableFile(atPath: bundle.deletingLastPathComponent().path)
    }

    static func verify(_ app: URL, requirement: String, version: String) throws {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else {
            throw UpdateError("The downloaded app could not be read.")
        }
        var req: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else {
            throw UpdateError("Internal error: bad code requirement.")
        }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        let status = SecStaticCodeCheckValidity(code, flags, req)
        guard status == errSecSuccess else {
            throw UpdateError("The downloaded app is not signed by the same developer as this one (\(status)), so it was not installed.")
        }
        let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard (info?["CFBundleShortVersionString"] as? String) == version else {
            throw UpdateError("The downloaded app is not the version the release describes.")
        }
    }

    /// Only https — or plain http to this machine, for trying the updater
    /// against a local feed.
    static func allowedDownload(_ url: URL) -> Bool {
        if url.scheme == "https" { return true }
        return url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")
    }

    static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func run(_ tool: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw UpdateError("\(tool) failed (\(p.terminationStatus)).") }
    }
}

struct UpdateError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
