import Foundation
import AppKit
import Combine
import os
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
///            location the user picked (it may be an external disk); one
///            store per account on one server
///
/// Mirrors and pin stores both belong to the account signed in, in folders
/// of its own (AccountFolder): another account signing in on this Mac gets
/// its own, and never sees, serves or deletes the first one's.
@MainActor
final class DriveService: ObservableObject {
    @Published private(set) var cacheRoot: URL
    /// The streaming cache's cap, per drive: each mount's rclone keeps a
    /// cache of its own and holds it to this. rclone reads it as it starts,
    /// so a new value applies as each drive next mounts (Clear Streaming
    /// Cache remounts them all now) — changing it does not interrupt a
    /// drive something is reading from.
    @Published var cacheLimitGB: Int { didSet { defaults.set(cacheLimitGB, forKey: Keys.limit) } }
    /// Drives to keep mounted, across launches (SyncDomain identifiers).
    @Published private(set) var wantMounted: Set<String>
    @Published private(set) var pinnedFiles: Set<String> = []
    @Published private(set) var pinRules: [PinRule] = []
    /// Folder rules naming no folder in their drive now: renamed or deleted
    /// on the web. What they kept stays meanwhile (PinStore.unresolved).
    @Published private(set) var unresolvedPins: Set<PinRule> = []
    @Published private(set) var pinnedBytes: Int64 = 0
    @Published private(set) var streamingBytes: Int64 = 0
    @Published private(set) var syncing: Set<String> = []
    /// Drives whose offline files are being brought up to date right now.
    @Published private(set) var downloading = 0
    /// The last sync could not reach the server. Finder keeps showing the
    /// last synced state, and files kept offline keep opening.
    @Published private(set) var isOffline = false
    @Published var problem: String?
    /// Why files are not being kept offline right now: the cache's disk is
    /// not connected, or has no room.
    @Published private(set) var offlineProblem: String?
    /// The cache is being moved.
    @Published private(set) var relocating = false
    /// Why the last move of the cache was refused or failed, for Settings:
    /// an answer to the user's choice, not a state of the drives.
    @Published private(set) var relocationProblem: String?

    let mounts = MountManager()
    private let server = DAVServer()
    private var mirrors: [String: DriveMirror] = [:]
    private var names: [String: String] = [:]
    /// The signed-in account's pin store. The mounts read it from the
    /// bridge's own threads, and it may open after they start — when its
    /// disk was not connected at launch — so they look it up each time.
    private let currentPins = OSAllocatedUnfairLock<PinStore?>(initialState: nil)
    private var pins: PinStore? {
        get { currentPins.withLock { $0 } }
        set { currentPins.withLock { $0 = newValue } }
    }
    /// Every store opened this run, by account folder, kept for the run:
    /// one per folder, ever. Two would clear each other's downloads, and an
    /// old one's last save would overwrite the new one's rules.
    private var stores: [String: PinStore] = [:]
    /// Moved on by each start and stop. Work begun before — a tick, a mirror
    /// opening, a reconcile — checks it after each wait, and stops rather
    /// than act for an account that has signed out.
    private var generation = 0
    private var tickingGeneration: Int?
    private var tickAgain = false
    /// Scopes being reconciled; true when another pass is wanted after.
    private var reconciling: [String: Bool] = [:]
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

