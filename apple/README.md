# Onyx for macOS (and iOS)

One Swift codebase. On the Mac it is **Onyx.app**:

- **A window with the whole workspace.** Browse, search, preview, upload, share
  and manage drives, as on the web, in a window of its own. It signs itself in
  from the Mac's device token, so no second email link and no browser tab.
- **Drives in Finder, streaming.** Each drive you turn on mounts in Finder
  under `~/Onyx` and *Locations*. It shows exactly what the web shows you,
  because it lists from the same access-checked feed. Files stream as apps
  read them, a range at a time, straight from storage.
- **Offline copies.** Pin a file, a folder or a whole drive from the Onyx
  window, and it is kept on this Mac to open with no connection. The cache
  can live in any folder, including an external disk (Settings → Storage).
- **A menu bar item** that keeps Finder in sync while the window is closed.

The iOS app (`OnyxIOS/`) shares OnyxKit and the extension source; it is not
built yet.

## Build it, no Xcode needed

Everything builds with the Command Line Tools alone:

```sh
cd apple
swift test --package-path OnyxKit        # the sync, sign-in and signing logic
scripts/build-mac.sh                     # → build/Onyx.app
open build/Onyx.app
```

If `swift test` fails with "plugin for module 'TestingMacros' not found",
delete `OnyxKit/.build` and run it again. The Command Line Tools
sometimes lose the path to Swift Testing's macro plugin in an incremental
build.

That build is **unsigned**. The window, sign-in and the whole workspace work.
Finder does not: the app and its extension share the sign-in through an app
group and its keychain, and macOS grants those only to code signed with a
provisioning profile that includes them. An unsigned copy says so in
Settings → Finder rather than offering drives that could only ever ask you
to sign in. The next section covers signing.

### Releasing: signed, notarized, and on the website

`scripts/release-mac.sh` builds a universal app (Apple silicon and Intel) and
signs it with your Developer ID. It notarizes and staples the app, packs
`Onyx.dmg` (for people) and `Onyx.zip` (for the updater), and writes
`onyx-mac.json` (version, build and checksums). With `--publish` it also
creates the GitHub release `mac-v<version>`. The website's **Download for
Mac** button (`/download`) and every installed copy's updater find it
there within ten minutes (`lib/mac-release.js`).

**Once, on this Mac:**

1. **A Developer ID certificate.** In Xcode, open Settings → Accounts and
   sign in with your Apple ID. Then choose Manage Certificates → + →
   **Developer ID Application**. This needs the account holder or an admin
   of the team. Check it with:
   ```sh
   security find-identity -v -p codesigning   # shows "Developer ID Application: Your Name (TEAMID)"
   ```
