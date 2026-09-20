#!/usr/bin/env node
//
// scripts/doctor.mjs — check the environment, create the schema, report what's
// missing. Run it before trusting a deployment:
//
//   npm run doctor
//
// It imports the REAL lib/db.js rather than a copy of its DDL, so warming the
// schema here exercises exactly the code path a request would. If the lazy
// ensure* guards are going to fail, they fail here with a readable message
// instead of on someone's first page load.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── .env.local ───────────────────────────────────────────────────────────────
// Loaded by hand rather than with --env-file so `npm run doctor` works with no
// extra flags, and so a missing file is a note rather than a crash.
function loadEnv() {
  for (const name of ['.env.local', '.env']) {
    try {
      const text = readFileSync(resolve(root, name), 'utf8');
      for (const line of text.split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let [, key, value] = m;
        value = value.trim().replace(/\s+#.*$/, '');
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
      }
      return name;
    } catch { /* try the next one */ }
  }
  return null;
}

const envFile = loadEnv();

// ── output ───────────────────────────────────────────────────────────────────
const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m' };
const paint = (c, s) => (process.stdout.isTTY ? `${c}${s}${C.reset}` : s);

let failures = 0;
let warnings = 0;

const ok = (label, detail = '') => console.log(`  ${paint(C.green, '✓')} ${label}${detail ? paint(C.dim, `  ${detail}`) : ''}`);
const warn = (label, detail = '') => { warnings++; console.log(`  ${paint(C.yellow, '!')} ${label}${detail ? paint(C.dim, `  ${detail}`) : ''}`); };
const fail = (label, detail = '') => { failures++; console.log(`  ${paint(C.red, '✗')} ${label}${detail ? paint(C.dim, `  ${detail}`) : ''}`); };
const section = (t) => console.log(`\n${paint(C.bold, t)}`);

// ── 1. Environment ───────────────────────────────────────────────────────────
section('Environment');
console.log(paint(C.dim, `  ${envFile ? `loaded ${envFile}` : 'no .env.local found — reading the process environment'}`));

const REQUIRED = [
  ['__CONNECTION__', 'Postgres connection string — DATABASE_URL or POSTGRES_URL'],
  ['AUTH_SECRET', 'session signing — openssl rand -base64 32'],
  ['RESEND_API_KEY', 'magic-link sign-in; without it nobody can sign in'],
];
const OPTIONAL = [
  ['NOTIFY_FROM', 'sender for the sign-in email'],
  ['ADMIN_EMAILS', 'defaults to the bootstrap admin in lib/auth-allowlist.js'],
  ['CRON_SECRET', '/api/cron/maintenance and /api/health when sign-in is broken'],
  ['NEXT_PUBLIC_APP_URL', 'used for share links and the magic-link email'],
  ['BLOB_READ_WRITE_TOKEN', 'fallback store; S3 is configured in Admin → Storage'],
];

// lib/db.js reads DATABASE_URL first and falls back to POSTGRES_URL, which is
// what the Supabase-Vercel integration injects. Report which one is actually
// in play: with two possible sources, "the connection string is set" is not
// enough to know which string is being used.
const CONNECTION_VAR = process.env.DATABASE_URL ? 'DATABASE_URL'
  : process.env.POSTGRES_URL ? 'POSTGRES_URL' : null;

for (const [key, why] of REQUIRED) {
  if (key === '__CONNECTION__') {
    if (CONNECTION_VAR) {
      ok(`connection string via ${CONNECTION_VAR}`);
      // The shadowing trap. Both set means DATABASE_URL wins, so an old or
      // hand-typed value silently overrides the one the integration manages —
      // and the integration keeps updating a variable nothing reads.
      if (process.env.DATABASE_URL && process.env.POSTGRES_URL
          && process.env.DATABASE_URL !== process.env.POSTGRES_URL) {
        warn('DATABASE_URL and POSTGRES_URL differ',
          'DATABASE_URL wins — the integration-managed POSTGRES_URL is being ignored');
      }
    } else {
      fail('no connection string', why);
    }
    continue;
  }
  process.env[key] ? ok(key) : fail(key, why);
}
for (const [key, why] of OPTIONAL) {
  process.env[key] ? ok(key) : warn(`${key} unset`, why);
}

if (CONNECTION_VAR) {
  try {
    const u = new URL(process.env[CONNECTION_VAR]);
    if (!/^postgres(ql)?:$/.test(u.protocol)) {
      fail(`${CONNECTION_VAR} protocol`, `expected postgres://, got ${u.protocol}`);
    } else {
      ok(`${CONNECTION_VAR} parses`, u.hostname);
      // The single most common Supabase-on-serverless mistake: using the
      // direct connection instead of the pooler. It works locally and then
      // exhausts the database's connection limit under real traffic, because
      // every serverless invocation opens its own socket.
      const port = u.port || '5432';
      if (u.hostname.includes('supabase')) {
        if (port === '6543' || u.hostname.includes('pooler')) {
          ok('using the connection pooler', `port ${port}`);
        } else {
          warn('this looks like the DIRECT connection', `port ${port} — use the pooler (6543) on serverless`);
        }
      }
      if (u.searchParams.get('pgbouncer') === 'true') {
        ok('pgbouncer flag set');
      }
    }
  } catch (e) {
    fail(`${CONNECTION_VAR} is not a valid URL`, e.message);
  }
}

if (failures) {
  console.log(`\n${paint(C.red, `${failures} required item(s) missing — fix those before the rest can run.`)}\n`);
  process.exit(1);
}

// ── 2. Connection ────────────────────────────────────────────────────────────
section('Database');

const { sql, ensureSchema } = await import(resolve(root, 'lib/db.js'));

try {
  const t0 = Date.now();
  const rows = await sql`SELECT version() AS v, current_database() AS db`;
  ok('connected', `${Date.now() - t0}ms · ${rows[0].db}`);
  console.log(paint(C.dim, `    ${String(rows[0].v).split(',')[0]}`));
} catch (e) {
  fail('cannot connect', e.message);
  console.log(`\n${paint(C.red, 'Connection failed — nothing below can run.')}\n`);
  process.exit(1);
}

// ── 3. Schema ────────────────────────────────────────────────────────────────
// Every table is created lazily by an ensure* guard the first time something
// touches it. Calling one read per guard warms the whole schema and, in doing
// so, smoke-tests each of those code paths.
section('Schema');

const db = await import(resolve(root, 'lib/db.js'));
// ensureSchema() runs the DDL regardless of SCHEMA_MANAGED — that flag turns
// the request-path guards off, and this is one of the places that takes over.
if (process.env.SCHEMA_MANAGED === '1') {
  console.log(paint(C.dim, '  SCHEMA_MANAGED=1 — request-path guards are off; applying DDL here instead'));
}
for (const r of await ensureSchema()) {
  r.ok ? ok(r.label) : fail(r.label, r.error);
}

const warmers = [
  ['settings', () => db.listSettings('')],
  ['files + acl', () => db.listFilesForUser({ limit: 1 }, { isAdmin: true })],
  ['folders', () => db.listFolderNames()],
  ['tombstones', () => db.listFileChanges({ cursor: 0, limit: 1 })],
  ['uploads', () => db.listUploads('doctor@example.com')],
  ['shares', () => db.getShareByToken('__doctor__')],
  ['filespaces', () => db.listFilespaces()],
  ['desktop tokens', () => db.listDesktopTokens('doctor@example.com')],
  ['invites', () => db.listInviteRequests({})],
  ['notifications', () => db.listNotifications('doctor@example.com', { limit: 1 })],
  ['user preferences', () => db.getUserPreferences('doctor@example.com')],
  ['magic links', () => db.getMagicLinkRedirect('__doctor__')],
];

for (const [label, run] of warmers) {
  try {
    await run();
    ok(label);
  } catch (e) {
    fail(label, e.message);
  }
}

// ── 4. What actually exists ──────────────────────────────────────────────────
section('Tables');

const EXPECTED = [
  'user', 'account', 'session', 'verificationToken',
  'settings', 'files', 'folders', 'folder_access', 'file_acl', 'file_shares',
  'file_tombstones', 'uploads', 'filespaces', 'filespace_access',
  'desktop_auth_codes', 'desktop_tokens', 'invite_requests',
  'notifications', 'notification_reads', 'user_preferences', 'magic_link_redirects',
];

try {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'`;
  const present = new Set(rows.map((r) => r.table_name));
  const missing = EXPECTED.filter((t) => !present.has(t));
  if (missing.length) {
    fail(`${missing.length} table(s) missing`, missing.join(', '));
  } else {
    ok(`all ${EXPECTED.length} tables present`);
  }
  const extra = [...present].filter((t) => !EXPECTED.includes(t));
  if (extra.length) console.log(paint(C.dim, `    also present: ${extra.join(', ')}`));
} catch (e) {
  fail('could not list tables', e.message);
}

// ── 5. The parts most likely to fail silently ────────────────────────────────
// These three are the reason this script exists. Each either works on first
// contact or fails in a way that is hard to diagnose from the UI.
section('Critical machinery');

try {
  const [{ exists }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'files' AND column_name = 'search_tsv'
    ) AS exists`;
  exists
    ? ok('full-text search column', 'generated, so it cannot drift from the row')
    : fail('files.search_tsv missing', 'search falls back to name matching only');
} catch (e) {
  fail('search column check', e.message);
}

try {
  await sql`SELECT last_value FROM files_change_seq`;
  ok('change sequence', 'delta sync and iOS enumeration depend on this');
} catch (e) {
  fail('files_change_seq missing', e.message);
}

try {
  const rows = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'files' AND indexname IN ('files_created_id_idx', 'files_search_idx', 'files_seq_idx')`;
  const found = rows.map((r) => r.indexname);
  found.length === 3
    ? ok('keyset + search indexes', found.join(', '))
    : warn(`${found.length}/3 indexes present`, `found: ${found.join(', ') || 'none'}`);
} catch (e) {
  warn('index check failed', e.message);
}

// A real round trip through the query builder — the listing is the one read
// path everything else depends on.
try {
  const t0 = Date.now();
  const page = await db.listFilesForUser({ limit: 5, withTotal: true }, { isAdmin: true });
  ok('listing query', `${Date.now() - t0}ms · ${page.total ?? 0} file(s)`);
} catch (e) {
  fail('listing query', e.message);
}

// ── 6. Ready for Phase 2 ─────────────────────────────────────────────────────
section('Phase 2 readiness');

try {
  const rows = await sql`SELECT default_version, installed_version FROM pg_available_extensions WHERE name = 'vector'`;
  if (!rows.length) {
    warn('pgvector unavailable', 'semantic search needs it — enable it in the dashboard');
  } else if (rows[0].installed_version) {
    ok('pgvector installed', `v${rows[0].installed_version}`);
  } else {
    ok('pgvector available', `v${rows[0].default_version} — not yet enabled, Phase 2 will CREATE EXTENSION`);
  }
} catch (e) {
  warn('pgvector check failed', e.message);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures) {
  console.log(paint(C.red, `${failures} failure(s), ${warnings} warning(s).`));
  process.exit(1);
}
console.log(paint(C.green, `Healthy${warnings ? ` — ${warnings} warning(s), none blocking` : ''}.`));
console.log(paint(C.dim, '\nNext: npm run dev, sign in, then Admin → Storage to connect a bucket.\n'));
