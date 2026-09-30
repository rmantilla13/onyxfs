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
///            exactly what the web shows this account, synced every 5 s
///            while anything is happening, less often when nothing is
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
    /// Settings' Turn On (turnOnDisks) under way, and why it did not work
    /// when it did not.
    @Published var turningOnDisks = false
    @Published var turnOnProblem: String?
    /// Sent to System Settings to switch the Onyx file system on, and it is
    /// still off: the note says a restart may be what it takes.
    @Published var switchDidNotTake = false
    /// What Onyx remembers of its file system's switch across launches: was
    /// it on, what was said (FileSystemSwitch). The first time, a disk that
    /// had its icon says it was on.
    var switchMemory = FileSystemSwitch.Memory.load(disksSeen: DiskIcons.anyRecorded)
    /// This run's look at the switch as the drives come back: once a run.
    var switchDecided = false
    /// When the person was last sent to System Settings for the switch, and
    /// the watch for it coming on (watchForSwitch).
    var settingsOpenedAt: ContinuousClock.Instant?
    var switchWatch: Task<Void, Never>?
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
    /// Drives as disks of their own (onyxfs): a DiskMounter on macOS 27,
    /// kept untyped because the type does not exist before it. `disks`
    /// (DriveService+Disks) is the typed way in.
    var diskMounter: AnyObject?
    /// Files copied onto a drive in Finder, on their way to the server —
    /// this account's, opened at sign-in.
    var uploads: UploadQueue?
    /// One per drive with a disk: Finder's changes, made on the server.
    var writers: [String: DriveWriter] = [:]
    /// Files waiting to upload keep Onyx out of App Nap (WorkActivity), from
    /// the first one queued until the last is up or given up on.
    @Published var uploadSummary = UploadSummary() {
        didSet { WorkActivity.app.set(.uploads, uploadSummary.waiting > 0) }
    }
    /// Asks the queue for the menu's summary, a few times a second while
    /// anything changes or is on its way (summarizeUploads), and is nil
    /// when nothing is.
    var uploadTicker: Task<Void, Never>?
    /// Moved by each sign-in and sign-out: a summary loop from before one
    /// does not clear the next one's ticker.
    var uploadSummaryRound = 0
    /// Set by the queue's news, from its own thread; the summary loop
    /// clears it as it asks. What starts a loop when none runs.
    let uploadSummaryWanted = OSAllocatedUnfairLock(initialState: false)
    /// What the drives moved, second by second, for the Activity window: the
    /// disks' own reports, uploads and offline copies. Kept by adding; read
    /// only while the window is open.
    let transfers = TransferLog()
    /// Told after each pass that brought a drive's mirror up to date, with
    /// what it changed, and of each upload the server has now — before the
    /// queue lets go of its copy: the thumbnail worker's way in
    /// (ThumbnailService).
    var onMirrorSynced: ((DriveMirror, Replica.Diff) -> Void)?
    var onUploadFinished: ((UploadJob) -> Void)?
    private let server = DAVServer()
    private var mirrors: [String: DriveMirror] = [:]
    private var names: [String: String] = [:]
    /// Drives the bridge answers the onyxfs extension for (mounted as disks,
    /// or on their way): their mirrors are kept current like a mounted drive's.
    private var onyxfsScopes: Set<String> = []
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
    /// The generation start() got as far as mounting under, until stop():
    /// a drive list arriving before that (or after a sign-out) mounts
    /// nothing, since start() mounts what is wanted itself.
    private var active: Int?
    private var tickingGeneration: Int?
    private var tickAgain = false
    /// The next tick, and when it is due (`scheduleTick`).
    private var nextTick: (timer: Timer, at: ContinuousClock.Instant)?
    /// When anything last happened that the drives should keep up with: a
    /// change made here, a change the server showed, an upload on its way,
    /// Onyx brought forward. How soon the next tick comes goes by it.
    private var lastActivity = ContinuousClock.now
    /// Syncs asked for as uploads finish, by drive (`syncSoon`): whether
    /// another is wanted after the one under way, and under which sign-in.
    private var soonSyncs: [String: (generation: Int, again: Bool)] = [:]
    /// Scopes being reconciled; true when another pass is wanted after.
    private var reconciling: [String: Bool] = [:]
    /// Each pinned drive's last pass: the mirror it read (its revision, and
    /// whether it was whole), and when. A tick asks for another only when
    /// something is owed (`reconcileOwed`).
    private var reconciled: [String: (revision: UInt64, whole: Bool, at: ContinuousClock.Instant)] = [:]
    /// Views showing the cache's figures now (Settings › Storage): only
    /// while there are any is the streaming folder walked for them.
    private var usageShown = 0
    /// Each disk's streaming cache, as its extension last said: its own
    /// running total, so nothing is walked for it. Written from the
    /// bridge's threads. A disk not mounted now keeps its last figure — its
    /// cache stays on this Mac.
    private let diskCaches = OSAllocatedUnfairLock<[String: Int64]>(initialState: [:])
    weak var model: AppModel?
    private let defaults = UserDefaults.standard
    private var forwarding: AnyCancellable?
    var diskForwarding: AnyCancellable?

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
        setUpDisks()
        mounts.onEjected = { [weak self] scope in self?.forgetWanted(scope) }
        // What each disk read, fetched and was given, as its extension
        // reports it about once a second (POST /fs/v1/activity), and what
        // its streaming cache holds.
        let transfers = self.transfers, diskCaches = self.diskCaches
        server.fs.onActivity { scope, moved in
            transfers.add(.read, moved.read)
            transfers.add(.download, moved.download)
            transfers.add(.write, moved.write)
            if let cache = moved.cache { diskCaches.withLock { $0[scope] = cache } }
        }
        // Bytes going by — apps reading and writing the disks, and every
        // transfer counted here — keep Onyx out of App Nap until a few
        // seconds pass with none. Woken by the first bytes after a quiet
        // spell, never polled while nothing moves (the Activity graphs hear
        // the same wake, ActivityClock).
        let quiet: @Sendable () -> Bool = { [weak transfers] in transfers?.quiet(for: 2) ?? true }
        transfers.onWake = {
            WorkActivity.app.poke(.transfers, every: DriveService.transfersLookEvery, quiet: quiet)
        }
    }

    /// How often bytes going by are looked for while they move.
    nonisolated static let transfersLookEvery: Duration = .seconds(2)

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
    static let noAccountProblem = "Onyx is checking which account is signed in. Your drives appear here once the server answers."

    func start(model: AppModel) async {
        self.model = model
        generation += 1
        let started = generation
        // Signed out already — the sign-in was refused as the app opened:
        // nothing is mounted, and no problem is reported, for nobody.
        guard model.phase == .signedIn else { return }
        do {
            _ = try await server.start()
        } catch {
            problem = "The Finder bridge could not start: \(error.localizedDescription)"
            return
        }
        guard started == generation, model.phase == .signedIn else { return }
        guard let account = model.email, !account.isEmpty else {
            // Mirrors and offline files are each one account's; with no
            // account known, none can be shown or kept. The app asks the
            // server who is signed in and starts this again once it knows.
            problem = Self.noAccountProblem
            return
        }
        if problem == Self.noAccountProblem { problem = nil }
        Self.adoptUnscopedMirrors(into: Self.mirrorsDirectory(server: model.config.baseURL, account: account))
        // Its disk may not be connected. The drives mount and stream all the
        // same, and each tick tries the store again.
        openPins()
        await refreshPins()
        guard started == generation else { return }
        openUploads(account: account, server: model.config.baseURL)
        active = started
        await mountWanted()
        guard started == generation else { return }
        // Is the Onyx file system as the person left it? If not, they hear
        // why their drives are in ~/Onyx (FileSystemSwitch).
        await decideFileSystemSwitch()
        guard started == generation else { return }
        // A mounted drive is to show what the web shows: every 5 s while
        // anything is happening, and less often when nothing is (tickPace).
        lastActivity = .now
        Task { await ticked() }
    }

    /// Sign-out: unmount everything and stop syncing. Pinned copies stay on
    /// disk, in the account's own store, for when it signs in again; no
    /// other account is served them or can delete them.
    func stop() {
        generation += 1
        active = nil
        nextTick?.timer.invalidate()
        nextTick = nil
        soonSyncs = [:]
        reconciled = [:]
        mounts.unmountAllNow()
        stopDisks()
        for key in mirrors.keys { server.setRoute(MountManager.remoteName(SyncDomain(identifier: key)!), nil) }
        // Nothing more answered for any disk, whatever is still mounted.
        server.fs.endAll()
        onyxfsScopes = []
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
        disksUnmountAllNow()
    }

    // MARK: - Mounting

    func isMounted(_ scope: SyncDomain) -> Bool {
        if case .mounted = mountState(of: scope) { return true }
        return false
    }

    /// How a drive's mount is doing — as a disk or in ~/Onyx, whichever it
    /// is. What the menus, Settings and the page show.
    func mountState(of scope: SyncDomain) -> MountManager.State? {
        diskState(of: scope) ?? mounts.state(of: scope)
    }

    /// Every drive's, disks and mounts together (the menu bar's count).
    var allMountStates: [MountManager.State] {
        Array(mounts.states.values) + diskStates
    }

    func setMounted(_ scope: SyncDomain, name: String, _ on: Bool) async {
        if on {
            wantMounted.insert(scope.identifier)
            await mount(scope, name: name)
        } else {
            wantMounted.remove(scope.identifier)
            await mounts.unmount(scope)
            await diskUnmount(scope)
        }
        defaults.set(Array(wantMounted), forKey: Keys.mounted)
    }

    /// Mount each drive that should be in Finder and is not yet: at start,
    /// and whenever the drive list arrives (AppModel.refresh). When the
    /// server could not be reached at launch — a login item starting before
    /// Wi-Fi — that is only later, and the drives mount then. One whose mount
    /// failed stays as it is, its reason on show, until turned off and on.
    func mountWanted() async {
        guard let model, active == generation else { return }
        let started = generation
        for drive in model.finderDrives {
            let scope = SyncDomain.drive(id: drive.id)
            guard wantMounted.contains(scope.identifier), mountState(of: scope) == nil else { continue }
            await mount(scope, name: drive.name)
            guard started == generation else { return }
        }
        if wantMounted.contains(SyncDomain.library.identifier), mountState(of: .library) == nil {
            await mount(.library, name: MountFolder.library)
        }
    }

    /// The file system extension just came on — switched on in System
    /// Settings while Onyx runs, or by Turn On: each drive in ~/Onyx moves to
    /// a disk of its own, and with the last of them "localhost" leaves
    /// Finder's sidebar. One whose folder mount will not let go (a file open
    /// on it) stays where it is until the next launch; one whose disk does not
    /// mount comes back to ~/Onyx, as always.
    ///
    /// One pass at a time: asked again while one runs (the switch's news and
    /// Turn On's own answer can arrive together), one more pass follows it.
    func remountAsDisks() async {
        if remounting {
            remountAgain = true
            return
        }
        remounting = true
        defer { remounting = false }
        repeat {
            remountAgain = false
            guard let model else { return }
            let started = generation
            var drives: [(SyncDomain, String)] = model.finderDrives.map { (.drive(id: $0.id), $0.name) }
            drives.append((.library, MountFolder.library))
            for (scope, name) in drives where wantMounted.contains(scope.identifier) && mounts.state(of: scope) != nil {
                await mounts.unmount(scope)
                guard started == generation else { return }
                guard mounts.state(of: scope) == nil else { continue }
                await mount(scope, name: name)
            }
        } while remountAgain
    }

    private var remounting = false
    private var remountAgain = false

    private func mount(_ scope: SyncDomain, name: String) async {
        let started = generation
        guard let mirror = await mirror(for: scope, name: name) else { return }
        // Signed out, or turned off, while its mirror opened.
        guard started == generation, wantMounted.contains(scope.identifier) else { return }
        let segment = MountManager.remoteName(scope)
        server.setRoute(segment, DAVResponder(source: MountSource(scope: scope.identifier, mirror: mirror,
                                                                  pins: currentPins),
                                             bearerToken: server.token, hrefPrefix: "/\(segment)"))
        // As a disk of its own when this Mac can (onyxfs); in ~/Onyx otherwise.
        if await mountAsDisk(scope, name: name, mirror: mirror) { return }
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

    /// Ejected in Finder, or unmounted by something other than Onyx: the
    /// drive is no longer wanted there.
    func forgetWanted(_ scope: SyncDomain) {
        wantMounted.remove(scope.identifier)
        defaults.set(Array(wantMounted), forKey: Keys.mounted)
        model?.web.publishOfflineState()
    }

    /// The mirror a drive's writes are checked against (opened if it is not).
    func mirrorForWrites(_ scope: SyncDomain) async -> DriveMirror? {
        if let open = mirrors[scope.identifier] { return open }
        return await mirror(for: scope, name: names[scope.identifier] ?? scope.identifier)
    }

    /// After a change Finder made: the drive's mirror now, not at the next
    /// tick, so the next listing already shows it.
    func syncForWrites(_ scope: SyncDomain) async {
        noteActivity()
        guard let mirror = mirrors[scope.identifier] else { return }
        if let diff = try? await sync(mirror) { onMirrorSynced?(mirror, diff) }
        await writers[scope.identifier]?.mirrorChanged()
    }

    /// A drive's mirror brought up to the server — held as work in flight
    /// (WorkActivity) once it has gone on past `syncGrace`, so a pass
    /// bringing pages goes at full speed with the window closed. A quiet
    /// pass, a few hundred bytes, is over well before and never touches the
    /// activity: its timer is called off unfired.
    private func sync(_ mirror: DriveMirror) async throws -> Replica.Diff {
        let hold = WorkActivity.app.begin(.sync, grace: Self.syncGrace)
        defer { hold.end() }
        return try await mirror.sync()
    }

    static let syncGrace: Duration = .seconds(2)

    /// After an upload finished: the drive's mirror before long, so the file
    /// leaves pending for the server's copy. At once for the first; then at
    /// most once a second, however many finish meanwhile — a thousand
    /// photos copied in were a thousand syncs, each fetching the drive's
    /// folders, one per file. The file is listed all along, read from its
    /// copy here.
    func syncSoon(_ scope: SyncDomain) {
        let id = scope.identifier
        if soonSyncs[id]?.generation == generation {
            soonSyncs[id]?.again = true
            return
        }
        let started = generation
        soonSyncs[id] = (started, false)
        Task {
            while started == generation, soonSyncs[id]?.generation == started {
                soonSyncs[id]?.again = false
                let began = ContinuousClock.now
                await syncForWrites(scope)
                try? await Task.sleep(until: began + .seconds(1), clock: .continuous)
                guard soonSyncs[id]?.generation == started, soonSyncs[id]?.again == true else { break }
            }
            if soonSyncs[id]?.generation == started { soonSyncs[id] = nil }
        }
    }

    /// The drives' mirrors open now.
    var openMirrors: [DriveMirror] { Array(mirrors.values) }

    func reveal(_ scope: SyncDomain) {
        if diskState(of: scope) != nil { diskReveal(scope) } else { mounts.reveal(scope) }
    }

    // MARK: - onyxfs: drives as disks

    /// For DiskMounter: what FSKit mounts `scope` from as a disk of its own,
    /// `onyxfs-drive://127.0.0.1:<port>/<scope>?ticket=<t>&name=<name>&v=1`.
    ///
    /// Starts the bridge if need be, and has it answer the onyxfs extension
    /// for the drive from the same mirror and offline copies the NFS mounts
    /// read (MirrorFSSource), its mirror kept current by the tick. Then
    /// issues a ticket for this one mount: one exchange, within two minutes
    /// (FSSessions), so ask again for every mount — a remount after the app
    /// restarts included, as sessions end with the app.
    ///
    /// Throws while no one is signed in (or the account is not known yet),
    /// and for a drive this account's drive list does not have.
    func onyxfsResourceURL(for scope: SyncDomain) async throws -> URL {
        guard let model, model.phase == .signedIn, active == generation else { throw OnyxfsMountError.notSignedIn }
        let name: String
        switch scope {
        case .library:
            name = MountFolder.library
        case let .drive(id):
            guard let drive = model.finderDrives.first(where: { $0.id == id }) else { throw OnyxfsMountError.noSuchDrive }
            name = drive.name
        }
        let started = generation
        let port = try await server.start()
        guard let mirror = await mirror(for: scope, name: name), started == generation else {
            throw OnyxfsMountError.notSignedIn
        }
        let id = scope.identifier
        // One responder per drive, for as long as its mirror lasts: stop()
        // and driveGone() end it with the mirror.
        if server.fs.responder(for: id) == nil {
            // Finder's changes go through the drive's writer (to the server,
            // as the web's own), and what it has not sent yet is laid over
            // the mirror so it shows at once.
            let writer = await writer(for: scope)
            let overlay: (@Sendable () async -> (FSOverlay, UInt64))? = writer.map { w in { @Sendable in await w.overlay() } }
            let source = MirrorFSSource(scope: id, mirror: mirror, pins: { [currentPins] in currentPins.withLock { $0 } },
                                        volume: { [weak self] in
                                            await self?.onyxfsVolume(scope)
                                                ?? FSVolumeInfo(name: name, readOnly: true, cacheLimitBytes: 0)
                                        },
                                        overlay: overlay,
                                        icon: { [weak self] in
                                            // Drawn off the main thread: the
                                            // drive's colour and name are all
                                            // it needs from here.
                                            let drive = await self?.onyxfsIconDrive(scope)
                                            return DriveIcon.icns(color: drive?.color, name: drive?.name,
                                                                  mark: DriveService.appIcon)
                                        })
            server.fs.register(FSResponder(scope: id, source: source))
            server.fs.setWriter(writer, for: id)
        }
        onyxfsScopes.insert(id)
        let ticket = server.fs.sessions.issueTicket(for: id)
        return FSBridge.resourceURL(port: port, scope: id, ticket: ticket, name: name)
    }

    /// For DiskMounter, once the disk is unmounted, or its mount failed: the
    /// drive's sessions end, so its extension — or anything that learned a
    /// key — reads nothing more, and its unspent tickets go too.
    func endOnyxfsSessions(for scope: SyncDomain) {
        server.fs.end(scope: scope.identifier)
        onyxfsScopes.remove(scope.identifier)
    }

    /// The disk's name and figures, asked for afresh by `/fs/v1/volume`.
    ///
    /// Writable only when this account may change something there, as the
    /// server says (`can` in the drive list): a drive's editor or owner
    /// whose platform role allows it (Filespace.mayAddFiles), and for the
    /// library anyone whose role may upload, as on the web
    /// (AppModel.libraryWritable). From an older server, which does not say,
    /// a drive's editors and owners, and the library for an admin only. The
    /// server checks every write again whatever this says.
    private func onyxfsVolume(_ scope: SyncDomain) -> FSVolumeInfo {
        let limit = Int64(max(0, cacheLimitGB)) << 30
        switch scope {
        case .library:
            return FSVolumeInfo(name: MountFolder.library, readOnly: !(model?.libraryWritable ?? false), cacheLimitBytes: limit)
        case let .drive(id):
            let drive = model?.drives.first { $0.id == id }
            return FSVolumeInfo(name: drive?.name ?? names[scope.identifier] ?? id,
                                readOnly: !(drive?.mayAddFiles ?? false), cacheLimitBytes: limit)
        }
    }

    /// What a drive's disk icon is drawn from (DriveIcon): its colour, as
    /// the server gives it, and its name's initial. None for the library,
    /// whose disk wears the app's own icon.
    private func onyxfsIconDrive(_ scope: SyncDomain) -> (color: String?, name: String)? {
        guard case let .drive(id) = scope else { return nil }
        guard let drive = model?.drives.first(where: { $0.id == id }) else { return (nil, names[scope.identifier] ?? "") }
        return (drive.color, drive.name)
    }

    /// The app's own icon, the ONYX FS mark, at its largest: the library's
    /// disk icon. Read once, the first time a library disk mounts.
    nonisolated static let appIcon: CGImage? = {
        guard let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let widths = (0..<CGImageSourceGetCount(source)).map { index in
            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            return (index, properties?[kCGImagePropertyPixelWidth] as? Int ?? 0)
        }
        guard let largest = widths.max(by: { $0.1 < $1.1 }) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, largest.0, nil)
    }()

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
        if await mirror.lastSynced == nil {
            do {
                let diff = try await sync(mirror)
                onMirrorSynced?(mirror, diff)
            } catch OnyxError.driveGone {
                // Not with the thresholds as they are — a first sync is one
                // refusal (DriveMirror.refusalsBeforeGone) — but should they
                // allow it, the drive goes as it would on a tick.
                guard started == generation else { return nil }
                await driveGone(scope)
                return nil
            } catch {
                // Offline, or a hiccup: the mirror on disk answers, and the
                // next tick tries again. Or the server refused the drive:
                // the mirror withholds it, and it mounts showing nothing
                // until the ticks find it back, or lost.
            }
        }
        guard started == generation else { return nil }
        return mirror
    }

    /// The server says this account may no longer open the drive: it was
    /// deleted, or the account was taken off it. The mirror has already
    /// forgotten its tree (DriveMirror.sync). Nothing of it stays on this
    /// Mac either: not in Finder, not kept offline, not mounted again at the
    /// next launch — access taken away on the web reaches the device.
    ///
    /// Only once the server has refused the drive for minutes on end
    /// (DriveMirror.refusalsBeforeGone): it gives the same answer when one
    /// of its own queries fails, and none of this can be undone. Until then
    /// the mirror only withholds the drive, which shows empty in Finder and
    /// keeps its offline copies.
    ///
    /// With the offline store's disk not connected, its copies wait
    /// (PinStore.removeAll): the store's rules still name the drive, so once
    /// the disk is back its mirror is opened again (tick), the server says
    /// the same, and they go then.
    private func driveGone(_ scope: SyncDomain) async {
        let id = scope.identifier
        let started = generation
        appLog.info("drive: \(id, privacy: .public) is no longer available to this account; removing it")
        // Nothing more is answered for it, first — to rclone or to a disk.
        server.setRoute(MountManager.remoteName(scope), nil)
        server.fs.end(scope: id)
        onyxfsScopes.remove(id)
        mirrors[id] = nil
        names[id] = nil
        if wantMounted.remove(id) != nil { defaults.set(Array(wantMounted), forKey: Keys.mounted) }
        await mounts.unmount(scope)
        await diskUnmount(scope)
        guard started == generation else { return }
        if let pins { await pins.removeAll(scope: id) }
        guard started == generation else { return }
        // Shows the page and Settings what is kept and mounted now.
        await refreshPins()
        guard started == generation else { return }
        // And the drive list, so it leaves the menus too.
        await model?.refresh()
    }

    // MARK: - Ticking

    /// How often a tick comes: every 5 s within a minute of anything
    /// happening, or while a window is open; every 30 s after that; every
    /// minute once ten have gone by with nothing. Each tick is a request per
    /// drive, and a Mac left alone need not make twelve a minute for each.
    static let activePace: Duration = .seconds(5)
    static let idlePace: Duration = .seconds(30)
    static let restingPace: Duration = .seconds(60)
    static let activeFor: Duration = .seconds(60)
    static let idleFor: Duration = .seconds(600)
    /// A pinned drive's copies are looked at on a tick at least this often
    /// with nothing else owed: a copy deleted by hand is fetched again.
    static let reconcileAtLeastEvery: Duration = .seconds(600)
    /// And this often while the last pass could not do everything (the
    /// cache's disk full or gone), in case it can now.
    static let reconcileAfterProblem: Duration = .seconds(60)

    /// Something happened the drives should keep up with: the ticks come
    /// every 5 s for the next minute, the next one within 5 s.
    func noteActivity() {
        lastActivity = .now
        if let nextTick, nextTick.at > .now + Self.activePace { scheduleTick(in: Self.activePace) }
    }

    /// The pace now (`activePace` and the rest).
    private var tickPace: Duration {
        let quiet = ContinuousClock.now - lastActivity
        if quiet < Self.activeFor || Self.windowIsOpen { return Self.activePace }
        return quiet < Self.idleFor ? Self.idlePace : Self.restingPace
    }

    /// Onyx's own window on screen: the person is looking at the drives.
    private static var windowIsOpen: Bool {
        NSApp.windows.contains { $0.isVisible && $0.canBecomeMain && !($0 is NSPanel) }
    }

    /// One timer, for the next tick only, set again after each: the pace
    /// can change between two. Given a tenth of its wait as tolerance, so
    /// macOS may fold its firing in with other work rather than wake for it.
    private func scheduleTick(in delay: Duration) {
        nextTick?.timer.invalidate()
        let seconds = Double(delay.components.seconds) + Double(delay.components.attoseconds) / 1e18
        let timer = Timer(timeInterval: seconds, repeats: false) { [weak self] _ in
            Task { @MainActor in await self?.ticked() }
        }
        timer.tolerance = seconds / 10
        RunLoop.main.add(timer, forMode: .common)
        nextTick = (timer, .now + delay)
    }

    /// A tick, then the next one set for the pace it leaves.
    private func ticked() async {
        nextTick?.timer.invalidate()
        nextTick = nil
        await tick()
        guard active == generation, model?.phase == .signedIn, nextTick == nil else { return }
        scheduleTick(in: tickPace)
    }

    /// Bring each mirror that is mounted or pinned up to the server, and
    /// fetch whatever a pin now wants.
    ///
    /// One tick at a time. A tick asked for while one runs (syncNow) asks
    /// it to go round once more instead of starting a second.
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
        // The drive list has not come yet: the server was out of reach when
        // the app opened. Asked for again until it answers, and then the
        // drives wanted in Finder mount (AppModel.refresh → mountWanted).
        if let model, !model.drivesLoaded {
            await model.refresh()
            guard started == generation else { return }
        }
        // And every five minutes once it has: a colour or name changed on
        // the web reaches the drive's disk icon (drivesChanged).
        await model?.refreshIfOlder(than: 300)
        guard started == generation else { return }
        // Drives in ~/Onyx because the Onyx file system is off: switched on
        // in System Settings since, they become disks now, not at the next
        // launch. Asked only while that is so.
        await checkFileSystemSwitch()
        guard started == generation else { return }
        // A cache disk plugged back in: its store opens now, and every
        // pinned drive is owed a pass on it.
        if pins == nil {
            openPins()
            if pins != nil {
                reconciled = [:]
                await refreshPins()
            }
            guard started == generation else { return }
        }
        let pinnedScopes = Set(pinRules.map(\.scope))
        let due = mirrors.filter { wantMounted.contains($0.key) || pinnedScopes.contains($0.key) || onyxfsScopes.contains($0.key) }
        var gone: Set<String> = []
        // One drive after another. They went four at a time in a task group
        // in 0.5.14, and on macOS 27 the group's children crashed the app as
        // they reported back — EXC_BAD_ACCESS in TaskGroup::offer, the moment
        // a launch's first syncs finished, on every launch. A drive with
        // nothing new answers in a few hundred milliseconds; in turn is what
        // 0.5.13 did, for as long as it ran.
        for (id, mirror) in due {
            guard started == generation else { return }
            syncing.insert(id)
            let result: Result<Replica.Diff, Error>
            do { result = .success(try await sync(mirror)) } catch { result = .failure(error) }
            // Signed out while it synced: nothing more for that account.
            guard started == generation else { return }
            switch result {
            case let .success(diff):
                onMirrorSynced?(mirror, diff)
                // Something changed on the web: the ticks keep up for a while.
                if !diff.isEmpty { noteActivity() }
                // Files this Mac uploaded that the mirror now shows stop
                // being pending, and their staged copies go.
                await writers[id]?.mirrorChanged()
                if isOffline {
                    isOffline = false
                    // Back: what failed for want of a network is tried now,
                    // not after its wait — every pinned drive's.
                    await pins?.retryNow()
                    reconciled = [:]
                }
            case let .failure(error):
                if case .notAuthenticated? = error as? OnyxError {
                    syncing.remove(id)
                    // For the sign-in this tick began under, which it still is
                    // (checked above): whoever is signed in now is not to be
                    // signed out for another's token.
                    await model?.tokenRejected()
                    return
                }
                if case .driveGone? = error as? OnyxError {
                    syncing.remove(id)
                    gone.insert(id)
                    await driveGone(mirror.scope)
                    continue
                }
                if error is URLError {
                    // Offline: the mount keeps answering from the last good
                    // mirror, and pinned files keep working.
                    isOffline = true
                }
                // Otherwise a server hiccup: the same, and the next tick tries
                // again. A refusal of the drive lands here too until it has
                // gone on long enough to be believed; the mirror withholds the
                // drive meanwhile, and a pass against it deletes nothing.
            }
            guard started == generation else { return }
            syncing.remove(id)
            // Not waited for: a pin downloading for hours must not hold up
            // the syncing of every drive after this one.
            if pinnedScopes.contains(id), await reconcileOwed(id, mirror) { reconcileSoon(id) }
        }
        guard started == generation else { return }
        // Pins in drives that are not mounted still need their mirror.
        for scope in pinnedScopes where mirrors[scope] == nil && !gone.contains(scope) {
            // Checked before opening one, which would be for whoever is
            // signed in by then.
            guard started == generation else { return }
            guard let domain = SyncDomain(identifier: scope) else { continue }
            let opened = await mirror(for: domain, name: names[scope] ?? scope)
            guard started == generation else { return }
            if opened != nil { reconcileSoon(scope) }
        }
        // Only for someone looking: Settings › Storage.
        if usageShown > 0 { await refreshUsage() }
    }

    /// Whether a pinned drive's copies are owed a pass: its mirror shows
    /// something new since the last one read it, a failed download is due
    /// again, or it has been a while. Each pass looks at every copy on disk,
    /// and one every tick for a drive kept offline whole was a hundred
    /// thousand stats every few seconds, with nothing changed.
    private func reconcileOwed(_ scope: String, _ mirror: DriveMirror) async -> Bool {
        guard let last = reconciled[scope] else { return true }
        let (revision, index) = await mirror.snapshot
        if revision != last.revision || index.isAuthoritative != last.whole { return true }
        let since = ContinuousClock.now - last.at
        if since >= Self.reconcileAtLeastEvery { return true }
        guard let pins else { return false }
        if await pins.retryDue(scope: scope) { return true }
        // The cache's disk unplugged, or back, since the last pass said
        // otherwise: a pass finds out, and Settings says so (one look at
        // /Volumes, not at the copies).
        let problem = await pins.problem
        if PinStore.isOnMissingVolume(cacheRoot) != (problem == .unavailable) { return true }
        return since >= Self.reconcileAfterProblem && problem != nil
    }

    func syncNow() async {
        // Asked for: whatever is waiting to be tried again goes now, and
        // every pinned drive is looked at.
        await pins?.retryNow()
        reconciled = [:]
        noteActivity()
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
        let started = generation
        var indexes: [(scope: String, index: MirrorIndex)] = []
        for (scope, mirror) in mirrors { indexes.append((scope, await mirror.index)) }
        // Signed out meanwhile: these were the last account's files.
        guard started == generation else { return }
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

    /// A file's copy kept offline, found by its id alone, for the proxy
    /// worker, which has no drive for it: in whichever open drive's mirror
    /// has the file, and only at the version that mirror has now, as a read
    /// from Finder would be served. With it, what the mirror says of the
    /// bytes: its size, and its etag (the content hash, where the server has
    /// one).
    func keptCopy(fileId: String) async -> (url: URL, entry: MirrorEntry)? {
        for (scope, mirror) in mirrors {
            guard let entry = await mirror.snapshot.index.file(id: fileId),
                  let url = await localCopy(scope: scope, entry: entry) else { continue }
            return (url, entry)
        }
        return nil
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
        let (revision, index) = await mirror.snapshot
        guard started == generation else { return }
        reconciled[scope] = (revision, index.isAuthoritative, .now)
        let transfers = self.transfers
        let report = await pins.reconcile(scope: scope, index: index) { entry, destination in
            guard let id = entry.fileId else { throw OnyxError.decoding("not a file") }
            // Work in flight while this copy comes down (WorkActivity): what
            // is kept offline arrives as fast with the window closed as open.
            let fetching = WorkActivity.app.begin(.offlineCopies)
            defer { fetching.end() }
            let url = try await mirror.contentURL(fileId: id)
            // Straight into the store's folder, on the cache's own disk.
            do {
                try await FileDownload.fetch(url, to: destination, received: { transfers.add(.download, $0) })
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

    /// Settings › Storage on screen (`true`) or gone: its figures are
    /// brought up to date now and with each tick while it shows them, and
    /// not otherwise.
    func showUsage(_ shown: Bool) {
        usageShown = max(0, usageShown + (shown ? 1 : -1))
        guard shown else { return }
        noteActivity()
        Task { await refreshUsage() }
    }

    /// The cache's figures: what is kept offline, from the store's records,
    /// and what is streamed — the disks' caches as their extensions report
    /// them, and the folder mounts' (rclone's, which keeps no total of its
    /// own) walked. Only when asked for: each tick walked every file of
    /// that folder, with no one looking.
    private func refreshUsage() async {
        let started = generation
        let bytes = await pins?.usage() ?? 0
        let problem = await pins?.problem
        let dir = streamingDirectory
        let streamed = await Task.detached(priority: .utility) { Self.directorySize(dir) }.value
        guard started == generation else { return }
        pinnedBytes = bytes
        if pins != nil { offlineProblem = describe(problem) }
        streamingBytes = streamed + diskCaches.withLock { $0.values.reduce(0, +) }
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
        let started = generation
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
        // Signed out while it moved: the drives stay unmounted, as stop() left them.
        guard started == generation else { return }
        if pins == nil, model?.phase == .signedIn { openPins() }
        for scope in mounted {
            await mount(scope, name: names[scope.identifier] ?? scope.identifier)
            guard started == generation else { return }
        }
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
        let started = generation
        let mounted = mounts.states.keys.compactMap(SyncDomain.init(identifier:))
        for scope in mounted { await mounts.unmount(scope) }
        try? FileManager.default.removeItem(at: streamingDirectory)
        for scope in mounted {
            guard started == generation else { return }
            await mount(scope, name: names[scope.identifier] ?? scope.identifier)
        }
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

/// Why a drive cannot be mounted as a disk now (DriveService.onyxfsResourceURL).
enum OnyxfsMountError: LocalizedError {
    /// Signed out, or the account not known yet: a drive's mirror and the
    /// files kept offline are one account's.
    case notSignedIn
    /// Not among the drives this account may open.
    case noSuchDrive

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Sign in to Onyx to mount drives."
        case .noSuchDrive: return "This drive is not available to your account."
        }
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
