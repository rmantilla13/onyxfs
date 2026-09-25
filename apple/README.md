# Onyx for macOS (and iOS)

One Swift codebase. On the Mac it is **Onyx.app**:

- **A window with the whole workspace.** Browse, search, preview, upload, share
  and manage drives, as on the web, in a window of its own. It signs itself in
  from the Mac's device token, so no second email link and no browser tab.
- **Drives in Finder.** Each drive you turn on appears under *Locations* in
  Finder's sidebar, backed by a File Provider extension. Files download when
  opened and are evicted when macOS needs the space. What you see follows the
  web's own rules: the drive's members, grants, and files shared with you.
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

That build is **unsigned**. The window, sign-in and the whole workspace work.
Finder does not: the app and its extension share the sign-in through an app
group and its keychain, and macOS gives those only to code signed by an Apple
Developer team. An unsigned copy says so in Settings → Finder rather than
offering drives that could only ever ask you to sign in.

### Signed, for Finder

You need an Apple Developer team, a signing certificate in your keychain, and
provisioning profiles for `io.onyxfs.app` and `io.onyxfs.app.fileprovider`.
Both profiles need the `group.io.onyxfs` app group.

```sh
ONYX_TEAM_ID=ABCDE12345 \
ONYX_SIGN_IDENTITY="Apple Development: you@example.com (ABCDE12345)" \
ONYX_APP_PROFILE=~/profiles/Onyx.provisionprofile \
ONYX_EXT_PROFILE=~/profiles/OnyxFileProvider.provisionprofile \
scripts/build-mac.sh
```

Copy the result to `/Applications` before turning drives on. File Provider
extensions are most reliable from there.

To work in Xcode instead, generate the project (`project.yml` is the source of
truth; the `.xcodeproj` is not checked in):

```sh
brew install xcodegen
ONYX_TEAM_ID=ABCDE12345 xcodegen generate && open Onyx.xcodeproj
```

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
| Finder | One File Provider domain per drive (`SyncDomain`: `drive.<id>`, or `library`). The extension syncs `GET /api/files/delta?drive=` into a `Replica` and fetches bytes via `GET /api/space/files/<id>`. |
| Access | The delta uses the listing's own access rule. A row you may not see arrives as a bare id and is dropped. A change of drive membership, which writes no file row, shows up as a new `scope` fingerprint, and the replica starts over. |

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

- **OnyxKit:** 31 tests (`swift test`).
  - The tree built from delta pages (folders derived from paths, renames, empty folders, deletions).
  - Domain identifiers, and server-address parsing.
  - The handoff cookie's scope and lifetime.
  - SigV4, pinned against the AWS SDK's own presigner.
  - PKCE, pinned against the server's `pkceChallenge` and RFC 7636.
- **The server's delta:** checked against a real Postgres.
  - A drive member's feed matches what the web shows them.
  - Deletions carry only an id.
  - Pages walk every row once.
  - Unsharing arrives as a deletion.
- **The client path end to end:** OnyxKit's `DeltaSync` into a `Replica` against a running server.
  - The folder tree matches the web.
  - Opening a file returns its exact bytes.
  - A second pass finds nothing new.
- **The app:** built with `scripts/build-mac.sh` and run against a local server.
  - Pairing, the web-view handoff, and the workspace rendering all work.
  - Settings, and signing out.

**Not yet exercised: the extension running under Finder.** That needs the
signed build above. The code compiles and links as an app extension, and the
logic it runs is the tested OnyxKit. Its first run on a signed build is where
anything left will surface.

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
| Finder domains | `drive.<filespace id>`, `library` |

The Tauri app in `desktop/` uses the same bundle identifier, so install one
or the other on a Mac, not both.

## Next

- **Writes from Finder** (ROADMAP 5.4), after the conflict policy (5.5) is
  written down. Until then every item is read-only in its capabilities, so
  Finder refuses a drop up front rather than accepting a file it would lose.
- **Editing in place.** The rclone mount in `desktop/` stays for opening
  multi-gigabyte masters without downloading them first, and for Windows.
- **Distribution:** Developer ID, notarization, and Sparkle for updates
  (5.8).
