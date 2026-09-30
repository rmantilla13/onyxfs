import Foundation
import OnyxKit
import os
import UIKit

private let log = Logger(subsystem: "io.onyxfs.app", category: "downloads")

/// One file on its way out of Onyx: from the tap that asked for it until it
/// is in Photos, in a folder in Files, or in the share sheet.
struct DownloadItem: Identifiable, Codable, Equatable {
    enum State: Codable, Equatable {
        /// Asking the server where the bytes are (it authorizes each file).
        case preparing
        case downloading
        /// Going into the photo library.
        case saving
        /// Here, waiting for the rest of its batch, or for Onyx to be on
        /// screen to show the folder picker or the share sheet.
        case ready
        case done(String)
        case failed(Failure)
    }

    struct Failure: Codable, Equatable {
        var message: String
        var canRetry = true
        /// Photos would not take it, or may not: Files is offered instead.
        var offerFiles = false
        /// Onyx may not add to Photos, which Settings changes.
        var offerSettings = false
    }

    let id: UUID
    /// The files asked for together. Files and the share sheet take them
    /// together; Photos takes each as it lands.
    var batch: UUID
    let fileId: String
    /// What it lands as.
    let name: String
    let kind: String
    let variant: SaveVariant
    var destination: SaveDestination
    var expected: Int64?
    var received: Int64 = 0
    var state: State
    /// When the link it is fetched through stops working: a retry after it
    /// asks for a new one rather than resuming.
    var linkExpires: Date?

    var isActive: Bool {
        switch state {
        case .preparing, .downloading, .saving, .ready: return true
        case .done, .failed: return false
        }
    }

    var isDone: Bool {
        if case .done = state { return true }
        return false
    }

    var failure: Failure? {
        if case let .failed(failure) = state { return failure }
        return nil
    }

    var fraction: Double? { SavePlan.fraction(received: received, expected: expected) }
}

/// A heavy video's streamable copy, as the Save menu offers it beside the
/// original.
struct StreamableCopy: Equatable {
    let size: Int64?
    let shortSide: Int?

    var label: String { SavePlan.streamableLabel(shortSide: shortSide) }

    /// Only a video this large is given one (lib/proxies.js PROXY_MIN_BYTES).
    static let minimumSize: Int64 = 200 * 1024 * 1024

    static func mayHave(_ file: FileItem) -> Bool {
        (file.kind == "video" || SavePlan.photosSupport(name: file.name, kind: file.kind) == .video)
            && (file.size ?? 0) >= minimumSize
    }

    /// Whether `file` has one ready, and what it is: its frame and size
    /// from the proxy's own record, or — from a server that cannot say — only
    /// that the content link carries one.
    static func lookup(_ file: FileItem, api: OnyxAPI) async -> StreamableCopy? {
        guard mayHave(file) else { return nil }
        if let status = try? await api.proxyStatus(fileId: file.id) {
            return status.isReady ? StreamableCopy(size: status.size, shortSide: status.shortSide) : nil
        }
        if let link = try? await api.contentLink(fileId: file.id), link.proxyUrl != nil {
            return StreamableCopy(size: nil, shortSide: nil)
        }
        return nil
    }
}

/// Everything being saved out of Onyx: what the tray shows, and the work
/// behind it.
///
/// Each file's bytes come through the content link the preview uses — the
/// server authorizes the file and signs it — fetched by the system in the
/// background (DownloadTransport), so leaving the app does not stop a
/// multi-gigabyte video. Then Photos takes it (moved in, not copied), or,
/// once the rest of its batch is here, the Files app's folder picker or the
/// share sheet does. Nothing is kept after: a file saved, shared, cancelled
/// or failed takes its folder with it, and a download that failed leaves
/// only what the system holds to resume it, until it is retried or
/// dismissed. The list itself is kept (downloads.json) so that a download
/// the system finishes after iOS ended the app is still taken where it was
/// going.
@MainActor @Observable
final class DownloadCenter {
    static let shared = DownloadCenter()

    private(set) var items: [DownloadItem] = []
    /// What just finished, said once ("Saved 3 to Photos").
    private(set) var notice: Notice?

    struct Notice: Identifiable, Equatable {
        let id = UUID()
        let text: String
        var failed = false
    }

