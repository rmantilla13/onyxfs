# Onyx roadmap

Target: **100k+ files, heavy video**, on web, macOS, and a **native iOS app that
appears in Files.app**.

That target, not a feature wishlist, is what orders the work below. Three things
get dramatically more expensive with every file added, so they come first even
though none of them is visible in the UI.

---

## The three retrofits to avoid

### 1. Deletions leave no trace

`deleteFile()` removes the row. A client that was offline when it happened has
no way to learn the file is gone — it will keep showing a ghost forever.

Any sync client (the iOS File Provider, and eventually the desktop app) needs
**tombstones**: a durable record that item X was deleted at time T, retained
longer than the longest plausible client absence. Adding this later means every
client that synced before the change has a permanently inconsistent view, with
no way to repair short of a full re-enumeration.

The `trash` feature is close but not sufficient — it is a UI affordance with a
purge that hard-deletes. Sync needs the tombstone to outlive the purge.

### 2. There is no way to ask "what changed?"

Every read is a full listing. A File Provider enumerating 100k items on every
launch is a non-starter — and Apple's API is explicitly built around the
opposite: `enumerateChanges(from: anchor)` returns a delta and a new anchor.

This needs a **monotonic change cursor** on the files table — a sequence number
bumped on every insert, update and delete — plus an endpoint that returns
changes since a given cursor. `updated_at` alone is not safe: two writes in the
same millisecond can straddle a cursor and one will be missed.

### 3. Uploads cap at 5GB and cannot resume

The upload path is a single presigned `PUT`. That is a hard 5GB S3 ceiling, and
any network blip loses the entire transfer. For heavy video this is a day-one
blocker, not a scaling concern.

The fix is multipart: `CreateMultipartUpload`, presign each part, upload parts
in parallel with retry, `CompleteMultipartUpload`. Part state has to survive a
page reload for resumability, which means it is a small amount of new schema —
easier to add before there is an upload history to migrate.

**These three are Phase 1 for a reason.** Everything else on this list can be
added incrementally without invalidating what came before.

---

## Phase 1 — Foundations

| | Work | Why now |
|---|---|---|
| 1.1 | Change cursor + tombstones | Retrofit is destructive (above) |
| 1.2 | `GET /api/files/delta?cursor=` | The shape iOS requires |
| 1.3 | Multipart resumable upload | 5GB ceiling today |
| 1.4 | Push filtering into SQL | See below |
| 1.5 | Keyset pagination | `OFFSET` degrades linearly at 100k |
| 1.6 | Postgres full-text search | Replaces a JS substring scan |

### On 1.4 — the indexes already exist

`listFiles()` runs `SELECT * FROM files ORDER BY created_at DESC` with no
`WHERE` clause and filters everything in JavaScript — folder, kind, tags,
filespace prefix, search — then applies ACLs in JS, then slices for pagination.
The route passes no limit, so every surviving row is returned and presigned.

Meanwhile `ensureFilesTable()` already creates indexes on `folder`,
`created_at DESC`, `kind`, and a GIN index on `metadata`. None of them is used
by any query. Most of this task is writing the query the schema was built for.

Watch for: ACL filtering has to move into the query too. Filtering after the
`LIMIT` returns short pages; filtering before it is what makes pagination
correct.

### On 1.6 — Postgres is enough

At 100k–1M rows, `tsvector` + GIN over name/tags/notes/caption is fast and adds
no infrastructure. Reach for a dedicated search service only when you want
fuzzy matching, per-field boosting, or search over transcripts — not before.

---

## Phase 2 — The media pipeline

Heavy video is where the current design breaks hardest, and none of it is a
small fix.

### 2.1 Thumbnails are capped at 200MB

`lib/thumbs.js` sets `VIDEO_MAX_BYTES = 200MB` and **downloads the entire file
into memory** before handing it to ffmpeg. Above that, the file silently gets no
thumbnail.

Two layers to fix:

- **Range-read instead of full download.** ffmpeg does not need the whole file
  to grab a frame — with a faststart MP4 the moov atom is at the head, so the
  first few MB suffice. This alone lifts the cap enormously and is a contained
  change.
- **Get off the serverless function.** Even fixed, thumbnailing 100k assets
  inside Vercel functions is the wrong shape: cold starts, a 300s ceiling, and
  no backpressure. This wants a real queue and a worker that can stream.

### 2.2 Playback needs proxies, not presigned originals

Scrubbing a multi-GB ProRes or 4K master through a presigned URL is unusable —
the browser has to range-fetch across the network for every seek.

The answer is the standard one: generate an **HLS proxy** (or a single H.264
720p/1080p rendition) at ingest, play that, and reserve the original for
download. This is the same worker as 2.1, so build them together.

### 2.3 Stop presigning per request

At 100k files with a virtualized grid you are signing URLs constantly, and every
signed URL expires — which breaks browser caching and forces re-signing on
scroll.

Use a **CDN with signed cookies** (CloudFront, or R2 + Workers). One cookie
authorizes a whole prefix for the session, thumbnails become plain `<img src>`
that cache normally, and the per-request signing cost disappears. This is the
single biggest perceived-speed win in the whole plan.

