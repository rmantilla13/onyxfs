import AppKit
import FinderSync
import os
import OnyxFinderCore

let finderLog = Logger(subsystem: "io.onyxfs.app.findersync", category: "finder")

/// Onyx in Finder's right-click menu — Keep Offline, Remove Offline Copy,
/// Show in Onyx — and a mark on what is kept offline, for the drives Onyx
/// has mounted: each a disk of its own at /Volumes/<drive>, or a folder
/// mount in ~/Onyx/<drive>.
///
/// Finder starts it once the person has switched it on in System Settings
/// (one process for Finder, and one for each app's Open and Save panels).
/// It knows nothing of drives itself: the app hands it an index of what is
/// mounted and what is kept (FinderIndex), which it asks for as it starts and
/// again each time the app says it changed — never per item. Every mark
/// Finder asks for is answered from that index in memory (FinderLookup). Keep
/// Offline and Remove Offline Copy go to the app, which keeps files offline
/// as the Onyx window does (DriveService), and the marks follow from the
/// index it sends back. With nothing changing it does nothing at all.
@objc(OnyxFinderSync)
final class FinderSync: FIFinderSync {
    private let link: AppLink?
    private let shown = OSAllocatedUnfairLock(initialState: Shown())
    /// What the last menu offered, for its actions. Main thread only.
    private var plan = FinderMenuPlan()

    /// The items Finder has asked to mark, until it stops showing their
    /// folder: each with the mark it was given, to change when the index
    /// does. Finder may ask from any thread.
    private struct Shown {
        var lookup = FinderLookup.empty
        /// The app answered the last time it was asked.
        var reachable = false
        /// The drives' mount points: the folders Finder is asked to watch.
        /// Kept when the app stops answering, so a drive it left behind can
        /// still be opened in it.
        var roots: [String] = []
        var items: [String: [URL: String]] = [:]
        var count = 0

        /// Past this many, what is remembered is let go of: a very long day
        /// of browsing, not something on screen.
        static let most = 50_000

        mutating func remember(_ url: URL, _ badge: String) {
            let folder = url.deletingLastPathComponent().standardizedFileURL.path
            if items[folder, default: [:]].updateValue(badge, forKey: url) == nil { count += 1 }
            if count > Self.most {
                items = [folder: items[folder] ?? [:]]
                count = items[folder]?.count ?? 0
            }
        }

        mutating func forget(folder url: URL) {
            count -= items.removeValue(forKey: url.standardizedFileURL.path)?.count ?? 0
        }
    }

    override init() {
        link = AppLink(bundle: .main)
        super.init()
        let controller = FIFinderSyncController.default()
        // Set at once, as Finder expects; the drives come with the index.
        controller.directoryURLs = []
        for badge in FinderLookup.Badge.allCases {
            controller.setBadgeImage(Badges.image(badge), label: Badges.label(badge), forBadgeIdentifier: badge.rawValue)
        }
        guard let link else {
            finderLog.error("this extension is not inside Onyx; it has nothing to show")
            return
        }
        link.watch { [weak self] in self?.reload() }
        reload()
    }

    // MARK: - The index

    private func reload() {
        link?.fetchIndex { [weak self] index in self?.apply(index) }
    }

    /// A new index (nil: the app is not running): the lookup swapped in, the
    /// watched folders set if they moved, and each mark already given that
    /// the index changes, changed.
    private func apply(_ index: FinderIndex?) {
        let update = shown.withLock { shown -> (roots: [String]?, marks: [(URL, String)])? in
            if let index, shown.reachable, index.generation == shown.lookup.generation { return nil }
            shown.reachable = index != nil
            shown.lookup = index.map(FinderLookup.init) ?? .empty
            var roots: [String]?
            if let index, index.drives.map(\.root) != shown.roots {
                shown.roots = index.drives.map(\.root)
                roots = shown.roots
            }
            var marks: [(URL, String)] = []
            for (folder, items) in shown.items {
                for (url, old) in items {
                    let now = Self.badge(for: url, in: shown.lookup)
                    guard now != old else { continue }
                    marks.append((url, now))
                    shown.items[folder]?[url] = now
                }
            }
            return (roots, marks)
        }
        guard let update else { return }
        DispatchQueue.main.async {
            let controller = FIFinderSyncController.default()
            if let roots = update.roots {
                controller.directoryURLs = Set(roots.map { URL(fileURLWithPath: $0, isDirectory: true) })
            }
            for (url, badge) in update.marks { controller.setBadgeIdentifier(badge, for: url) }
        }
    }

    private static func badge(for url: URL, in lookup: FinderLookup) -> String {
        lookup.badge(for: url.path)?.rawValue ?? ""
    }

    // MARK: - Marks

    override func requestBadgeIdentifier(for url: URL) {
        let badge = shown.withLock { shown -> String in
            let badge = Self.badge(for: url, in: shown.lookup)
            shown.remember(url, badge)
            return badge
        }
        FIFinderSyncController.default().setBadgeIdentifier(badge, for: url)
    }

    override func endObservingDirectory(at url: URL) {
        shown.withLock { $0.forget(folder: url) }
    }

    // MARK: - The menu

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        let controller = FIFinderSyncController.default()
        let urls: [URL]
        switch menuKind {
        case .contextualMenuForItems, .contextualMenuForSidebar:
            urls = controller.selectedItemURLs() ?? controller.targetedURL().map { [$0] } ?? []
        case .contextualMenuForContainer:
            urls = controller.targetedURL().map { [$0] } ?? []
        default:
            return nil
        }
        let paths = urls.map(\.path)
        let (lookup, roots) = shown.withLock { ($0.lookup, $0.roots) }
        let menu = NSMenu(title: "")
        guard let link, link.isReachable else {
            // Onyx is not running. A drive it left behind can only come back
            // through it.
            let inADrive = paths.contains { path in
                roots.contains { FinderPath.isAtOrUnder(FinderPath.key(path), FinderPath.key($0)) }
            }
            guard inADrive else { return nil }
            menu.addItem(withTitle: "Open Onyx", action: #selector(openOnyx(_:)), keyEquivalent: "")
            return menu
        }
        let plan = FinderMenuPlan.make(for: paths, in: lookup)
        guard !plan.isEmpty else { return nil }
        self.plan = plan
        if !plan.keep.isEmpty {
            menu.addItem(withTitle: FinderMenuPlan.keepTitle, action: #selector(keepOffline(_:)), keyEquivalent: "")
        }
        if !plan.remove.isEmpty {
            menu.addItem(withTitle: plan.removeTitle, action: #selector(removeOfflineCopy(_:)), keyEquivalent: "")
        }
        if let note = plan.note {
            // No action: shown, not chosen.
            let said = NSMenuItem(title: note, action: nil, keyEquivalent: "")
            said.isEnabled = false
            menu.addItem(said)
        }
        if plan.show != nil {
            menu.addItem(withTitle: FinderMenuPlan.showTitle, action: #selector(showInOnyx(_:)), keyEquivalent: "")
        }
        return menu
    }

    @objc func keepOffline(_ sender: AnyObject?) {
        link?.send(.keep, paths: plan.keep)
    }

    @objc func removeOfflineCopy(_ sender: AnyObject?) {
        link?.send(.remove, paths: plan.remove)
    }

    @objc func showInOnyx(_ sender: AnyObject?) {
        guard let show = plan.show else { return }
        link?.send(.show, paths: [show])
        // Forward through LaunchServices as well: an app that is not in
        // front may not be let to come forward on its own.
        link?.openApp()
    }

    @objc func openOnyx(_ sender: AnyObject?) {
        link?.openApp()
    }
}