    private static var mirrorsRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("\(OnyxIdentifiers.folderName)/Mirrors", isDirectory: true)
    }

    /// The account's own mirrors: another account's sync never overwrites
    /// them, so neither starts from scratch after the other signs in.
    private static func mirrorsDirectory(server: URL, account: String) -> URL {
        mirrorsRoot.appendingPathComponent(AccountFolder.name(server: server, account: account), isDirectory: true)
    }

    /// Mirrors kept before they had a folder per account go into this
    /// account's. DriveMirror checks whose each one is, so another account's
    /// is only fetched afresh, as it would have been anyway.
    private static func adoptUnscopedMirrors(into folder: URL) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: mirrorsRoot.path) else { return }
        for name in names where name.hasSuffix(".json") {
            let from = mirrorsRoot.appendingPathComponent(name)
            try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
            if (try? fm.moveItem(at: from, to: folder.appendingPathComponent(name))) == nil {
                try? fm.removeItem(at: from)
            }
        }
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
        generation += 1
        let started = generation
        do {
            _ = try await server.start()
        } catch {
            problem = "The Finder bridge could not start: \(error.localizedDescription)"
            return
        }
        guard started == generation else { return }
        guard let account = model.email, !account.isEmpty else {
            // Mirrors and offline files are each one account's; with no
            // account known, none can be shown or kept.
            problem = "Onyx does not know which account is signed in. Sign out and in again to see your drives in Finder."
            return
        }
        Self.adoptUnscopedMirrors(into: Self.mirrorsDirectory(server: model.config.baseURL, account: account))
        // Its disk may not be connected. The drives mount and stream all the
        // same, and each tick tries the store again.
        openPins()
        await refreshPins()
        for drive in model.finderDrives where wantMounted.contains(SyncDomain.drive(id: drive.id).identifier) {
            guard started == generation else { return }
            await mount(.drive(id: drive.id), name: drive.name)
        }
        guard started == generation else { return }
        if wantMounted.contains(SyncDomain.library.identifier) {
            await mount(.library, name: "Library")
        }
        guard started == generation else { return }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { await self?.tick() }
        }
        Task { await tick() }
    }

    /// Sign-out: unmount everything and stop syncing. Pinned copies stay on
    /// disk, in the account's own store, for when it signs in again; no
    /// other account is served them or can delete them.
    func stop() {
        generation += 1
        timer?.invalidate()
        timer = nil
        mounts.unmountAllNow()
        for key in mirrors.keys { server.setRoute(MountManager.remoteName(SyncDomain(identifier: key)!), nil) }
        mirrors.removeAll()
        // The account's downloads stop now, rather than carry on under the
        // next sign-in's token. The store stays open for the run (`stores`):
        // the same account signing back in picks it up again.
        if let pins { Task { await pins.cancelPasses() } }
        pins = nil
        reconciling = [:]
        syncing = []
        pinRules = []
        pinnedFiles = []
        unresolvedPins = []
        pinnedBytes = 0
        offlineProblem = nil
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
        server.setRoute(segment, DAVResponder(source: MountSource(scope: scope.identifier, mirror: mirror,
                                                                  pins: currentPins),
                                             bearerToken: server.token, hrefPrefix: "/\(segment)"))
        guard let bridge = server.baseURL(for: segment) else { return }
        await mounts.mount(scope, name: name, bridge: bridge, token: server.token,
                           cache: streamingCache, cacheLimitGB: cacheLimitGB, logs: Self.logsDirectory)
    }

    /// Where the mounts cache what they stream: the cache location, or, with
    /// its disk not connected, the default one for now. A drive should not
    /// fail to mount for want of a place to keep what is only a cache.
    private var streamingCache: URL {
        PinStore.isOnMissingVolume(cacheRoot)
            ? Self.defaultRoot.appendingPathComponent("Streaming", isDirectory: true)
            : streamingDirectory
    }

    func reveal(_ scope: SyncDomain) { mounts.reveal(scope) }

    // MARK: - Mirrors

    private func mirror(for scope: SyncDomain, name: String) async -> DriveMirror? {
        names[scope.identifier] = name
        if let existing = mirrors[scope.identifier] { return existing }
        // Only for an account known by address: a mirror, like a pin store,
        // is one account's, and "" is nobody's.
        guard let model, let account = model.email, !account.isEmpty else { return nil }
        let started = generation
        let config = model.config
        // Read and indexed off the main thread; a large drive takes a moment.
        let mirror = await DriveMirror.open(scope: scope,
                                            directory: Self.mirrorsDirectory(server: config.baseURL, account: account),
                                            server: config.baseURL, account: account,
                                            api: { OnyxAPI(config: config) })
        // Signed out meanwhile: not kept, so not reused at the next sign-in.
        guard started == generation else { return nil }
        // Another caller may have opened it meanwhile; one mirror per drive.
        if let existing = mirrors[scope.identifier] { return existing }
        mirrors[scope.identifier] = mirror
        // The first listing waits for a sync, so a new mount does not open empty.
        if await mirror.lastSynced == nil { _ = try? await mirror.sync() }
        guard started == generation else { return nil }
        return mirror
    }

    /// Every 15 s: bring each mirror that is mounted or pinned up to the
    /// server, and fetch whatever a pin now wants.
    ///
    /// One at a time. The timer fires whatever the last tick is doing, and
    /// a tick that finds one running asks it to go round once more instead
    /// of starting a second.
    private func tick() async {
        guard model?.phase == .signedIn else { return }
        if tickingGeneration == generation {
            tickAgain = true
            return
        }
        let started = generation
        tickingGeneration = started
        defer { if tickingGeneration == started { tickingGeneration = nil } }
        repeat {
            tickAgain = false
            await tickOnce(started)
        } while tickAgain && started == generation
    }

    private func tickOnce(_ started: Int) async {
        // A cache disk plugged back in: its store opens now.
        if pins == nil {
            openPins()
            if pins != nil { await refreshPins() }
        }
        let pinnedScopes = Set(pinRules.map(\.scope))
        for (id, mirror) in mirrors where wantMounted.contains(id) || pinnedScopes.contains(id) {
            guard started == generation else { return }
            syncing.insert(id)
            do {
                _ = try await mirror.sync()
                if isOffline {
                    isOffline = false
                    // Back: what failed for want of a network is tried now,
                    // not after its wait.
                    await pins?.retryNow()
                }
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
            // Signed out while it synced: nothing more for that account.
            guard started == generation else { return }
            syncing.remove(id)
            // Not waited for: a pin downloading for hours must not hold up
            // the syncing of every drive after this one.
            if pinnedScopes.contains(id) { reconcileSoon(id) }
        }
        // Pins in drives that are not mounted still need their mirror.
        for scope in pinnedScopes where mirrors[scope] == nil {
            guard let domain = SyncDomain(identifier: scope) else { continue }
            let opened = await mirror(for: domain, name: names[scope] ?? scope)
            guard started == generation else { return }
            if opened != nil { reconcileSoon(scope) }
        }
        await refreshUsage()
    }

    func syncNow() async {
        // Asked for: whatever is waiting to be tried again goes now.
        await pins?.retryNow()
        await tick()
    }

    // MARK: - Pins

    /// From the web page (in the app) or Settings. Returns once the rule is
    /// kept; the downloads carry on in the background.
    func pin(_ rule: PinRule) async { await pin([rule]) }

    func unpin(_ rule: PinRule) async { await unpin([rule]) }

    /// Files by server id: the scope is the drive the page is showing, or
    /// wherever a mirror holds them. Thousands at once are one change to the
    /// store and one pass per drive, not one of each per file.
    func pinFiles(_ ids: [String], scope hint: String?, _ on: Bool) async {
        var indexes: [(scope: String, index: MirrorIndex)] = []
        for (scope, mirror) in mirrors { indexes.append((scope, await mirror.index)) }
        let rules = ids.map { id in
            PinRule(scope: indexes.first { $0.index.file(id: id) != nil }?.scope ?? hint ?? SyncDomain.library.identifier,
                    target: .file(id: id))
        }
        if on { await pin(rules) } else { await unpin(rules) }
    }

    private func pin(_ rules: [PinRule]) async {
        guard let pins, !rules.isEmpty else { return }
        let started = generation
        await pins.pin(rules)
        await refreshPins()
        for scope in Set(rules.map(\.scope)) {
            guard started == generation else { return }
            if mirrors[scope] == nil, let domain = SyncDomain(identifier: scope) {
                _ = await mirror(for: domain, name: names[scope] ?? scope)
                guard started == generation else { return }
            }
            reconcileSoon(scope)
        }
    }

    private func unpin(_ rules: [PinRule]) async {
        guard let pins, !rules.isEmpty else { return }
        let started = generation
        await pins.unpin(rules)
        await refreshPins()
        guard started == generation else { return }
        for scope in Set(rules.map(\.scope)) { reconcileSoon(scope) }
    }

    func localCopy(scope: String, entry: MirrorEntry) async -> URL? {
        guard let id = entry.fileId else { return nil }
        return await pins?.localCopy(scope: scope, fileId: id, etag: entry.etag)
    }

    /// A pass for `scope` soon, not waited for. One at a time per scope: a
    /// call while one runs asks for one more after it, which reads the
    /// mirror's index as it is then. However many ticks go by during an
    /// hours-long download, one pass waits.
    private func reconcileSoon(_ scope: String) {
        if reconciling[scope] != nil {
            reconciling[scope] = true
            return
        }
        reconciling[scope] = false
        let started = generation
        Task {
            while started == generation {
                reconciling[scope] = false
                await reconcile(scope)
                guard started == generation else { return }
                if reconciling[scope] != true {
                    reconciling[scope] = nil
                    return
                }
            }
        }
    }

    private func reconcile(_ scope: String) async {
        guard let pins, let mirror = mirrors[scope] else { return }
        let started = generation
        downloading += 1
        defer { downloading -= 1 }
        let index = await mirror.index
        guard started == generation else { return }
        let report = await pins.reconcile(scope: scope, index: index) { entry, destination in
            guard let id = entry.fileId else { throw OnyxError.decoding("not a file") }
            let url = try await mirror.contentURL(fileId: id)
            // Straight into the store's folder, on the cache's own disk.
            do {
                try await FileDownload.fetch(url, to: destination)
            } catch let OnyxError.http(status, message) {
                // Storage refused the link: the next try fetches a new one.
                await mirror.forgetContentURL(fileId: id)
                throw OnyxError.http(status: status, message: message)
            }
        }
        guard started == generation else { return }
        if !report.failed.isEmpty {
            appLog.error("pins: \(report.failed.count) failed in \(scope, privacy: .public)")
        }
        await refreshPins()
    }

    /// The signed-in account's store, in a folder of its own under Pinned.
    /// Not opened while its disk is not connected (offlineProblem says so);
    /// the drives mount and stream all the same, and each tick tries again.
    private func openPins() {
        guard let model, let account = model.email, !account.isEmpty else { return }
        let name = AccountFolder.name(server: model.config.baseURL, account: account)
        if let open = stores[name] {
            pins = open
            return
        }
        do {
            let store = try PinStore(directory: pinnedDirectory.appendingPathComponent(name, isDirectory: true))
            stores[name] = store
            pins = store
            offlineProblem = nil
        } catch {
            offlineProblem = PinStore.isOnMissingVolume(pinnedDirectory)
                ? describe(.unavailable)
                : "Files kept offline could not be opened: \(error.localizedDescription)"
        }
    }

    private func refreshPins() async {
        let started = generation
        guard let pins else {
            pinRules = []
            pinnedFiles = []
            unresolvedPins = []
            pinnedBytes = 0
            model?.web.publishOfflineState()
            return
        }
        let rules = await pins.rules()
        let scopes = Set(rules.map(\.scope))
        var files = Set<String>()
        var unresolved = Set<PinRule>()
        for (scope, mirror) in mirrors where scopes.contains(scope) {
            let index = await mirror.index
            for entry in await pins.wanted(scope: scope, index: index) {
                if let id = entry.fileId { files.insert(id) }
            }
            unresolved.formUnion(await pins.unresolved(scope: scope, index: index))
        }
        for rule in rules { if case let .file(id) = rule.target { files.insert(id) } }
        let bytes = await pins.usage()
        let problem = await pins.problem
        // Signed out meanwhile: the next account is not shown this one's.
        guard started == generation else { return }
        pinRules = rules
        pinnedFiles = files
        unresolvedPins = unresolved
        pinnedBytes = bytes
        offlineProblem = describe(problem)
        model?.web.publishOfflineState()
    }

    private func describe(_ problem: PinStore.Problem?) -> String? {
        switch problem {
        case .unavailable?:
            // Not "choose another location": the files kept offline cannot
            // move off a disk that is not there (relocateCache).
            return "Files kept offline are not being updated: \(cacheRoot.path) is not available. "
                + "Connect the disk it is on."
        case .full?:
            return "There is not enough free space in \(cacheRoot.path) for everything kept offline. "
                + "Free some space, or choose another location in Settings → Storage."
        case nil:
            return nil
        }
    }

    // MARK: - Cache settings

    private func refreshUsage() async {
        let started = generation
        let bytes = await pins?.usage() ?? 0
        let problem = await pins?.problem
        let dir = streamingDirectory
        let streamed = await Task.detached { Self.directorySize(dir) }.value
        guard started == generation else { return }
        pinnedBytes = bytes
        if pins != nil { offlineProblem = describe(problem) }
        streamingBytes = streamed
    }

    /// Move everything — pinned copies and the streaming cache — to a folder
    /// the user chose, perhaps on an external disk. Mounts restart on the new
    /// location.
    ///
    /// Every account's store moves, not only the signed-in one's (or none,
    /// signed out): a store left behind would be found by nothing once the
    /// cache has moved. Refused while the current location's disk is not
    /// connected, since nothing on it could come along.
    func relocateCache(to newRoot: URL) async {
        guard !relocating else { return }
        relocationProblem = nil
        guard !CacheLocation.isSame(newRoot, cacheRoot) else { return }
        if let refusal = CacheLocation.refusal(for: newRoot, current: cacheRoot, mounts: MountManager.root) {
            relocationProblem = refusal
            return
        }
        if PinStore.isOnMissingVolume(cacheRoot) {
            relocationProblem = "Connect the disk that holds \(cacheRoot.path) first, so what is kept offline can move with it."
            return
        }
        relocating = true
        defer { relocating = false }
        let mounted = mounts.states.keys.compactMap(SyncDomain.init(identifier:))
        for scope in mounted { await mounts.unmount(scope) }
        // Downloads under way stop; the next tick starts them in the new place.
        for store in stores.values { await store.cancelPasses() }
        let oldPinned = pinnedDirectory
        do {
            try await moveStores(from: oldPinned, to: newRoot.appendingPathComponent("Pinned", isDirectory: true))
            // The streaming cache is only a cache: start it afresh there.
            try? FileManager.default.removeItem(at: streamingDirectory)
            PinStore.removeIfEmpty(oldPinned)
            cacheRoot = newRoot
            defaults.set(newRoot.path, forKey: Keys.root)
        } catch {
            relocationProblem = "The cache could not be moved: \(error.localizedDescription)"
        }
        if pins == nil, model?.phase == .signedIn { openPins() }
        for scope in mounted { await mount(scope, name: names[scope.identifier] ?? scope.identifier) }
        await refreshPins()
        await refreshUsage()
    }

    /// Each account's store under `old`, and any open one, to the same name
    /// under `new`. If one cannot move, those that did are moved back.
    private func moveStores(from old: URL, to new: URL) async throws {
        let folders = Set(PinStore.stores(in: old)).union(stores.keys).sorted()
        var moved: [(store: PinStore, from: URL)] = []
        do {
            for name in folders {
                let store: PinStore
                if let open = stores[name] {
                    store = open
                } else {
                    store = try PinStore(directory: old.appendingPathComponent(name, isDirectory: true))
                    stores[name] = store
                }
                let from = await store.directory
                try await store.relocate(to: new.appendingPathComponent(name, isDirectory: true))
                moved.append((store, from))
            }
        } catch {
            for (store, from) in moved.reversed() { try? await store.relocate(to: from) }
            throw error
        }
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
    /// The signed-in account's store as it is now: it may open after the
    /// mount did.
    let pins: OSAllocatedUnfairLock<PinStore?>

    func entry(at path: String) async -> MirrorEntry? { await mirror.index.entry(at: path) }
    func children(of path: String) async -> [MirrorEntry]? { await mirror.index.children(of: path) }

    func content(for entry: MirrorEntry) async -> DAVContent {
        guard let id = entry.fileId else { return .unavailable }
        if let store = pins.withLock({ $0 }),
           let local = await store.localCopy(scope: scope, fileId: id, etag: entry.etag) { return .local(local) }
        do { return .redirect(try await mirror.contentURL(fileId: id)) }
        catch { return .unavailable }
    }
}
