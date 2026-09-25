# Onyx roadmap

**What Onyx is:** an AI-native asset manager for one person's media library. You
find footage by describing it, not by remembering where you filed it.

**Targets:** 100k+ files, heavy video. S3 is the library. Web, a native macOS
app that appears in Finder, and a native iOS app that appears in Files.app —
one Swift codebase for both.

**Standing constraint:** no recurring AI spend. Everything core runs on hardware
you already own. Paid enrichment is opt-in, scoped, and never on by default.

---

## The reframe

Onyx as built is *storage-shaped*: folders, tags you typed, a substring match on
filenames. The product described above is *search-shaped* — the system
understands the content and you ask it in English.

That moves the ingest pipeline from a nice-to-have to the core of the product,
and it changes what "performance" means. At 100k+ files the interesting question
is not how fast a folder listing renders; it is whether you can find one shot
out of a hundred thousand in under a second.

---

## How the search actually works

CLIP-family models — **SigLIP** is the current recommendation, it outperforms
CLIP at the same size — embed images and text into a *shared* vector space. So:

1. Embed every image (and sampled video frames) once, at ingest.
2. At query time, embed the text query.
3. Nearest neighbours in that space are your results.

No captioning step, no API call, no per-file cost. This is the engine.

### Where the compute goes

**The desktop app is the ingest worker.** It already handles upload; it also
extracts frames, runs the embedding model locally, and uploads the vectors
alongside the file. Apple Silicon runs these models well.

This is the design decision that satisfies the no-spend constraint. The cloud
stores bytes; your machine does the thinking. No GPU instance, no inference
service, no bill that scales with library size.

Consequence: the same work needs a server-side fallback for files that arrive
any other way (bucket sync, the web uploader, iOS). Keep the pipeline a single
module with two callers rather than two implementations.

### Storage: pgvector, in the database you already have

Embeddings live in a column beside the file row on Neon. No vector database, no
second store to keep in sync, no new infrastructure.

- Images: one vector on the file row.
- Video: a `file_frames` table — `file_id`, `timestamp_ms`, `embedding` — so a
  hit returns *the video and the point in it*. Being taken straight to the
  right second is most of the magic; it is worth the extra table.
- Index: HNSW with cosine distance.

Scale note: 100k videos at ~50 sampled frames each is ~5M vectors. pgvector
with HNSW handles that, but it is the number to watch — sample on scene changes
rather than a fixed interval and it stays far smaller.

### Ranking: hybrid, not pure vector

Vector search has excellent recall and mediocre precision on exact terms — it
will not reliably find a file because you typed its client's name. Fuse two
rankings:

- **Vector** similarity for semantic and visual recall.
- **Postgres full-text** over filenames, tags, captions and transcripts for
  exact matches.

Reciprocal rank fusion over the two is simple and works well. Both live in the
same database, so this is one query, not a fan-out.

---

## Paid enrichment stays optional

Claude vision produces captions and structured tags that measurably improve
recall on abstract queries, and give you human-readable descriptions. ARMRA's
`lib/vision.js` is a proven template for the prompt — its central lesson is
worth keeping: *"a person" is useless; "woman pouring from a sachet into a glass
at a marble counter, morning sunlight, hand-held framing" is gold.*

Rough one-time cost to caption 100k images, via the Batch API at 50%:

| Model | Estimated |
|---|---|
| `claude-haiku-4-5` | ~$125 |
| `claude-sonnet-5` | ~$250 |
| `claude-opus-5` | ~$625 |

Assumes ~1,500 input tokens per image and ~200 output. Image tokens scale with
resolution — baseline with `count_tokens` on a real sample before committing to
any of it.

**This ships off by default, and the controls come before the feature:**

- A **dry run** that reports estimated token spend and dollar cost, and exits.
- A **hard budget cap** per run, enforced client-side, that aborts on breach.
- **Scoped runs** — one folder, one filespace, one selection. Never "the whole
  library" as a default.
- **Incremental by construction** — only files with no caption, so a re-run
  costs nothing.
- **Batch API always**, never the synchronous endpoint, for the 50%.

