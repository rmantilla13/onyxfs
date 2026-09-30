import AppKit
import Combine
import FinderSync
import OnyxKit
import OnyxFinderCore

/// Finder's Onyx menus and marks, from the app's side. The Finder extension
/// (OnyxFinder.appex) knows nothing of drives: it asks here what is mounted
/// and what is kept offline, and asks here to keep and let go
/// (OnyxFinderCore's FinderWire, over a Mach port this registers).
///
/// What it is given is one index (FinderIndex): each drive mounted now,
/// where, and what it keeps by path — folders by their rules, files kept on
/// their own, and what is not on this Mac yet. The index is rebuilt only when
/// one of those changes (a pin, a file arriving, a drive mounted or ejected,
/// a sign-in or out), at most every half second, and the extension is told
/// with one Darwin notification; it then asks for the index once, never per
/// item. While nothing changes, nothing here runs.
///
/// Keep Offline and Remove Offline Copy become the same rules the Onyx
/// window makes (DriveService.pin/unpin): a file by its id, a folder by its
/// path, the whole drive for the drive itself. So what Finder keeps shows
/// wherever pins show — the page's marks, Settings › Storage — and what the
/// page keeps is marked in Finder.
@MainActor
final class FinderSyncService: ObservableObject {
    /// Switched on in System Settings; nil until looked (`checkEnabled`).
    @Published private(set) var enabled: Bool?
    /// This copy of Onyx carries the extension (scripts/build-mac.sh).
    let isBundled: Bool

    private weak var model: AppModel?
    private var server: FinderPortServer?
    /// The app's bundle identifier, which names the port and notification:
    /// Onyx Dev's are its own.
    private let app: String
    private var index = FinderIndex()
    /// `index` as the extension is sent it.
    private var encoded = FinderIndex().encoded()
    private var lastPublished: ContinuousClock.Instant?
    private var updateDue: Task<Void, Never>?
    private var watching: AnyCancellable?
    /// What the index was last built from, to tell whether it must be again.
    private var built: (mounts: [Mount], rules: [PinRule], signedIn: Bool)?
    private var keptChanged = true
    /// Counts builds, so one that finishes late never replaces a newer one.
    private var builds = 0
    /// Published even if unchanged: the first, which an extension started
    /// before the app is waiting for.
    private var mustPublish = false

    private struct Mount: Equatable, Sendable {
        let root: String
        let scope: SyncDomain
        let name: String
    }