    @ObservationIgnored let transport = DownloadTransport()
    /// The listing's rows, for the tray's pictures; not kept across launches.
    @ObservationIgnored private var sources: [UUID: FileItem] = [:]
    @ObservationIgnored private var preparing: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var resumeData: [UUID: Data] = [:]
    /// A folder picker or share sheet is up: the next batch waits for it.
    @ObservationIgnored private var handingOver = false
    @ObservationIgnored private var handOverRetry: Task<Void, Never>?
    @ObservationIgnored private var noticeTimer: Task<Void, Never>?
    /// Batches whose outcome has been said, so it is said once.
    @ObservationIgnored private var settled: Set<UUID> = []

    static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Downloads", isDirectory: true)
    }

    static func folder(for id: UUID) -> URL {
        folder.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    static func file(for item: DownloadItem) -> URL {
        folder(for: item.id).appendingPathComponent(item.name)
    }

    private static var record: URL { folder.appendingPathComponent("downloads.json") }

    private init() {
        Self.prepareFolder()
        items = Self.load()
        transport.destination = { id, name in Self.folder(for: id).appendingPathComponent(name) }
        transport.onEvent = { event in
            Task { @MainActor in DownloadCenter.shared.handle(event) }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification,
                                               object: nil, queue: .main) { _ in
            Task { @MainActor in DownloadCenter.shared.handOverWaiting() }
        }
        Task { await reattach() }
    }

    subscript(id: UUID) -> DownloadItem? { items.first { $0.id == id } }

    func source(for id: UUID) -> FileItem? { sources[id] }

    // MARK: - Asking

    /// Saves `files` to `destination`: each downloaded, then handed over.
    /// For Photos, access is asked for first, and a file Photos cannot
    /// import is said so at once — with Files offered — rather than after
    /// its download.
    func save(_ files: [FileItem], variant: SaveVariant = .original, to destination: SaveDestination,
              api: OnyxAPI, streamable: StreamableCopy? = nil) {
        guard !files.isEmpty else { return }
        guard destination == .photos else {
            enqueue(files, variant: variant, to: destination, api: api, streamable: streamable)
            return
        }
        Task {
            if await PhotosSaver.authorize() {
                enqueue(files, variant: variant, to: .photos, api: api, streamable: streamable)
            } else {
                askForPhotosAccess {
                    self.enqueue(files, variant: variant, to: .files, api: api, streamable: streamable)
                }
            }
        }
    }

    private func enqueue(_ files: [FileItem], variant: SaveVariant, to destination: SaveDestination,
                         api: OnyxAPI, streamable: StreamableCopy?) {
        let batch = UUID()
        let names = SavePlan.uniqueNames(files.map {
            variant == .streamable ? SavePlan.streamableName(for: $0.name, shortSide: streamable?.shortSide) : $0.name
        })
        for (file, name) in zip(files, names) {
            var item = DownloadItem(id: UUID(), batch: batch, fileId: file.id, name: name, kind: file.kind,
                                    variant: variant, destination: destination,
                                    expected: variant == .streamable ? streamable?.size : file.size, state: .preparing)
            sources[item.id] = file
            if destination == .photos, variant == .original,
               case let .unsupported(reason) = SavePlan.photosSupport(name: file.name, kind: file.kind) {
                item.state = .failed(.init(message: reason, canRetry: false, offerFiles: true))
                items.append(item)
                continue
            }
            items.append(item)
            start(item.id, api: api)
        }
        persist()
        settle(batch)
    }

    // MARK: - The person's hand

    /// Stops a download, or takes a finished or failed one off the list,
    /// with whatever of it was here.
    func cancel(_ id: UUID) {
        guard let item = self[id] else { return }
        switch item.state {
        case .saving:
            return // Photos has it; it cannot be taken back halfway
        case .downloading:
            transport.cancel(id) // .cancelled comes back, and removes it
        case .preparing:
            preparing[id]?.cancel()
            remove(id)
        case .ready, .done, .failed:
            remove(id)
        }
        handOver(item.batch)
    }

    func retry(_ id: UUID, api: OnyxAPI) {
        guard let item = self[id], let failure = item.failure, failure.canRetry else { return }
        if item.destination == .photos {
            Task {
                guard await PhotosSaver.authorize() else {
                    askForPhotosAccess { self.saveToFiles(id, api: api) }
                    return
                }
                retryNow(id, api: api)
            }
        } else {
            retryNow(id, api: api)
        }
    }

    private func retryNow(_ id: UUID, api: OnyxAPI) {
        guard let item = self[id] else { return }
        // Downloaded, and only Photos said no: it is asked again.
        if item.destination == .photos, FileManager.default.fileExists(atPath: Self.file(for: item).path) {
            downloaded(id)
            return
        }
        // Alone now: the rest of its batch has gone on without it.
        update(id) { $0.batch = UUID() }
        if let data = resumeData.removeValue(forKey: id) {
            if let expires = item.linkExpires, expires.timeIntervalSinceNow > 300 {
                update(id) { $0.state = .downloading }
                transport.resume(data, item: id, name: item.name, expected: item.expected)
                persist()
                return
            }
            transport.discard(data)
        }
        start(id, api: api)
    }

    /// What Photos would not take, to a folder in Files instead: the file
    /// already here, or fetched now if Photos was never going to take it.
    func saveToFiles(_ id: UUID, api: OnyxAPI) {
        guard let item = self[id] else { return }
        let batch = UUID()
        update(id) {
            $0.destination = .files
            $0.batch = batch
        }
        if FileManager.default.fileExists(atPath: Self.file(for: item).path) {
            update(id) { $0.state = .ready }
            persist()
            handOver(batch)
        } else {
            start(id, api: api)
        }
    }

    /// Takes everything finished or failed off the list.
    func clearFinished() {
        for item in items where !item.isActive { remove(item.id) }
    }

    /// Signing out: every download stops, and nothing of them stays.
    func removeAll() {
        for item in items {
            preparing[item.id]?.cancel()
            if case .downloading = item.state { transport.cancel(item.id) }
        }
        for data in resumeData.values { transport.discard(data) }
        resumeData = [:]
        sources = [:]
        items = []
        try? FileManager.default.removeItem(at: Self.folder)
        Self.prepareFolder()
    }

    // MARK: - The work

    private func start(_ id: UUID, api: OnyxAPI) {
        guard let item = self[id] else { return }
        update(id) {
            $0.state = .preparing
            $0.received = 0
        }
        preparing[id]?.cancel()
        preparing[id] = Task {
            defer { preparing[id] = nil }
            do {
                // Already on this device, the version a preview opened: a
                // clone of it (instant, and no second copy on APFS).
                if item.variant == .original, let file = sources[id], let kept = PreviewFiles.cached(for: file) {
                    let target = Self.file(for: item)
                    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? FileManager.default.removeItem(at: target)
                    try FileManager.default.copyItem(at: kept, to: target)
                    update(id) { $0.received = $0.expected ?? 0 }
                    downloaded(id)
                    return
                }
                try Self.checkRoom(for: item.expected)
                let link = try await api.contentLink(fileId: item.fileId)
                try Task.checkCancellation()
                let url: URL
                switch item.variant {
                case .original:
                    url = link.url
                case .streamable:
                    guard let proxy = link.proxyUrl else {
                        throw DownloadProblem(message: "The \(SavePlan.streamableLabel(shortSide: nil)) copy isn't available any more.",
                                              canRetry: false)
                    }
                    url = proxy
                }
                update(id) {
                    $0.state = .downloading
                    $0.linkExpires = link.expiresAt?.date
                }
                persist()
                transport.start(url, item: id, name: item.name, expected: item.expected)
            } catch {
                if Session.isCancel(error) { return }
                fail(id, error)
            }
        }
    }

    private func handle(_ event: DownloadTransport.Event) {
        switch event {
        case let .progress(id, received, expected):
            update(id) {
                $0.received = received
                if let expected { $0.expected = expected }
                if $0.state == .preparing { $0.state = .downloading }
            }
        case let .finished(id, _):
            guard self[id] != nil else {
                // Cancelled while its last bytes came in.
                try? FileManager.default.removeItem(at: Self.folder(for: id))
                return
            }
            update(id) { $0.received = max($0.received, $0.expected ?? 0) }
            downloaded(id)
        case let .failed(id, error, data):
            if let data {
                if self[id] != nil { resumeData[id] = data } else { transport.discard(data) }
            }
            fail(id, error)
        case let .cancelled(id):
            remove(id)
        }
    }

    /// Here: into Photos now, or to wait for the rest of its batch.
    private func downloaded(_ id: UUID) {
        guard let item = self[id] else { return }
        switch item.destination {
        case .photos:
            update(id) { $0.state = .saving }
            persist()
            let file = Self.file(for: item)
            let support: PhotosSupport = item.variant == .streamable
                ? .video : SavePlan.photosSupport(name: item.name, kind: item.kind)
            Task {
                // A 4 GB video takes Photos a moment: finished even if the
                // app is left meanwhile.
                let background = UIApplication.shared.beginBackgroundTask(withName: "Save to Photos")
                let outcome = await PhotosSaver.save(file, name: item.name, as: support, moving: true)
                switch outcome {
                case .saved:
                    removeFolder(id)
                    update(id) { $0.state = .done(SavePlan.saved(1, to: .photos)) }
                case let .unsupported(reason):
                    update(id) { $0.state = .failed(.init(message: reason, canRetry: false, offerFiles: true)) }
                case .denied:
                    update(id) {
                        $0.state = .failed(.init(message: "Onyx isn't allowed to add to Photos.",
                                                 canRetry: true, offerFiles: true, offerSettings: true))
                    }
                case let .failed(words):
                    update(id) { $0.state = .failed(.init(message: words, canRetry: true, offerFiles: true)) }
                }
                persist()
                settle(item.batch)
                if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
            }
        case .files, .share:
            update(id) { $0.state = .ready }
            persist()
            handOver(item.batch)
        }
    }

    /// Files and the share sheet take a batch whole: once nothing in it is
    /// still coming, and Onyx is on screen to show them.
    private func handOver(_ batch: UUID) {
        let members = items.filter { $0.batch == batch }
        guard !members.contains(where: { $0.state == .preparing || $0.state == .downloading }) else { return }
        let ready = members.filter { $0.state == .ready }
        guard let destination = ready.first?.destination, destination != .photos, !handingOver else { return }
        let ids = ready.map(\.id)
        let urls = ready.map { Self.file(for: $0) }
        let done: (Bool) -> Void = { completed in
            DownloadCenter.shared.handedOver(ids, batch: batch, to: destination, completed: completed)
        }
        let shown = destination == .files ? Handoff.exportToFiles(urls, done: done) : Handoff.share(urls, done: done)
        if shown {
            handingOver = true
        } else if UIApplication.shared.applicationState == .active {
            // Something is on its way on or off the screen: a moment later.
            handOverRetry?.cancel()
            handOverRetry = Task {
                try? await Task.sleep(for: .milliseconds(600))
                if !Task.isCancelled { handOverWaiting() }
            }
        }
        // Otherwise it waits for Onyx to come back (didBecomeActive).
    }

    private func handOverWaiting() {
        guard !handingOver else { return }
        var seen = Set<UUID>()
        for item in items where item.state == .ready && seen.insert(item.batch).inserted {
            handOver(item.batch)
            if handingOver { return }
        }
    }

    private func handedOver(_ ids: [UUID], batch: UUID, to destination: SaveDestination, completed: Bool) {
        handingOver = false
        for id in ids {
            // Moved to the folder chosen, or given to another app: either
            // way, not kept here.
            removeFolder(id)
            if completed {
                update(id) { $0.state = .done(destination == .files ? SavePlan.saved(1, to: .files) : "Shared") }
            } else {
                items.removeAll { $0.id == id }
                sources[id] = nil
            }
        }
        persist()
        settle(batch)
        handOverWaiting()
    }

    private func fail(_ id: UUID, _ error: Error) {
        guard let item = self[id] else { return }
        let problem = error as? DownloadProblem
        log.error("save failed: \(String(describing: error), privacy: .public)")
        update(id) {
            $0.state = .failed(.init(message: problem?.message ?? Session.words(for: error), canRetry: problem?.canRetry ?? true))
        }
        // Nothing half-fetched stays here.
        removeFolder(id)
        persist()
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        handOver(item.batch)
        settle(item.batch)
    }

    private func remove(_ id: UUID) {
        guard let item = self[id] else { return }
        preparing[id]?.cancel()
        if let data = resumeData.removeValue(forKey: id) { transport.discard(data) }
        removeFolder(id)
        items.removeAll { $0.id == id }
        sources[id] = nil
        persist()
        handOver(item.batch)
        settle(item.batch)
    }

    /// Once nothing in a batch is under way: what it came to, said once.
    /// Saved files leave the list a moment later; failures stay until they
    /// are dealt with.
    private func settle(_ batch: UUID) {
        let members = items.filter { $0.batch == batch }
        guard !members.isEmpty, !members.contains(where: \.isActive), settled.insert(batch).inserted else { return }
        let saved = members.filter(\.isDone)
        let failed = members.count - saved.count
        if let first = saved.first {
            var text = saved.count == 1 ? (first.state.doneText ?? "") : SavePlan.saved(saved.count, to: first.destination)
            if failed > 0 { text += " · \(failed) not saved" }
            announce(text)
            Task {
                try? await Task.sleep(for: .seconds(5))
                items.removeAll { $0.batch == batch && $0.isDone }
                for item in saved { sources[item.id] = nil }
            }
        } else if failed > 0 {
            announce(failed == 1 ? "Couldn't save \(members[0].name)" : "Couldn't save \(failed) files", failed: true)
        }
    }

    private func announce(_ text: String, failed: Bool = false) {
        notice = Notice(text: text, failed: failed)
        if !failed { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        UIAccessibility.post(notification: .announcement, argument: text)
        noticeTimer?.cancel()
        noticeTimer = Task {
            try? await Task.sleep(for: .seconds(3.5))
            if !Task.isCancelled { notice = nil }
        }
    }

    private func askForPhotosAccess(saveToFiles: @escaping () -> Void) {
        Handoff.alert("Allow Onyx to Add to Photos",
                      message: "Onyx can only add the photos and videos you save. Turn it on in Settings › Privacy & Security › Photos, or save to Files instead.",
                      actions: [
                          .init(title: "Open Settings") { Handoff.openSettings() },
                          .init(title: "Save to Files Instead", run: saveToFiles),
                          .init(title: "Cancel", style: .cancel) {},
                      ])
    }

    // MARK: - Launch

    /// After a launch: what the system is still fetching carries on, what
    /// it finished while the app was ended is taken where it was going, and
    /// what it could not is said so.
    private func reattach() async {
        let running = await transport.activate()
        for item in items {
            let here = FileManager.default.fileExists(atPath: Self.file(for: item).path)
            switch item.state {
            case .preparing, .downloading:
                if running.contains(item.id) {
                    update(item.id) { $0.state = .downloading }
                } else if here {
                    downloaded(item.id)
                } else {
                    update(item.id) {
                        $0.state = .failed(.init(message: "The download stopped when Onyx was closed."))
                    }
                }
            case .saving:
                if here { downloaded(item.id) } else { items.removeAll { $0.id == item.id } }
            case .ready:
                if !here { items.removeAll { $0.id == item.id } }
            case .done:
                items.removeAll { $0.id == item.id }
            case .failed:
                break
            }
        }
        sweep()
        persist()
        handOverWaiting()
    }

    // MARK: - Keeping

    private func update(_ id: UUID, _ change: (inout DownloadItem) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[index])
    }

    private func persist() {
        let kept = items.filter { !$0.isDone }
        do {
            try JSONEncoder().encode(kept).write(to: Self.record, options: .atomic)
        } catch {
            log.error("could not keep the download list: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func load() -> [DownloadItem] {
        guard let data = try? Data(contentsOf: record) else { return [] }
        return (try? JSONDecoder().decode([DownloadItem].self, from: data)) ?? []
    }

    private func removeFolder(_ id: UUID) {
        try? FileManager.default.removeItem(at: Self.folder(for: id))
    }

    /// Folders no item owns: left by a crash between a move and a save.
    private func sweep() {
        let owned = Set(items.map(\.id.uuidString))
        let entries = (try? FileManager.default.contentsOfDirectory(at: Self.folder, includingPropertiesForKeys: nil)) ?? []
        for entry in entries where entry.hasDirectoryPath && !owned.contains(entry.lastPathComponent) {
            try? FileManager.default.removeItem(at: entry)
        }
    }

    /// Room for `bytes`, with some to spare, before any of it is fetched.
    private static func checkRoom(for bytes: Int64?) throws {
        guard let bytes, bytes > 0,
              let free = try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
                  .volumeAvailableCapacityForImportantUsage,
              free > 0 else { return }
        if bytes + (256 << 20) > free {
            let needs = SavePlan.size(bytes) ?? "more"
            let has = SavePlan.size(free) ?? "less"
            throw DownloadProblem(message: "There isn't room on this \(Session.deviceLabel): this needs \(needs), and \(has) is free.")
        }
    }

    private static func prepareFolder() {
        var folder = Self.folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Files on their way somewhere else: never backed up.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
    }
}

extension DownloadItem.State {
    var doneText: String? {
        if case let .done(text) = self { return text }
        return nil
    }
}