Anthropic has no embeddings endpoint, so this is strictly about captions and
tags. The vectors are always local.

Transcripts (Whisper, self-hosted) are the other enrichment worth having and
cost nothing but compute — for interview and doc footage, searching what was
*said* is often more valuable than searching what was *shown*.

---

## Phases

### Phase 1 — Foundations

Unchanged from the storage roadmap, and still first: these are the things that
are destructive to retrofit.

| | Work | Why now |
|---|---|---|
| 1.1 | Change cursor + tombstones | Deleting a row leaves an offline client no way to learn the file is gone. Sync needs a tombstone that outlives the trash purge. |
| 1.2 | `GET /api/files/delta?cursor=` | The shape iOS's `enumerateChanges(from:)` requires. `updated_at` alone is unsafe — two writes in the same millisecond can straddle a cursor. |
| ~~1.3~~ | ~~Multipart resumable upload~~ | **Done.** Parts are independently signed and retried; S3 holds the part manifest, so a reload resumes rather than restarts. Abandoned uploads are swept by the daily cron — their parts bill silently and never appear in the bucket listing. |
| 1.4 | Filtering into SQL | `listFiles()` selects the whole table and filters in JavaScript, while indexes on `folder`, `created_at`, `kind` and a GIN index on `metadata` sit unused. Mostly a matter of writing the query the schema was built for. |
| 1.5 | Keyset pagination | `OFFSET` degrades linearly at 100k. |

### Phase 2 — The ingest pipeline

The core of the product.

| | Work |
|---|---|
| 2.1 | pgvector: schema, HNSW index, `file_frames` table |
| 2.2 | Embedding module (SigLIP via ONNX) — one module, two callers |
| 2.3 | Desktop ingest: frames + embeddings on upload |
| 2.4 | Server fallback for bucket-sync / web / iOS arrivals |
| 2.5 | Hybrid search: vector + FTS, reciprocal rank fusion |
| 2.6 | Search UI — query box, similarity ("more like this"), frame-accurate video hits |

**2.7 — fix video thumbnails.** `lib/thumbs.js` caps video at
`VIDEO_MAX_BYTES = 200MB` and buffers the entire file in memory, so most of a
heavy-video library silently gets no thumbnail at all. ffmpeg only needs the
head of a faststart MP4 to pull a frame — range-read instead of downloading.
The same fix is what makes frame sampling for embeddings viable.

**2.8 — video proxies.** Scrubbing a multi-GB master through a presigned URL is
unusable. Generate an HLS or 1080p proxy at ingest, play that, keep the original
for download. Same worker as 2.7, so build them together.

### Phase 3 — Interface and scale

| | Work |
|---|---|
| 3.1 | Virtualized grid (non-negotiable at this scale) |
| 3.2 | Facet counts via scoped `GROUP BY`, not a client-side scan |
| 3.3 | CDN + signed cookies instead of presigning every request |
| 3.4 | The UI/API gap (below) |

**3.3 is the biggest perceived-speed win in the plan.** One cookie authorizes a
whole prefix for the session; thumbnails become plain `<img src>` that cache
normally, and per-request signing disappears.

**3.4 — backends that are already working with no interface:**

| Working API | Missing UI |
|---|---|
| `/api/files/trash` | Trash & restore |
| `/api/share` | Creating a link at all |
| `/api/files/[id]` PATCH | Rename, move, detail view |
| `/api/files/metadata-bulk` | Bulk metadata editor |
| `/api/files/folders` | Create / rename folder |
| `/api/files/[id]/acl` | Per-file sharing |

### Phase 4 — Optional enrichment

Claude captions and tags, behind every control listed above. Whisper
transcripts, self-hosted. Both feed the FTS half of hybrid search.

### Phase 5 — Native Apple apps: macOS and iOS

One Swift codebase, two hosts. The shared piece is a File Provider extension
(`NSFileProviderReplicatedExtension`, macOS 11+ / iOS 16+) — the same API on
both platforms — wrapped by a thin SwiftUI app per platform. That is what puts
Onyx in Finder's sidebar and in Files.app with on-demand download, sync badges
and eviction, without a kernel extension, an NFS mount, or a webview.

