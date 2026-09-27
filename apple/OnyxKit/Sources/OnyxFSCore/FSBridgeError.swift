import Foundation

/// Why the bridge, or storage, could not do what was asked.
///
/// Each case says what the file system should report, so the FSKit glue maps
/// them in one place (`posixCode`).
public enum FSBridgeError: Error, Sendable, Hashable {
    /// 401, or the bridge cannot be reached: Onyx.app quit or restarted, and
    /// the session died with it. The app mounts the drive again when it is
    /// back; until then nothing on this volume can be answered.
    case disconnected
    /// No such file or folder.
    case notFound
    /// 403: the drive is read-only for this account, or the server refused
    /// the change.
    case forbidden(String)
    /// 409: something is in the way (a file where a folder was asked for, a
    /// rename onto a name that exists).
    case conflict(String)
    /// 413: the drive has no room for this.
    case quotaExceeded(String)
    /// 400: not a request the app can make sense of, or not a name a file
    /// can have there.
    case invalid(String)
    /// Any other refusal, or an answer that could not be read, with the
    /// bridge's own sentence.
    case server(String)
    /// Storage refused a range read with this status, after a fresh link
    /// where one could help.
    case storage(status: Int)
    /// Storage could not be reached, after retries.
    case network(URLError.Code)
    /// The file's bytes changed on the web while it was open here: what was
    /// already read belongs to the old version, and mixing the two would hand
    /// an app a file that never existed. Opening it again reads the new one.
    case stale
    /// The mount's resource URL is not an onyxfs v1 URL.
    case invalidResource(String)

    /// The errno a file system reports for this.
    public var posixCode: POSIXErrorCode {
        switch self {
        case .disconnected: return .ENOTCONN
        case .notFound: return .ENOENT
        case .forbidden: return .EACCES
        case .conflict: return .EEXIST
        case .quotaExceeded: return .EDQUOT
        case .invalid: return .EINVAL
        case .server, .storage: return .EIO
        case let .network(code): return code == .timedOut ? .ETIMEDOUT : .EIO
        case .stale: return .ESTALE
        case .invalidResource: return .EINVAL
        }
    }
}

extension FSBridgeError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .disconnected: return "Onyx is not running, or has restarted since this drive was mounted."
        case .notFound: return "No such file or folder."
        case let .forbidden(message), let .conflict(message), let .quotaExceeded(message), let .invalid(message),
             let .server(message):
            return message
        case let .storage(status): return "Storage refused the read (\(status))."
        case let .network(code): return "Storage could not be reached (\(code.rawValue))."
        case .stale: return "The file changed on the web while it was open."
        case let .invalidResource(why): return "Not an onyxfs mount: \(why)"
        }
    }
}
