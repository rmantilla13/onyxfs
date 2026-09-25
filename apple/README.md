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