**Why this replaces the Tauri app on macOS.** Today macOS mounts the bucket
through rclone over NFS. It works, but it is a foreign filesystem: no sync
status in Finder, no offline eviction, every stat is a network call, and it
dies with the process. A File Provider domain is what iCloud Drive, Dropbox and
Shade are built on. The Tauri app stays for Windows (WinFSP) until there is a
reason to do otherwise.

**Not buildable in Tauri**: a File Provider runs as a separate process with
roughly a 50MB memory ceiling and no webview. It has to be native.

**Revised for macOS: Finder gets streaming mounts, not File Provider.** A File
Provider materialises a whole file before any app can read it, which is wrong
for a video library where the point is to scrub a 40 GB master without
downloading it. The old rclone mount streamed but read the bucket directly —
showing what the web hides, and never telling Onyx about a file dropped in.
Onyx.app now does both properly: rclone's NFS mount (macOS's own client, no
macFUSE) reads a WebDAV bridge inside the app, which lists each drive from
`/api/files/delta` — the web's own access rule — and redirects reads to the
file's presigned URL, so ranges stream straight from storage into rclone's
VFS cache. Offline pins and a user-placed cache sit on top (apple/README.md).
File Provider stays the plan for iOS's Files.app, where there is no mount.

**The control plane already has what it needs.** Phase 1 shipped the two
contracts the extension is built on: `GET /api/files/delta?cursor=` is the
exact shape `enumerateChanges(from:)` requires, and `POST /api/space/sts`
mints prefix-scoped, expiring credentials so the extension streams bytes
straight from S3 rather than proxying through the app — which is also the only
way to stay under that memory ceiling. Multipart upload is the same server
protocol the web uploader uses.

#### Shape of the code

```
apple/
  Onyx.xcworkspace
  OnyxKit/                 Swift package — everything shared
    Auth/                  PKCE via ASWebAuthenticationSession on the existing
                           onyxfs:// scheme; tokens in a Keychain access group
                           so the extension can read them (it cannot show a
                           login UI)
    API/                   typed client for /api/files, /delta, /space/sts,
                           multipart, search
    Sync/                  the enumeration + change engine: cursor per domain,
                           tombstone handling, conflict policy
    S3/                    SigV4 GET/PUT with range requests — small enough to
                           hand-roll; the AWS SDK for Swift is a 60MB
                           dependency for two request types
    Ingest/                SigLIP via Core ML for Phase 2 embeddings (macOS
                           first; the Neural Engine on M-series makes the
                           desktop the ingest worker the roadmap already
                           assumes)
  OnyxFileProvider/        the extension target, shared source, built twice
  OnyxMac/                 menu-bar app: sign in, choose filespaces, sync
                           status, pause, "open in Finder", ingest queue
  OnyxIOS/                 SwiftUI browser + search, camera-roll import,
                           share-sheet "Save to Onyx", Files.app via the
                           extension
```

#### Milestones