2. **Notarization credentials.** Create an app-specific password at
   [account.apple.com](https://account.apple.com) → Sign-In and Security →
   App-Specific Passwords. Then save it under a profile name; the command
   prompts for the password:
   ```sh
   xcrun notarytool store-credentials onyx-notary --apple-id you@example.com --team-id TEAMID
   ```
3. **Provisioning profiles, for Finder drives only.** At
   developer.apple.com → Certificates, IDs & Profiles:
   - Register the App IDs `io.onyxfs.app` and `io.onyxfs.app.fileprovider`,
     both with the **App Groups** capability.
   - Register the app group `group.io.onyxfs`, and assign it to both.
   - Create a **Developer ID** provisioning profile for each and download
     them.

   Without the profiles, a release still installs, signs you in, shows the
   workspace and updates itself; Finder waits for them. macOS refuses to
   launch an app that claims an app group without a profile granting it, so
   the script leaves the group off rather than ship an app that won't open.

**Each release:**

```sh
echo 0.3.0 > VERSION                                     # bump: copies update only to a newer version
ONYX_NOTES="What changed, for the update window." \
ONYX_APP_PROFILE=~/Downloads/Onyx_Developer_ID.provisionprofile \
ONYX_EXT_PROFILE=~/Downloads/OnyxFileProvider_Developer_ID.provisionprofile \
scripts/release-mac.sh --publish
```

Without `--publish` it stops at `build/release/`, for a look first.

### In Xcode

`project.yml` is the source of truth; the `.xcodeproj` is generated from it
and not checked in. Xcode also builds the iOS targets:

```sh
brew install xcodegen
ONYX_TEAM_ID=TEAMID xcodegen generate && open Onyx.xcodeproj
```

### Updates

The app asks its server (`/api/desktop/mac/latest`) for the newest release
at launch, every six hours, and from **Onyx → Check for Updates…**. It offers
a newer one in a sheet: Install and Relaunch, Later, or Skip This Version.
Automatic checks can be turned off in Settings → Account.

Before anything is installed:

- the zip must match the SHA-256 the release published;
- the app inside must be signed by **the same Apple team** as the running
  copy, with the same bundle ID. This is checked with the same code-signing
  check Gatekeeper uses.

A compromised feed or a swapped file therefore cannot install something
else. The swap happens after the app quits, and then the new version opens.

An unsigned copy cannot vouch for anything, so it only offers to open the
download. A debug build (`CONFIG=debug scripts/build-mac.sh`) may replace
an unsigned copy with another unsigned one, so the whole path can be tried
locally:

```sh
open build/Onyx.app --args --update-feed http://127.0.0.1:8791/feed.json
```

A server can point the feed at its own builds with `ONYX_MAC_RELEASE_URL`
(an `onyx-mac.json` URL), or at another repository with `ONYX_RELEASES_REPO`.

### Pointing it at a development server

The sign-in screen's *Server* link, or Settings → Account, takes an address
such as `localhost:3000`. Changing servers signs you out, because a token
belongs to the server that issued it.

For a scripted run, launch with a pairing code from `/space/pair`:

```sh
open build/Onyx.app --args --server localhost:3000 --pair ABCD1234EFGH
```

## How it fits the server

| | |
|---|---|
| Sign-in | PKCE in `ASWebAuthenticationSession` (`/space/authorize` → `/api/desktop/token`), or a pairing code. The token is kept in the Keychain. |
| The window | `WKWebView` on the web app. `POST /api/desktop/web-session` returns a one-time code, bound to a secret the app sets as a cookie in its own web view, so a leaked link signs nobody in (`lib/web-handoff.js`). |
| Finder | One rclone NFS mount per drive, using macOS's own NFS client (no macFUSE), each in a folder of its own under `~/Onyx` (a drive whose name would land on another's folder, or on `Library`, gets `Name (2)`). It mounts a WebDAV bridge inside the app (`DAVServer` + `DAVResponder`) on 127.0.0.1, which needs a per-launch bearer token. The bridge lists from a `DriveMirror`: `GET /api/files/delta?drive=` synced every 15 s into a `Replica`. Reads are 302s to the file's presigned URL (`GET /api/space/files/<id>`), so rclone fetches byte ranges straight from storage, or they are served from a pinned copy (`PinStore`). A link is reused only while the file stays at the version it was signed for, since a rename or a move changes the object's key. rclone's VFS cache keeps what was read, and treats a cached file as stale when its size or modified time changes (vendor `rclone`; the bridge's time moves with every change to the file). Each drive's rclone keeps a cache of its own, capped at the size set in Settings → Storage when that drive mounted. |
| Access | The delta uses the listing's own access rule. A row you may not see arrives as a bare id and is dropped. A change of drive membership, which writes no file row, shows up as a new `scope` fingerprint: the drive is fetched again from the start beside the tree Finder shows, and swapped in once whole. Offline copies are deleted only against a drive fetched to the end (`isAuthoritative`), never a half-fetched one. A drive the account has lost answers 404. The mirror withholds it at once (Finder shows it empty, nothing is deleted), since the server answers the same when one of its own queries fails. Only after refusals over ten minutes with no page between does it forget the drive and report `OnyxError.driveGone`, and the app then unmounts the drive, deletes its offline copies and stops mounting it at launch. |
| Offline copies | A `PinStore` per account on one server (`Pinned/account-<hash>/`), as the mirrors are (`Mirrors/account-<hash>/`), so another account signing in on the Mac neither inherits the rules nor deletes the copies. A pass fetches what the rules reach straight into the store's folder, on the cache's own disk (`FileDownload`), three at a time and only while that disk has room (a gigabyte is kept free). A failed download waits 30 s, then twice as long each time up to an hour, or until the network comes back. While the cache's disk is not connected a pass does nothing at all, Settings says so, and the drives mount and stream regardless. A disk that comes back under a new device number (a USB disk plugged in again, a share reconnected) is still the store's if it is the same volume or the folder holds the store's `.store-id`; any other folder by that path is left alone. A pinned folder renamed on the web keeps its files' copies and shows as not found. One pass per drive at a time with at most one queued behind it, and `pins.json` is written only when something changed. Sign-out stops the account's downloads. The whole cache moves to a folder the user picks, every account's store with it, but not into `~/Onyx` or into itself. |

### Who can read a mounted drive

