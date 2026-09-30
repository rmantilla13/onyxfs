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
- **Keep Offline in Finder.** Right-click a file or folder on a drive in
  Finder — a disk of its own or a folder in `~/Onyx` — and choose **Keep
  Offline**, or **Remove Offline Copy**; **Show in Onyx** opens it in the
  window. What is kept wears a tick, and an arrow while it is still on its
  way. The same pins as the window's, so each shows in the other and in
  Settings › Storage. It is a Finder extension (`OnyxFinder`), which the
  person switches on in System Settings › General › Login Items &
  Extensions › Finder; Settings › Finder says so and opens the pane.
- **Each drive in Finder's sidebar** under Locations, with its own icon —
  its initial in its colour from the web, which follows the drive when it
  changes there.
- **A menu bar item** that keeps Finder in sync while the window is closed.
  It opens a panel: how Onyx is doing, the activity graphs and what is on
  its way, and each drive with the icon its disk has in Finder and a switch
  to put it there or take it away. Closing the window, or ⌘Q (Close to Menu
  Bar), leaves Onyx there; ⌥⌘Q, or Quit in the panel or the Dock, quits it.
  Settings › General can keep its Dock icon while the window is closed.
- **As fast out of sight as in view.** macOS naps an app it cannot see,
  putting off its timers and slowing its CPU, disk and network. 0.5.17 was
  napped for hours at a time, its window open behind others; in a test app
  shaped like Onyx, the nap began within a minute of the window going out
  of sight, and a transfer on a busy Mac then ran about five times slower.
  While Onyx has work in flight — uploads (Finder's and the window's),
  downloads, offline copies, a sync bringing pages, bytes going to and from
  the disks, thumbnails, waveforms, streamable versions, transcripts, an
  update — it holds one activity that keeps it out of App Nap, and lets it
  go five seconds after the last (`WorkActivity`). It never keeps the Mac
  awake, and while nothing is under way nothing is held.
- **Activity**, along the foot of the window: what the drives are moving
  right now, download, upload, read and write, each a figure and a minute's
  graph, and each download from its click until it is done, with Show in
  Finder. It costs nothing while nothing moves (ONYXFS.md, "Activity"), and
  Settings › General (or View › Show Activity) hides it.
- **Streamable versions of heavy videos.** A large video — an action
  camera's 4K HEVC runs at 60–120 Mbps — stalls on a phone. The server asks
  for a 1080p H.264 copy of each one (lib/proxies.js); this Mac takes the
  jobs from its queue while Onyx runs, downloads the master, re-encodes it on
  the media engine (`ProxyTranscoder`, about 7× real time for 4K60 on Apple
  silicon) and uploads the copy, which the web and the iPhone then play. A
  master this Mac uploaded itself, or keeps offline, is not downloaded
  again: its own upload is kept for the job for up to a day
  (`ProxySources`), and that job is taken first. Settings › General turns
  it off.
- **Thumbnails the web is missing**, made here: a 4K clip straight from a
  camera, or a HEIC or RAW a browser cannot draw, gets its thumbnail, the
  smaller sizes, the player's poster and the placeholder a tile shows
  until they load from this Mac, at the web's sizes, and every device
  shows them. For each file it uploads, from the bytes
  still here, and for the files of the drives it syncs; one at a time, and
  nothing at all while nothing is missing. Settings › General turns it off
  (ONYXFS.md, "Thumbnails").

On iPhone and iPad it is **Onyx** (`OnyxIOS/`), native SwiftUI:

- **The drives, browsed as the web lists them.** Folders as icons or a list,
  sorted by name, date or size, searched beneath the folder you are in, a
  page at a time — from the same access-checked listing the web reads.
  Each tile has its picture at once: the placeholder in the file's row,
  softened, until the thumbnail comes (`PlaceholderImages`).
- **A file full screen.** Photos zoom, video and sound stream from storage
  (picture in picture, AirPlay), documents open in Quick Look; swipe
  through a folder, send a copy of a file, see its details.
- **Links, as the web makes them.** Share Link… on a file (its menu, the
  preview's Share, Get Info) or a folder (its menu, the folder's ⋯): public,
  password or private, an expiry, and comments or approvals on a photo or a
  video — only what the server says this account may make (`LinkChoices`),
  with anything it still refuses said in its words. The links there are,
  to copy, send, change and revoke. It is offered only where the server
  marks the file (`can.share`) or folder (`share`) as this account's to
  manage, and the account may share at all (`/api/space/filespaces`
  `shares`). The web's own routes, with the device token (`Links.swift`).
- **Sign-in as on the Mac.** The web's own sign-in in a sheet (the magic
  link opened from Mail finishes it through `onyxfs://`), or a pairing code
  from `/space/pair`.

