import AppKit
import CryptoKit
import OnyxKit

/// Each disk's icon kept as its drive is on the web. A drive given a new
/// colour or name there gets the matching icon in Finder now, rather than at
/// its disk's next mount, when the file system extension draws it again.
///
/// The icon is set as any app sets one (NSWorkspace.setIcon), which Finder
/// picks up at once. An icon the person gave the disk (Get Info) stays: only
/// an icon that is this app's — the one the extension put there, or the last
/// one set here — is replaced. What was set here is remembered across
/// launches, as the bytes it left on the disk and the drawing they were of.
@MainActor
enum DiskIcons {
    nonisolated private static let defaultsKey = "diskIcons"

    /// Some disk has had its icon here: drives have been disks on this Mac,
    /// so the Onyx file system was on (FileSystemSwitch's first memory).
    nonisolated static var anyRecorded: Bool {
        !(UserDefaults.standard.dictionary(forKey: defaultsKey) ?? [:]).isEmpty
    }

    /// Bring the disk at `volume` to `drive`'s icon, if its icon is still
    /// this app's to change.
    static func sync(_ scope: SyncDomain, volume: URL, color: String?, name: String) {
        guard let wanted = DriveIcon.icns(color: color, name: name) else { return }
        let drawing = digest(wanted)
        let file = volume.appendingPathComponent(".VolumeIcon.icns")
        let now = (try? Data(contentsOf: file)).map(digest)
        var records = UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: [String: String]] ?? [:]
        let mine = records[scope.identifier]

        // The extension's own, as drawn today: nothing to do but know it.
        if now == drawing {
            if mine?["file"] != drawing {
                records[scope.identifier] = ["file": drawing, "drawing": drawing]
                UserDefaults.standard.set(records, forKey: defaultsKey)
            }
            return
        }
        // An icon this app did not leave there: the person's own.
        if let now, now != mine?["file"] { return }
        // This app's, and already of this drawing.
        if now != nil, mine?["drawing"] == drawing { return }

        guard let image = NSImage(data: wanted), NSWorkspace.shared.setIcon(image, forFile: volume.path, options: []) else {
            appLog.error("onyxfs: the icon of \(scope.identifier, privacy: .public) could not be changed")
            return
        }
        // As it lies on the disk now — setIcon writes its own .icns — so the
        // next look knows it for this app's.
        if let left = try? Data(contentsOf: file) {
            records[scope.identifier] = ["file": digest(left), "drawing": drawing]
            UserDefaults.standard.set(records, forKey: defaultsKey)
        }
        appLog.info("onyxfs: \(scope.identifier, privacy: .public) has its new icon")
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
