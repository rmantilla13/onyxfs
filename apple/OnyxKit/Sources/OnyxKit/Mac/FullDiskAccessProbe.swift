import Foundation

/// Whether Onyx for Mac has Full Disk Access, as opening a file only Full
/// Disk Access opens says. Nothing is read: each file is opened and closed.
///
/// No one file does on every macOS. Up to 26 the account's own privacy
/// database, ~/Library/Application Support/com.apple.TCC/TCC.db, answered;
/// on 27.0.1 that folder is gone (ENOENT), and a probe of it alone said "off"
/// to everyone, Full Disk Access on or not. So a few are tried in turn, and
/// the first that is there decides: opened, it is on; refused (EPERM or
/// EACCES), it is off. One that is not there, or fails some other way, says
/// nothing, and the next is tried. None there: not known, and the app claims
/// neither.
///
/// The first there decides, rather than any that opens: the privacy database
/// is what Full Disk Access guards, and once it has said no, a later file
/// opening (a folder macOS guards only as it is listed, say) would be the
/// wrong answer.
public enum FullDiskAccessProbe {
    public enum Answer: Equatable, Sendable {
        case granted
        case notGranted
        /// No file to ask with.
        case unknown
    }

    /// What opening one file came to.
    public enum Outcome: Equatable, Sendable {
        case opened
        /// EPERM or EACCES.
        case refused
        /// ENOENT or ENOTDIR: not there.
        case missing
        /// Anything else (EIO, EMFILE, …): no answer either way.
        case failed(Int32)

        public init(errno code: Int32) {
            switch code {
            case EPERM, EACCES: self = .refused
            case ENOENT, ENOTDIR: self = .missing
            default: self = .failed(code)
            }
        }
    }

    /// In the order they are tried: the Mac's own privacy database (on 27.0.1
    /// the one there is), the account's (before 27), and Safari's folder,
    /// which Full Disk Access guards on every macOS.
    public static func candidates(home: String) -> [String] {
        [
            "/Library/Application Support/com.apple.TCC/TCC.db",
            home + "/Library/Application Support/com.apple.TCC/TCC.db",
            home + "/Library/Safari",
        ]
    }

    public static func answer(home: String, open: (String) -> Outcome = FullDiskAccessProbe.open) -> Answer {
        for path in candidates(home: home) {
            switch open(path) {
            case .opened: return .granted
            case .refused: return .notGranted
            case .missing, .failed: continue
            }
        }
        return .unknown
    }

    /// open(2), then close(2): nothing read.
    public static func open(_ path: String) -> Outcome {
        let fd = Darwin.open(path, O_RDONLY)
        guard fd >= 0 else { return Outcome(errno: errno) }
        close(fd)
        return .opened
    }
}