Next: drives in the Files app (the File Provider extension here, which the
two platforms share), uploads from the camera roll, and a Save to Onyx
share sheet.

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

Keep the profiles in `apple/.signing/` of the main checkout (`Onyx`,
`OnyxFS`, and `OnyxDev`/`OnyxDevFS` for dev builds, each
`.provisionprofile`); it is gitignored.

**Each release** is one command, from any checkout:

```sh
apple/scripts/ship-mac.sh --dry-run    # what would ship: the version, the commit, the notes
apple/scripts/ship-mac.sh              # the next version, from origin/main
apple/scripts/ship-mac.sh --from <branch or commit>
```

`npm run ship:mac -- …` is the same. It:

1. checks what a release needs before the long part: gh, the certificate,
   the profiles (and when they expire), the notary profile, an unlocked
   screen;
2. takes the next version after the last one published, unless given one;
3. refuses a commit that does not contain the last release, so nothing
   shipped is lost. The version the branch says (`apple/VERSION`) must not
   be older than the last release either;
4. drafts the notes from the commits since the last release and opens them
   in `$EDITOR`, or takes `--notes`;
5. builds, signs and notarizes that commit from GitHub, in a throwaway
   worktree (about ten minutes), and leaves the result in
   `apple/build/ship/<version>/`;
6. stops to ask before publishing, so the dmg can be installed and tried
   first; then publishes `mac-v<version>`, tagged at the commit it built.

`scripts/release-mac.sh` is the build it runs, and still works on its own
(`--publish` refuses a checkout with uncommitted changes).

### In Xcode

`project.yml` is the source of truth; the `.xcodeproj` is generated from it
and not checked in. Xcode also builds the iOS targets:

```sh
brew install xcodegen
ONYX_TEAM_ID=TEAMID xcodegen generate && open Onyx.xcodeproj
```

### The iOS app, from the command line