### 2.4 Storage lifecycle

100k+ of heavy video is a real bill. Intelligent-Tiering for the general case,
and a lifecycle rule moving originals to Glacier once a proxy exists — the proxy
stays hot, the master goes cold. Restore-on-demand in the UI.

---

## Phase 3 — The interface

### 3.1 Virtualized grid

Non-negotiable at this scale. Render the visible window only, with the delta
endpoint feeding it.

### 3.2 Facet counts need a strategy

`buildFacets()` currently counts across every loaded row on the client. At 100k
that is neither possible nor useful. Pick one:

- **Scoped counts** — count only within the active filter, via the GIN index.
  Accurate and cheap, but counts shift as you filter.
- **Precomputed summary table** — refreshed by the same worker. Fast and stable,
  eventually consistent.
- **Drop the counts** — show facet values without numbers.

Scoped counts are the right default; they are what people actually read.

### 3.3 The UI/API gap

Several backends are ported, verified and have no interface. Cheapest work here:

| Working API | Missing UI |
|---|---|
| `/api/files/trash` | Trash & restore |
| `/api/share` | Creating a link at all |
| `/api/files/[id]` PATCH | Rename, move, detail view |
| `/api/files/metadata-bulk` | Bulk metadata editor |
| `/api/files/folders` | Create / rename folder |
| `/api/files/[id]/acl` | Per-file sharing |

---

## Phase 4 — Native iOS

The goal is Onyx in **Files.app**, behaving like iCloud Drive. That means an
`NSFileProviderReplicatedExtension` — native Swift, iOS 16+.

### What this is not

It is **not** buildable in Tauri. A File Provider runs as a separate extension
process with roughly a 50MB memory ceiling and no webview. It is a distinct
native codebase that happens to talk to the same API.

### What the architecture already gives you

More than it might seem. `POST /api/space/sts` already mints exactly what a File
Provider wants: credentials scoped to one bucket prefix, with an expiry. The
extension can stream bytes straight from S3 without proxying through the control
plane — which is also the only way to stay inside that memory ceiling.

**The control plane needs no new concepts for iOS.** It needs Phase 1 (delta
enumeration, tombstones, multipart) and nothing beyond it.

### The shape of the work

1. **App + extension + App Group.** The container app handles sign-in; the
   extension does the file work. They share the auth token via a Keychain access
   group — the extension cannot present UI to log in.
2. **Auth.** `ASWebAuthenticationSession` for the PKCE hand-off, reusing the
   `onyxfs://` scheme the desktop already uses. The pairing-code fallback works
   here too.
3. **Enumeration.** Paginated listing plus `enumerateChanges(from:)` against the
   Phase 1 delta endpoint. This is where tombstones become load-bearing.
4. **Materialization.** Fetch content on demand, stream to disk, never buffer.
   Thumbnails come from the same `_thumbs/` objects the web grid uses.
5. **Upload.** Multipart from the device, with the extension's background
   URLSession so transfers survive the app being suspended.
6. **Conflicts.** Decide the policy explicitly. Last-write-wins is defensible
   for a single-user workspace; say so in the code rather than discovering it.

### Sequencing

Do not start this before Phase 1 ships. A File Provider built against
full-listing endpoints will need rewriting, and the enumeration contract is the
hardest part to change once devices are syncing against it.

---

## Phase 5 — Compatibility

- **Viewers on non-AWS storage.** R2, MinIO and Spaces have no STS, so
  `mintFilespaceCredentials()` falls to the static rung — which deliberately
  refuses viewers, because IAM cannot scope or expire that key. **On non-AWS
  storage you currently cannot have a read-only member at all.** Fix with a
  credential-broker proxy, or R2's own scoped-token API.
- **Windows.** The WinFSP mount path is far less exercised than the macOS NFS
  one. Needs real testing before it is advertised.
- **Linux desktop.** Tauri supports it; unverified here.

---

## Cross-cutting

**Tests.** There are currently none. The credential ladder and the ACL filter
are where a silent regression is most expensive — and Phase 1 rewrites the query
underneath the ACL filter. Those two deserve tests *before* that work, not after.

**Decide before first release:** the bundle identifier `io.onyxfs.app` and the
`onyxfs://` scheme are compiled into the installed app and registered with the
OS. Changing either after release orphans every install.

**Port leftovers**, cheaper to drop before there is data: the `cue_review_id`
column (from the dropped video-review feature) and indexes still named
`brand_files_*` on a table now called `files`.

---

## Suggested order

1. Tests around the credential ladder and ACL filter
2. Phase 1 — cursor, tombstones, delta endpoint, multipart, SQL filtering, keyset paging, FTS
3. Phase 2.1 + 2.2 — the media worker (range-read thumbnails, HLS proxies)
4. Phase 3.1 + 3.3 — virtualized grid, then the missing UIs
5. Phase 2.3 — CDN and signed cookies
6. Phase 4 — native iOS
7. Phase 5 — compatibility

Phases 1 and 2 are the ones that are painful to defer. Everything from 3 onward
can be reordered to taste.
