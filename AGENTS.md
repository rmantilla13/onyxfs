# Working in this repo

Onyx is a web control plane (repo root) plus a Tauri desktop client
(`desktop/`). Read `README.md` first — it explains the control-plane /
data-plane split that the rest of the design follows from.

## Conventions that are load-bearing

**No migrations.** Tables are created lazily by `ensure*Table()` guards in
`lib/db.js`. To add a column, add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
to the relevant guard. Because rows already exist, every change must be
backward-compatible: no new NOT NULL without a default, no renames. After
changing DDL, regenerate `db/init.sql` rather than editing it — it is derived
from these guards.

**Nothing middleware imports may reach `lib/db.js`.** middleware.js runs on the
Edge runtime, which has no TCP sockets, and the Postgres driver needs them.
Pulling the driver into that bundle builds cleanly and then fails at runtime on
every request. This is why the auth config is split: `auth.config.js` is
Edge-safe and is what middleware builds from; `auth.js` adds the adapter and
the email provider for Node contexts. Put anything that needs the database in a
route handler or server component, never in middleware or auth.config.js. After
changing either, check with:

```bash
npx next build && grep -c postgres .next/server/middleware.js   # must be 0
```

**Queries use tagged-template SQL**, not an ORM. Drizzle appears only in
`lib/schema.js`, only for Auth.js's four tables, because its adapter requires
real Drizzle objects. Do not query app tables through it.

**Read paths go authorize → filter → presign, in that order.** Never presign
before filtering; that mints a URL for a row the caller may not be entitled to.

**Drives are boundaries.** A file stored under a filespace's prefix belongs to
that drive's members (`lib/drive-access.js`): members read, editors and owners
write, everyone else sees nothing but a file shared with them directly. The
listing query, `canAccessFile`, `modifiableFileIds` and every route that writes
under a prefix (`getFilespaceForWrite`) apply it — a new read or write path
must too.

**Enforce feature flags on the server.** A flag that changes behaviour must be
read server-side, not passed in by the client. `DELETE /api/files/[id]` is the
reference case: it reads the `trash` flag itself rather than taking a parameter.

**Never render `BRAND` directly.** Go through `resolveBrand()` / `loadBrand()`,
and style from the CSS custom properties the root layout emits. Hardcoding a
colour or the name "Onyx" in a component breaks the white-label layer — and
dark mode, which swaps those same properties under `[data-theme='dark']`.

**Roles subtract, never add.** `effectiveFlags()` narrows the global flag map;
a role must not be able to enable something the platform has off. Admin access
is env-gated (`ADMIN_EMAILS`) on purpose — keep it independent of roles.

**Secrets never reach the client.** `listConfigKeys()` returns presence and
source only. `sanitizeStorageConfig()` strips the secret key. Keep it that way.

## Checks

```bash
npm run dev:local                  # the app on local Postgres + S3; sign-in links print to the terminal
npm test                           # unit tests, no database needed
npm run build                      # web — the real check; JSX errors surface here
npm run doctor                     # creates the schema and verifies a live database
cd desktop && npm run build        # tsc -b && vite build
cd desktop/src-tauri && cargo check
```

`grep -c postgres .next/server/middleware.js` must print **0** after a build.
Anything else means the Postgres driver has been pulled into the Edge bundle,
which builds cleanly and then fails on every request. See auth.config.js.

Some storage tests want a real S3 API and **skip** when none is listening, so
a green run does not necessarily mean they ran:

```bash
pip install 'moto[server]' && python -m moto.server -p 5111
npm test                           # test/storage-move.test.js now exercises real moves
```

They are worth starting before touching anything that computes an object key.
A mock would agree with whatever key we compute; the point is to check the
object actually lands there and the old one is gone.

`cargo check` needs GTK dev packages on Linux and a file at
`src-tauri/binaries/rclone-<target-triple>` (the bundler wants the sidecar to
exist; a stub is fine for a type-check). The app itself targets macOS.

## Things to leave alone unless asked

- The `onyxfs://` scheme is compiled into the desktop bundle and registered with
  the OS. Changing it in `lib/brand.js` alone silently breaks browser hand-off —
  it must match `desktop/src-tauri/tauri.conf.json`.
- `AUTH_SECRET` and `DATABASE_URL` are in `LOCKED_KEYS` (`lib/config.js`) and
  must stay there. Overriding either from a table read through them is circular.
- The magic-link email sends both HTML and plain-text parts and keeps the raw
  URL out of the body. Both are deliberate anti-spam-filter measures.