Xcode must be installed, but need not be the selected developer directory:
`DEVELOPER_DIR` points each command at it. A simulator build is signed to
run locally (`CODE_SIGN_IDENTITY=-`), which gives it the Keychain the
sign-in needs:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project Onyx.xcodeproj -scheme OnyxIOS \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' CODE_SIGN_IDENTITY=- build
xcrun simctl install booted <DerivedData>/Build/Products/Debug-iphonesimulator/Onyx.app
xcrun simctl launch booted io.onyxfs.app --server http://localhost:3000 --pair CODE
```

`--server` and `--pair` sign in without a tap, as on the Mac: the code
comes from `/space/pair` on a signed-in web session (or `POST
/api/desktop/authorize` with `{"kind":"pairing"}`). The simulator shares the
Mac's network, so `localhost` is `npm run dev:local`'s server.

### TestFlight

```sh
scripts/release-ios.sh --upload
```

This builds the app, signs it for the App Store and uploads it. TestFlight
has it once Apple has processed it, usually within minutes. Without
`--upload` it stops at `build/ios/Onyx.xcarchive`, and nothing leaves the Mac.

Before the first upload:

1. In [App Store Connect](https://appstoreconnect.apple.com/apps), **+ → New
   App**: iOS, bundle ID `io.onyxfs.app`, any SKU. The name must be unique on
   the App Store; the home screen still says Onyx (`CFBundleDisplayName`).
2. Sign Xcode in to the developer account (**Settings → Accounts**). The upload
   makes the Apple Distribution certificate and the App Store profile itself.
   No iPhone need be registered to the team: the archive is signed for the
   App Store at export, never for development. An App Store Connect API key
   works instead; see the script's header.

Each build number is the time it was built, so every upload is newer than the
last. Bump `MARKETING_VERSION` in `project.yml` for a new version. Add yourself
to a group under **TestFlight → Internal Testing**, and builds reach you
through the TestFlight app. Testers outside the team need Beta App Review,
which needs an account for the reviewer to sign in with.

#### App Review's account

Apple asks for a user name and password, and nobody at Apple can open an
emailed link. So the reviewer signs in with a password, from the same
sign-in sheet as everyone else, and the app needs nothing special for it.
On the server (production, since that is where the app points):

1. **Admin → Access requests → Add someone…**: an address on a domain you
   own, such as `appreview@onyxfs.io`. Nobody need read its mail.
2. **Admin → Drives**: a drive with content that shows what the app does
   (photos, a video, some audio, a PDF, a few folders), with the reviewer's
   address as a member. Nothing of anyone else's: Apple sees all of it.
3. Back in **Access requests** (the Approved tab), **Password… → Make a
   password**. It is shown once; copy it.
4. In App Store Connect, **TestFlight → Test Information → Beta App Review
   Information**: tick *Sign-in required*, enter the address and the
   password, and in *Review Notes* say how:

   > Tap Sign In, then Continue. On the sign-in page, tap "Sign in with a
   > password", enter the user name and password above, then tap Authorize.
   > The account's drive has sample photos, video, audio and documents.

Passwords are only ever for an account like this one (lib/password-signin.js):
an admin can't have one, ten wrong tries lock it for fifteen minutes, and
**Password… → Remove password** (or removing the person) takes it away.
Make a new one after review if it went anywhere but App Store Connect.

`OnyxIOS/PrivacyInfo.xcprivacy` gives the reasons for the APIs Apple asks
about (user defaults, file dates, disk space). A new use of one needs its
reason there, or the upload is refused. The Files extension
(`OnyxFileProviderIOS`) is not embedded yet; it comes with the Files app.

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
The new copy is registered with macOS before the old one is let go: with
no copy registered, even for a moment, macOS forgets that the Onyx file
system was switched on, and every drive falls back to `~/Onyx` (ONYXFS.md,
"Kept on across updates"). Finder replacing the app with a copy dragged
from the disk image can still do that; Onyx then says so, in a notice and
in its menu bar panel, and moves the drives back to disks the moment the
switch in System Settings is on again.

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
| Finder | One rclone NFS mount per drive, using macOS's own NFS client (no macFUSE), each in a folder of its own under `~/Onyx` (a drive whose name would land on another's folder, or on `Library`, gets `Name (2)`). It mounts a WebDAV bridge inside the app (`DAVServer` + `DAVResponder`) on 127.0.0.1, which needs a per-launch bearer token. The bridge lists from a `DriveMirror`: `GET /api/files/delta?drive=` synced into a `Replica` every 5 s while anything is happening, and every 30–60 s when nothing is. Reads are 302s to the file's presigned URL (`GET /api/space/files/<id>`), so rclone fetches byte ranges straight from storage, or they are served from a pinned copy (`PinStore`). A link is reused only while the file stays at the version it was signed for, since a rename or a move changes the object's key. rclone's VFS cache keeps what was read, and treats a cached file as stale when its size or modified time changes (vendor `rclone`; the bridge's time moves with every change to the file). Each drive's rclone keeps a cache of its own, capped at the size set in Settings → Storage when that drive mounted. |
| Access | The delta uses the listing's own access rule. A row you may not see arrives as a bare id and is dropped. A change of drive membership, which writes no file row, shows up as a new `scope` fingerprint: the drive is fetched again from the start beside the tree Finder shows, and swapped in once whole. Offline copies are deleted only against a drive fetched to the end (`isAuthoritative`), never a half-fetched one. A drive the account has lost answers 404. The mirror withholds it at once (Finder shows it empty, nothing is deleted), since the server answers the same when one of its own queries fails. Only after refusals over ten minutes with no page between does it forget the drive and report `OnyxError.driveGone`, and the app then unmounts the drive, deletes its offline copies and stops mounting it at launch. |
| Offline copies | A `PinStore` per account on one server (`Pinned/account-<hash>/`), as the mirrors are (`Mirrors/account-<hash>/`), so another account signing in on the Mac neither inherits the rules nor deletes the copies. A pass fetches what the rules reach straight into the store's folder, on the cache's own disk (`FileDownload`), three at a time and only while that disk has room (a gigabyte is kept free). A failed download waits 30 s, then twice as long each time up to an hour, or until the network comes back. While the cache's disk is not connected a pass does nothing at all, Settings says so, and the drives mount and stream regardless. A disk that comes back under a new device number (a USB disk plugged in again, a share reconnected) is still the store's if it is the same volume or the folder holds the store's `.store-id`; any other folder by that path is left alone. A pinned folder renamed on the web keeps its files' copies and shows as not found. One pass per drive at a time with at most one queued behind it, and `pins.json` is written only when something changed. A tick asks for a pass only when one is owed: the drive's mirror shows something new, a failed download is due again, or ten minutes have passed (a pass looks at every copy on disk). Sign-out stops the account's downloads. The whole cache moves to a folder the user picks, every account's store with it, but not into `~/Onyx` or into itself. |
| Finder's menus | `OnyxFinder.appex`, a Finder Sync extension (sandboxed, no provisioning profile), knows nothing of drives itself. The app registers a Mach port (`io.onyxfs.app.finder`, a CFMessagePort on the main run loop; the extension's one sandbox exception is to look it up) and hands it one index (`FinderIndex`, OnyxFinderCore): each drive mounted now, where (`/Volumes/<drive>` or `~/Onyx/<drive>`), and what it keeps by path — folders by their rules, files kept on their own, and what is not here yet (past 5,000 on their way, the folders holding them). The app rebuilds it only when that changes, at most every half second (longer for a big one), and posts one Darwin notification (`io.onyxfs.app.finder.changed`); the extension then asks for it once. Every mark Finder asks for, and every menu, is answered from it in memory (`FinderLookup`, `FinderMenuPlan`), with the web's rules: something only a kept folder keeps says "Kept Offline with “Footage”" rather than offering Remove. Keep Offline and Remove Offline Copy go back over the port as paths; the app acts only on paths inside the drives it has mounted now, and makes the same rules the window does (`FinderPins`: a file by id, a folder by its path, the drive for its root). While nothing changes, neither side does anything. Onyx Dev's port, notification and extension (`io.onyxfs.app.dev.*`) are its own. |
| Thumbnails | `ThumbnailService` runs OnyxKit's `ThumbnailWorker` over the files a drive's mirror says have none (`ReplicaFile.previews`, from the feed's `thumbnailKey`, `thumbSizes` and `posterKey`), and over each upload as it finishes. For each file: `GET /api/files/<id>` (still missing?), `GET /api/files/<id>/thumbnail` (a 204 when this account may record one), the pictures drawn with AVFoundation or ImageIO at `Poster`'s sizes (lib/poster.js), `POST /api/files/presign` with `{thumb, sizes}` and `{poster}`, the PUTs to storage, then `PUT /api/files/<id>/thumbnail`, which carries the placeholder too (`Placeholder`: the smallest picture at 24 px, a JPEG of a few hundred bytes). The thumbnail route takes the device token, as the write routes do (lib/bearer-gate.js). |

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

The web's own routes the apps call with their token — the Mac's writes,
the iPhone's links to a file or a folder (`/api/files/<id>/shares`,
`/api/files/folders/shares`) — stay behind the gate for a browser, and are
let past it only with `Authorization: Bearer …` (`lib/bearer-gate.js`,
whose handlers check the token themselves: `requirePrincipal(req)`).

A new endpoint for these clients goes under one of them, or into that list
with a handler that takes the token in every method. Otherwise the JSON
decode fails on HTML, with a complaint about the character `<`.

## What is verified, and how

- **OnyxKit:** 649 tests (`swift test`: OnyxKit, OnyxFSCore, and the two
  together), among them:
  - The tree built from delta pages: folders derived from paths, renames, empty folders, deletions.
  - Each id is reported once, as what it is now.
  - No presigned links are kept.
  - Domain identifiers, and server-address parsing.
  - The handoff cookie's scope and lifetime (`__Host-` over https).
  - Update version arithmetic, and the release shape.
  - The update swap, run as the updater runs it with stand-ins for
    lsregister and open: the new copy registered before the old one is let
    go, the old one put back when a rename fails, nothing done before Onyx
    has exited.
  - The Onyx file system's switch: when Onyx says it is off, when it
    switches it on itself (only on macOS 27.0, once), and when it leaves the
    person's own choice alone (`FileSystemSwitch`); and whether Onyx has
    Full Disk Access, on macOS 27.0.1 and before.
  - SigV4, pinned against the AWS SDK's own presigner.
  - PKCE, pinned against the server's `pkceChallenge` and RFC 7636.
  - Thumbnails: every size and poster time against a table lib/poster.js
    computed; which files need one, and in what order; the worker's
    asking, hand-in, waits and stopping, against a stub; the drawing, on
    clips and photos written for the test (4K HEVC, a portrait clip, a
    black opening, an EXIF-turned JPEG, a HEIC, a transparent PNG), and on
    ffmpeg's test source when there is an ffmpeg (`ONYX_FFMPEG`).
  - Placeholders: the web's own strings read as the server reads them, and
    nothing else; the Mac's kept by the server as sent, with no Exif or
    colour profile, even from a Display P3 photo; TinyJPEG's rewriting
    checked to decode to the same pixels.
- **Thumbnails end to end:** OnyxKit's worker against a local server
  (`npm run dev:local`). A 4K HEVC master with none, one with an old 480px
  thumbnail, one with a newer thumbnail that has no smaller sizes, a HEIC,
  and a file uploaded as the Mac uploads: each made (the newer one kept),
  recorded, and in the feed with its sizes and poster.
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
- **Finder's menus:** OnyxFinderCoreTests pin where an item is (a disk, a folder mount, a neighbour whose name begins the same), what is kept and on its way, the menu for every kind of selection, and a request across a real Mach port; FinderPinsTests pin the rule each item makes, the same as the web's. Against a running Onyx Dev, a sandboxed stand-in with the extension's own entitlements got the app's notification as it opened, fetched the index, had its requests answered, and saw the port go as it quit; pluginkit listed the extension, not switched on. Not yet seen: the menus and marks in Finder itself, which needs the extension switched on.

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
| Finder extension | `io.onyxfs.app.findersync`; the app's port for it `io.onyxfs.app.finder` |
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
