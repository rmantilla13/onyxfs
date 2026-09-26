# onyxfs — each Onyx drive as its own disk on the Mac

## What the owner asked for

"Mount each drive on Onyx as a hard drive in my Mac, as a way of streaming
data. Currently it's showing inside a localhost; it needs to act like its own
drive with its own folder structure. Our own proprietary file system, called
onyxfs."

Today (0.4.0) a drive is an NFS mount of rclone's loopback server inside
`~/Onyx/<Drive>`: macOS classes it as a *network* volume from "localhost",
not local, not ejectable, reporting the Mac's own disk size. Only a real file
system can be a disk. On macOS that is **FSKit**: a user-space file system as
an app extension, no kernel extension, no macFUSE.

## The shape

```
Finder / Premiere / Resolve
        │  VFS
      kernel (+ macOS 27 kernel data cache for FSKit volumes)
        │
     fskitd ── OnyxFS.appex  (FSKit module "onyxfs", sandboxed, one process per mounted drive)
                   │  onyxfs bridge protocol v1: HTTP/1.1 on 127.0.0.1, per-volume session key
                   ▼
              Onyx.app  (the existing DAVServer listener gains /fs/v1/*)
                   ├─ DriveMirror / MirrorIndex  → the tree: names, sizes, dates, versions
                   ├─ PinStore                   → bytes of files kept offline, served locally
                   └─ presigned GET (OnyxAPI)    → where the bytes live in storage
                                                     (the extension range-reads storage directly)
```

- File system type (`FSShortName`): `onyxfs`. Resource URL scheme: `onyxfs-drive` —
  NOT `onyxfs:`, which is the app's registered sign-in hand-off scheme (CLAUDE.md).
- Extension: `OnyxFS.appex` in `Onyx.app/Contents/Extensions/`, bundle id
  `io.onyxfs.app.fs` (dev builds: `io.onyxfs.app.dev.fs`), display name "Onyx".
- Each drive mounts at `/Volumes/<Drive name>` through
  `FSClient.shared.mountSingleVolume(resource:bundleID:options:)` (macOS 27,
  entitlement `com.apple.developer.fskit.mount` on the app). The volume is
  local, ejectable, shows the drive's own size, has the drive's folders at its
  root, appears in Finder's sidebar under Locations and on the Desktop.
- macOS 26 and older, or when the extension is not enabled/entitled: the
  existing rclone NFS mount in `~/Onyx` stays as the fallback. Nothing is
  removed.

