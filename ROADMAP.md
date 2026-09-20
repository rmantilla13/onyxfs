# Onyx roadmap

**What Onyx is:** an AI-native asset manager for one person's media library. You
find footage by describing it, not by remembering where you filed it.

**Targets:** 100k+ files, heavy video. S3 is the library. Web, macOS, and a
native iOS app that appears in Files.app.

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
| 1.3 | Multipart resumable upload | A single presigned PUT caps at 5GB and cannot resume. For heavy video this is a blocker today. |
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

### Phase 5 — Native iOS

Onyx in Files.app via an `NSFileProviderReplicatedExtension` — native Swift,
iOS 16+. **Not buildable in Tauri**: a File Provider runs as a separate process
with roughly a 50MB memory ceiling and no webview.

The architecture already pays off here. `POST /api/space/sts` mints exactly what
the extension needs — prefix-scoped, expiring credentials — so it streams bytes
straight from S3 rather than proxying through the control plane, which is also
the only way to stay under that memory ceiling. **The control plane needs no new
concepts for iOS.** It needs Phase 1 and nothing beyond it.

Shape of the work: container app + extension sharing auth through a Keychain
access group (the extension cannot present a login UI); PKCE via
`ASWebAuthenticationSession` reusing the existing `onyxfs://` scheme; paginated
enumeration plus delta against 1.2; background `URLSession` for uploads; and an
explicit conflict policy written down rather than discovered.

Do not start before Phase 1 ships. The enumeration contract is the hardest thing
to change once devices are syncing against it.

### Phase 6 — Compatibility

- **Viewers on non-AWS storage.** R2, MinIO and Spaces have no STS, so
  `mintFilespaceCredentials()` falls to the static rung — which deliberately
  refuses viewers, since IAM cannot scope or expire that key. **On non-AWS
  storage you currently cannot have a read-only member at all.**
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
6. Phase 5 — native iOS
7. Phase 4 — paid enrichment, if and when it earns its cost
8. Phase 6 — compatibility

Phase 4 sits deliberately late. By the time free search is good, you will know
whether captions are worth paying for — and that is a much better position from
which to spend than guessing now.
