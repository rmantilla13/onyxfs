import Foundation

/// How Onyx for Mac swaps an update in once it has quit (Updater, OnyxMac):
/// a detached shell script, since an app cannot replace itself while it
/// runs. Kept here as text so the tests can run it, with stand-ins for
/// lsregister and open (UpdateSwapTests).
///
/// Run as `sh -c script onyx-update <pid> <current> <fresh> <lsregister> <open>`
/// (`arguments`). It
///
/// 1. waits for Onyx (`pid`) to exit;
/// 2. moves the running copy aside, as `previous.app` beside the new one,
///    and the new copy into its place: two renames on one volume;
/// 3. registers the new copy with LaunchServices, with what is inside it
///    (`-f -R -trusted`), then unregisters the old copy and deletes it;
/// 4. opens the new copy.
///
/// If either rename fails, the old copy is put back where it was (if it
/// moved at all), registered again, and opened.
///
/// Why 3 is in that order. LaunchServices must describe the copy that runs:
/// the swap is a rename, and a record left describing the copy it replaced
/// stops Onyx's file system extension as it starts ("Invalid bundle record
/// for current process", after the updates to 0.5.5 and 0.5.6), so the old
/// copy is unregistered and the new one registered. But not with the old one
/// let go first. macOS keeps a file system extension's switch in System
/// Settings by its bundle identifier, and fskit_agent, which watches
/// LaunchServices, drops the identifier of a module no copy is registered
/// for — and its switch with it — then takes it back, when a copy is
/// registered again, as a new module: switched off. The in-app updates to
/// 0.5.17 and 0.5.18 unregistered first and got away with it, the new copy
/// registered 60 ms later, before fskit_agent looked. Finder replacing 0.5.14
/// with a copy dragged from the disk image left none registered for five
/// seconds, and that switched it off: every drive went to ~/Onyx (ONYXFS.md,
/// "Kept on across updates"). Registered first, the identifier never leaves.
public enum UpdateSwap {
    public static let script = """
    pid="$1"; current="$2"; fresh="$3"; lsregister="$4"; opener="$5"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
    old="$(dirname "$fresh")/previous.app"
    if mv "$current" "$old" && mv "$fresh" "$current"; then
      "$lsregister" -f -R -trusted "$current" >/dev/null 2>&1
      "$lsregister" -u "$old" >/dev/null 2>&1
      rm -rf "$old"
    else
      [ -d "$current" ] || mv "$old" "$current"
      "$lsregister" -f -R -trusted "$current" >/dev/null 2>&1
    fi
    "$opener" "$current"
    """

    public static let lsregister =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

    /// What follows `-c script` for `/bin/sh`: its `$0`, then the script's
    /// own five.
    public static func arguments(pid: Int32, current: String, fresh: String,
                                 lsregister: String = lsregister, open: String = "/usr/bin/open") -> [String] {
        ["-c", script, "onyx-update", String(pid), current, fresh, lsregister, open]
    }
}