| | Work | Notes |
|---|---|---|
| 5.0 | Decide identifiers, once | `io.onyxfs.app` (already chosen), `io.onyxfs.app.fileprovider`, app group `group.io.onyxfs`, one Keychain access group. Compiled into every install; changing them later orphans every device. |
| 5.1 | OnyxKit: auth + API client | **Done (macOS).** Sign-in by PKCE or pairing code, token in the Keychain; builds and tests with the Command Line Tools alone. |
| 5.1b | The Mac app as a platform | **Done.** Onyx.app: the whole web workspace in a window of its own, signed in from the device token (`/api/desktop/web-session`), plus a menu bar item and Settings. `apple/scripts/build-mac.sh`. |
| 5.2 | Finder on macOS | **Streaming mounts** (revised above): one rclone NFS mount per drive through the app's WebDAV bridge; offline pins; a movable cache; read-only until 5.4. The File Provider built first is kept for iOS (5.3). |
| 5.3 | Same extension on iOS | The source is shared; this is provisioning, memory profiling under the 50MB cap, and Files.app testing. |
| 5.4 | Writes | Create, rename, move, delete, modify → `POST /api/files`, `PATCH /api/files/[id]`, multipart for large. Background `URLSession` so a 20GB upload survives the app being killed. |
| 5.5 | Conflict policy, written down | Server keeps a `version` counter per file; a write carries the version it was based on; mismatch → the server keeps both, the loser is renamed `name (conflict from <device>)`. Decided here, not discovered later. |
| 5.6 | iOS app proper | Browse, search (Phase 2.5's hybrid endpoint), preview, share links, camera-roll import, share-sheet extension. |
| 5.7 | macOS ingest worker | Move Phase 2.3 here: frames + SigLIP embeddings on upload, on the Neural Engine. The Tauri worker becomes Windows-only. |
| 5.8 | Distribution | Apple Developer account, notarised direct download for macOS (Sparkle for updates, replacing Tauri's updater), TestFlight then App Store for iOS. |

#### Server work this needs (small)

- `files.version INT` and `files.content_hash` for 5.5. Add to the guard and
  `db/init.sql` together.
- `PATCH /api/files/[id]` already renames and moves; make it accept
  `If-Match: <version>`.
- ~~`/api/files/delta` should include `version` and `content_hash` in each row~~
  **Done**, and the feed is now judged by the listing's access rule, scoped
  per drive, and fingerprints the access it was computed under.
- A device registry: `devices` table (`id`, `email`, `name`, `platform`,
  `last_seen`, `cursor`), so the admin can see and revoke a device, and so
  the conflict rename above can name it.

Do not start 5.2 before 5.5 is written. The enumeration and conflict contracts
are the hardest things to change once devices are syncing against them.

### Phase 6 — Compatibility

- ~~**Viewers on non-AWS storage.**~~ **Done for Backblaze B2.** B2 has no
  STS, but `b2_create_key` mints an application key restricted to one bucket,
  one name prefix and a lifetime — the same three guarantees AssumeRole gives
  — and the result works against B2's S3-compatible endpoint. The ladder has
  a `b2-native` rung, so viewers get real scoped credentials there.
  **Still open for R2, MinIO and Spaces**, which fall to the static rung and
  therefore refuse viewers. R2 is the same shape of work: its
  `/accounts/{id}/r2/temp-access-credentials` API returns prefix-scoped
  credentials with a session token, closer to STS than B2's keys are.
- **Storage economics.** B2 is roughly a quarter of S3's per-TB price with
  egress free to 3× stored (and unmetered through Cloudflare), which for a
  cold-heavy video library is most of the bill. B2 is slower on small-object
  reads, so it wants the CDN from 3.3 in front of it — which is planned work
  either way, just load-bearing rather than optional.
- **Windows.** The WinFSP path is far less exercised than the macOS NFS one.

---

## Cross-cutting

**Tests.** There are none. The credential ladder and the ACL filter are where a
silent regression costs most — and Phase 1 rewrites the query underneath the ACL
filter. Those deserve tests *before* that work.

**Decide before first release:** the bundle identifier `io.onyxfs.app` and the
`onyxfs://` scheme are compiled into the installed app and registered with the
OS. Changing either after release orphans every install.

**Port leftovers**, cheaper to drop before there is data: the `cue_review_id`
column (from the dropped video-review feature) and indexes still named
`brand_files_*` on a table now called `files`.

---

## Suggested order

1. Tests around the credential ladder and ACL filter
2. Phase 1 — cursor, tombstones, delta, multipart, SQL filtering, keyset paging
3. Phase 2.7 + 2.8 — the media worker (range-read frames, proxies)
4. Phase 2.1–2.6 — pgvector, embeddings, hybrid search, search UI
5. Phase 3 — virtualized grid, CDN, the missing UIs
6. Phase 5 — native macOS + iOS (5.0–5.5 first: the File Provider core)
7. Phase 4 — paid enrichment, if and when it earns its cost
8. Phase 6 — compatibility

Phase 4 sits deliberately late. By the time free search is good, you will know
whether captions are worth paying for — and that is a much better position from
which to spend than guessing now.