**Read and write, in this build.** The owner: "make sure we have permission
to read and write when copying files in Finder. Both Finder and web should
always be the same." So: reads stream (Phase A below); and copying a file onto
the drive uploads it to Onyx, new folder / rename / move / delete in Finder do
the same on the web (delete = the web's trash), a file saved over is replaced
in place (same file, same comments), and web changes reach Finder within
seconds. A drive the account can only view mounts read-only; the server
re-checks every write anyway. See "Writes" at the end.

## Security

The resource URL is visible to every local account in `mount` output, so it
carries only a **one-time ticket**, never a lasting secret:

`onyxfs-drive://127.0.0.1:<bridgePort>/<scope>?ticket=<ticket>&name=<drive name, percent-encoded>&v=1`

(`name` lets FSKit's probe name the volume without spending the ticket.)

- `<scope>` is `drive.<id>` or `library` (SyncDomain.identifier).
- The app issues a ticket per mount (32 random bytes, base64url), valid for
  120 s and for one exchange. The extension exchanges it for a **session key**
  (32 random bytes) that lives only in the two processes' memory.
- Every other request carries `Authorization: Bearer <session>`. A session is
  bound to its scope. Sessions end when the app quits (in memory only) or the
  drive is unmounted.
- This closes the hole the NFS mount had (any local account could mount
  rclone's unauthenticated NFS port).

## Bridge protocol v1 (app side, on the DAVServer listener)

All JSON (UTF-8), `Content-Type: application/json`. Errors:
`{ "error": "<sentence>" }` with 400/401/404/409/500/503. Paths are absolute
within the drive, `/`-separated, NFC-normalized, no trailing slash except the
root `/`, never containing `..` or empty segments. Names are matched
case-insensitively (case-preserving), as the mirror and Finder do: a folder
never holds two names that differ only in case.

**Entry** (a file or folder):
```json
{ "name": "Take 1.mov", "type": "file", "id": "uuid-or-null", "size": 123,
  "mtime": 1790460000.5, "version": "opaque-string", "local": false }
```
- `type`: `"file"` or `"dir"`. Folders have `id: null`, `size: 0`,
  `version` = a stable hash of the folder path, `mtime` = newest child's or 0.
- `version` changes whenever the file's bytes may have changed (use the
  mirror's modified time + size + storage key — whatever MirrorEntry has that
  moves with content). It keys the extension's chunk cache.
- `local`: the bytes are on this Mac (kept offline), so `/data` serves them
  without the network.

Endpoints:

1. `POST /fs/v1/session` — body `{ "ticket": "…" }`, no bearer.
   200:
   ```json
   { "session": "…", "generation": 42,
     "volume": { "scope": "drive.abc", "name": "Client Deliverables",
                 "readOnly": true, "totalBytes": 0, "usedBytes": 123456,
                 "fileCount": 1234 },
     "cacheLimitBytes": 53687091200 }
   ```
   `totalBytes` 0 = unknown (the extension then reports used + a large free
   figure, e.g. used + 8 TiB, so apps never think it's full). 401 for an
   unknown/used/expired ticket.
2. `GET /fs/v1/list?path=/a/b` → `{ "path": "/a/b", "generation": 42, "entries": [Entry…] }`.
   404 when there is no such folder. Order: folders first, then files, by name.
3. `GET /fs/v1/stat?path=/a/b/c.mov` → `{ "generation": 42, "entry": Entry }`, 404 if absent.
   `path=/` returns the root as a dir entry named after the drive.
4. `GET /fs/v1/source?id=<fileId>` →
   `{ "kind": "remote", "url": "https://…presigned…", "expiresAt": 1790460900, "size": 123, "version": "…" }`
   or `{ "kind": "local", "size": 123, "version": "…" }` (then read via `/data`).
   The presigned URL is valid ≥ 15 min; the extension refreshes it before
   `expiresAt - 60` and once on a 403 from storage. Authorize → filter →
   presign: only files in this session's scope (the mirror already holds only
   what the account may see).
5. `GET /fs/v1/data?id=<fileId>` with `Range: bytes=a-b` → 206 bytes from the
   pinned copy on this Mac; if the file is not local, 307 to the presigned URL.
6. `GET /fs/v1/changes?since=<generation>&wait=25` → long-poll, answers as soon
   as the mirror changes (or after `wait` seconds with no change):
   `{ "generation": 43, "all": false, "paths": ["/a/b", "/"] }` — folders whose
   listing changed. `all: true` = drop everything (e.g. the mirror was rebuilt).
7. `GET /fs/v1/volume` → the `volume` object from (1), fresh.

`generation` is a per-scope counter that moves every time that drive's mirror
changes.

## The extension's engine (OnyxFSCore — pure Swift, no FSKit, unit-tested)

A SwiftPM library target `OnyxFSCore` in the OnyxKit package (its own target,
depending on nothing but Foundation), so the extension stays small and the
logic is testable with `swift test`.

- `FSBridgeClient` — the protocol above over URLSession (ephemeral config,
  HTTP/1.1 keep-alive to 127.0.0.1, 30 s timeouts; `changes` 40 s). Parses
  the resource URL. Typed errors: `.disconnected` (401 / connection refused —
  the app is gone or restarted), `.notFound`, `.server(String)`.
- `NodeTable` (actor) — stable `UInt64` item ids per path (root = 2, then
  monotonically from 16), the latest Entry per path, directory listings cached
  until `changes` invalidates them (or 30 s TTL as a backstop), a background
  task running the `changes` long-poll.
- `ChunkStore` (actor) — on-disk chunk cache in the extension's own Caches
  folder: one file per chunk, key = `sha256(fileId + version)/<index>`, LRU
  eviction to `cacheLimitBytes` (default 50 GiB), survives restarts, tolerates
  a corrupt/partial chunk (discard).
- `FileReader` (actor, one per open file) — `read(offset:length:) async throws -> Data`:
  8 MiB chunks; sequential detection; read-ahead window that grows 2 → 16
  chunks (≤ 128 MiB) while reads stay sequential and resets on a seek; up to 4
  chunk fetches in flight; in-flight de-duplication; remote chunks by HTTP
  Range GET on the presigned URL (refresh + retry once on 403/400 from
  storage, 3 attempts with backoff on network errors), local files via
  `/fs/v1/data`; short final chunk handled; reads past EOF return what exists.
- All of it under `apple/OnyxKit/Sources/OnyxFSCore/`, tests under
  `apple/OnyxKit/Tests/OnyxFSCoreTests/` with a stub bridge (URLProtocol or a
  tiny local HTTP server).

## The FSKit glue (OnyxFS.appex)

- `@main struct OnyxFSExtension: UnaryFileSystemExtension` →
  `OnyxFileSystem: FSUnaryFileSystem, FSUnaryFileSystemOperations`:
  probe/load an `FSGenericURLResource` with scheme `onyxfs`; load exchanges
  the ticket and builds the volume.
- `OnyxVolume: FSVolume` — read-only: activate (root item), lookup, enumerate
  directory (with attributes), get attributes, read, open/close, statfs
  (`volumeStatistics` from the volume object), path conf, capabilities
  (case-insensitive, case-preserving, 64-bit ids, no hard links/symlinks/xattrs writes), write
  operations → `EROFS`. macOS 27's data cache handler: grant `readCache` for
  files so the kernel caches pages. Items: `OnyxItem: FSItem` carrying the
  NodeTable id. Owner = the mounting user; modes 0555/0444.
- Info.plist (`EXAppExtensionAttributes`): `EXExtensionPointIdentifier`
  `com.apple.fskit.fsmodule`, `FSShortName` `onyxfs`, `FSSupportedSchemes`
  `["onyxfs-drive"]`, `FSActivateOptionSyntax` `{ shortOptions: "" }`, plus the
  keys needed for generic URL resources.
- Entitlements: `com.apple.security.app-sandbox`,
  `com.apple.developer.fskit.fsmodule`, `com.apple.security.network.client`.
  Needs a Developer ID provisioning profile for `io.onyxfs.app.fs` with the
  FSKit capability (`apple/.signing/OnyxFS.provisionprofile`).

## The app side

- `FSSessions` — tickets and sessions (above).
- `FSResponder` (OnyxKit, like DAVResponder, unit-tested) — answers /fs/v1
  from a DriveMirror index + PinStore + a presign function.
- `DiskMounter` (OnyxMac, macOS 27) — is our module installed and enabled
  (`FSClient.shared.installedExtensions`)? Mount with
  `mountSingleVolume`; unmount (`FileManager.unmountVolume(at:)`); remount
  after the app restarts (sessions died with it); report mounting / mounted /
  failed like MountManager. DriveService uses it when available, else
  MountManager (NFS).
- Settings → Finder: which way drives mount; when the module is not enabled,
  a button that opens System Settings' File System Extensions pane
  (`FSClient.shared.openFileSystemExtensionsSettings()`).
- `scripts/build-mac.sh`: builds `OnyxFS`, assembles
  `Contents/Extensions/OnyxFS.appex`, signs it with its entitlements and
  profile; adds `com.apple.developer.fskit.mount` to the app's entitlements
  only when the app's profile grants it (a restricted entitlement a profile
  does not grant stops the app from launching).


## Writes (the owner asked for read-write; this is part of this build)

### Who may write
The volume is read-write when the account may add to the drive (the same test
the web's upload uses: drive role editor/owner via getFilespaceForWrite, and
the role's `files.upload` capability), otherwise read-only (mounted `rdonly`,
modes 0555/0444, writes → EACCES). The bridge reports it as
`volume.readOnly`. Each operation's own capability (files.edit for rename/move,
files.delete for delete, folders.manage for folders) is enforced by the server
route; a refusal comes back to Finder as EACCES with the server's sentence in
the log.

