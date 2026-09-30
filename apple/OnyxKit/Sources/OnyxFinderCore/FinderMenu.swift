import Foundation

/// What Finder's right-click menu offers for the items it was opened on,
/// with the web's rules (app/files/FilesClient.js, fileOfflineItem and its
/// neighbours): Keep Offline for what is not kept; Remove Offline Copy for
/// what is kept by a choice of its own; and for what only a kept folder
/// keeps, a line saying so instead, since letting go of it alone would
/// change nothing. A selection of both kinds is offered both, each acting on
/// its own items.
public struct FinderMenuPlan: Equatable, Sendable {
    /// Items to keep offline: none of them is now.
    public var keep: [String] = []
    /// Items to let go of: each is kept by a rule of its own.
    public var remove: [String] = []
    /// "Remove Offline Copy", or "…Copies" for a folder or several items.
    public var removeTitle = FinderMenuPlan.removeOne
    /// Said, not offered, when every item is kept only with its folder:
    /// "Kept Offline with “Footage”".
    public var note: String?
    /// The one item Show in Onyx opens, when there is one.
    public var show: String?

    public static let keepTitle = "Keep Offline"
    public static let removeOne = "Remove Offline Copy"
    public static let removeMany = "Remove Offline Copies"
    public static let showTitle = "Show in Onyx"

    public var isEmpty: Bool { keep.isEmpty && remove.isEmpty && note == nil && show == nil }

    public init() {}

    /// For the items the menu was opened on, as absolute paths. Items in no
    /// Onyx drive are left out; with none left, the plan is empty and the
    /// menu offers nothing.
    public static func make(for paths: [String], in lookup: FinderLookup) -> FinderMenuPlan {
        var plan = FinderMenuPlan()
        let states = paths.compactMap { path in lookup.state(of: path).map { (path, $0) } }
        guard !states.isEmpty else { return plan }
        var keptWith: [(drive: Int, folder: String)] = []
        var removesFolder = false
        for (path, state) in states {
            switch state.kept {
            case .no:
                plan.keep.append(path)
            case .own:
                plan.remove.append(path)
                removesFolder = removesFolder || state.isKeptFolder
            case let .with(folder):
                keptWith.append((state.location.drive, folder))
            }
        }
        if plan.remove.count > 1 || removesFolder { plan.removeTitle = removeMany }
        if plan.keep.isEmpty, plan.remove.isEmpty, let first = keptWith.first {
            let one = keptWith.allSatisfy { $0.drive == first.drive && FinderPath.key($0.folder) == FinderPath.key(first.folder) }
            plan.note = one ? keptWithWords(first.folder, driveName: lookup.name(ofDrive: first.drive))
                : "Kept Offline with Their Folders"
        }
        if states.count == 1 { plan.show = states[0].0 }
        return plan
    }

    /// "Kept Offline with “Footage”": the kept folder by its name, or the
    /// drive by its own for the whole drive (lib/offline-marks.js, keptWith).
    public static func keptWithWords(_ folder: String, driveName: String) -> String {
        let name = folder.isEmpty ? driveName : FinderPath.lastSegment(folder)
        return name.isEmpty ? "Kept Offline with the Whole Drive" : "Kept Offline with \u{201C}\(name)\u{201D}"
    }
}
