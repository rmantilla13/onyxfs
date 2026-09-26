import Foundation
import AppKit
import Combine
import OnyxKit

/// Drives in Finder, and the files kept on this Mac: the one place that ties
/// the synced mirrors, the pin store, the WebDAV bridge and the rclone mounts
/// together, and holds their settings.
///
///   mirror   each drive's tree, from the server's access-checked feed —
///            exactly what the web shows this account, synced every 15 s
///   bridge   answers rclone from the mirror; reads go to storage by redirect,
///            or to a pinned copy
///   mounts   one rclone NFS mount per drive, under ~/Onyx
///   pins     files, folders or whole drives kept offline, in the cache
///            location the user picked (it may be an external disk)
@MainActor
final class DriveService: ObservableObject {
    @Published private(set) var cacheRoot: URL
    @Published var cacheLimitGB: Int { didSet { defaults.set(cacheLimitGB, forKey: Keys.limit) } }
    /// Drives to keep mounted, across launches (SyncDomain identifiers).
    @Published private(set) var wantMounted: Set<String>
    @Published private(set) var pinnedFiles: Set<String> = []
    @Published private(set) var pinRules: [PinRule] = []
    @Published private(set) var pinnedBytes: Int64 = 0
    @Published private(set) var streamingBytes: Int64 = 0
    @Published private(set) var syncing: Set<String> = []
    /// Pinned files being fetched right now.
    @Published private(set) var downloading = 0
    /// The last sync could not reach the server. Finder keeps showing the
    /// last synced state, and files kept offline keep opening.
    @Published private(set) var isOffline = false
    @Published var problem: String?

    let mounts = MountManager()
    private let server = DAVServer()
    private var mirrors: [String: DriveMirror] = [:]
    private var names: [String: String] = [:]
    private var pins: PinStore?
    private var timer: Timer?
    private weak var model: AppModel?
    private let defaults = UserDefaults.standard
    private var forwarding: AnyCancellable?

    private enum Keys {
        static let root = "cache.root"
        static let limit = "cache.limitGB"
        static let mounted = "mounts.wanted"
    }

    init() {
        let saved = UserDefaults.standard.string(forKey: Keys.root).map { URL(fileURLWithPath: $0, isDirectory: true) }
        cacheRoot = saved ?? Self.defaultRoot
        let limit = UserDefaults.standard.integer(forKey: Keys.limit)
        cacheLimitGB = limit == 0 && UserDefaults.standard.object(forKey: Keys.limit) == nil ? 50 : limit
        wantMounted = Set(UserDefaults.standard.stringArray(forKey: Keys.mounted) ?? [])
        // A mount finishing or failing changes what this reports too (the
        // menu bar icon, Settings), so its changes are passed on.
        forwarding = mounts.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        mounts.onEjected = { [weak self] scope in
            guard let self else { return }
            wantMounted.remove(scope.identifier)
            defaults.set(Array(wantMounted), forKey: Keys.mounted)
            model?.web.publishOfflineState()
        }
    }