### Bridge protocol v1 — write endpoints (app side)
All require the session bearer; all 403 with `{error}` when the volume is
read-only or the server refuses.

8. `PUT /fs/v1/file?path=/a/b.mov` — body: the whole file's bytes, streamed
   (Content-Length known). Headers: `X-Onyx-Mtime: <unix seconds>` (optional).
   The app writes the body to its own staging area, then answers **at once**
   with `{ "entry": Entry, "generation": n }` — the entry has `pending: true`
   until the upload finishes — and uploads in the background (single PUT or
   multipart, retried, surviving an app restart). If a file exists at that
   path it is a **replacement**: same file id, new bytes. While pending, the
   bytes are served locally by `/fs/v1/data` (entry `local: true`).
9. `POST /fs/v1/mkdir` — `{ "path": "/a/new" }` → `{ "entry": Entry }` (409 if a
   file is in the way; an existing folder is fine).
10. `POST /fs/v1/rename` — `{ "from": "/a/x", "to": "/b/y", "replace": false }`
    → `{ "entry": Entry }`. Files and folders; moving across folders; 409 when
    `to` exists and `replace` is false; with `replace: true` a file at `to`
    goes to the trash first (how apps "save as" over a file).
11. `DELETE /fs/v1/item?path=/a/x` → `{ "ok": true }`. A file → the web's trash
    (the server's trash flag decides, as on the web). A folder → deleted with
    its contents the way the web's folder delete does.

Entry gains `"pending": bool` (bytes still uploading from this Mac). Entries
never carry `.DS_Store`, `._*`, `.Trashes`, `.Spotlight-V100`, `.fseventsd`,
`.TemporaryItems`, `Icon\r`: those never reach the server (below).

`version` must depend only on the bytes (size + content etag/modified), not
on the storage key or path: a rename or move must not throw away the
extension's cached chunks.

### What the app does for a write (Mac upload engine)
- The server's own routes, with the device's bearer token: `POST
  /api/files/presign` (small files) or `POST /api/files/upload/multipart`
  (create / sign parts / complete — large files, ≥ 64 MiB, parts retried
  individually, resumable after a restart), then `POST /api/files` to
  create the file row; `PATCH /api/files/[id]` to rename/move a file;
  `DELETE /api/files/[id]` to trash it; `/api/files/folders` POST/PATCH/DELETE
  for folders; a content-replacement call for save-over (new on the server:
  same id, new bytes; previews dropped so they regenerate; `seq` bumped).
- The mirror is updated at once from each response (the delta confirms it
  later), so Finder, the menus and the web page inside the app agree
  immediately.
- A queue with progress ("Uploading 3 files — 42%" in the menu bar), per
  file retries with backoff, and a failure reported (menu bar + the file
  stays pending, and the error in the log) rather than silently dropped.

### What the extension does for a write
- `createItem(file)` → a local node, bytes in a staging file in the
  extension's own container; `write` fills it; `setAttributes(size)` truncates;
  when the last writer closes it (or on `synchronize`), the extension streams
  it to `PUT /fs/v1/file` and then serves it like any other file.
- Opening an existing remote file for writing (not truncating) first fetches
  it whole into staging (copy-on-write), then the same.
- `mkdir`, `rename` (incl. `overItem`), `remove` → the bridge calls above.
- **Local-only names** (`.DS_Store`, `._*`, `.Trashes`, `.Spotlight-V100`,
  `.fseventsd`, `.TemporaryItems`, `Icon\r`) live only in the extension's
  container; they are never uploaded and never listed by the bridge.
- **Extended attributes** are kept locally per item (so macOS does not
  write `._` AppleDouble files); never uploaded.
- **Finder's Trash**: moving an item into `/.Trashes/<uid>/` trashes it on the
  web; the extension keeps a local tombstone so Finder's Trash shows it; Put
  Back restores it (web restore), Empty Trash only forgets the tombstone (the
  web's trash purges on its own schedule).

### Keeping them the same
The app syncs a mounted drive's mirror every 5 s (not 15) while it is
mounted, and the bridge's `changes` long-poll carries that to the extension,
which invalidates listings and the kernel's cache for changed files
(`KernelCacheCoherencyAction.revoke` / `.invalidate`).
