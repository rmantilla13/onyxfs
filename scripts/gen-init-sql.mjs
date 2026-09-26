#!/usr/bin/env node
//
// scripts/gen-init-sql.mjs — write db/init.sql from the guards in lib/db.js.
//
//   npm run schema:sql            regenerate db/init.sql
//   npm run schema:sql -- --check exit 1 if db/init.sql is not what the guards produce
//
// db/init.sql has always said it is generated from the statements lib/db.js
// executes. It was not: it was a copy kept in step by hand, and two branches
// that each added a column both edited the same few lines of it. Now it is
// captured, not copied:
//
//   1. create an EMPTY scratch database, with a random name
//   2. load lib/db.js against it with ONYX_SCHEMA_CAPTURE=1, which hands the
//      text of every statement the driver sends to a list (captureHook)
//   3. run ensureSchema() — every guard, in the order the app runs them
//   4. keep the DDL (CREATE and ALTER), write it out with a header and a
//      statement count, and drop the scratch database whatever happened
//
// Empty matters. ensureFileIndexes skips an index that already exists, and a
// statement that is never sent is never captured — so the scratch database
// is made fresh on every run rather than reused.
//
// WHERE IT RUNS. The Postgres server named by SCHEMA_SQL_SERVER_URL: a
// connection string to any database on a server you control, used only to
// CREATE and DROP the scratch database. Unset, it is the `npm run dev:local`
// cluster (127.0.0.1:55432), whose `onyx` database this never opens — it
// only adds and removes its own `onyx_schema_<random>` beside it.
//
// A throwaway server does just as well, and is what to use when the dev
// cluster is not running. Any Postgres 13+ (DROP DATABASE … WITH (FORCE));
// on macOS, export LC_ALL=en_US.UTF-8 first or the postmaster refuses to
// start ("became multithreaded during startup"):
//
//   initdb -D /tmp/onyx-schema -U postgres --auth=trust
//   pg_ctl -D /tmp/onyx-schema -o "-p 56432 -k /tmp" -l /tmp/onyx-schema.log start
//   SCHEMA_SQL_SERVER_URL=postgresql://postgres@127.0.0.1:56432/postgres npm run schema:sql
//   pg_ctl -D /tmp/onyx-schema stop && rm -rf /tmp/onyx-schema
//
// The role needs CREATEDB, and CREATE EXTENSION for pg_trgm; without the
// extension the trigram index is left out of the file, as the app leaves it
// out of the database.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'db', 'init.sql');
const DEV_LOCAL_SERVER = 'postgresql://postgres@127.0.0.1:55432/postgres';
const check = process.argv.includes('--check');

const HEADER = `-- db/init.sql — OPTIONAL, and GENERATED: run \`npm run schema:sql\`, never edit.
--
-- Onyx creates every table lazily, on first use, from the ensure*Table()
-- guards in lib/db.js. A fresh database self-assembles on the first request
-- and no migration step is needed to deploy.
--
-- This file exists for the case where you would rather have the whole schema
-- up front: run it once in the SQL editor and the guards become no-ops. It is
-- captured from the statements those guards send to an empty database
-- (scripts/gen-init-sql.mjs), so the two agree by construction. The large-
-- library indexes the app builds CONCURRENTLY appear here in the plain form,
-- which on a fresh database is instant.
--`;

/** The statement as written in the guard, without the template's indentation. */
export function dedent(text) {
  const lines = String(text).replace(/\t/g, '  ').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return '';
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(Math.min(pad, l.length - l.trimStart().length))).join('\n');
}

/** Captured statements → the DDL, once each, in the order it ran. */
export function schemaStatements(captured) {
  const out = [];
  const seen = new Set();
  for (const raw of captured) {
    let text = dedent(raw).replace(/;\s*$/, '');
    if (!/^(CREATE|ALTER)\s/i.test(text)) continue;
    // Built CONCURRENTLY by the app so a large table keeps taking writes; on
    // a database being set up from this file there is nothing to wait for.
    text = text.replace(/^CREATE INDEX CONCURRENTLY /i, 'CREATE INDEX ');
    const key = text.replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function renderInitSql(statements) {
  return `${HEADER}\n-- Statements: ${statements.length}\n\n${statements.map((s) => `${s};`).join('\n\n')}\n`;
}

function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function main() {
  const server = process.env.SCHEMA_SQL_SERVER_URL || DEV_LOCAL_SERVER;
  const scratch = `onyx_schema_${randomBytes(6).toString('hex')}`;
  const admin = postgres(server, { max: 1, onnotice: () => {} });

  try {
    await admin.unsafe(`CREATE DATABASE ${scratch}`);
  } catch (e) {
    await admin.end({ timeout: 5 }).catch(() => {});
    console.error(`\n  Could not create a scratch database on ${new URL(server).host}: ${e.message}`);
    if (!process.env.SCHEMA_SQL_SERVER_URL) {
      console.error('  Start the dev cluster with `npm run dev:local`, or point SCHEMA_SQL_SERVER_URL at a server you control.');
      console.error('  scripts/gen-init-sql.mjs shows how to start a throwaway one.\n');
    }
    process.exit(1);
  }

  let statements;
  try {
    // lib/db.js reads its connection string and the capture switch when it
    // loads, so both are set before the import, never after.
    process.env.DATABASE_URL = withDatabase(server, scratch);
    delete process.env.POSTGRES_URL;
    process.env.ONYX_SCHEMA_CAPTURE = '1';
    globalThis.__onyxSchemaCapture = [];
    const db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    const failed = results.filter((r) => !r.ok);
    await db.sql.end({ timeout: 5 }).catch(() => {});
    if (failed.length) {
      throw new Error(`guards failed on an empty database — fix them before generating:\n${failed.map((f) => `    ${f.label}: ${f.error}`).join('\n')}`);
    }
    statements = schemaStatements(globalThis.__onyxSchemaCapture);
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch((e) => {
      console.warn(`  Could not drop the scratch database ${scratch}: ${e.message}`);
    });
    await admin.end({ timeout: 5 }).catch(() => {});
  }

  const next = renderInitSql(statements);
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch { /* first run */ }

  if (check) {
    if (current !== next) {
      console.error('  db/init.sql is out of date with the guards in lib/db.js. Run `npm run schema:sql`.');
      process.exit(1);
    }
    console.log(`  db/init.sql is current (${statements.length} statements).`);
    return;
  }
  writeFileSync(OUT, next);
  console.log(`  db/init.sql ${current === next ? 'unchanged' : 'written'} — ${statements.length} statements.`);
}

// Importable for its pure helpers (test/init-sql.test.js); runs only as a script.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  });
}