    /// ~/Library/Application Support/Onyx/Offline: not Caches, which macOS
    /// may empty on its own — pinned files are promised to stay.
    static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("\(OnyxIdentifiers.folderName)/Offline", isDirectory: true)
    }

    private static var mirrorsDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("\(OnyxIdentifiers.folderName)/Mirrors", isDirectory: true)
    }

    private static var logsDirectory: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/\(OnyxIdentifiers.folderName)", isDirectory: true)
    }

    var pinnedDirectory: URL { cacheRoot.appendingPathComponent("Pinned", isDirectory: true) }
    var streamingDirectory: URL { cacheRoot.appendingPathComponent("Streaming", isDirectory: true) }

    // MARK: - Life cycle

    /// After sign-in: start the bridge, bring back the drives that were
    /// mounted, and start keeping mirrors and pins current.
    func start(model: AppModel) async {
        self.model = model
        do {
            _ = try await server.start()
            pins = try PinStore(directory: pinnedDirectory)
        } catch {
            problem = "The Finder bridge could not start: \(error.localizedDescription)"
            return
        }
        await refreshPins()
        for drive in model.finderDrives where wantMounted.contains(SyncDomain.drive(id: drive.id).identifier) {
            await mount(.drive(id: drive.id), name: drive.name)
        }
        if wantMounted.contains(SyncDomain.library.identifier) {
            await mount(.library, name: "Library")
        }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { await self?.tick() }
        }
        Task { await tick() }
    }

    /// Sign-out: unmount everything and stop syncing. Pinned copies stay on
    /// disk, but only the account that pinned them is ever served them — a
    /// mirror belongs to one account on one server.
    func stop() {
        timer?.invalidate()
        timer = nil
        mounts.unmountAllNow()
        for key in mirrors.keys { server.setRoute(MountManager.remoteName(SyncDomain(identifier: key)!), nil) }
        mirrors.removeAll()
    }

    func quit() {
        mounts.unmountAllNow()
    }

    // MARK: - Mounting

    func isMounted(_ scope: SyncDomain) -> Bool {
        if case .mounted = mounts.state(of: scope) { return true }
        return false
    }

    func setMounted(_ scope: SyncDomain, name: String, _ on: Bool) async {
        if on {
            wantMounted.insert(scope.identifier)
            await mount(scope, name: name)
        } else {
            wantMounted.remove(scope.identifier)
            await mounts.unmount(scope)
        }
        defaults.set(Array(wantMounted), forKey: Keys.mounted)
    }

    private func mount(_ scope: SyncDomain, name: String) async {
        guard let mirror = await mirror(for: scope, name: name) else { return }
        let segment = MountManager.remoteName(scope)
        server.setRoute(segment, DAVResponder(source: MountSource(scope: scope.identifier, mirror: mirror, pins: pins),
                                             bearerToken: server.token, hrefPrefix: "/\(segment)"))
        guard let bridge = server.baseURL(for: segment) else { return }
        await mounts.mount(scope, name: name, bridge: bridge, token: server.token,
                           cache: streamingDirectory, cacheLimitGB: cacheLimitGB, logs: Self.logsDirectory)
    }

    func reveal(_ scope: SyncDomain) { mounts.reveal(scope) }

    // MARK: - Mirrors

    private func mirror(for scope: SyncDomain, name: String) async -> DriveMirror? {
        names[scope.identifier] = name
        if let existing = mirrors[scope.identifier] { return existing }
        guard let model else { return nil }
        let config = model.config
        // Read and indexed off the main thread; a large drive takes a moment.
        let mirror = await DriveMirror.open(scope: scope, directory: Self.mirrorsDirectory, server: config.baseURL,
                                            account: model.email ?? "", api: { OnyxAPI(config: config) })
        // Another caller may have opened it meanwhile; one mirror per drive.
        if let existing = mirrors[scope.identifier] { return existing }
        mirrors[scope.identifier] = mirror
        // The first listing waits for a sync, so a new mount does not open empty.
        if await mirror.lastSynced == nil { _ = try? await mirror.sync() }
        return mirror
    }

    /// Every 15 s: bring each mirror that is mounted or pinned up to the
    /// server, and fetch whatever a pin now wants.
    private func tick() async {
        guard model?.phase == .signedIn else { return }
        let pinnedScopes = Set(pinRules.map(\.scope))
        for (id, mirror) in mirrors where wantMounted.contains(id) || pinnedScopes.contains(id) {
            syncing.insert(id)
            do {
                _ = try await mirror.sync()
                isOffline = false
            } catch OnyxError.notAuthenticated {
                syncing.remove(id)
                await model?.tokenRejected()
                return
            } catch is URLError {
                // Offline: the mount keeps answering from the last good
                // mirror, and pinned files keep working.
                isOffline = true
            } catch {
                // A server hiccup: the same, and the next tick tries again.
            }
            syncing.remove(id)
            if pinnedScopes.contains(id) { await reconcile(id) }
        }
        // Pins in drives that are not mounted still need their mirror.
        for scope in pinnedScopes where mirrors[scope] == nil {
            if let domain = SyncDomain(identifier: scope) {
                _ = await mirror(for: domain, name: names[scope] ?? scope)
                await reconcile(scope)
            }
        }
        await refreshUsage()
    }

    func syncNow() async { await tick() }

    // MARK: - Pins

    /// From the web page (in the app) or Settings.
    func pin(_ rule: PinRule) async {
        await pins?.pin(rule)
        await refreshPins()
        if let domain = SyncDomain(identifier: rule.scope) {
            _ = await mirror(for: domain, name: names[rule.scope] ?? rule.scope)
        }
        await reconcile(rule.scope)
    }

    func unpin(_ rule: PinRule) async {
        await pins?.unpin(rule)
        await refreshPins()
        await reconcile(rule.scope)
    }

    /// Files by server id: the scope is the drive the page is showing, or
    /// wherever a mirror holds them.
    func pinFiles(_ ids: [String], scope hint: String?, _ on: Bool) async {
        for id in ids {
            let scope = await scopeHolding(fileId: id) ?? hint ?? SyncDomain.library.identifier
            let rule = PinRule(scope: scope, target: .file(id: id))
            if on { await pin(rule) } else { await unpin(rule) }
        }
    }

    private func scopeHolding(fileId: String) async -> String? {
        for (id, mirror) in mirrors where await mirror.index.file(id: fileId) != nil { return id }
        return nil
    }

    func localCopy(scope: String, entry: MirrorEntry) async -> URL? {
        guard let id = entry.fileId else { return nil }
        return await pins?.localCopy(scope: scope, fileId: id, etag: entry.etag)
    }

    private func reconcile(_ scope: String) async {
        guard let pins, let mirror = mirrors[scope] else { return }
        downloading += 1
        defer { downloading -= 1 }
        let index = await mirror.index
        let report = await pins.reconcile(scope: scope, index: index) { entry in
            guard let id = entry.fileId else { throw OnyxError.decoding("not a file") }
            let url = try await mirror.contentURL(fileId: id)
            let (temp, response) = try await URLSession.shared.download(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                await mirror.forgetContentURL(fileId: id)
                throw OnyxError.http(status: status, message: "Storage refused the download.")
            }
            let kept = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.moveItem(at: temp, to: kept)
            return kept
        }
        if !report.failed.isEmpty {
            appLog.error("pins: \(report.failed.count) failed in \(scope, privacy: .public)")
        }
        await refreshPins()
    }

    private func refreshPins() async {
        guard let pins else { return }
        pinRules = await pins.rules()
        var files = Set<String>()
        for (scope, mirror) in mirrors {
            let index = await mirror.index
            for entry in await pins.wanted(scope: scope, index: index) {
                if let id = entry.fileId { files.insert(id) }
            }
        }
        for rule in pinRules { if case let .file(id) = rule.target { files.insert(id) } }
        pinnedFiles = files
        pinnedBytes = await pins.usage()
        model?.web.publishOfflineState()
    }

    // MARK: - Cache settings

    private func refreshUsage() async {
        pinnedBytes = await pins?.usage() ?? 0
        let dir = streamingDirectory
        streamingBytes = await Task.detached { Self.directorySize(dir) }.value
    }

    /// Move everything — pinned copies and the streaming cache — to a folder
    /// the user chose, perhaps on an external disk. Mounts restart on the new
    /// location.
    func relocateCache(to newRoot: URL) async {
        let mounted = mounts.states.keys.compactMap(SyncDomain.init(identifier:))
        for scope in mounted { await mounts.unmount(scope) }
        do {
            try await pins?.relocate(to: newRoot.appendingPathComponent("Pinned", isDirectory: true))
            // The streaming cache is only a cache: start it afresh there.
            try? FileManager.default.removeItem(at: streamingDirectory)
            cacheRoot = newRoot
            defaults.set(newRoot.path, forKey: Keys.root)
            problem = nil
        } catch {
            problem = "The cache could not be moved: \(error.localizedDescription)"
        }
        for scope in mounted { await mount(scope, name: names[scope.identifier] ?? scope.identifier) }
        await refreshUsage()
    }

    func clearStreamingCache() async {
        let mounted = mounts.states.keys.compactMap(SyncDomain.init(identifier:))
        for scope in mounted { await mounts.unmount(scope) }
        try? FileManager.default.removeItem(at: streamingDirectory)
        for scope in mounted { await mount(scope, name: names[scope.identifier] ?? scope.identifier) }
        await refreshUsage()
    }

    nonisolated static func directorySize(_ url: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in e {
            total += Int64((try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?.totalFileAllocatedSize ?? 0)
        }
        return total
    }
}

/// What the bridge answers one drive from: the mirror's tree, and for bytes,
/// a pinned copy when there is a current one, else storage by redirect.
struct MountSource: DAVSource {
    let scope: String
    let mirror: DriveMirror
    let pins: PinStore?

    func entry(at path: String) async -> MirrorEntry? { await mirror.index.entry(at: path) }
    func children(of path: String) async -> [MirrorEntry]? { await mirror.index.children(of: path) }

    func content(for entry: MirrorEntry) async -> DAVContent {
        guard let id = entry.fileId else { return .unavailable }
        if let local = await pins?.localCopy(scope: scope, fileId: id, etag: entry.etag) { return .local(local) }
        do { return .redirect(try await mirror.contentURL(fileId: id)) }
        catch { return .unavailable }
    }
}
