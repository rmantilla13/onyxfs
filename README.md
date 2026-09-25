# Onyx

A private file workspace. Browse it on the web, mount it as a drive.

Onyx is two programs against one bucket:

- **The web app** (this repo's root) — the control plane. It holds the catalog,
  decides who may see what, and mints credentials. It runs on Vercel.
- **The desktop app** (`desktop/`) — a thin Tauri client. It mounts a filespace
  as a local drive and talks **straight to S3**, so file bytes never pass
  through the web app.

```
                    ┌──────────────┐
   browser ────────▶│   Onyx web   │  catalog · access · STS minting
                    │  (control)   │
                    └──────┬───────┘
                           │ scoped, expiring credentials
                           ▼
   desktop ───────────────────────────▶  S3   (the data plane)
             reads and writes bytes directly
```

That split is the whole design. The control plane never sees a file's contents,
and a leaked desktop token is bounded by both the filespace prefix it was
scoped to and its own expiry.

## Stack

- Next.js 14 (App Router) on Vercel
- Postgres (Supabase) via postgres.js, addressed with tagged-template SQL
- Auth.js v5 — Resend magic links, optional Okta SSO
- S3, or anything S3-compatible (R2, Spaces, B2, Wasabi, MinIO)
- Tauri 2 + React 19 for the desktop client

## Getting it running

Node 22.15 or newer is required (`.nvmrc`); `npm test` fails to start on older versions.

### Entirely on this machine

No cloud account and no mail provider:

```bash
brew install postgresql@17 versitygw
npm install
npm run dev:local
```

The first run writes `.env.local`, creates a Postgres cluster and an S3 bucket
under `.dev/`, applies the schema, and points Admin → Storage at the bucket.
Every run starts whichever of the two is not already up, then `next dev`. Sign
in with an address from `ADMIN_EMAILS`: with `RESEND_API_KEY` unset, `next dev`
prints the magic link to the terminal instead of emailing it.

| | |
|---|---|
| Postgres | `postgresql://postgres@127.0.0.1:55432/onyx` |
| S3 | `http://127.0.0.1:59000`, bucket `onyx` — every object is a plain file under `.dev/s3/onyx/` |

Both keep running when you stop the app. `npm run dev:stop` stops them, and
`npm run dev:stop && rm -rf .dev` resets everything. The bucket is versitygw
rather than MinIO because MinIO's community builds are unmaintained and its
last Homebrew binary crashes at startup on macOS 27.

`dev:local` refuses to start when the `DATABASE_URL` that `next dev` would see
points anywhere but its own cluster, so a Supabase string left in `.env.local`
never gets a local session run on top of it.

npm 12 skips dependency install scripts that `allowScripts` in `package.json`
does not approve. ffmpeg-static's is approved there: it downloads the binary
that server-side video thumbnails need.

### Against a hosted database

```bash
npm install
cp .env.local.example .env.local   # fill in DATABASE_URL, AUTH_SECRET, RESEND_API_KEY
npm run dev
```

Then `npm run doctor` — it creates the schema, verifies the connection, and
says exactly what is missing.

There is **no migration step**. Every table is created lazily on first use by
an `ensure*Table()` guard in `lib/db.js`. `db/init.sql` holds the same DDL if
you would rather create everything up front; it is generated from those guards,
so the two cannot drift.

**Run `db/init.sql` once against a production database.** The lazy guards are
switched off there automatically (`NODE_ENV=production`), because a cold start
issuing a few dozen DDL statements before its first real query is a liability
once anyone is using the app — `CREATE` and `ALTER` take an exclusive lock on
their table even when they change nothing, and concurrent cold starts convoy.
Schema changes are applied instead by the daily maintenance cron and by
`npm run doctor`, both of which call `ensureSchema()`. `SCHEMA_MANAGED=0`
forces the guards back on if a deployment has to bootstrap its own schema.

**Use Supabase's connection pooler** (port 6543, transaction mode) for
`DATABASE_URL`, not the direct connection. Every serverless invocation opens
its own socket, so the direct URL exhausts the connection limit under real
traffic. The driver is configured with `prepare: false` to match transaction
pooling, which does not support prepared statements.

Storage is deliberately *not* an env var. Open `/admin` → **Storage**, enter the
bucket and keys, hit **Test connection**, then **Apply CORS**. Keeping it in the
settings table is what lets you test and change a backend without a redeploy.

## How things are arranged

| Path | What lives there |
|---|---|
| `lib/db.js` | Every table and query. Lazy DDL, tagged-template SQL. |
| `lib/storage.js` | S3: presigning, key layout, and the credential ladder. |
| `lib/brand.js` · `lib/brand-config.js` | The white-label layer (below). |
| `lib/config.js` | Runtime secret overrides — DB values shadow env vars. |
| `lib/features.js` · `lib/roles.js` | Feature flags, and the roles that narrow them. |
| `lib/dam.js` | The metadata/facet model. Dependency-free, shared client + server. |
| `app/api/space/*` · `app/api/desktop/*` | What the desktop client talks to. |
| `desktop/` | The Tauri app. |

### The brand layer

Nothing renders `BRAND` directly. Everything goes through `resolveBrand()`,
which layers an admin-edited config over the defaults in `lib/brand.js`. The
root layout emits the result as CSS custom properties and `globals.css` reads
only those — so renaming and recoloring Onyx is a settings write, not a deploy.

Dark mode comes from the same palette. `darkPalette()` turns the brand's ink
into the page and its paper into the text, then lifts every text colour until
it clears WCAG AA; the layout emits that under `[data-theme='dark']`. An inline
script in `<head>` (`lib/theme.js`) sets `data-theme` before first paint from
the Light / Dark / System choice in the nav, which lives in `localStorage` and
defaults to the OS. A component styled only from the custom properties
(`--paper`, `--surface`, `--line`, `--ink`, `--muted`, `--accent`, `--danger`…)
needs nothing else to support it.

The one exception is the desktop URL scheme. It is compiled into the app bundle
and registered with the OS at install time, so `/admin` shows it read-only.

### Feature flags

`lib/features.js` is the registry. Flags are merged over defaults, so adding one
needs no migration and a stale saved map never hides a new feature. Each flag
declares how it is enforced — `route`, `nav`, or `ui`.

Enforcement belongs on the server. `DELETE /api/files/[id]` reads the `trash`
flag itself to decide between a soft delete and a purge, rather than accepting a
parameter — otherwise a disabled safety net would be bypassable with a query
string.

### Roles

A role can only *remove* features, never grant one the platform has globally
off (`effectiveFlags`). Admin access stays gated on `ADMIN_EMAILS` and is
independent of roles, so a misconfigured role can never lock every admin out of
the panel that would fix it.

Roles and filespace grants are separate axes: a role decides which parts of Onyx
you see, a grant decides which storage you can reach.

### The credential ladder

`mintFilespaceCredentials()` walks four rungs, most-scoped first:

1. **Per-filespace keys** — a dedicated key for that bucket, if one was set.
2. **AssumeRole** — when a role ARN is configured. Scoped and expiring.
3. **GetFederationToken** — the default. Scoped and expiring.
4. **Static deployment key** — the fallback, and never handed to a viewer: IAM
   cannot scope or expire it, so read-only access it cannot enforce is refused
   with an actionable error rather than quietly over-granted.

Custom endpoints (R2, MinIO, Spaces) have no STS, so they go straight to rung 4
under the same rule.

### Authorize → filter → presign

Every list read follows that order. Rows are authorized first, filtered to what
the viewer may see, and only *then* presigned — so a URL is never minted for a
file the caller was not entitled to.

## The desktop app

```bash
cd desktop
npm install
npm run tauri:dev
```

It mounts through `rclone nfsmount` against macOS's built-in NFS client — no
macFUSE, no kernel extension approval, no reboot. rclone ships inside the
bundle. Browsing works without a mount at all, because the client also speaks S3
directly.

Sign-in is a browser PKCE hand-off over the `onyxfs://` scheme, with a typed
pairing code as the fallback for when a custom scheme cannot survive the round
trip. Tokens are stored in the system keychain and hashed at rest server-side;
the allowlist is re-checked on **every** request, so revoking someone cuts off
their desktop within one request rather than at token expiry.

### Before the first release

Two things are deliberately left unset, because they are yours to generate:

1. **Update signing key.** `tauri.conf.json` ships with `updater.active: false`
   and an empty `pubkey`. Run `npm run tauri signer generate`, put the public
   key in the config, keep the private key in CI, then set `active: true`.
   ARMRA's key was removed rather than carried over — verifying updates against
   a keypair you do not hold would reject every release you ship.
2. **The rclone sidecar.** `src-tauri/binaries/` is gitignored. Drop the rclone
   binary for each target there, named with the target triple, before bundling.

## Where this came from

Onyx is a rebuild of the file half of ARMRA Quest and ARMRA Space, reduced to
what a file workspace needs. The chassis is carried over largely intact — the
brand layer, the config override, the flags, the credential ladder, the desktop
auth flow — and the ~90 pages of creative tooling around it are not.

Notes worth keeping from that codebase, which the comments here preserve in
place: send magic-link mail with both an HTML and a plain-text part and never
print the raw callback URL in the body; move a trashed object out of its prefix
so it also leaves the mounted drive; and write the catalog row yourself after an
upload rather than trusting the storage to describe what landed.