    init() {
        app = Bundle.main.bundleIdentifier ?? OnyxIdentifiers.app
        isBundled = FileManager.default.fileExists(
            atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/PlugIns/OnyxFinder.appex").path)
        // Counted on from now, so an index an extension kept from the app's
        // last run is never taken for one of this run's.
        index.generation = UInt64(Date().timeIntervalSince1970 * 1000)
    }

    func attach(to model: AppModel) {
        self.model = model
        guard isBundled else { return }
        server = FinderPortServer(name: FinderWire.portName(app: app)) { [weak self] message, body in
            // The port's run loop is the main one.
            MainActor.assumeIsolated {
                self?.answer(message, body) ?? FinderWire.Reply(ok: false).encoded()
            }
        }
        if server == nil {
            appLog.error("finder: another copy of Onyx answers Finder's menus; this one does not")
        }
        let finder = model.finder
        finder.onKeptPathsChanged = { [weak self] in
            self?.keptChanged = true
            self?.setNeedsUpdate()
        }
        // Drives mounting and ejected, the drive list, signing in and out.
        watching = finder.objectWillChange.merge(with: model.objectWillChange)
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.setNeedsUpdate() } }
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
        // An extension that started before Onyx did asks now.
        update(force: true)
    }

    /// Quitting: no more answers, and the extension told, so it clears its
    /// marks rather than show what it can no longer vouch for.
    private func stop() {
        server?.invalidate()
        server = nil
        FinderSignal.post(FinderWire.changedNotification(app: app))
    }

    // MARK: - The index

    /// An update soon: after a quarter second, and no sooner than half a
    /// second after the last one was published — longer for a big index, so
    /// a drive's first pass, bringing thousands of files, sends it every few
    /// seconds rather than with every file.
    private func setNeedsUpdate() {
        guard updateDue == nil else { return }
        var wait = Duration.milliseconds(250)
        if let lastPublished {
            let gap = Duration.milliseconds(max(500, min(10_000, encoded.count / 100)))
            let since = ContinuousClock.now - lastPublished
            if since + wait < gap { wait = gap - since }
        }
        updateDue = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard let self else { return }
            self.updateDue = nil
            self.update()
        }
    }

    /// Rebuilt when what it is built from changed — off the main thread, since
    /// a drive's first pass may have a hundred thousand files on their way —
    /// then published: encoded once, and the extension told.
    private func update(force: Bool = false) {
        guard let model else { return }
        let signedIn = model.phase == .signedIn
        let mounts = signedIn ? currentMounts() : []
        let rules = model.finder.pinRules
        if !force, !keptChanged, let built, built.mounts == mounts, built.rules == rules, built.signedIn == signedIn {
            return
        }
        built = (mounts, rules, signedIn)
        keptChanged = false
        if force { mustPublish = true }
        let kept = model.finder.keptPaths
        builds += 1
        let build = builds
        Task {
            let drives = await Task.detached(priority: .utility) {
                Self.drives(mounts, rules: rules, kept: kept)
            }.value
            // A later build is on its way, and has what this one had.
            guard build == builds else { return }
            guard mustPublish || drives != index.drives || signedIn != index.signedIn else { return }
            mustPublish = false
            index.generation += 1
            index.signedIn = signedIn
            index.drives = drives
            encoded = index.encoded()
            lastPublished = .now
            FinderSignal.post(FinderWire.changedNotification(app: app))
        }
    }

    /// Each mounted drive's entry: the folders from the rules themselves,
    /// which are current even before the drive's first pass has worked out
    /// the rest, and its files and what is on its way from `kept`.
    private nonisolated static func drives(_ mounts: [Mount], rules: [PinRule],
                                           kept: [String: KeptPaths]) -> [FinderIndex.Drive] {
        mounts.map { mount in
            let id = mount.scope.identifier
            let paths = kept[id]
            let folders = rules.compactMap { rule -> String? in
                guard rule.scope == id, case let .folder(path) = rule.target else { return nil }
                return path
            }
            // In order, so an unchanged drive compares equal; past the limit
            // the entry sums them up by folder anyway (FinderIndex.Drive).
            let pending = paths.map { $0.pending.count > FinderIndex.Drive.pendingLimit
                ? Array($0.pending) : $0.pending.sorted() } ?? []
            return FinderIndex.Drive(root: mount.root, scope: id, name: mount.name, folders: folders,
                                     files: paths.map { $0.files.values.sorted() } ?? [], pending: pending)
        }
    }

    /// Each drive mounted now, as a disk or in ~/Onyx, and where.
    private func currentMounts() -> [Mount] {
        guard let model else { return [] }
        var drives: [(SyncDomain, String)] = model.finderDrives.map { (.drive(id: $0.id), $0.name) }
        drives.append((.library, MountFolder.library))
        return drives.compactMap { scope, name in
            guard case let .mounted(url)? = model.finder.mountState(of: scope) else { return nil }
            return Mount(root: url.standardizedFileURL.path, scope: scope, name: name)
        }
    }

    // MARK: - Requests

    /// On the main thread, as the port's run loop is: an answer at once. The
    /// work a request asks for carries on after it.
    private func answer(_ message: Int32, _ body: Data) -> Data {
        guard let kind = FinderWire.Message(rawValue: message) else {
            return FinderWire.Reply(ok: false, message: "Onyx does not know that request.").encoded()
        }
        switch kind {
        case .index:
            return encoded
        case .open:
            openWindow()
            return FinderWire.Reply(ok: true).encoded()
        case .keep, .remove, .show:
            guard body.count <= FinderWire.maxRequestBytes, let request = FinderWire.Request.decode(body) else {
                return FinderWire.Reply(ok: false, message: "Onyx could not read that request.").encoded()
            }
            guard model?.phase == .signedIn else {
                return FinderWire.Reply(ok: false, message: "Sign in to Onyx first.").encoded()
            }
            Task { await perform(kind, paths: request.paths) }
            return FinderWire.Reply(ok: true).encoded()
        }
    }

    /// Only paths inside a drive mounted now, as this app has it mounted —
    /// whatever the extension's copy of the index says — and only as Keep
    /// Offline and Remove Offline Copy would.
    private func perform(_ kind: FinderWire.Message, paths: [String]) async {
        guard let model else { return }
        let finder = model.finder
        let mounted = FinderLookup(FinderIndex(drives: currentMounts().map {
            FinderIndex.Drive(root: $0.root, scope: $0.scope.identifier, name: $0.name, folders: [], files: [], pending: [])
        }))
        var byScope: [String: [String]] = [:]
        for path in paths {
            guard let at = mounted.locate(path) else { continue }
            byScope[at.scope, default: []].append(at.path)
        }
        switch kind {
        case .keep, .remove:
            var rules: [PinRule] = []
            for (scope, inside) in byScope {
                guard let domain = SyncDomain(identifier: scope), let mirror = await finder.mirrorForWrites(domain) else { continue }
                let index = await mirror.index
                rules += inside.compactMap { FinderPins.rule(scope: scope, path: $0, index: index) }
            }
            appLog.info("finder: \(kind == .keep ? "keep" : "remove", privacy: .public) offline, \(rules.count) from \(paths.count) items")
            if kind == .keep { await finder.pin(rules) } else { await finder.unpin(rules) }
        case .show:
            guard let item = byScope.first, let inside = item.value.first,
                  let domain = SyncDomain(identifier: item.key), let mirror = await finder.mirrorForWrites(domain),
                  let page = FinderPins.webPath(scope: domain, path: inside, index: await mirror.index) else { return }
            openWindow()
            model.web.go(page)
        case .index, .open:
            break
        }
    }

    /// The Onyx window, forward (MenuBarIcon opens it).
    private func openWindow() {
        NotificationCenter.default.post(name: .onyxOpenWindow, object: nil)
    }

    // MARK: - Switched on?

    /// Whether the person has switched the extension on, asked of macOS off
    /// the main thread: when Settings › Finder shows, and when Onyx comes
    /// back from System Settings. Never on a timer.
    func checkEnabled() {
        guard isBundled else { return }
        Task { [weak self] in
            let on = await Task.detached(priority: .utility) { FIFinderSyncController.isExtensionEnabled }.value
            self?.enabled = on
        }
    }

    /// System Settings, where the person switches it on. Onyx never does:
    /// it is their setting.
    func openSettings() {
        FIFinderSyncController.showExtensionManagementInterface()
    }
}