While a drive is mounted, **any account on this Mac can read it**, not only
the one that mounted it. This is a known limitation of the transport.

- rclone serves each mount to macOS's NFS client from a TCP port of its own
  on 127.0.0.1, and that NFS server has no authentication.
- Any local process that finds the port can mount it, or read it with a
  userspace NFS client: another user's, or a sandboxed app allowed to make
  network connections. It then reads the drive as the signed-in account:
  rclone fetches through the bridge with that account's token, and storage
  answers the presigned links minted for it.
- The bridge's bearer token keeps other processes from reading the bridge
  directly. It cannot help here, because rclone presents it on every
  caller's behalf.

What the app does about it:

- `~/Onyx` and every mount folder are `0700`, and the mounts show their files
  as the signed-in user's, `0600`/`0700` (`--uid`, `--gid`, `--umask 077`).
  This closes the way in through the file system, not the NFS port.
- Nothing is mounted while signed out, and quitting unmounts every drive.

So on a Mac shared by people who should not see each other's drives, keep
drives out of Finder there (Settings → Finder) and use the Onyx window. On a
Mac with one user account, the exposure is to software that could not
otherwise read your files: a sandboxed app allowed to make network
connections, or a service running under an account of its own.

The fix is a transport with no TCP listener: FSKit on recent macOS, or
File Provider, where the system talks to the app directly. It is tracked
in ROADMAP.md (Phase 5).

Only these paths are reachable without a browser cookie; `middleware.js`
excludes them so a bearer request gets a clean 401 instead of a redirect:

```
/api/desktop/*      device auth, and the web-view handoff
/api/space/*        drives, credentials, one file's download link
/api/files/delta    sync enumeration
```

A new endpoint for these clients goes under one of them. Otherwise the JSON
decode fails on HTML, with a complaint about the character `<`.

## What is verified, and how

- **OnyxKit:** 37 tests (`swift test`).
  - The tree built from delta pages: folders derived from paths, renames, empty folders, deletions.
  - Each id is reported once, as what it is now.
  - No presigned links are kept.
  - Domain identifiers, and server-address parsing.
  - The handoff cookie's scope and lifetime (`__Host-` over https).
  - Update version arithmetic, and the release shape.
  - SigV4, pinned against the AWS SDK's own presigner.
  - PKCE, pinned against the server's `pkceChallenge` and RFC 7636.
- **The server's delta:** checked against a real Postgres.
  - A drive member's feed matches what the web shows them.
  - Deletions carry only an id.
  - Pages walk every row once.
  - Unsharing arrives as a deletion.
  - A folder grant is a name, not a LIKE pattern: a grant on `Q1_2024` does not reach `Q1-2024/…`.
- **The client path end to end:** OnyxKit's `DeltaSync` into a `Replica` against a running server.
  - The folder tree matches the web.
  - Opening a file returns its exact bytes.
  - A second pass finds nothing new.
- **The app:** built with `scripts/build-mac.sh` and run against a local server.
  - Pairing, the web-view handoff (at `localhost` and `127.0.0.1`), the workspace, Settings and sign-out all work.
- **The updater:** a 0.2.0 build found 0.2.1 on a local feed, downloaded and verified it, quit, swapped the bundle and reopened as 0.2.1. With a tampered checksum it refused and left 0.2.0 in place.

**The File Provider extension** (`OnyxFileProvider/`) is kept but no longer
built into the app by default (`ONYX_FILE_PROVIDER=1` adds it). File Provider
downloads a whole file before any app can read it, so it cannot stream; the
mounts replaced it for Finder. It is where the iOS app's Files integration will
come from.

## Identifiers

These are compiled into every install, so changing one after release orphans
existing data. They are fixed in `OnyxKit/Sources/OnyxKit/OnyxConfig.swift`
and `SyncDomain.swift`:

| | |
|---|---|
| App | `io.onyxfs.app` |
| Extension | `io.onyxfs.app.fileprovider` |
| App group, keychain group | `group.io.onyxfs` |
| URL scheme | `onyxfs` |
| Drive scopes | `drive.<filespace id>`, `library` (mounts, mirrors, pins) |

The Tauri app in `desktop/` uses the same bundle identifier, so install one
or the other on a Mac, not both. On Windows it stays the desktop client.

## Next

- **Saving from Finder** (ROADMAP 5.4), after the conflict policy (5.5) is
  written down. The mounts are read-only until then. Writes will go through
  Onyx, not straight to the bucket, so what is saved in Finder shows on the
  web too.
- **Distribution:** Developer ID, notarization, and Sparkle for updates
  (5.8).
