# Onyx for macOS and iOS

One Swift codebase, two hosts, sharing a File Provider extension
(`NSFileProviderReplicatedExtension` — the same API on macOS 11+ and iOS 16+).

**None of this has been compiled.** It was written in an environment with no
Swift toolchain, so the first `xcodegen generate && xcodebuild` is on your Mac
and should be expected to surface signature and concurrency diagnostics. What
*has* been verified is the part that cannot be checked by compiling: the two
algorithms that must agree byte-for-byte with something outside this codebase.

## What is verified, and how

**SigV4.** The signer was implemented in JavaScript first and checked against
the AWS SDK's own presigner (`@aws-sdk/s3-request-presigner`) on identical
canonical inputs — four requests covering spaces, UTF-8, reserved characters
and unescaped slashes. All four matched. Those signatures are frozen in
`SigV4Tests`. **A failure there means the Swift diverges from AWS, not that a
number needs updating.**

**PKCE.** Expectations in `PKCETests` come from running the server's own
`pkceChallenge` (`app/api/desktop/token/route.js`). The first case is the
vector from RFC 7636 Appendix B, so the server, this client and the RFC are
all pinned to each other.

## Build

```sh
brew install xcodegen
export ONYX_TEAM_ID=YOURTEAMID        # Apple Developer team
cd apple && xcodegen generate
open Onyx.xcodeproj
```

Run the OnyxKit tests first — they need no signing, no device and no server,
and they are what tells you the port is faithful:

```sh
cd apple/OnyxKit && swift test
```

The `.xcodeproj` is not checked in. `project.yml` is the source of truth; the
project is regenerated from it.

## Identifiers

Compiled into every install, so changing one after release orphans existing
data. Fixed in `OnyxKit/Sources/OnyxKit/OnyxConfig.swift`:

| | |
|---|---|
| App | `io.onyxfs.app` |
| Extension | `io.onyxfs.app.fileprovider` |
| App group | `group.io.onyxfs` |
| Keychain access group | `group.io.onyxfs` |
| URL scheme | `onyxfs` |

The keychain access group must appear in **both** targets' entitlements. If it
is missing from the extension, the keychain returns `-34018` and the drive
enumerates empty rather than reporting an error — which reads as "my files are
gone", not "sign in again".

## What works, and what does not

Implemented: device sign-in over the existing `/api/desktop/*` PKCE routes,
cursor-based enumeration against `/api/files/delta`, materialise-on-open via
scoped credentials from `/api/space/sts` and a presigned ranged GET, a local
mirror so the system is not asked to stat over the network, and a per-filespace
credential cache that refreshes five minutes before expiry.

**Read-only.** `createItem`, `modifyItem` and `deleteItem` return
`.notAuthenticated` deliberately. A File Provider that accepts a write it
cannot perform loses the file: the system considers it handed over and removes
its own copy. The enumeration contract is the hardest thing to change once
devices are syncing against it, so it ships first and alone.

**Flat.** Every file hangs off the root. Folders need stable identifiers that
the server does not yet mint.

**One filespace.** `/api/files/delta` does not say which filespace a row
belongs to, so every item is attributed to the first one — correct for a
single-filespace deployment, wrong for several.
`FileProviderEnumerator.defaultFilespaceId()` is the only place that changes
when the server starts returning it per row.

## FUSE stays

The rclone mount in `desktop/` keeps the editing job on macOS. A File Provider
materialises a file when it is opened, which would stall a 4K timeline
mid-scrub. This exists for Finder and Files.app browsing, on-demand download,
and iOS — none of which FUSE can do. The two are complementary, not a
migration.

## Server dependencies

Only these paths are reachable without a browser cookie, because
`middleware.js` excludes them so a bearer request gets a clean 401 rather than
a 302 to a sign-in page an extension cannot render:

```
/api/desktop/*      device auth (PKCE)
/api/space/*        filespaces and credential minting
/api/files/delta    sync enumeration
```

Adding an endpoint for this client means adding it to that matcher too, or the
JSON decode fails on HTML with a complaint about the character `<`.
