// lib/db.js — Onyx's data layer.
//
// Postgres over postgres.js, addressed with tagged-template SQL.
// There is no migration tool and no schema file: every table is created lazily,
// on first touch, by an `ensure*Table()` guard that runs `CREATE TABLE IF NOT
// EXISTS` once per warm instance. Adding a column means adding an `ALTER TABLE
// ... ADD COLUMN IF NOT EXISTS` line to that guard.
//
// The trade: deploys never need a migration step and a fresh database
// self-assembles on first request, but the schema lives in code rather than in
// a versioned ledger, so column changes must stay backward-compatible with rows
// already in the table. `db/init.sql` mirrors the same DDL for anyone who would
// rather create everything up front.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as authSchema from './schema.js';
import { mergeFlags } from './features.js';
import { principalHasCap } from './roles.js';
import { buildFileQuery, buildDeltaQuery, buildFolderCountQuery, nextCursor, FILE_COLUMNS } from './file-query.js';
import { escapeLike, rebase } from './folder-ops.js';
import { newShareToken, hashSharePassword, verifySharePassword, MAX_PASSWORD_FAILURES, PASSWORD_LOCK_MS } from './shares.js';
import { driveAccess, drivePatterns, canWriteDrive } from './drive-access.js';
import { createHash } from 'node:crypto';
import { avatarPath } from './avatars.js';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!connectionString) {
  console.warn('[db] No DATABASE_URL or POSTGRES_URL set. Connect Postgres and redeploy.');
}

/**
 * Is there a connection string at all, and which variable supplied it?
 *
 * Exported because three places need to agree on the answer and each used to
 * spell out `DATABASE_URL || POSTGRES_URL` for itself: this module, the health
 * check, and the sign-in action. `which` matters more than it looks — the
 * fallback means a deployment can run happily on POSTGRES_URL while everyone
 * assumes DATABASE_URL is doing the work, and deleting "the redundant one" is
 * then an outage. That is not hypothetical; it is what happened here.
 *
 * Reads process.env live rather than closing over the const above, so an
 * admin-panel override (lib/config.js writes into process.env) is seen.
 */
export function hasConnectionString() {
  const which = process.env.DATABASE_URL ? 'DATABASE_URL'
    : process.env.POSTGRES_URL ? 'POSTGRES_URL'
    : null;
  return { ok: !!which, which };
}

// Build the client defensively. A malformed connection string throws
// synchronously, and this module is imported by auth.js — the Auth.js root —
// so that throw would take down auth initialization and reach users as an
// opaque "Configuration" error page. Defer the failure to query time instead,
// where it lands in the logs with a message that says what to fix and
// /api/health can report it.
//
// ── Serverless connection settings ──────────────────────────────────────────
// These four matter on Vercel and are easy to get wrong:
//
//   prepare: false   Supabase's pooler (Supavisor) in TRANSACTION mode does not
//                    support prepared statements — a connection is handed to a
//                    different client between statements, so a prepared plan
//                    from one is not there for the next. Leaving this on
//                    produces intermittent "prepared statement does not exist"
//                    errors under concurrency, which look like flakes.
//
//   max: 1           Each serverless invocation is its own process. A pool of
//                    N per invocation multiplied by concurrent invocations
//                    exhausts the pooler's connection limit quickly. One
//                    connection per invocation is the safe shape. (The Auth.js
//                    adapter has a second, opened only when it queries — see
//                    getDb.)
//
//   max_pipeline: 0  max: 1 does NOT serialize a Promise.all. postgres.js
//                    pipelines: it writes a second query onto the socket while
//                    the first is still running. Supavisor in transaction mode
//                    never answers a statement pipelined behind a finished
//                    one, so the promise waits until its deadline. That was the
//                    /api/files hang: the folder count and listAllTags' listing
//                    go out together, and the listing timed out "executing on
//                    the server" on a one-row table. 0 sends one statement at
//                    a time. Nothing here uses sql.begin, which 0 would break
//                    (porsager/postgres#1210).
//
//   idle_timeout     Release the connection rather than holding it for the
//                    lifetime of a warm lambda.
//
// The connection string must be the POOLER url (port 6543), not the direct
// one (5432). The direct connection is a real Postgres socket per invocation
// and will exhaust the database's limit under any real traffic.
/**
 * Say, once per instance, what we are actually dialling.
 *
 * Production reached a state where every query timed out but nothing
 * errored: /api/files answered 200 with an empty library because the read
 * blew its deadline. Timeouts that land exactly on the deadline, on every
 * query including SELECT 1, are the signature of time spent GETTING a
 * connection rather than running a statement — and the commonest cause by
 * far is a connection string pointed at Postgres directly instead of at the
 * pooler.
 *
 * That fact is invisible from the outside: DATABASE_URL is a secret, so the
 * one number that decides this (the port) cannot be read from the Vercel
 * dashboard without decrypting it. So the app reports it itself. Host and
 * port are not secrets; the user and password are never touched.
 */
/**
 * Does this text look like documentation that was pasted as a value?
 *
 * Worth naming explicitly: the difference between "that hostname is wrong" and
 * "the '…' you can see is not part of it" is the difference between a
 * half-hour and ten seconds.
 */
function placeholderHint(text) {
  if (!/[…<>]|\.\.\./.test(String(text || ''))) return '';
  return ' It looks like a placeholder from documentation was copied literally —'
       + ' the "…", "..." or "<...>" is not part of the real value.';
}

export function describeConnection(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    // Not silent: a string this broken produced a bare "unparseable" line and
    // no advice, which says nothing a person can act on. Angle brackets are
    // rejected outright by the URL parser, so "<region>.pooler.supabase.com"
    // lands here rather than in the hostname check below.
    return {
      label: 'unparseable connection string',
      warn: 'The connection string is not a valid URL, so no connection is possible.'
          + placeholderHint(raw)
          + ' It should look like postgresql://user:password@host:6543/postgres —'
          + ' copy it from the provider console rather than retyping it.',
    };
  }

  const host = u.hostname;
  const port = u.port || '5432';
  const params = [...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || 'none';

  // A hostname that cannot resolve, checked before anything classifies it.
  //
  // This check exists because the classification below is suffix-based, and a
  // suffix match is happy with a host that DNS will never accept. A connection
  // string was once configured as "…pooler.supabase.com" — the horizontal
  // ellipsis from a piece of documentation, pasted as a literal character —
  // and this function reported "Supabase pooler, transaction mode" with no
  // warning, a clean bill of health for a name that could only ever produce
  // ENOTFOUND. Same shape as trusting an S3 endpoint because it contains the
  // word "backblazeb2": the substring matched and the resolver disagreed.
  //
  // WHATWG URL percent-encodes anything not permitted in a host, so a '%' here
  // is a precise signal rather than a guess.
  if (host.includes('%')) {
    let decoded = host;
    try { decoded = decodeURIComponent(host); } catch { /* keep the raw form */ }
    return {
      label: `${host}:${port} — INVALID hostname, cannot resolve; params: ${params}`,
      warn: `The hostname "${decoded}" contains characters that are not valid in a DNS name, `
          + 'so every connection will fail with ENOTFOUND.'
          + placeholderHint(decoded)
          + ' Copy the connection string from the provider console rather than retyping it.',
    };
  }

  // Supabase gives out three URLs and only one of them belongs in a lambda.
  const pooled = /pooler\.supabase\.com$/i.test(host);
  const directSupabase = /^db\..+\.supabase\.(co|net)$/i.test(host);

  let kind = 'postgres';
  let warn = null;
  if (pooled && port === '6543') kind = 'Supabase pooler, transaction mode';
  else if (pooled && port === '5432') {
    kind = 'Supabase pooler, SESSION mode';
    warn = 'Session mode holds one server connection per client for the whole session. '
         + 'Serverless opens a client per invocation, so the pool is exhausted under very '
         + 'little traffic and later connections wait. Use port 6543 (transaction mode).';
  } else if (pooled) kind = `Supabase pooler on an unexpected port (${port})`;
  else if (directSupabase) {
    kind = 'Supabase DIRECT connection';
    // The first sentence used to be about connection limits. That is true but
    // it is not what happens: this hostname publishes no A record at all.
    // Supabase moved direct connections to IPv6-only (IPv4 is a paid add-on)
    // and Vercel's functions are IPv4-only, so the name does not resolve and
    // every query dies at getaddrinfo — which reads as the database being
    // down rather than as the wrong URL being used. Lead with the real cause.
    warn = 'On an IPv4-only platform — Vercel included — this will not resolve at all: '
         + 'Supabase publishes no A record for db.<ref>.supabase.co (direct connections '
         + 'are IPv6-only unless the IPv4 add-on is enabled), so every query fails with '
         + 'ENOTFOUND. Where it does resolve it is still wrong for serverless, because '
         + 'each invocation opens a real Postgres connection and the limit is reached at '
         + 'low traffic. Use the transaction pooler: host aws-0-<region>.pooler.supabase.com, '
         + 'port 6543, username postgres.<ref>. Copy it from Supabase → Connect; do not retype it.';
  }

  return { label: `${host}:${port} — ${kind}; params: ${params}`, warn };
}

/**
 * Stand-in for a client that cannot exist, so the failure is the configured
 * message wherever it is hit. It has to answer `.unsafe` and `.begin` as well
 * as being callable: half this module reaches for `sql.unsafe`, and
 * "sql.unsafe is not a function" says nothing about the missing DATABASE_URL
 * that actually caused it.
 */
function unusableClient(message) {
  const fail = () => { throw new Error(message); };
  fail.unsafe = fail;
  fail.begin = fail;
  fail.file = fail;
  fail.end = async () => {};
  fail.options = {};
  return fail;
}

// `npm run schema:sql` (scripts/gen-init-sql.mjs) writes db/init.sql from
// the statements the guards below actually send, rather than from a copy
// someone kept in step by hand. With ONYX_SCHEMA_CAPTURE=1 every client this
// module makes — the index builder's own connection included — hands each
// statement's text to a list the script reads back. Off, it is not attached
// at all, so nothing on a real request pays for it.
function captureHook() {
  if (process.env.ONYX_SCHEMA_CAPTURE !== '1') return {};
  return {
    debug: (_connection, text) => {
      (globalThis.__onyxSchemaCapture ||= []).push(String(text));
    },
  };
}

function createSqlClient() {
  if (!connectionString) {
    return unusableClient('Database is not configured — set DATABASE_URL and redeploy. See /api/health.');
  }
  try {
    return postgres(connectionString, {
      ...captureHook(),
      prepare: false,
      max: 1,
      max_pipeline: 0,
      idle_timeout: 20,
      connect_timeout: 15,
      // postgres.js rejects an `undefined` parameter outright, where the
      // previous driver coerced it. Mapping it to NULL keeps every
      // `${maybeMissing}` in this file behaving the way it was written, rather
      // than turning a missing optional field into a runtime error.
      transform: { undefined: null },
      // CREATE … IF NOT EXISTS on an existing object raises a NOTICE, and
      // postgres.js prints each one as a multi-line object. That is the
      // guards working as intended and it swamps the Vercel log with noise
      // that reads like an error. Keep anything stronger than NOTICE.
      onnotice: (n) => {
        if (n.severity && n.severity !== 'NOTICE' && n.severity !== 'INFO' && n.severity !== 'DEBUG' && n.severity !== 'LOG') {
          console.warn(`[db] ${n.severity}: ${n.message}`);
        }
      },
    });
  } catch (e) {
    console.error('[db] postgres() init failed:', e.message);
    return unusableClient(`Database connection string is invalid: ${e.message}`);
  }
}

// ── Query deadlines ─────────────────────────────────────────────────────────
// A statement that blocks on a lock, or a socket that died while the lambda
// was frozen, otherwise waits until Vercel kills the invocation at 300s. That
// is what a 504 on /signin looked like in production: two NOTICEs from the
// settings DDL, then silence. The reads on every render's path race a timer
// instead; on expiry the statement is cancelled server-side and the caller's
// existing fallback (brand defaults, an empty list) takes over.
//
// postgres.js queries are thenables that carry `.cancel()`, so the race is
// enough — no per-connection statement_timeout, which the pooler's
// transaction mode would not reliably keep between statements anyway.
export const QUERY_DEADLINE_MS = 15_000;

// The render path is not allowed to wait fifteen seconds. Every page reads
// the brand config through getSetting, so that read gets a deadline short
// enough that a struggling database costs a visibly slow page rather than a
// page that looks hung.
export const RENDER_DEADLINE_MS = 4_000;

export function withDeadline(query, ms = QUERY_DEADLINE_MS, label = 'query') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { query.cancel?.(); } catch { /* best effort */ }
      reject(new Error(`[db] ${label} exceeded ${ms}ms and was cancelled`));
    }, ms);
  });
  return Promise.race([query, deadline]).finally(() => clearTimeout(timer));
}

// ── A deadline on EVERY query, not the five I happened to guard ─────────────
//
// Production ran 36 gateway timeouts in three hours, spread across every
// route that touches Postgres — /api/files, the admin routes, the magic-link
// /verify pages, and /api/health, whose only statement is SELECT 1. Every one
// of them sat for the full 300 seconds before Vercel killed the invocation.
//
// The mechanism is serverless plus a pooled connection. Vercel freezes an idle
// lambda with its socket to Supavisor still open. The pooler times that
// connection out from its side. On thaw the lambda writes into a socket whose
// peer is gone and waits for a reply that cannot arrive; TCP keepalive
// notices eventually, and eventually is minutes. With `max: 1` there is one
// connection per invocation, so every later query in the same request queues
// behind the wedged one.
//
// `withDeadline` above already existed and was applied to five queries: the
// ones whose timeouts I had actually seen in a log. The other 189 were
// unbounded. Guarding call sites one at a time cannot work — the next query
// anyone adds is unguarded again, and which query wedges is a property of
// when the lambda thawed, not of the query.
//
// So the deadline moves to the driver, where it is one decision instead of
// 194. A query is armed when it is AWAITED, which matters: a fragment —
// sql`AND kind = ${k}` interpolated into another template, as the file query
// builder does throughout — is never awaited and so is never armed, and goes
// on behaving as a fragment.
//
// On expiry: cancel the statement server-side (best effort — if the socket is
// the problem, the cancel travels on a new one) and reject, so the caller's
// existing error handling runs at 15s with a message naming the statement,
// instead of the platform's 300s with nothing.

/** Shorten a statement to something that identifies it in a log line. */
function statementLabel(args) {
  const first = args && args[0];
  const text = Array.isArray(first) ? first.join(' ? ') : typeof first === 'string' ? first : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? (flat.length > 72 ? `${flat.slice(0, 72)}…` : flat) : 'query';
}

/**
 * Attach a deadline to a postgres.js Query, in place.
 *
 * In place, rather than wrapping: `.values()`, `.raw()` and `.simple()` all
 * return `this`, and drizzle's postgres-js driver chains `.values()` onto the
 * query it gets back. Mutating the instance keeps every one of those working
 * — only `then`/`catch`/`finally` are shadowed.
 */
let queriesSettled = 0;
let firstSettleMs = null;
const instanceStart = Date.now();

function armDeadline(query, ms, label) {
  if (!query || typeof query.then !== 'function' || typeof query.cancel !== 'function') return query;

  let raced = null;
  const begin = () => {
    if (raced) return raced;
    // Query#then triggers execution via handle(); we bypass it below, so call
    // it here or the statement is never sent.
    try { query.handle(); } catch { /* handle() is idempotent and async */ }

    const underlying = Promise.prototype.then.call(query, (v) => v);
    // After the deadline fires nobody is awaiting `underlying` any more, but
    // the statement still settles — usually as a cancellation error. Without
    // a handler that is an unhandled rejection, which Node may treat as fatal.
    Promise.prototype.then.call(underlying, undefined, () => {});

    const t0 = Date.now();
    let timer;
    const bell = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // A timeout on an instance that has never completed a query is a
        // different fault from one on an instance that was working a moment
        // ago: the first is "cannot get a connection", the second is "the
        // database got slow". Without this the log cannot tell them apart,
        // and they have nothing in common but the symptom.
        // WHERE the time went, which is the whole question once the data is
        // ruled out — a one-row table cannot take fifteen seconds to read.
        //
        // postgres.js sets `state` when it hands a query to a connection and
        // `active` while that query is the one the server is working on. It
        // also PIPELINES: a query behind a slow one is written to the socket
        // immediately rather than held back, so "queued" and "sent" are not
        // opposites here. The three states, verified against a real server:
        //
        //   no state        never reached a connection — none was available.
        //                   Nothing to do with the query or the data.
        //   state, !active  written to the connection, waiting behind earlier
        //                   statements in the same session. With max: 1 this
        //                   is head-of-line blocking: something in front is
        //                   slow and this is paying for it.
        //   state, active   the server really is taking this long on it.
        const reached = !query.state
          ? 'NEVER REACHED A CONNECTION — none was available'
          : query.active
            ? 'executing on the server'
            : 'waiting behind an earlier statement on the same connection (head-of-line)';
        reject(new Error(
          `[db] ${label} exceeded ${ms}ms and was cancelled `
          + `[${reached}] `
          + `(${queriesSettled} queries have succeeded on this instance`
          + `${firstSettleMs == null ? ', none yet — this looks like connecting, not querying'
                                     : `, first took ${firstSettleMs}ms`}`
          + `; instance is ${Date.now() - instanceStart}ms old)`,
        ));

        // Cancel AFTER rejecting, not before.
        //
        // postgres.js's cancel() rejects a QUEUED query synchronously, inside
        // the call — so cancelling first meant the underlying promise settled
        // before the line above ran, and Promise.race handed the caller
        // "canceling statement due to user request" instead of this message.
        // The deadline is the decision; the cancel is cleanup, and cleanup
        // does not get to overwrite the diagnosis. This showed up as an
        // intermittent test failure, which is the only reason it was found:
        // in production it would just have been a less useful log line, now
        // and then, with nothing to say it had happened.
        try { query.cancel(); } catch { /* best effort */ }
      }, ms);
    });

    raced = Promise.race([underlying, bell]);
    raced.then(
      () => {
        clearTimeout(timer);
        queriesSettled += 1;
        if (firstSettleMs == null) {
          firstSettleMs = Date.now() - t0;
          // The first query of an instance pays for the TCP handshake, TLS and
          // the pooler's own connect. Worth knowing on its own: if THIS is the
          // slow one and later queries are fast, the fault is the connection.
          console.log(`[db] first query on this instance settled in ${firstSettleMs}ms (includes connect)`);
        }
      },
      () => clearTimeout(timer),
    );
    return raced;
  };

  query.then = (ok, err) => begin().then(ok, err);
  query.catch = (err) => begin().then(undefined, err);
  query.finally = (fn) => begin().finally(fn);
  return query;
}

/**
 * Wrap a postgres.js client so everything it issues carries `ms`.
 *
 * A Proxy rather than a replacement object: postgres.js hangs a lot off the
 * client (`options`, `array`, `json`, `types`, `end`) and drizzle reads some
 * of it. Only the two call shapes this codebase uses — the tagged template
 * and `.unsafe()` — are intercepted; everything else passes through.
 */
export function withQueryDeadlines(raw, ms) {
  if (typeof raw !== 'function') return raw;
  const cache = new Map();
  return new Proxy(raw, {
    apply(target, thisArg, args) {
      return armDeadline(Reflect.apply(target, thisArg, args), ms, statementLabel(args));
    },
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (cache.has(prop)) return cache.get(prop);
      const fn = prop === 'unsafe' || prop === 'file'
        ? (...a) => armDeadline(value.apply(target, a), ms, statementLabel(a))
        : value.bind(target);
      cache.set(prop, fn);
      return fn;
    },
  });
}

// Every query this module issues, armed. Drizzle's client (see getDb) is
// armed the same way, so the Auth.js adapter's reads are bounded too — those
// sit on the sign-in path, which is where a hang is most expensive.
const sql = withQueryDeadlines(createSqlClient(), QUERY_DEADLINE_MS);

if (connectionString) {
  const { label, warn } = describeConnection(connectionString);
  console.log('[db] target:', label);
  if (warn) console.warn('[db] WARNING:', warn);

  // The shadowing trap. The Supabase-Vercel integration creates and keeps
  // updating POSTGRES_URL; the line above prefers DATABASE_URL. With both set
  // and different, DATABASE_URL wins silently and forever — including through
  // a credential rotation that only POSTGRES_URL receives. scripts/doctor.mjs
  // has warned about this locally for a while; nothing warned in production,
  // which is the only place the integration actually writes the variable.
  if (process.env.DATABASE_URL && process.env.POSTGRES_URL
      && process.env.DATABASE_URL !== process.env.POSTGRES_URL) {
    console.warn(
      '[db] WARNING: DATABASE_URL and POSTGRES_URL are both set and differ. '
      + 'DATABASE_URL is the one in use; the integration-managed POSTGRES_URL is '
      + 'ignored and will keep drifting. To resolve it, confirm DATABASE_URL '
      + 'holds a working pooler string FIRST, then remove POSTGRES_URL — the '
      + 'other order removes the only connection string a deployment has.',
    );
  }
}

export { sql };

// ── Lazy schema guards ──────────────────────────────────────────────────────
// Every table below is created by one of these on first touch. The guard
// memoizes the IN-FLIGHT promise, not a boolean set afterwards: with a flag,
// two concurrent callers on a cold instance (generateMetadata and the page
// both loading the brand, say) each ran the DDL, and every request logged the
// same NOTICE twice. Now the second caller awaits the first's promise.
//
// A failure is logged, the memo is cleared so the next caller retries, and
// the promise resolves rather than rejects — the query that follows will fail
// with the real error if the table is genuinely absent, which is a clearer
// message than the DDL's. This matches what the try/catch in most of the old
// guards did, and what the settings path needs: a broken guard must degrade
// to defaults, not take down every render.
//
// ── Managed schema: the default in production ───────────────────────────────
// When managed, the guards below do nothing on the request path. The schema
// is owned by db/init.sql (run once) and by ensureSchema(), which the
// maintenance cron, /api/health and `npm run doctor` call explicitly.
//
// This is ON by default in production and OFF in development, which is the
// way round that matches what each is for. In development a fresh database
// self-assembling on first request is the whole point of the lazy guards. In
// production it is a liability: every cold start — every new lambda, and
// bots hitting /signin make plenty — issues a few dozen DDL statements
// before its first real query, and CREATE/ALTER take an ACCESS EXCLUSIVE
// lock on their table even when they change nothing. Concurrent cold starts
// then convoy on each other's locks with every real query queued behind.
//
// That is not a theory. Production logs showed one request running seven
// CREATE statements in a single second, and the next request, ten seconds
// later, timing out inside the same guards.
//
// SCHEMA_MANAGED=0 forces the old behavior back on if a deploy ever needs to
// bootstrap its own schema; SCHEMA_MANAGED=1 forces it off in development.
// A schema change is: edit the guard, add the line to db/init.sql, and run
// it — or hit the cron endpoint, which runs every guard either way.
function schemaManaged() {
  const flag = process.env.SCHEMA_MANAGED;
  if (flag) return /^(1|true|yes|on)$/i.test(flag);
  return process.env.NODE_ENV === 'production';
}
const SCHEMA_GUARDS = [];

export function lazySchema(label, run) {
  let inflight = null;
  function force(refresh = false) {
    if (refresh) inflight = null;
    if (inflight) return inflight;
    inflight = withDeadline(run(), QUERY_DEADLINE_MS * 2, label).catch((e) => {
      console.warn(`[${label}] failed:`, e.message);
      inflight = null;
      throw e;
    });
    return inflight;
  }
  function ensure() {
    if (schemaManaged()) return Promise.resolve();
    return force().catch(() => {});
  }
  SCHEMA_GUARDS.push({ label, force });
  ensure.force = force;
  return ensure;
}

/**
 * Run a query; if Postgres says a column does not exist, apply that table's
 * guard once and try again.
 *
 * The managed schema means production does not run DDL on the request path,
 * which is what keeps cold starts from convoying on locks. The cost is a
 * window: between deploying code that selects a new column and running the
 * migration, every query naming that column fails. That window took out the
 * whole file listing once — the code shipped, the ALTER had not been run, and
 * `column f.version does not exist` was the entire library.
 *
 * So the read path heals itself. 42703 is undefined_column and 42P01 is
 * undefined_table, which for this codebase mean exactly one thing: the guard
 * is ahead of the database — a column added, or a whole table a new release
 * reads before anyone ran `npm run doctor`. Apply it and retry. Anything else
 * rethrows — this must not become a blanket retry that hides a real error
 * behind a second attempt.
 *
 * `guard` may be a list, for a query that reads more than one table: each is
 * applied, in order, and they share one cooldown.
 */
// When the last repair for a guard was attempted, so a database that stays
// behind the code cannot turn every request into another round of DDL.
const repairAttempts = new Map();
const REPAIR_COOLDOWN_MS = 60_000;
const SCHEMA_BEHIND = new Set(['42703', '42P01']);

export async function withSchemaRetry(guard, run) {
  try {
    return await run();
  } catch (e) {
    if (!SCHEMA_BEHIND.has(e?.code)) throw e;
    const guards = (Array.isArray(guard) ? guard : [guard]).filter(Boolean);
    if (!guards.length) throw e;

    // `force()`, NOT `force(true)`. This mattered: force(true) clears the
    // memo, so every failing request started its OWN repair. On the day the
    // `files.version` column was missing, seventeen /api/files requests meant
    // seventeen ALTER TABLE statements, each wanting ACCESS EXCLUSIVE on
    // `files`. A pending ACCESS EXCLUSIVE request blocks every reader queued
    // behind it, so the self-heal became the outage: the reads it was meant
    // to rescue were the ones waiting on its lock. Without the refresh the
    // repair happens once per instance and later callers await that one.
    const key = guards[0];
    const last = repairAttempts.get(key);
    if (last && Date.now() - last < REPAIR_COOLDOWN_MS) {
      // Already tried recently and the column is still missing, so the repair
      // is not working. Surface the real error rather than queue more DDL.
      throw e;
    }
    repairAttempts.set(key, Date.now());

    console.warn('[db] schema is behind the code (%s) — applying the guard once and retrying', e.message);
    for (const g of guards) await g.force();
    return run();
  }
}

/**
 * Run every guard, SCHEMA_MANAGED or not, one at a time. For the cron, the
 * health check and the doctor — the places where DDL belongs. Returns one
 * row per guard so a caller can report which, if any, failed.
 */
export async function ensureSchema() {
  const results = [];
  const guards = [{ label: 'ensureAuthTables', force: () => ensureAuthTables(true) }, ...SCHEMA_GUARDS];
  for (const { label, force } of guards) {
    try {
      await force();
      results.push({ label, ok: true });
    } catch (e) {
      results.push({ label, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * A Drizzle handle over the same connection, used ONLY by Auth.js's
 * DrizzleAdapter (see lib/schema.js). Nothing in Onyx should query through
 * this — use the tagged-template `sql` above.
 *
 * Exposed as a factory rather than a value because drizzle-orm/postgres-js
 * inspects its client at construction: building it at module load would crash
 * whenever DATABASE_URL is absent, which is exactly the case the deferred
 * error above exists to survive, and would take the build down with it.
 *
 * Auth.js's adapter also sniffs this object to pick a SQL dialect, so it
 * cannot be handed a Proxy — the deferral has to happen one level up, around
 * the adapter itself (see auth.js).
 */
/** Whether a connection string exists at all — lets callers pick a real
 *  database path or a build-time stub without reaching into process.env. */
export function isDbConfigured() {
  return !!connectionString;
}

// Drizzle gets its own client. drizzle-orm/postgres-js replaces the client's
// json/jsonb and timestamp serializers with pass-throughs at construction, so
// sharing `sql` handed every sql.json() in this file a raw object once auth.js
// had loaded — which is every authenticated request. Saving a setting and
// recording an upload both failed with "The "string" argument must be of type
// string".
let _db = null;
export function getDb() {
  if (!connectionString) {
    throw new Error('Database is not configured — set DATABASE_URL and redeploy. See /api/health.');
  }
  if (!_db) _db = drizzle(withQueryDeadlines(createSqlClient(), QUERY_DEADLINE_MS), { schema: authSchema });
  return _db;
}

/**
 * Create the four tables Auth.js requires. Unlike Onyx's own tables, these are
 * touched first by the adapter rather than by our code, so there is no natural
 * call site to hang a lazy guard on — auth.js wraps the adapter and awaits
 * this before every method instead. Cached after the first success, so the
 * steady-state cost is one resolved promise.
 *
 * Column names are quoted because Auth.js's schema is camelCase and Postgres
 * would otherwise fold them to lowercase.
 */
let authTablesEnsured = null;
export function ensureAuthTables(force = false) {
  if (!force && schemaManaged()) return Promise.resolve();
  if (authTablesEnsured) return authTablesEnsured;
  authTablesEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS "user" (
        id              TEXT PRIMARY KEY,
        name            TEXT,
        email           TEXT UNIQUE,
        "emailVerified" TIMESTAMPTZ,
        image           TEXT
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS "account" (
        "userId"            TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        type                TEXT NOT NULL,
        provider            TEXT NOT NULL,
        "providerAccountId" TEXT NOT NULL,
        refresh_token       TEXT,
        access_token        TEXT,
        expires_at          BIGINT,
        token_type          TEXT,
        scope               TEXT,
        id_token            TEXT,
        session_state       TEXT,
        PRIMARY KEY (provider, "providerAccountId")
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS "session" (
        "sessionToken" TEXT PRIMARY KEY,
        "userId"       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        expires        TIMESTAMPTZ NOT NULL
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS "verificationToken" (
        identifier TEXT NOT NULL,
        token      TEXT NOT NULL,
        expires    TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (identifier, token)
      )
    `;
  })().catch((e) => {
    // Reset so the next request retries rather than caching the failure.
    authTablesEnsured = null;
    throw e;
  });
  return authTablesEnsured;
}

// ─── Settings — the admin-managed key/value store ────────────────────────────
//
// One jsonb table backs every piece of runtime configuration: the brand config,
// role assignments, feature flags, the storage backend, and the secret
// overrides in lib/config.js. Anything that an admin can change without a
// redeploy lives here rather than in an env var.

const ensureSettingsTable = lazySchema('ensureSettingsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      updated_at  BIGINT NOT NULL,
      updated_by  TEXT
    )
  `;
});

// ── Settings cache ──────────────────────────────────────────────────────────
// Settings change when an admin saves a form — minutes or months apart — and
// are read on every single render, including the 404s that scanners generate
// against /favicon.ico and /ads.txt. Reading them from Postgres each time
// makes the most static data in the system the most expensive.
//
// So: a per-instance cache with a short TTL. A warm lambda reads each key
// once a minute; a write invalidates immediately, and in the worst case
// another instance is up to a minute stale, which is the right trade for
// configuration.
//
// Failures are cached too, briefly. That is the part that matters when the
// database is struggling: without it, a read that takes four seconds to time
// out does so on EVERY request, and the site is slow for exactly as long as
// the database is unhappy. With it, one request pays and the rest render on
// defaults until the negative entry expires.
const SETTINGS_TTL_MS = 60_000;
const SETTINGS_FAIL_TTL_MS = 10_000;
const settingsCache = new Map();

/** Drop a key (or everything) from the cache — after any write. */
export function invalidateSetting(key) {
  key == null ? settingsCache.clear() : settingsCache.delete(key);
}

/**
 * Undo a double-encoded jsonb value.
 *
 * setSetting used to write `${JSON.stringify(value)}::jsonb`. That was correct
 * under the previous driver, which sent the string as text for the cast to
 * parse. postgres.js infers the parameter type from the column and JSON-encodes
 * it again, so what landed in the database was a jsonb STRING containing JSON
 * — `jsonb_typeof` returns 'string', not 'object'.
 *
 * Every consumer then did `typeof saved === 'object' ? saved : {}` and got the
 * defaults, silently, on every read. That is why a saved storage configuration
 * never came back: it was written, and then discarded on the way out.
 *
 * The write is fixed. This repairs rows written before it, so a working
 * configuration does not have to be typed in again. Only a string that parses
 * to an object or array is unwrapped — a setting that is legitimately a string
 * is left exactly as it is.
 */
function decodeSetting(value) {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
  }
}

export async function getSetting(key, { deadlineMs = RENDER_DEADLINE_MS, fresh = false, strict = false } = {}) {
  // `fresh` skips the read, not the write: an admin screen must never show a
  // value older than the one it just saved. The cache is per instance, so a
  // PUT handled by one lambda and the GET that follows handled by another
  // would otherwise redisplay the old config for up to a minute — which
  // looks exactly like the save having failed.
  const hit = fresh ? null : settingsCache.get(key);
  // A remembered FAILURE is a fine answer for a render (defaults) and the
  // wrong one for a strict caller, who asked precisely to be told the read
  // did not work: they read again instead.
  if (hit && hit.expires > Date.now() && !(strict && hit.failed)) return hit.value;

  await ensureSettingsTable();
  try {
    // Read the WHOLE table, not the one row asked for.
    //
    // `settings` holds a handful of rows — brand, roles, features, storage —
    // and a page render asks for most of them. One query per key meant four
    // or more sequential round trips before anything touched the files table,
    // on a single connection (max: 1), so they could not even overlap. The
    // table is small enough that fetching all of it costs the same as
    // fetching one row, and every other key on the page is then a cache hit.
    //
    // A key with no row is cached as null, so a miss does not re-query for
    // every absent key on every render.
    const rows = await withDeadline(
      sql`SELECT key, value FROM settings`,
      deadlineMs, `getSetting(${key})`,
    );
    const expires = Date.now() + SETTINGS_TTL_MS;
    const seen = new Set();
    for (const row of rows) {
      settingsCache.set(row.key, { value: decodeSetting(row.value ?? null), expires });
      seen.add(row.key);
    }
    if (!seen.has(key)) settingsCache.set(key, { value: null, expires });
    return settingsCache.get(key).value;
  } catch (e) {
    console.warn(`[db] getSetting(${key}) failed:`, e.message);
    // `strict` callers must be able to tell "there is no such setting" from
    // "I could not read it". Returning null for both is fine for a render —
    // brand defaults are a reasonable page — and catastrophic for a write:
    // a save that merges over defaults because the read timed out silently
    // erases every field the form did not send, the stored secret included.
    // That is not hypothetical; it is how a working storage config got wiped
    // on every save while the database was slow.
    if (strict) throw e;
    // Nor is a failure worth caching for a caller that explicitly asked for
    // a fresh read — poisoning the entry for ten seconds defeats the point.
    if (!fresh) settingsCache.set(key, { value: null, expires: Date.now() + SETTINGS_FAIL_TTL_MS, failed: true });
    return null;
  }
}

export async function setSetting(key, value, updatedBy = null) {
  await ensureSettingsTable();
  invalidateSetting(key);
  await sql`
    INSERT INTO settings (key, value, updated_at, updated_by)
    VALUES (${key}, ${sql.json(value)}, ${Date.now()}, ${updatedBy})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
  `;
  invalidateSetting(key);
  return value;
}

export async function deleteSetting(key) {
  await ensureSettingsTable();
  await sql`DELETE FROM settings WHERE key = ${key}`;
  invalidateSetting(key);
  return true;
}

/** Every setting whose key starts with `prefix` (used by the config overlay). */
export async function listSettings(prefix = '') {
  await ensureSettingsTable();
  try {
    const rows = await withDeadline(prefix
      ? sql`SELECT key, value, updated_at, updated_by FROM settings WHERE key LIKE ${prefix + '%'} ORDER BY key`
      : sql`SELECT key, value, updated_at, updated_by FROM settings ORDER BY key`,
    QUERY_DEADLINE_MS, 'listSettings');
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: Number(r.updated_at) || null, updatedBy: r.updated_by || null }));
  } catch (e) {
    console.warn('[db] listSettings failed:', e.message);
    return [];
  }
}

// Typed accessors over the same table. Each is a named key so callers never
// have to remember the string, and a bad read degrades to `{}` rather than
// throwing — a missing settings row must not break a page render.
const blob = (key) => ({
  get: async (opts) => (await getSetting(key, opts)) || {},
  set: (value, by) => setSetting(key, value, by),
});

const brandBlob = blob('brand.config');
const rolesBlob = blob('roles.config');
const flagsBlob = blob('features.flags');
const maintenanceBlob = blob('maintenance.config');

export const getBrandConfig = brandBlob.get;
export const setBrandConfig = brandBlob.set;
export const getRolesConfig = rolesBlob.get;
export const setRolesConfig = rolesBlob.set;
export const getMaintenanceConfig = maintenanceBlob.get;
export const setMaintenanceConfig = maintenanceBlob.set;

/** Feature flags, merged over the defaults in lib/features.js. */
export async function getFeatureFlags(opts) {
  return mergeFlags(await flagsBlob.get(opts));
}

export async function setFeatureFlags(flags, by) {
  return flagsBlob.set(flags, by);
}


// ─── Magic-link redirect indirection (anti-Safe-Browsing) ─────
// Short-token table that maps a clean URL like /verify/<id> to the actual
// Auth.js callback URL. Lets us send a page-shaped link in the email instead
// of the /api/auth/callback/email?token=...&email=... pattern that Chrome's
// phishing classifier keeps flagging.

const ensureMagicLinkRedirectsTable = lazySchema('ensureMagicLinkRedirectsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS magic_link_redirects (
      id TEXT PRIMARY KEY,
      target_url TEXT NOT NULL,
      email TEXT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS magic_link_redirects_expires_idx ON magic_link_redirects (expires_at)`;
});

/**
 * Mint a short opaque token and store the mapping to the real Auth.js callback URL.
 * Expires 24h after creation, matching Auth.js's verification token TTL.
 */
export async function createMagicLinkRedirect({ targetUrl, email }) {
  if (!sql) throw new Error('Database not configured');
  await ensureMagicLinkRedirectsTable();

  // 16-char URL-safe random token. crypto.randomUUID() is fine but a bit
  // long for a URL path component; this stays compact while keeping
  // ~96 bits of entropy (URL-safe base64 alphabet, 16 chars).
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000; // 24h

  await sql`
    INSERT INTO magic_link_redirects (id, target_url, email, created_at, expires_at)
    VALUES (${id}, ${targetUrl}, ${email || null}, ${now}, ${expiresAt})
  `;

  // Best-effort cleanup of expired rows. Tiny table, cheap to vacuum inline.
  try {
    await sql`DELETE FROM magic_link_redirects WHERE expires_at < ${now}`;
  } catch {
    // Non-fatal — if cleanup fails the table just gets a bit larger.
  }

  return { id, expiresAt };
}

/**
 * Resolve a short token back to its target URL. Returns null if not found
 * or expired (so the verify page can render an "expired" state).
 */
export async function getMagicLinkRedirect(id) {
  if (!sql) throw new Error('Database not configured');
  await ensureMagicLinkRedirectsTable();
  const now = Date.now();
  // Deadlined like the other render-path reads: this one is on the critical
  // path of signing in, and an unbounded wait here is a 504 on the link
  // someone just clicked in their inbox.
  const rows = await withDeadline(
    sql`
      SELECT * FROM magic_link_redirects
      WHERE id = ${id} AND expires_at >= ${now}
      LIMIT 1
    `,
    RENDER_DEADLINE_MS, 'getMagicLinkRedirect',
  );
  return shapeMagicLinkRedirect(rows[0]);
}

/**
 * Row → object, like every other getter in this file. The verify page read
 * `row.targetUrl` off a raw row whose column is `target_url`, so every
 * valid link rendered the "expired" page while the row sat there unread.
 */
export function shapeMagicLinkRedirect(r) {
  if (!r) return null;
  return {
    id: r.id,
    targetUrl: r.target_url,
    email: r.email || null,
    createdAt: Number(r.created_at) || null,
    expiresAt: Number(r.expires_at) || null,
  };
}


// ─────────────────────────────────────────────────────────────────────────
// Invite-only access control
//
// Lazy-create pattern matching the other tables in this file. A small wrinkle:
// we also run a one-time bootstrap on first table creation to seed approved
// rows for every email already in the Auth.js `user` table — that way no
// existing signed-in user gets locked out when invite-only mode goes live.
// Bootstrap only runs ONCE per table lifetime; we detect it by checking if
// any rows exist after creation.
// ─────────────────────────────────────────────────────────────────────────

const ensureInviteRequestsTable = lazySchema('ensureInviteRequestsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS invite_requests (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      reason TEXT,
      status TEXT NOT NULL,
      requested_at BIGINT NOT NULL,
      reviewed_at BIGINT,
      reviewed_by TEXT,
      review_note TEXT
    )
  `;
});

/**
 * One-time bootstrap on initial deploy of invite-only mode. Seeds approved
 * rows for:
 *   1. Every email in ADMIN_EMAILS env var (founder backstop).
 *   2. Every email already in Auth.js's `user` table (existing signed-in users).
 *
 * Idempotent — ON CONFLICT (email) DO NOTHING, so re-running this on an
 * already-bootstrapped table is a no-op. Wrapped in try/catch per insert so
 * one malformed email doesn't abort the seeding of the rest.
 *
 * Called automatically from listInviteRequests on every load; guarded by an
 * existence check so the actual work only runs when the table is empty.
 */
async function maybeBootstrapInviteRequests() {
  if (!sql) return;
  await ensureInviteRequestsTable();

  // Only bootstrap if the table is empty (first deploy of invite-only mode).
  // After that this is a no-op.
  const existing = await sql`SELECT COUNT(*)::int AS n FROM invite_requests`;
  if (existing[0]?.n > 0) return;

  console.log('[invites] bootstrapping invite_requests with admin + existing-user seeds…');

  // The admins, from the one place that decides who they are. This used to
  // keep its own copy with its own defaults, and the copy seeded an approved
  // row for an address nobody on the deployment controls.
  let adminEmails = [];
  try {
    const { getAdminEmails } = await import('./auth-allowlist.js');
    adminEmails = getAdminEmails().filter((s) => s.includes('@'));
  } catch (e) {
    console.warn('[invites] could not read the admin list during bootstrap:', e.message);
  }

  // Pull every existing Auth.js user (anyone who has previously signed in).
  // The DrizzleAdapter creates the `user` table on first sign-in, so this
  // may not exist yet on a brand-new deploy — wrap in try/catch and
  // continue regardless. PostgreSQL identifier `user` is reserved, hence
  // the quoted name.
  let userEmails = [];
  try {
    const rows = await sql`SELECT email FROM "user" WHERE email IS NOT NULL`;
    userEmails = rows
      .map((r) => String(r.email || '').trim().toLowerCase())
      .filter((e) => e.includes('@'));
  } catch (e) {
    console.warn('[invites] could not read user table during bootstrap (expected on fresh installs):', e.message);
  }

  const allToSeed = Array.from(new Set([...adminEmails, ...userEmails]));
  const now = Date.now();
  let seeded = 0;
  for (const email of allToSeed) {
    try {
      await sql`
        INSERT INTO invite_requests (id, email, name, reason, status, requested_at, reviewed_at, reviewed_by, review_note)
        VALUES (${crypto.randomUUID()}, ${email}, NULL, NULL, 'approved', ${now}, ${now}, 'system-bootstrap', 'Auto-approved during invite-only migration')
        ON CONFLICT (email) DO NOTHING
      `;
      seeded += 1;
    } catch (e) {
      console.warn(`[invites] bootstrap seed failed for ${email}:`, e.message);
    }
  }
  console.log(`[invites] bootstrap seeded ${seeded} email(s)`);
}

/**
 * Create a new invite request, OR return the existing one if this email has
 * already requested. Dedupe is by email (unique constraint). The wasExisting
 * flag tells the caller whether to show "request received" or "you already
 * have a pending/approved request" copy on the success screen.
 */
export async function createOrGetInviteRequest({ email, name, reason }) {
  if (!sql) throw new Error('Database not configured');
  await ensureInviteRequestsTable();

  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    throw new Error('Invalid email address');
  }

  // Already requested? Return the existing row — don't create a duplicate
  // or overwrite the original request. Approved rows stay approved; denied
  // rows stay denied (the user can email the admin if they want to re-request).
  const existing = await sql`
    SELECT id, email, name, reason, status,
           requested_at AS "requestedAt",
           reviewed_at AS "reviewedAt",
           reviewed_by AS "reviewedBy",
           review_note AS "reviewNote"
    FROM invite_requests WHERE email = ${normalized} LIMIT 1
  `;
  if (existing.length > 0) {
    return { ...existing[0], wasExisting: true };
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await sql`
    INSERT INTO invite_requests (id, email, name, reason, status, requested_at)
    VALUES (${id}, ${normalized}, ${name || null}, ${reason || null}, 'pending', ${now})
  `;
  return {
    id,
    email: normalized,
    name: name || null,
    reason: reason || null,
    status: 'pending',
    requestedAt: now,
    wasExisting: false,
  };
}

/**
 * List all invite requests, optionally filtered by status. Default order
 * surfaces pending first (the action items), then approved, then denied,
 * within each group sorted by request date descending.
 */
export async function listInviteRequests({ status } = {}) {
  if (!sql) return [];
  await ensureInviteRequestsTable();
  await maybeBootstrapInviteRequests();

  const rows = status
    ? await sql`
        SELECT id, email, name, reason, status,
               requested_at AS "requestedAt",
               reviewed_at  AS "reviewedAt",
               reviewed_by  AS "reviewedBy",
               review_note  AS "reviewNote"
        FROM invite_requests
        WHERE status = ${status}
        ORDER BY requested_at DESC
      `
    : await sql`
        SELECT id, email, name, reason, status,
               requested_at AS "requestedAt",
               reviewed_at  AS "reviewedAt",
               reviewed_by  AS "reviewedBy",
               review_note  AS "reviewNote"
        FROM invite_requests
        ORDER BY
          CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
          requested_at DESC
      `;
  return rows.map((r) => ({
    ...r,
    requestedAt: r.requestedAt ? Number(r.requestedAt) : null,
    reviewedAt: r.reviewedAt ? Number(r.reviewedAt) : null,
  }));
}

/**
 * The states an invite row can be in. The sign-in gate reads 'approved' and
 * nothing else, so any other string an admin client sent used to be stored
 * as-is and quietly lock the person out — a typo was a revoke. Now only these
 * three are accepted, by the route and here.
 */
export const INVITE_STATUSES = ['approved', 'denied', 'pending'];
export const isInviteStatus = (s) => INVITE_STATUSES.includes(s);

/**
 * Update an existing invite request — admin approval/denial flow. Stamps
 * reviewedAt + reviewedBy automatically. Returns the updated row.
 */
export async function updateInviteRequest(id, { status, reviewedBy, reviewNote }) {
  if (!sql) throw new Error('Database not configured');
  if (!isInviteStatus(status)) throw new Error(`Unknown invite status "${status}".`);
  await ensureInviteRequestsTable();
  const now = Date.now();
  await sql`
    UPDATE invite_requests
    SET status      = ${status},
        reviewed_at = ${now},
        reviewed_by = ${reviewedBy || null},
        review_note = ${reviewNote || null}
    WHERE id = ${id}
  `;
  const rows = await sql`
    SELECT id, email, name, reason, status,
           requested_at AS "requestedAt",
           reviewed_at  AS "reviewedAt",
           reviewed_by  AS "reviewedBy",
           review_note  AS "reviewNote"
    FROM invite_requests WHERE id = ${id} LIMIT 1
  `;
  if (!rows[0]) return null;
  return {
    ...rows[0],
    requestedAt: rows[0].requestedAt ? Number(rows[0].requestedAt) : null,
    reviewedAt: rows[0].reviewedAt ? Number(rows[0].reviewedAt) : null,
  };
}

/**
 * Admin-only: hard-delete an invite request row. Used by the "Remove" action
 * in the admin panel — wipes the user's access record entirely (a removed
 * person can request access again from scratch). For a block that survives
 * re-requests, deny the request (status 'denied') or suspend the person.
 *
 * Note: this revokes the DB grant, but an already-issued session stays valid
 * until it expires/refreshes (the gate runs at sign-in). Env-level ADMIN_EMAILS
 * are unaffected by this — they're granted in env, not the table.
 */
export async function deleteInviteRequest(id) {
  if (!sql) throw new Error('Database not configured');
  await ensureInviteRequestsTable();
  await sql`DELETE FROM invite_requests WHERE id = ${id}`;
  return { ok: true, id };
}

/**
 * Admin "add directly" path — create (or re-approve) an approved invite row for
 * an email without routing it through the pending-request queue. Idempotent via
 * ON CONFLICT (email). Used by /api/admin/invites (action: 'add').
 */
export async function adminAddApprovedInvite({ email, name, reviewedBy }) {
  if (!sql) throw new Error('Database not configured');
  await ensureInviteRequestsTable();
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    throw new Error('Invalid email address');
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO invite_requests (id, email, name, status, requested_at, reviewed_at, reviewed_by, review_note)
    VALUES (${id}, ${normalized}, ${name || null}, 'approved', ${now}, ${now}, ${reviewedBy || null}, 'Added directly by admin')
    ON CONFLICT (email) DO UPDATE
      SET status      = 'approved',
          reviewed_at = ${now},
          reviewed_by = ${reviewedBy || null},
          review_note = 'Re-approved directly by admin'
  `;
  return { email: normalized, status: 'approved' };
}

/**
 * Fast boolean check used by the auth gate. Returns true iff there's an
 * approved row for this email AND the person is not suspended. Note:
 * env-driven admin emails are handled separately in lib/auth-allowlist.js →
 * isEmailGrantedAccess(); this function only looks at the DB.
 */
export async function isEmailApprovedInvite(email) {
  if (!sql) return false;
  try {
    await ensureInviteRequestsTable();
    await ensurePeopleTable();
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return false;
    // Suspension is checked here rather than beside it, so every gate that
    // asks "may they sign in" — the sign-in callback, the magic-link action,
    // every desktop request — gets the same answer from one statement.
    const rows = await withSchemaRetry([ensureInviteRequestsTable, ensurePeopleTable], () => sql`
      SELECT 1 FROM invite_requests i
      WHERE i.email = ${normalized} AND i.status = 'approved'
        AND NOT EXISTS (SELECT 1 FROM people p WHERE p.email = ${normalized} AND p.status = 'suspended')
      LIMIT 1
    `);
    return rows.length > 0;
  } catch (e) {
    console.error('[isEmailApprovedInvite] failed:', e);
    // Fail closed — if the DB is unreachable, treat as not-approved. This
    // means a DB outage temporarily blocks sign-ins for non-admins, which
    // is the right trade-off: better to lock everyone out than to silently
    // let unauthorized emails through.
    return false;
  }
}


// ─────────────────────────────────────────────────────────────────────────
// Notifications — agent-emitted alerts surfaced in the nav bell.
// ─────────────────────────────────────────────────────────────────────────

const ensureNotificationsTable = lazySchema('ensureNotificationsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_email TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      link TEXT,
      agent_key TEXT,
      metadata JSONB,
      created_at BIGINT NOT NULL,
      read_at BIGINT
    )
  `;
  // Per-user read state for BROADCAST notifications (user_email IS NULL). The
  // shared row's read_at can't track per-user reads, so each user's read of a
  // broadcast is recorded here instead.
  await sql`
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      read_at BIGINT NOT NULL,
      PRIMARY KEY (notification_id, user_email)
    )
  `;
});

/**
 * Create a notification. If userEmail is null/omitted, the notification is
 * broadcast — every signed-in user will see it until they age out / are
 * deleted. Otherwise it's targeted to that user only.
 */
export async function createNotification({
  userEmail = null,
  type,
  title,
  body = null,
  link = null,
  agentKey = null,
  metadata = null,
}) {
  if (!sql) return null;
  // The `notifications` flag is enforced here, where every notice is made,
  // so no emitter can forget it.
  if (!(await getFeatureFlags()).notifications) return null;
  await ensureNotificationsTable();
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await sql`
      INSERT INTO notifications (id, user_email, type, title, body, link, agent_key, metadata, created_at)
      VALUES (${id}, ${userEmail}, ${type}, ${title}, ${body}, ${link}, ${agentKey}, ${metadata ? sql.json(metadata) : null}, ${now})
    `;
    return { id, userEmail, type, title, body, link, agentKey, metadata, createdAt: now };
  } catch (e) {
    console.error('[createNotification] failed:', e);
    return null;
  }
}

/**
 * List notifications for a user. Includes broadcasts (user_email IS NULL)
 * AND user-targeted rows. Newest first. Limited to the last 30 days by
 * default — older rows stay in the DB but aren't surfaced in the bell.
 */
export async function listNotifications(userEmail, { limit = 30, onlyUnread = false } = {}) {
  if (!sql) return [];
  await ensureNotificationsTable();
  const normalized = String(userEmail || '').trim().toLowerCase();
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    // Per-user read state: targeted rows use their own read_at; broadcasts use
    // the notification_reads row for this user (COALESCE picks whichever applies).
    const rows = onlyUnread
      ? await sql`
          SELECT n.id, n.user_email AS "userEmail", n.type, n.title, n.body, n.link,
                 n.agent_key AS "agentKey", n.metadata,
                 n.created_at AS "createdAt", COALESCE(n.read_at, nr.read_at) AS "readAt"
          FROM notifications n
          LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_email = ${normalized}
          WHERE (n.user_email = ${normalized} OR n.user_email IS NULL)
            AND n.read_at IS NULL AND nr.read_at IS NULL
            AND n.created_at >= ${since}
          ORDER BY n.created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT n.id, n.user_email AS "userEmail", n.type, n.title, n.body, n.link,
                 n.agent_key AS "agentKey", n.metadata,
                 n.created_at AS "createdAt", COALESCE(n.read_at, nr.read_at) AS "readAt"
          FROM notifications n
          LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_email = ${normalized}
          WHERE (n.user_email = ${normalized} OR n.user_email IS NULL)
            AND n.created_at >= ${since}
          ORDER BY n.created_at DESC
          LIMIT ${limit}
        `;
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt ? Number(r.createdAt) : null,
      readAt: r.readAt ? Number(r.readAt) : null,
    }));
  } catch (e) {
    console.error('[listNotifications] failed:', e);
    return [];
  }
}

/**
 * Count unread notifications for the bell badge. Cheap query — no payload
 * fetch, just COUNT(*).
 */
export async function countUnreadNotifications(userEmail) {
  if (!sql) return 0;
  await ensureNotificationsTable();
  const normalized = String(userEmail || '').trim().toLowerCase();
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    const rows = await sql`
      SELECT COUNT(*)::int AS n FROM notifications n
      LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_email = ${normalized}
      WHERE (n.user_email = ${normalized} OR n.user_email IS NULL)
        AND n.read_at IS NULL AND nr.read_at IS NULL
        AND n.created_at >= ${since}
    `;
    return rows[0]?.n || 0;
  } catch (e) {
    console.error('[countUnreadNotifications] failed:', e);
    return 0;
  }
}

/**
 * Mark one or all notifications read. id=null marks all user-visible
 * notifications as read in one shot — the "mark all read" button.
 */
export async function markNotificationsRead({ id = null, userEmail }) {
  if (!sql) return;
  await ensureNotificationsTable();
  const normalized = String(userEmail || '').trim().toLowerCase();
  const now = Date.now();
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    if (id) {
      // Targeted row → set its own read_at. (No-op for a broadcast, whose
      // user_email is NULL, so we never mark a broadcast read for everyone.)
      await sql`UPDATE notifications SET read_at = ${now} WHERE id = ${id} AND user_email = ${normalized} AND read_at IS NULL`;
      // Broadcast → record this user's read in notification_reads.
      await sql`
        INSERT INTO notification_reads (notification_id, user_email, read_at)
        SELECT ${id}, ${normalized}, ${now} FROM notifications WHERE id = ${id} AND user_email IS NULL
        ON CONFLICT (notification_id, user_email) DO NOTHING`;
    } else {
      await sql`UPDATE notifications SET read_at = ${now} WHERE user_email = ${normalized} AND read_at IS NULL`;
      // Mark every currently-visible unread broadcast read for this user.
      await sql`
        INSERT INTO notification_reads (notification_id, user_email, read_at)
        SELECT n.id, ${normalized}, ${now} FROM notifications n
        WHERE n.user_email IS NULL AND n.created_at >= ${since}
        ON CONFLICT (notification_id, user_email) DO NOTHING`;
    }
  } catch (e) {
    console.error('[markNotificationsRead] failed:', e);
  }
}


// ─── v0.32.0 — User preferences (profile page) ────────────────────────
// Per-user notification + display preferences. Keyed by email (same as
// every other user lookup in this codebase). JSONB blob so we can extend
// the shape without migrations.

async function ensureUserPreferencesTable() {
  if (!sql) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS user_preferences (
        email TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `;
  } catch (e) {
    console.warn('[ensureUserPreferencesTable] failed (will retry on next call):', e.message);
  }
}

/**
 * Default preferences. Returned whenever a user has no row in the table
 * yet (i.e. they've never visited /profile). Designed to be sensible
 * defaults that mostly preserve pre-v0.32 behavior: email notifications
 * stay on, daily report stays off (opt-in), Slack personal channel is off
 * (org-wide Slack ping continues independently via SLACK_WEBHOOK_URL).
 */
export function getDefaultUserPreferences() {
  return {
    displayName: null,
    // v0.32.9 — User can upload a circular profile photo (Vercel Blob URL).
    // When null/absent, the Avatar component renders the user's first
    // initial on a deterministic prismatic gradient.
    avatarUrl: null,
    notifications: {
      email: {
        jobReady: true,
        commentMention: true,
        dailyReport: false,
      },
      slack: {
        enabled: false,
        webhookUrl: null,
        // v1.47.0 — set when the user connects via the "Connect with Slack"
        // OAuth button (vs pasting a webhook). Purely for display: which
        // workspace + channel the alerts post to.
        channel: null,
        teamName: null,
        jobReady: true,
        commentMention: true,
        dailyReport: false,
      },
    },
    defaults: {
      mode: 'pipeline',
      imageModel: null,
      videoModel: null,
      includeHooks: false,
      includeLanding: false,
    },
    // Per-user quick-menu sub-bar: an ordered array of tool hrefs. null = use the
    // default set (see lib/quicknav.js). mergePrefs replaces arrays wholesale, so
    // a save sends the full desired order.
    quickNav: null,
  };
}

/**
 * Deep-merge two preference objects. Used by getUserPreferences to merge
 * stored partial prefs into the defaults so new pref keys added in a later
 * version automatically pick up the default value without us having to
 * back-fill rows.
 */
function mergePrefs(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const bv = base[k];
    const pv = patch[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv)) {
      out[k] = mergePrefs(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

export async function getUserPreferences(email) {
  if (!email) return getDefaultUserPreferences();
  if (!sql) return getDefaultUserPreferences();
  await ensureUserPreferencesTable();
  try {
    const rows = await sql`SELECT data FROM user_preferences WHERE email = ${email}`;
    if (!rows[0]) return getDefaultUserPreferences();
    // Merge with defaults so any newly-added pref keys are present
    return mergePrefs(getDefaultUserPreferences(), rows[0].data || {});
  } catch (e) {
    console.error('[getUserPreferences] failed:', e.message);
    return getDefaultUserPreferences();
  }
}

/**
 * Update preferences. Reads the existing row (or defaults), deep-merges
 * the patch, and writes the full blob back via UPSERT. This way callers
 * can send partial patches like { notifications: { email: { jobReady: false } } }
 * without clobbering other categories.
 */
export async function updateUserPreferences(email, patch) {
  if (!email) throw new Error('updateUserPreferences requires an email');
  if (!sql) throw new Error('Database not configured');
  await ensureUserPreferencesTable();
  const existing = await getUserPreferences(email);
  const merged = mergePrefs(existing, patch);
  const now = Date.now();
  await sql`
    INSERT INTO user_preferences (email, data, updated_at)
    VALUES (${email}, ${sql.json(merged)}, ${now})
    ON CONFLICT (email) DO UPDATE
      SET data = ${sql.json(merged)},
          updated_at = ${now}
  `;
  return merged;
}

/**
 * Update the Auth.js `user.name` column for the given email. Used by the
 * /profile page when the user edits their display name. The Auth.js
 * adapter doesn't expose an update helper, so we go to SQL directly. The
 * table is named `user` (singular, Auth.js convention).
 *
 * Returns true if a row was updated, false if no user exists with that
 * email yet (which shouldn't happen post-signin but is worth guarding).
 */
export async function updateUserName(email, name) {
  if (!email) throw new Error('updateUserName requires an email');
  if (!sql) throw new Error('Database not configured');
  // Quoted "user" because user is a reserved word in Postgres
  const result = await sql`UPDATE "user" SET name = ${name} WHERE email = ${email}`;
  return result.length > 0 || (result.count ?? 0) > 0;
}


// ─── Profile pictures ───────────────────────────────────────────────────────
// One per person, stored here rather than in the bucket (see lib/avatars.js):
// a 256px WebP the upload route re-encodes, a few kilobytes. `id` is a hash
// of the address and is what the picture's URL carries, so no URL ever
// carries an address; `version` changes with each new picture, which is
// what lets the browser cache each one for ever.
const ensureAvatarsTable = lazySchema('ensureAvatarsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS user_avatars (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      image BYTEA NOT NULL,
      type TEXT NOT NULL,
      version BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
});

// In production the schema is applied by the cron and `npm run doctor`, not
// on the request path (schemaManaged). Until then this table may not exist:
// 42P01 is undefined_table, and the guard is forced once and the call tried
// again, so the first picture anyone sets after a deploy still saves.
async function withAvatarsTable(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.code !== '42P01') throw e;
    await ensureAvatarsTable.force(true);
    return fn();
  }
}

/** The picture id for an address: a hash, stable, never the address. */
export function avatarIdFor(email) {
  return createHash('sha256').update(`onyx-avatar:${String(email || '').trim().toLowerCase()}`).digest('hex').slice(0, 24);
}

/** Where this person's picture is served, or null when they have none. Never throws: a nav falls back to initials. */
export async function getAvatarUrl(email) {
  if (!sql || !email) return null;
  try {
    await ensureAvatarsTable();
    const rows = await withAvatarsTable(() => sql`SELECT id, version FROM user_avatars WHERE email = ${String(email).trim().toLowerCase()}`);
    return rows[0] ? avatarPath(rows[0].id, rows[0].version) : null;
  } catch (e) {
    console.warn('[getAvatarUrl] failed:', e.message);
    return null;
  }
}

/** The stored picture itself, by id: { image, type, version } or null. */
export async function getAvatarById(id) {
  if (!sql || !id) return null;
  await ensureAvatarsTable();
  const rows = await withAvatarsTable(() => sql`SELECT image, type, version FROM user_avatars WHERE id = ${String(id)}`);
  if (!rows[0]) return null;
  return { image: Buffer.from(rows[0].image), type: rows[0].type, version: String(rows[0].version) };
}

/** Store (or replace) this person's picture. `image` is already re-encoded. Returns its URL. */
export async function setAvatar(email, image, type) {
  if (!sql) throw new Error('Database not configured');
  await ensureAvatarsTable();
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('email required');
  const id = avatarIdFor(e);
  const now = Date.now();
  await withAvatarsTable(() => sql`
    INSERT INTO user_avatars (id, email, image, type, version, updated_at)
    VALUES (${id}, ${e}, ${image}, ${type}, ${now}, ${now})
    ON CONFLICT (email) DO UPDATE SET image = EXCLUDED.image, type = EXCLUDED.type,
      version = EXCLUDED.version, updated_at = EXCLUDED.updated_at
  `);
  return avatarPath(id, now);
}

export async function deleteAvatar(email) {
  if (!sql) return false;
  await ensureAvatarsTable();
  const rows = await withAvatarsTable(() => sql`DELETE FROM user_avatars WHERE email = ${String(email || '').trim().toLowerCase()} RETURNING id`);
  return rows.length > 0;
}

// ─── People ─────────────────────────────────────────────────────────────────
// One row per person who can sign in, has been invited, or once did: their
// role, whether they are suspended, their limit overrides, the moment their
// sessions stop being honoured, and their preferences.
//
// Not Auth.js's "user" table. Drizzle's adapter owns that one, it is keyed by
// an opaque id where every Onyx table is keyed by email, and removing someone
// deletes it. A person has to survive a suspension and join the rest of the
// schema cheaply, so they get a table of their own, keyed by email, with a
// separate `id` for URLs so no address ever appears in one.
//
// Rows appear in five places, all ON CONFLICT (email) DO NOTHING: a sign-in
// (auth.js events.signIn), an invite approved or someone added directly, a
// desktop token's first use, a session seen without a row (lib/session.js),
// and a one-time backfill the first time the People list loads. role_id NULL
// means the default role, so nobody behaves differently for having a row.
const ensurePeopleTable = lazySchema('ensurePeopleTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS people (
      id                   TEXT PRIMARY KEY,
      email                TEXT NOT NULL UNIQUE,
      display_name         TEXT,
      role_id              TEXT,
      status               TEXT NOT NULL DEFAULT 'active',
      status_reason        TEXT,
      status_changed_at    BIGINT,
      status_changed_by    TEXT,
      pause_links          BOOLEAN NOT NULL DEFAULT true,
      sessions_valid_after BIGINT,
      quota_bytes          BIGINT,
      max_upload_bytes     BIGINT,
      ai_monthly_cents     INT,
      prefs                JSONB NOT NULL DEFAULT '{}',
      first_seen_at        BIGINT,
      last_seen_at         BIGINT,
      created_at           BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS people_role_idx ON people (role_id)`;
});

export const PERSON_STATUSES = ['active', 'suspended'];

const numOrNull = (v) => (v == null ? null : Number(v));

export function shapePerson(r) {
  if (!r || !r.id) return null;
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name || null,
    roleId: r.role_id || null,
    status: r.status || 'active',
    statusReason: r.status_reason || null,
    statusChangedAt: numOrNull(r.status_changed_at),
    statusChangedBy: r.status_changed_by || null,
    pauseLinks: r.pause_links !== false,
    sessionsValidAfter: numOrNull(r.sessions_valid_after),
    quotaBytes: numOrNull(r.quota_bytes),
    maxUploadBytes: numOrNull(r.max_upload_bytes),
    aiMonthlyCents: numOrNull(r.ai_monthly_cents),
    prefs: r.prefs && typeof r.prefs === 'object' ? r.prefs : {},
    firstSeenAt: numOrNull(r.first_seen_at),
    lastSeenAt: numOrNull(r.last_seen_at),
    createdAt: numOrNull(r.created_at),
    updatedAt: numOrNull(r.updated_at),
  };
}

const normEmail = (email) => String(email || '').trim().toLowerCase();

/**
 * v1's role assignment for `email`, as a subquery over the stored
 * roles.config: the role id, or NULL. Read in the statement that creates a
 * person's row, so the row is born holding whatever role they held before —
 * there is no moment in which they have a row, a NULL role (the default) and
 * a v1 assignment that said otherwise. Keys are matched as parseRolesConfig
 * matches them, trimmed and lowercased; a value that is not a string is no
 * assignment. A blob written double-encoded (see decodeSetting) is unwrapped
 * the same way, and only when it looks like the object it was.
 */
function legacyAssignmentSql(email) {
  return sql`(
    SELECT a.value #>> '{}'
    FROM settings s
    CROSS JOIN LATERAL (SELECT CASE jsonb_typeof(s.value)
        WHEN 'object' THEN s.value
        WHEN 'string' THEN CASE WHEN (s.value #>> '{}') ~ '^\\s*\\{' THEN (s.value #>> '{}')::jsonb END
      END AS cfg) c
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(c.cfg -> 'assignments') = 'object'
      THEN c.cfg -> 'assignments' ELSE '{}'::jsonb END) a
    WHERE s.key = 'roles.config' AND lower(trim(a.key)) = ${email} AND jsonb_typeof(a.value) = 'string'
    LIMIT 1)`;
}

/**
 * Make sure a person has a row. Never overwrites one: an existing row's role,
 * status and overrides are the admin's, and a sign-in must not reset them.
 * `seen` stamps first/last seen, for the paths that mean someone actually
 * arrived (a sign-in, a desktop request) rather than was invited. `roleId`
 * applies only to a row this call creates; without one, a new row takes the
 * person's v1 assignment, if they had one (legacyAssignmentSql), since from
 * the moment a row exists the row alone decides their role (resolveRole).
 */
export async function upsertPerson(email, { seen = false, roleId = null } = {}) {
  const e = normEmail(email);
  if (!sql || !e.includes('@')) return null;
  await ensurePeopleTable();
  await ensureSettingsTable();
  const now = Date.now();
  const at = seen ? now : null;
  const rows = await withSchemaRetry([ensurePeopleTable, ensureSettingsTable], () => sql`
    INSERT INTO people (id, email, role_id, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${e}, COALESCE(${roleId || null}::text, ${legacyAssignmentSql(e)}), ${at}, ${at}, ${now}, ${now})
    ON CONFLICT (email) DO UPDATE SET
      first_seen_at = COALESCE(people.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at  = COALESCE(EXCLUDED.last_seen_at, people.last_seen_at)
    RETURNING *`);
  return shapePerson(rows[0]);
}

export async function getPersonByEmail(email) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  await ensurePeopleTable();
  const rows = await withSchemaRetry(ensurePeopleTable, () => sql`SELECT * FROM people WHERE email = ${e} LIMIT 1`);
  return shapePerson(rows[0]);
}

export async function getPersonById(id) {
  if (!sql || !id) return null;
  await ensurePeopleTable();
  const rows = await withSchemaRetry(ensurePeopleTable, () => sql`SELECT * FROM people WHERE id = ${String(id)} LIMIT 1`);
  return shapePerson(rows[0]);
}

/**
 * Change what an admin may change on a person. Only the keys present are
 * written; null clears an override back to the role's value. Validation is
 * the caller's (the People API checks role ids and the org's ceilings).
 */
export async function updatePerson(email, fields = {}) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  await ensurePeopleTable();
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
  const rows = await withSchemaRetry(ensurePeopleTable, () => sql`
    UPDATE people SET
      role_id          = CASE WHEN ${has('roleId')} THEN ${fields.roleId ?? null} ELSE role_id END,
      quota_bytes      = CASE WHEN ${has('quotaBytes')} THEN ${fields.quotaBytes ?? null}::bigint ELSE quota_bytes END,
      max_upload_bytes = CASE WHEN ${has('maxUploadBytes')} THEN ${fields.maxUploadBytes ?? null}::bigint ELSE max_upload_bytes END,
      ai_monthly_cents = CASE WHEN ${has('aiMonthlyCents')} THEN ${fields.aiMonthlyCents ?? null}::int ELSE ai_monthly_cents END,
      display_name     = CASE WHEN ${has('displayName')} THEN ${fields.displayName ?? null} ELSE display_name END,
      updated_at       = ${Date.now()}
    WHERE email = ${e}
    RETURNING *`);
  return shapePerson(rows[0]);
}

/**
 * Last seen, for the People list. Called at most every ten minutes per
 * person per instance (lib/session.js); the WHERE keeps two instances from
 * both writing within the same window.
 */
export async function touchPersonSeen(email) {
  const e = normEmail(email);
  if (!sql || !e) return;
  const now = Date.now();
  try {
    await sql`
      UPDATE people SET last_seen_at = ${now}, first_seen_at = COALESCE(first_seen_at, ${now})
      WHERE email = ${e} AND (last_seen_at IS NULL OR last_seen_at < ${now - 10 * 60_000})`;
  } catch { /* a missed "last seen" is not worth a failed request */ }
}

/**
 * Suspend or reactivate. Suspending also ends every session: the cutoff
 * moves to now, so a browser signed in before it is signed out on its next
 * request (lib/session.js), and every desktop token is deleted. Drive grants
 * and files stay, which is what makes it reversible.
 */
export async function setPersonStatus(email, { status, reason = null, by = null, pauseLinks = true } = {}) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  if (!PERSON_STATUSES.includes(status)) throw new Error(`Unknown status "${status}".`);
  await ensurePeopleTable();
  await upsertPerson(e);
  const now = Date.now();
  const suspending = status === 'suspended';
  const rows = await sql`
    UPDATE people SET
      status = ${status},
      status_reason = ${suspending ? (reason || null) : null},
      status_changed_at = ${now},
      status_changed_by = ${by || null},
      pause_links = ${suspending ? pauseLinks !== false : true},
      sessions_valid_after = CASE WHEN ${suspending} THEN ${now}::bigint ELSE sessions_valid_after END,
      updated_at = ${now}
    WHERE email = ${e}
    RETURNING *`;
  let devices = 0;
  if (suspending) devices = (await revokePersonDevices(e)).devices;
  return { person: shapePerson(rows[0]), devices };
}

/** Every desktop token and pending pairing code for an address, gone. */
async function revokePersonDevices(email) {
  await ensureDesktopAuthTables();
  const tokens = await sql`DELETE FROM desktop_tokens WHERE email = ${email} RETURNING id`;
  await sql`DELETE FROM desktop_auth_codes WHERE email = ${email}`;
  return { devices: tokens.length };
}

/**
 * Sign out everywhere: every browser session issued before now stops being
 * honoured on its next request, and every desktop token is revoked.
 */
export async function signOutEverywhere(email) {
  const e = normEmail(email);
  if (!sql || !e) return { devices: 0 };
  await upsertPerson(e);
  await sql`UPDATE people SET sessions_valid_after = ${Date.now()}, updated_at = ${Date.now()} WHERE email = ${e}`;
  return revokePersonDevices(e);
}

/**
 * What getSessionUser needs about a signed-in address, in one round trip:
 * their people row, their invite's status, their picture, and — for a web
 * session the Mac app made from a device token — whether that token still
 * exists. Revoking the device then ends the web view's session too.
 */
export async function sessionRowFor(email, deviceTokenId = null) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  const now = Date.now();
  const rows = await withSchemaRetry(
    [ensurePeopleTable, ensureInviteRequestsTable, ensureAvatarsTable, ensureDesktopAuthTables],
    () => sql`
      SELECT p.*,
             (SELECT status FROM invite_requests WHERE email = ${e} LIMIT 1) AS invite_status,
             a.id AS avatar_id, a.version AS avatar_version,
             CASE WHEN ${deviceTokenId}::text IS NULL THEN true
                  ELSE EXISTS (SELECT 1 FROM desktop_tokens t
                               WHERE t.id = ${deviceTokenId} AND t.email = ${e}
                                 AND (t.expires_at IS NULL OR t.expires_at >= ${now}))
             END AS device_ok
      FROM (SELECT 1) AS one
      LEFT JOIN people p ON p.email = ${e}
      LEFT JOIN user_avatars a ON a.email = ${e}`,
  );
  const r = rows[0] || {};
  return {
    person: shapePerson(r),
    inviteStatus: r.invite_status || null,
    avatar: r.avatar_id ? { id: r.avatar_id, version: String(r.avatar_version) } : null,
    deviceOk: r.device_ok !== false,
  };
}

/**
 * The one-time seed the People list runs on first load: everyone who has
 * signed in, every approved invite and every env admin gets a row, and v1's
 * role assignments are copied onto them. ON CONFLICT DO NOTHING and "only
 * where role_id is still empty", so running it again changes nothing an
 * admin has set since.
 */
export async function backfillPeople({ adminEmails = [], assignments = {} } = {}) {
  if (!sql) return { added: 0, roles: 0 };
  await ensurePeopleTable();
  await ensureInviteRequestsTable();
  await ensureAuthTables();
  const now = Date.now();
  const admins = adminEmails.map(normEmail).filter((e) => e.includes('@'));
  const added = await withSchemaRetry(ensurePeopleTable, () => sql`
    INSERT INTO people (id, email, first_seen_at, created_at, updated_at)
    SELECT gen_random_uuid()::text, e.email, MIN(e.seen), ${now}, ${now}
    FROM (
      SELECT lower(email) AS email, ${now}::bigint AS seen FROM "user" WHERE email IS NOT NULL
      UNION ALL
      SELECT lower(email), NULL FROM invite_requests WHERE status = 'approved'
      UNION ALL
      SELECT unnest(${admins}::text[]), NULL
    ) e
    WHERE e.email LIKE '%@%'
    GROUP BY e.email
    ON CONFLICT (email) DO NOTHING
    RETURNING id`);
  const pairs = Object.entries(assignments || {}).filter(([e, id]) => e.includes('@') && typeof id === 'string');
  let roles = 0;
  if (pairs.length) {
    const r = await sql`
      UPDATE people p SET role_id = a.role_id, updated_at = ${now}
      FROM unnest(${pairs.map(([e]) => normEmail(e))}::text[], ${pairs.map(([, id]) => id)}::text[]) AS a(email, role_id)
      WHERE p.email = a.email AND p.role_id IS NULL
      RETURNING p.id`;
    roles = r.length;
  }
  return { added: added.length, roles };
}

/** Bytes of live files this person added — what their storage quota counts. */
export async function usedBytesBy(email) {
  const e = normEmail(email);
  if (!sql || !e) return 0;
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT COALESCE(SUM(size), 0)::bigint AS bytes FROM files
    WHERE created_by = ${e} AND deleted_at IS NULL`);
  return Number(rows[0]?.bytes) || 0;
}

const PEOPLE_SORTS = {
  // The later of a web visit and a desktop request.
  active: 'GREATEST(COALESCE(p.last_seen_at, 0), COALESCE(dev.last_used, 0)) DESC, p.email ASC',
  name: "lower(COALESCE(p.display_name, i.name, u.name, p.email)) ASC, p.email ASC",
  storage: 'COALESCE(st.bytes, 0) DESC, p.email ASC',
};

/**
 * The People list: one statement joining people, their invite, their Auth.js
 * user, and counts of drives, bytes and devices. `status` is 'active',
 * 'invited' (approved but never signed in), 'suspended' or 'admins';
 * `roleIds` narrows to people holding one of those roles, `defaultRole`
 * says which one a NULL role_id means. Paged by offset: this is a list of
 * people, hundreds at most, sorted by things that change.
 */
export async function listPeople({ q = '', status = '', roleIds = null, defaultRole = 'member', adminEmails = [], sort = 'active', offset = 0, limit = 100 } = {}) {
  if (!sql) return { rows: [], total: 0 };
  await Promise.all([ensurePeopleTable(), ensureInviteRequestsTable(), ensureFilespacesTables(), ensureDesktopAuthTables(), ensureFilesTable(), ensureAuthTables()]);
  const now = Date.now();
  const admins = adminEmails.map(normEmail);
  const needle = String(q || '').trim().toLowerCase();
  const like = needle ? `%${escapeLike(needle)}%` : null;
  const order = PEOPLE_SORTS[sort] || PEOPLE_SORTS.active;
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const off = Math.max(0, Number(offset) || 0);
  const roles = Array.isArray(roleIds) ? roleIds.map(String) : null;
  const signedIn = sql`(u.id IS NOT NULL OR p.first_seen_at IS NOT NULL)`;
  const statusClause =
    status === 'active' ? sql`AND p.status = 'active' AND ${signedIn}`
    : status === 'invited' ? sql`AND p.status = 'active' AND NOT ${signedIn}`
    : status === 'suspended' ? sql`AND p.status = 'suspended'`
    : status === 'admins' ? sql`AND p.email = ANY(${admins}::text[])`
    : sql``;
  const roleClause = roles
    ? sql`AND NOT (p.email = ANY(${admins}::text[]))
          AND (p.role_id = ANY(${roles}::text[]) OR (p.role_id IS NULL AND ${defaultRole}::text = ANY(${roles}::text[])))`
    : sql``;
  const rows = await withSchemaRetry([ensurePeopleTable, ensureFilesTable], () => sql`
    SELECT p.*, i.status AS invite_status, i.name AS invite_name,
           i.reviewed_by AS invite_reviewed_by, i.reviewed_at AS invite_reviewed_at,
           u.name AS user_name, (u.id IS NOT NULL) AS has_user,
           COALESCE(d.n, 0)::int AS drives,
           COALESCE(st.bytes, 0)::bigint AS bytes,
           COALESCE(dev.n, 0)::int AS devices, dev.last_used AS device_last_used,
           COUNT(*) OVER ()::int AS total
    FROM people p
    LEFT JOIN invite_requests i ON i.email = p.email
    LEFT JOIN LATERAL (SELECT id, name FROM "user" WHERE lower(email) = p.email LIMIT 1) u ON true
    LEFT JOIN LATERAL (SELECT COUNT(*) AS n FROM filespace_access fa WHERE fa.user_email = p.email) d ON true
    LEFT JOIN LATERAL (SELECT SUM(f.size) AS bytes FROM files f WHERE f.created_by = p.email AND f.deleted_at IS NULL) st ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n, MAX(t.last_used_at) AS last_used FROM desktop_tokens t
      WHERE t.email = p.email AND (t.expires_at IS NULL OR t.expires_at >= ${now})
    ) dev ON true
    WHERE (${like}::text IS NULL
           OR p.email LIKE ${like} OR lower(p.display_name) LIKE ${like}
           OR lower(i.name) LIKE ${like} OR lower(u.name) LIKE ${like})
      ${statusClause}
      ${roleClause}
    ORDER BY ${sql.unsafe(order)}
    LIMIT ${lim} OFFSET ${off}`);
  return {
    rows: rows.map((r) => ({
      person: shapePerson(r),
      inviteStatus: r.invite_status || null,
      inviteName: r.invite_name || null,
      userName: r.user_name || null,
      hasUser: !!r.has_user,
      drives: Number(r.drives) || 0,
      bytes: Number(r.bytes) || 0,
      devices: Number(r.devices) || 0,
      deviceLastUsedAt: numOrNull(r.device_last_used),
      reviewedBy: r.invite_reviewed_by || null,
      reviewedAt: numOrNull(r.invite_reviewed_at),
    })),
    total: rows[0] ? Number(rows[0].total) || 0 : 0,
    offset: off,
    limit: lim,
  };
}

/** Everything the person drawer shows, other than the audit trail. */
export async function personDetail(email) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  await Promise.all([ensurePeopleTable(), ensureInviteRequestsTable(), ensureFilespacesTables(), ensureSharesTable(), ensureFilesTable(), ensureAuthTables()]);
  const [[head], drives, links, devices, [usage]] = await withSchemaRetry([ensurePeopleTable, ensureFilespacesTables, ensureSharesTable], () => Promise.all([
    sql`
      SELECT p.*, i.status AS invite_status, i.name AS invite_name,
             i.reviewed_by AS invite_reviewed_by, i.reviewed_at AS invite_reviewed_at,
             (SELECT name FROM "user" WHERE lower(email) = ${e} LIMIT 1) AS user_name,
             EXISTS (SELECT 1 FROM "user" WHERE lower(email) = ${e}) AS has_user
      FROM (SELECT 1) one
      LEFT JOIN people p ON p.email = ${e}
      LEFT JOIN invite_requests i ON i.email = ${e}`,
    sql`
      SELECT a.filespace_id, a.role, a.granted_by, a.granted_at, f.name, f.bucket, f.prefix
      FROM filespace_access a JOIN filespaces f ON f.id = a.filespace_id
      WHERE a.user_email = ${e} ORDER BY lower(f.name)`,
    sql`
      SELECT s.token, s.file_id, s.kind, s.mode, (s.password_hash IS NOT NULL) AS has_password,
             s.expires_at, s.view_count, s.created_at, f.name AS file_name
      FROM file_shares s LEFT JOIN files f ON f.id = s.file_id
      WHERE s.created_by = ${e} ORDER BY s.created_at DESC LIMIT 200`,
    listDesktopTokens(e),
    sql`SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes FROM files WHERE created_by = ${e} AND deleted_at IS NULL`,
  ]));
  return {
    person: shapePerson(head),
    inviteStatus: head?.invite_status || null,
    inviteName: head?.invite_name || null,
    userName: head?.user_name || null,
    hasUser: !!head?.has_user,
    reviewedBy: head?.invite_reviewed_by || null,
    reviewedAt: numOrNull(head?.invite_reviewed_at),
    drives: drives.map((d) => ({
      filespaceId: d.filespace_id, name: d.name, bucket: d.bucket, prefix: d.prefix,
      role: d.role || 'viewer', grantedBy: d.granted_by || null, grantedAt: numOrNull(d.granted_at),
    })),
    links: links.map((l) => ({
      token: l.token, fileId: l.file_id || null, fileName: l.file_name || null,
      kind: (l.mode || 'public') === 'private' ? 'private' : l.has_password ? 'password' : 'public',
      target: l.kind || 'file',
      expiresAt: numOrNull(l.expires_at), viewCount: Number(l.view_count) || 0, createdAt: numOrNull(l.created_at),
    })),
    devices,
    usage: { files: Number(usage?.files) || 0, bytes: Number(usage?.bytes) || 0 },
  };
}

/**
 * What removing a person takes with it, counted — the preview the Remove
 * confirmation states — or, with `apply`, done. Their files stay, with
 * created_by as it was: the library is the org's, not theirs.
 *
 * Deleted: drive grants, their user-subject folder and file grants, desktop
 * tokens and codes, their picture, the links they made, notifications
 * addressed to them, and their people, invite and Auth.js user rows (the
 * last cascades to their sessions and accounts). There are no foreign keys
 * here, so each is its own statement; a failure part-way leaves a person
 * with fewer grants, never more.
 */
export async function removePerson(email, { apply = false } = {}) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  await Promise.all([
    ensurePeopleTable(), ensureInviteRequestsTable(), ensureFilespacesTables(), ensureFolderAclTable(),
    ensureFileAclTable(), ensureDesktopAuthTables(), ensureAvatarsTable(), ensureSharesTable(),
    ensureNotificationsTable(), ensureFilesTable(), ensureAuthTables(),
  ]);
  const [[c]] = await withSchemaRetry([ensurePeopleTable, ensureSharesTable], () => Promise.all([sql`
    SELECT
      (SELECT COUNT(*) FROM filespace_access WHERE user_email = ${e})::int AS drives,
      (SELECT COUNT(*) FROM folder_access WHERE subject_type = 'user' AND subject = ${e})::int AS folder_grants,
      (SELECT COUNT(*) FROM file_acl WHERE scope = 'user' AND principal = ${e})::int AS file_grants,
      (SELECT COUNT(*) FROM desktop_tokens WHERE email = ${e})::int AS devices,
      (SELECT COUNT(*) FROM file_shares WHERE lower(created_by) = ${e})::int AS links,
      (SELECT COUNT(*) FROM notifications WHERE lower(user_email) = ${e})::int AS notifications,
      (SELECT COUNT(*) FROM files WHERE created_by = ${e} AND deleted_at IS NULL)::int AS files,
      (SELECT COALESCE(SUM(size), 0) FROM files WHERE created_by = ${e} AND deleted_at IS NULL)::bigint AS bytes,
      EXISTS (SELECT 1 FROM people WHERE email = ${e}) AS has_person,
      EXISTS (SELECT 1 FROM invite_requests WHERE email = ${e}) AS has_invite,
      EXISTS (SELECT 1 FROM "user" WHERE lower(email) = ${e}) AS has_user`]));
  const impact = {
    email: e,
    drives: c.drives, folderGrants: c.folder_grants, fileGrants: c.file_grants,
    devices: c.devices, links: c.links, notifications: c.notifications,
    filesKept: c.files, bytesKept: Number(c.bytes) || 0,
    exists: !!(c.has_person || c.has_invite || c.has_user),
  };
  if (!apply) return impact;

  await sql`DELETE FROM filespace_access WHERE user_email = ${e}`;
  await sql`DELETE FROM folder_access WHERE subject_type = 'user' AND subject = ${e}`;
  await sql`DELETE FROM file_acl WHERE scope = 'user' AND principal = ${e}`;
  await sql`DELETE FROM desktop_tokens WHERE email = ${e}`;
  await sql`DELETE FROM desktop_auth_codes WHERE email = ${e}`;
  await sql`DELETE FROM user_avatars WHERE email = ${e}`;
  await sql`DELETE FROM file_shares WHERE lower(created_by) = ${e}`;
  await sql`DELETE FROM notifications WHERE lower(user_email) = ${e}`;
  await sql`DELETE FROM people WHERE email = ${e}`;
  await sql`DELETE FROM invite_requests WHERE lower(email) = ${e}`;
  await sql`DELETE FROM "user" WHERE lower(email) = ${e}`;
  return { ...impact, removed: true };
}

/** The status chips' counts: everyone, active, invited, suspended, admins. */
export async function peopleCounts({ adminEmails = [] } = {}) {
  if (!sql) return { all: 0, active: 0, invited: 0, suspended: 0, admins: 0 };
  await Promise.all([ensurePeopleTable(), ensureAuthTables()]);
  const admins = adminEmails.map(normEmail);
  const [r] = await withSchemaRetry(ensurePeopleTable, () => sql`
    WITH p AS (
      SELECT p.email, p.status,
             (p.first_seen_at IS NOT NULL OR EXISTS (SELECT 1 FROM "user" u WHERE lower(u.email) = p.email)) AS signed_in
      FROM people p
    )
    SELECT COUNT(*)::int AS everyone,
           COUNT(*) FILTER (WHERE status = 'active' AND signed_in)::int AS active,
           COUNT(*) FILTER (WHERE status = 'active' AND NOT signed_in)::int AS invited,
           COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
           COUNT(*) FILTER (WHERE email = ANY(${admins}::text[]))::int AS admins
    FROM p`);
  return {
    all: Number(r?.everyone) || 0, active: Number(r?.active) || 0, invited: Number(r?.invited) || 0,
    suspended: Number(r?.suspended) || 0, admins: Number(r?.admins) || 0,
  };
}

/** Addresses whose row holds one of these role ids — the retired full-access ones, for the banner. */
export async function peopleWithRoles(roleIds = []) {
  if (!sql || !roleIds.length) return [];
  await ensurePeopleTable();
  const rows = await withSchemaRetry(ensurePeopleTable, () => sql`
    SELECT email FROM people WHERE role_id = ANY(${roleIds}::text[]) ORDER BY email`);
  return rows.map((r) => r.email);
}

/** How many people hold each role id (NULL counted as the default). */
export async function countPeopleByRole(defaultRole = 'member') {
  if (!sql) return {};
  await ensurePeopleTable();
  const rows = await withSchemaRetry(ensurePeopleTable, () => sql`
    SELECT COALESCE(role_id, ${defaultRole}) AS role_id, COUNT(*)::int AS n FROM people GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [r.role_id, Number(r.n) || 0]));
}

/** Deleting a custom role: its people fall back to the default role. */
export async function clearRoleAssignments(roleIds = []) {
  if (!sql || !roleIds.length) return 0;
  await ensurePeopleTable();
  const rows = await withSchemaRetry(ensurePeopleTable, () => sql`
    UPDATE people SET role_id = NULL, updated_at = ${Date.now()} WHERE role_id = ANY(${roleIds}::text[]) RETURNING id`);
  return rows.length;
}

/**
 * Of these addresses, the ones whose links are paused: suspended with
 * pause_links set. resolveShareAccess asks for one creator at a time.
 */
export async function isLinkCreatorPaused(email) {
  const e = normEmail(email);
  if (!sql || !e) return false;
  const rows = await withSchemaRetry(ensurePeopleTable, () => sql`
    SELECT 1 FROM people WHERE email = ${e} AND status = 'suspended' AND pause_links LIMIT 1`);
  return rows.length > 0;
}

// ─── Audit ──────────────────────────────────────────────────────────────────
// Who did what to whom, for the admin panel's Activity and the per-person and
// per-drive slices in its drawers. Written through lib/audit.js, which never
// throws: a failed audit write must not fail the thing it records.
//
//   actor    an email, 'guest:<id>' for a review-link guest, or 'system'
//   action   'person.role', 'drive.grant', 'share.revoke', …
//   subject  what it was done to: a type, an id, and a label that outlives
//            the thing itself (a removed person's address, a deleted file's
//            name). A person's subject id is their email, so their history
//            survives their removal and a re-invite.
const ensureAuditTable = lazySchema('ensureAuditTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id            TEXT PRIMARY KEY,
      at            BIGINT NOT NULL,
      actor         TEXT,
      action        TEXT NOT NULL,
      subject_type  TEXT,
      subject_id    TEXT,
      subject_label TEXT,
      detail        JSONB
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS audit_events_at_idx ON audit_events (at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS audit_events_subject_idx ON audit_events (subject_type, subject_id, at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor, at DESC)`;
});

export async function insertAuditEvent({ actor = null, action, subjectType = null, subjectId = null, subjectLabel = null, detail = null } = {}) {
  if (!sql || !action) return null;
  await ensureAuditTable();
  const id = crypto.randomUUID();
  const at = Date.now();
  await withSchemaRetry(ensureAuditTable, () => sql`
    INSERT INTO audit_events (id, at, actor, action, subject_type, subject_id, subject_label, detail)
    VALUES (${id}, ${at}, ${actor}, ${String(action)}, ${subjectType}, ${subjectId != null ? String(subjectId) : null},
            ${subjectLabel != null ? String(subjectLabel).slice(0, 500) : null}, ${detail ? sql.json(detail) : null})`);
  return { id, at };
}

const shapeAudit = (r) => ({
  id: r.id, at: Number(r.at) || null, actor: r.actor || null, action: r.action,
  subject: r.subject_type ? { type: r.subject_type, id: r.subject_id || null, label: r.subject_label || null } : null,
  detail: r.detail && typeof r.detail === 'object' ? r.detail : null,
});

/**
 * Newest first. `person` is an email: events by them or about them.
 * `before` pages: the `at` of the last event already shown.
 */
export async function listAuditEvents({ actor = null, action = null, subjectType = null, subjectId = null, person = null, before = null, limit = 50 } = {}) {
  if (!sql) return [];
  await ensureAuditTable();
  const p = person ? normEmail(person) : null;
  const rows = await withSchemaRetry(ensureAuditTable, () => sql`
    SELECT * FROM audit_events
    WHERE (${actor}::text IS NULL OR actor = ${actor})
      AND (${action}::text IS NULL OR action = ${action} OR action LIKE ${action ? `${escapeLike(action)}.%` : null})
      AND (${subjectType}::text IS NULL OR subject_type = ${subjectType})
      AND (${subjectId}::text IS NULL OR subject_id = ${subjectId})
      AND (${p}::text IS NULL OR actor = ${p} OR (subject_type = 'person' AND subject_id = ${p}))
      AND (${before}::bigint IS NULL OR at < ${before})
    ORDER BY at DESC, id DESC
    LIMIT ${Math.max(1, Math.min(Number(limit) || 50, 500))}`);
  return rows.map(shapeAudit);
}

/** Maintenance keeps a year. */
export async function pruneAuditEvents(olderThanMs) {
  if (!sql) return 0;
  await ensureAuditTable();
  const rows = await withSchemaRetry(ensureAuditTable, () => sql`
    DELETE FROM audit_events WHERE at < ${Number(olderThanMs)} RETURNING id`);
  return rows.length;
}

// ─── Maintenance runs ───────────────────────────────────────────────────────
// One row per run of lib/maintenance.js, from the daily cron or an admin's
// Run now, so Health can show when it last ran, how long it took and what it
// did — the cron's response used to be the only record, and nobody reads it.
const ensureMaintenanceRunsTable = lazySchema('ensureMaintenanceRunsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS maintenance_runs (
      id           TEXT PRIMARY KEY,
      trigger      TEXT NOT NULL,
      triggered_by TEXT,
      started_at   BIGINT NOT NULL,
      finished_at  BIGINT,
      ok           BOOLEAN,
      result       JSONB
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS maintenance_runs_started_idx ON maintenance_runs (started_at DESC)`;
});

export async function startMaintenanceRun({ trigger, by = null }) {
  if (!sql) return null;
  await ensureMaintenanceRunsTable();
  const id = crypto.randomUUID();
  await withSchemaRetry(ensureMaintenanceRunsTable, () => sql`
    INSERT INTO maintenance_runs (id, trigger, triggered_by, started_at)
    VALUES (${id}, ${String(trigger)}, ${by}, ${Date.now()})`);
  return id;
}

export async function finishMaintenanceRun(id, { ok, result }) {
  if (!sql || !id) return;
  await withSchemaRetry(ensureMaintenanceRunsTable, () => sql`
    UPDATE maintenance_runs SET finished_at = ${Date.now()}, ok = ${!!ok}, result = ${sql.json(result || {})}
    WHERE id = ${id}`);
}

export async function listMaintenanceRuns({ limit = 10 } = {}) {
  if (!sql) return [];
  await ensureMaintenanceRunsTable();
  const rows = await withSchemaRetry(ensureMaintenanceRunsTable, () => sql`
    SELECT * FROM maintenance_runs ORDER BY started_at DESC LIMIT ${Math.max(1, Math.min(Number(limit) || 10, 100))}`);
  return rows.map((r) => ({
    id: r.id, trigger: r.trigger, triggeredBy: r.triggered_by || null,
    startedAt: Number(r.started_at) || null, finishedAt: numOrNull(r.finished_at),
    ok: r.ok == null ? null : !!r.ok, result: r.result && typeof r.result === 'object' ? r.result : null,
  }));
}

// ─── Files — file manager cataloging all brand content across
// folders, regardless of where the bytes live (Vercel Blob or a custom bucket). ──
const ensureFilesTable = lazySchema('ensureFilesTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT DEFAULT '',
      kind TEXT,
      mime TEXT,
      size BIGINT,
      url TEXT NOT NULL,
      storage TEXT DEFAULT 'blob',
      storage_key TEXT,
      tags JSONB,
      notes TEXT,
      created_by TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS brand_files_folder_idx ON files (folder)`;
  await sql`CREATE INDEX IF NOT EXISTS brand_files_created_idx ON files (created_at DESC)`;
  // Library v2 (Phase 1): visibility + caption. AI catalog columns land in P2.
  // DEFAULT 'org' (visible to all signed-in users) backfills every existing
  // row on first ADD COLUMN — preserving the Library's current openness with
  // no separate migration. Restrictions ('owner'/'custom') become explicit.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'org'`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS caption TEXT`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS captioned_at BIGINT`;
  // Small generated thumbnail (grid loads this instead of the full original).
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail_key TEXT`;
  // The hover-scrub sprite sheet: 40 frames of the clip tiled into one image,
  // made in the browser at upload. Its own column rather than a metadata field
  // because presignFileUrls has to sign it, and that lookup wants a column.
  // Its geometry (frames, columns, tile size) lives in metadata.filmstrip,
  // which is where the player reads it from.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS filmstrip_key TEXT`;
  // A video's player poster: the grid thumbnail's frame at up to 1920px, for
  // the detail page's stage, where the grid-sized one would be enlarged
  // (lib/poster.js). A column for the same reason as filmstrip_key. Partial
  // index: most rows are not videos, and the lookup is only ever "does any
  // row still point at this poster" before a replaced one is deleted.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS poster_key TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS files_poster_key_idx ON files (poster_key) WHERE poster_key IS NOT NULL`;
  // Trash: soft-delete. deleted_at set = in trash (hidden from listings, kept
  // for 60 days). trash_key = where the S3 object now lives (moved out of the
  // mounted prefix so it disappears from Finder); storage_key stays as the
  // original location to restore back to.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at BIGINT`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS trash_key TEXT`;
  // Who moved it to the trash, for Admin → Trash. NULL for rows trashed
  // before the column existed.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_by TEXT`;
  // Thumbnail generation queue state: null/unqueued, 'pending', 'processing',
  // 'ready', 'error', 'skip'. Server-side worker (lib/thumbs.js) drains it.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS thumb_status TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS brand_files_thumb_status_idx ON files (thumb_status)`;
  await sql`CREATE INDEX IF NOT EXISTS brand_files_kind_idx ON files (kind)`;
  // DAM: flexible per-asset metadata (admin-defined field schema lives in
  // settings 'file.metadata.schema'). DEFAULT '{}' backfills existing rows.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`;
  try { await sql`CREATE INDEX IF NOT EXISTS brand_files_metadata_gin ON files USING GIN (metadata jsonb_path_ops)`; } catch (e) { console.warn('[ensureFilesTable] metadata GIN:', e.message); }
  try { await sql`CREATE INDEX IF NOT EXISTS brand_files_tags_gin ON files USING GIN (tags jsonb_path_ops)`; } catch (e) { console.warn('[ensureFilesTable] tags GIN:', e.message); }

  // ── Change cursor ───────────────────────────────────────────────────────
  // A monotonic sequence stamped on every insert and update, and on the
  // tombstone a delete leaves behind. This is what makes "what changed since
  // X?" answerable, which is what the iOS File Provider's
  // enumerateChanges(from: anchor) needs.
  //
  // updated_at is NOT a safe cursor: two writes in the same millisecond can
  // straddle a client's anchor and one of them is then never delivered. A
  // sequence has no ties by construction.
  await sql`CREATE SEQUENCE IF NOT EXISTS files_change_seq`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS seq BIGINT`;
  await sql`CREATE INDEX IF NOT EXISTS files_seq_idx ON files (seq)`;
  // A syncing client needs two version tokens per item, and they answer
  // different questions. `version` changes on any write and is what an
  // If-Match precondition compares, so a second writer cannot silently
  // clobber the first. `content_hash` changes only when the BYTES change,
  // which is how a client tells "renamed" from "re-uploaded" without a HEAD
  // to S3 per item — the per-stat network call a File Provider exists to
  // avoid. Rows predating this read as version 1 with a null hash, which
  // means "content unknown" and costs one HEAD, once.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash TEXT`;
  // Stamp rows that predate the column so no existing file is invisible to a
  // first sync. Cheap and idempotent — after the first run it matches nothing.
  await sql`UPDATE files SET seq = nextval('files_change_seq') WHERE seq IS NULL`;

  // ── Full-text search ────────────────────────────────────────────────────
  // A generated column, so it can never drift from the row it describes —
  // there is no trigger to forget and no backfill to run. to_tsvector with a
  // literal config is immutable, which is what makes it legal here.
  try {
    await sql`
      ALTER TABLE files ADD COLUMN IF NOT EXISTS search_tsv tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(name, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(caption, ''))
      ) STORED`;
    await sql`CREATE INDEX IF NOT EXISTS files_search_idx ON files USING GIN (search_tsv)`;
  } catch (e) { console.warn('[ensureFilesTable] search_tsv:', e.message); }

  // ── Keyset pagination ───────────────────────────────────────────────────
  // Composite indexes matching the (sort column, id) ordering the listing
  // uses. Without the id term the index cannot serve the row-value
  // comparison that makes deep pages cheap.
  await sql`CREATE INDEX IF NOT EXISTS files_created_id_idx ON files (created_at DESC, id DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS files_name_id_idx ON files (name ASC, id ASC)`;
  // Supports the legacy-thumbnail NOT EXISTS in the listing.
  await sql`CREATE INDEX IF NOT EXISTS files_thumbnail_key_idx ON files (thumbnail_key)`;
  // The sidebar's folder counts (listFileFolders) GROUP BY folder over live
  // rows. Partial on deleted_at, so that count is an index-only scan rather
  // than a read of the whole table on every listing request.
  await sql`CREATE INDEX IF NOT EXISTS files_live_folder_idx ON files (folder) WHERE deleted_at IS NULL`;
  // Duplicates (listDuplicateFiles) are live rows sharing a content hash and
  // a size. Partial, so the rows with no hash yet — every file from before
  // hashes were taken — cost the index nothing.
  await sql`CREATE INDEX IF NOT EXISTS files_content_hash_idx ON files (content_hash, size) WHERE deleted_at IS NULL AND content_hash IS NOT NULL`;

});

// ── Indexes for large libraries ─────────────────────────────────────────────
// Opening a folder is "this folder, in this order, the next 100 after the
// cursor". Without an index that leads with the folder AND continues with
// the sort, Postgres reads every row in the folder and sorts them to return
// a page: measured at 500k files, a 66k-file folder by size took 290ms, and
// a name search for a fragment 690ms. With these, both are a page read.
//
//   files_folder_*      one per sort the listing offers (lib/file-query.js,
//                       SORTS), led by the folder, partial on live rows. Each
//                       serves both directions — a backward scan is the DESC
//                       order. The expressions must match sortExpr exactly or
//                       the planner will not use them.
//   files_name_trgm_idx trigram index on the name, for the ILIKE '%fragment%'
//                       half of search, which no b-tree can serve. Needs the
//                       pg_trgm extension; without it (no privilege to create
//                       it) search still works, by scanning.
//   files_live_key_idx  prefix scans of storage_key — a drive's files, and
//                       its usage — with the size carried in the index so
//                       COUNT/SUM never visit the table.
//   files_created_by_size_idx
//                       the bytes one person has added, for their quota.
//
// Built CONCURRENTLY, so a table with millions of rows keeps taking writes
// while they build, and outside the request path: this guard is not awaited
// by any read — only ensureSchema (the maintenance cron, /api/health, `npm
// run doctor`, dev:local) runs it. A build can outlast the 15s query
// deadline, so it runs on a connection of its own with a long one; and a
// concurrent build that failed part-way leaves an INVALID index that IF NOT
// EXISTS would skip for ever, so an invalid index that is not still being
// built is dropped and built again.
const FILE_INDEXES = [
  ['files_folder_created_idx', 'ON files (folder, created_at, id) WHERE deleted_at IS NULL'],
  ['files_folder_name_idx', 'ON files (folder, name, id) WHERE deleted_at IS NULL'],
  ['files_folder_size_idx', 'ON files (folder, (coalesce(size, -1)), id) WHERE deleted_at IS NULL'],
  ['files_folder_updated_idx', 'ON files (folder, updated_at, id) WHERE deleted_at IS NULL'],
  ['files_folder_mime_idx', "ON files (folder, (coalesce(mime, '')), id) WHERE deleted_at IS NULL"],
  ['files_live_key_idx', 'ON files (storage_key text_pattern_ops) INCLUDE (size) WHERE deleted_at IS NULL'],
  ['files_name_trgm_idx', 'ON files USING GIN (name gin_trgm_ops) WHERE deleted_at IS NULL', 'pg_trgm'],
  // What one person has added: their storage quota (usedBytesBy) and the
  // People list's Storage column, without reading every row they own.
  ['files_created_by_size_idx', 'ON files (created_by, size) WHERE deleted_at IS NULL'],
];
export const FILE_INDEX_NAMES = FILE_INDEXES.map(([name]) => name);
const INDEX_BUILD_DEADLINE_MS = 30 * 60_000;

const ensureFileIndexes = lazySchema('ensureFileIndexes', async () => {
  if (!connectionString) return;
  await ensureFilesTable();
  const ddl = withQueryDeadlines(createSqlClient(), INDEX_BUILD_DEADLINE_MS);
  try {
    let trgm = true;
    try {
      await ddl`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    } catch (e) {
      trgm = false;
      console.warn('[ensureFileIndexes] pg_trgm unavailable, name search will scan:', e.message);
    }
    const state = await ddl`
      SELECT c.relname AS name, i.indisvalid AS valid,
             EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = c.oid) AS building
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ANY(${FILE_INDEX_NAMES})
    `;
    for (const [name, definition, needs] of FILE_INDEXES) {
      if (needs === 'pg_trgm' && !trgm) continue;
      const found = state.find((r) => r.name === name);
      if (found?.valid || found?.building) continue;
      // Constants from the table above, never input: unsafe() only because
      // an index name cannot be a bound parameter.
      if (found) await ddl.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      await ddl.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ${definition}`);
    }
  } finally {
    await ddl.end?.({ timeout: 5 }).catch(() => {});
  }
});

// ── Thumbnail generation queue ─────────────────────────────────────────────
// Server-side worker (lib/thumbs.js) generates previews so the browser never
// has to. enqueue → claim (atomic, concurrency-safe) → mark ready/error.

/** Mark image/video S3 files that lack a thumbnail (and aren't queued) pending. */
export async function enqueueMissingThumbs() {
  if (!sql) return 0;
  await ensureFilesTable();
  try {
    // Recover rows a dead worker left stuck in 'processing' (claimed but never
    // finished — stamped >5 min ago). Safe: an actively-processing row's
    // updated_at is recent (set at claim) so it isn't touched.
    const stale = Date.now() - 5 * 60 * 1000;
    await sql`UPDATE files SET thumb_status = 'pending' WHERE thumb_status = 'processing' AND updated_at < ${stale}`;
    const rows = await sql`
      UPDATE files SET thumb_status = 'pending'
      WHERE thumb_status IS NULL
        AND thumbnail_key IS NULL
        AND deleted_at IS NULL
        AND storage = 's3'
        AND kind IN ('image', 'video')
      RETURNING id`;
    return rows.length;
  } catch (e) { console.warn('[enqueueMissingThumbs]', e.message); return 0; }
}

/** Atomically claim up to `limit` pending files (FOR UPDATE SKIP LOCKED so
 *  concurrent workers/cron runs never grab the same row). Sets them 'processing'. */
export async function claimPendingThumbs(limit = 8) {
  if (!sql) return [];
  await ensureFilesTable();
  try {
    const now = Date.now();
    const rows = await sql`
      WITH c AS (
        SELECT id FROM files
        WHERE thumb_status = 'pending'
        ORDER BY created_at DESC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE files b SET thumb_status = 'processing', updated_at = ${now}
      FROM c WHERE b.id = c.id
      RETURNING b.id, b.storage_key AS "storageKey", b.kind, b.name, b.size`;
    return rows;
  } catch (e) { console.warn('[claimPendingThumbs]', e.message); return []; }
}

export async function markThumbReady(id, thumbnailKey, thumbnailUrl) {
  if (!sql) return;
  // A poster appearing is a change worth syncing — it is what a client shows.
  try {
    await sql`
      UPDATE files
      SET thumb_status = 'ready', thumbnail_key = ${thumbnailKey},
          thumbnail_url = ${thumbnailUrl || null},
          updated_at = ${Date.now()}, seq = nextval('files_change_seq')
      WHERE id = ${id}`;
  }
  catch (e) { console.warn('[markThumbReady]', e.message); }
}

export async function markThumbStatus(id, status) {
  if (!sql) return;
  try { await sql`UPDATE files SET thumb_status = ${status} WHERE id = ${id}`; }
  catch (e) { console.warn('[markThumbStatus]', e.message); }
}

/**
 * Record a thumbnail a browser made for an existing file, with the width,
 * height and duration it read on the way, and — for a video — the larger
 * player poster of the same frame. Metadata is merged, as updateFile does.
 * `version` is left alone: a poster is not an edit, and bumping it would fail
 * someone else's If-Match for a change they cannot see. So is `updated_at`,
 * for the same reason: it is the Modified date the list view shows and the
 * content-modification date the File Provider hands Finder, and remaking a
 * file's old thumbnail — which browsing the library now does — changes
 * neither the file nor what it is. `seq` still moves, so devices pick up the
 * new preview.
 *
 * A new thumbnail without a poster clears the old poster: it would be a
 * different frame from the one the grid now shows.
 */
export async function setFileThumbnail(id, thumbnailKey, media = {}, posterKey = null) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await sql`
    UPDATE files
    SET thumbnail_key = ${thumbnailKey}, thumbnail_url = NULL, thumb_status = 'ready',
        metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json(media)}::jsonb,
        seq = nextval('files_change_seq')
    WHERE id = ${id}
    RETURNING *`;
  const row = rows[0];
  if (!row) return null;
  if (posterKey || row.poster_key) row.poster_key = await recordPosterKey(id, posterKey || null);
  return shapeFile(row);
}

/**
 * Write a row's poster_key, on its own and best-effort; resolves what was
 * stored (null on failure).
 *
 * Its own statement so that a missing column costs only the poster. With
 * SCHEMA_MANAGED — the production default — a new column exists once the
 * maintenance cron or `npm run doctor` has run the guards; a deploy that lands
 * before that must still record uploads and thumbnails. A poster is not a
 * change devices sync, so seq is not bumped for it.
 */
async function recordPosterKey(id, posterKey) {
  try {
    const rows = await sql`UPDATE files SET poster_key = ${posterKey} WHERE id = ${id} RETURNING poster_key`;
    return rows[0]?.poster_key || null;
  } catch (e) {
    console.warn('[recordPosterKey]', e.message);
    return null;
  }
}

/**
 * Of `thumbKeys` and `posterKeys` — previews a row has just stopped pointing
 * at — the ones no row points at any more, which are safe to delete from the
 * bucket. Each kind is looked up in its own (indexed) column: the key checks
 * at every write keep a thumbnail key out of the poster column and the
 * reverse. When anything is uncertain the answer is "still in use": on any
 * error, nothing is returned.
 */
export async function unreferencedPreviewKeys({ thumbKeys = [], posterKeys = [] } = {}) {
  if (!sql) return [];
  const thumbs = [...new Set(thumbKeys.filter(Boolean).map(String))];
  const posters = [...new Set(posterKeys.filter(Boolean).map(String))];
  if (!thumbs.length && !posters.length) return [];
  try {
    await ensureFilesTable();
    const out = [];
    if (thumbs.length) {
      const rows = await sql`
        SELECT k FROM unnest(${thumbs}::text[]) AS k
        WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.thumbnail_key = k)`;
      out.push(...rows.map((r) => r.k));
    }
    if (posters.length) {
      const rows = await sql`
        SELECT k FROM unnest(${posters}::text[]) AS k
        WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.poster_key = k)`;
      out.push(...rows.map((r) => r.k));
    }
    return out;
  } catch (e) {
    console.warn('[unreferencedPreviewKeys]', e.message);
    return [];
  }
}

/** {pending, processing} counts — for the UI's "generating previews" hint. */
export async function countPendingThumbs() {
  if (!sql) return 0;
  await ensureFilesTable();
  try {
    const rows = await sql`SELECT count(*)::int AS n FROM files WHERE thumb_status IN ('pending', 'processing')`;
    return rows[0]?.n || 0;
  } catch { return 0; }
}

function shapeFile(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, folder: r.folder || '', kind: r.kind || 'other',
    mime: r.mime || null, size: r.size != null ? Number(r.size) : null,
    url: r.url, storage: r.storage || 'blob', storageKey: r.storage_key || null,
    tags: Array.isArray(r.tags) ? r.tags : [], notes: r.notes || null,
    visibility: r.visibility || 'owner', caption: r.caption || null,
    thumbnailUrl: r.thumbnail_url || null, thumbnailKey: r.thumbnail_key || null,
    filmstripKey: r.filmstrip_key || null,
    posterKey: r.poster_key || null,
    deletedAt: r.deleted_at ? Number(r.deleted_at) : null, trashKey: r.trash_key || null,
    deletedBy: r.deleted_by || null,
    version: r.version != null ? Number(r.version) : 1,
    contentHash: r.content_hash || null,
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    createdBy: r.created_by || null, createdAt: Number(r.created_at) || null, updatedAt: Number(r.updated_at) || null,
    seq: r.seq != null ? Number(r.seq) : null,
  };
}

// ── In-progress uploads ──────────────────────────────────────────────────────
//
// One row per multipart upload, so a browser reload or a closed laptop does not
// abandon a 40 GB transfer. The row holds only what is needed to resume — S3
// itself remembers which parts landed (see s3ListParts), so there is no part
// bookkeeping here to drift out of sync with reality.

const ensureUploadsTable = lazySchema('ensureUploadsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS uploads (
      id           TEXT PRIMARY KEY,
      upload_id    TEXT NOT NULL,
      storage_key  TEXT NOT NULL,
      filename     TEXT NOT NULL,
      size         BIGINT,
      mime         TEXT,
      folder       TEXT DEFAULT '',
      filespace_id TEXT,
      part_size    BIGINT NOT NULL,
      created_by   TEXT,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS uploads_owner_idx ON uploads (created_by, created_at DESC)`;
});

const shapeUpload = (r) => r && ({
  id: r.id,
  uploadId: r.upload_id,
  storageKey: r.storage_key,
  filename: r.filename,
  size: r.size != null ? Number(r.size) : null,
  mime: r.mime || null,
  folder: r.folder || '',
  filespaceId: r.filespace_id || null,
  partSize: Number(r.part_size),
  createdBy: r.created_by || null,
  createdAt: Number(r.created_at) || null,
  updatedAt: Number(r.updated_at) || null,
});

export async function createUpload(data = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureUploadsTable();
  const id = crypto.randomUUID();
  const now = Date.now();
  const rows = await sql`
    INSERT INTO uploads (id, upload_id, storage_key, filename, size, mime, folder, filespace_id, part_size, created_by, created_at, updated_at)
    VALUES (${id}, ${data.uploadId}, ${data.storageKey}, ${data.filename}, ${data.size != null ? Number(data.size) : null},
            ${data.mime || null}, ${data.folder || ''}, ${data.filespaceId || null}, ${Number(data.partSize)},
            ${data.createdBy || null}, ${now}, ${now})
    RETURNING *`;
  return shapeUpload(rows[0]);
}

/**
 * Fetch an upload, scoped to its owner.
 *
 * The ownership check is the point: an upload id plus a part number is enough
 * to write bytes into someone else's object, so every route that signs a part
 * has to prove the caller started this upload.
 */
export async function getUpload(id, email) {
  if (!sql || !id) return null;
  await ensureUploadsTable();
  const e = String(email || '').trim().toLowerCase();
  try {
    const rows = await sql`
      SELECT * FROM uploads
      WHERE id = ${id} AND lower(coalesce(created_by, '')) = ${e}
      LIMIT 1`;
    return shapeUpload(rows[0]) || null;
  } catch { return null; }
}

export async function touchUpload(id) {
  if (!sql || !id) return;
  await ensureUploadsTable();
  try { await sql`UPDATE uploads SET updated_at = ${Date.now()} WHERE id = ${id}`; } catch {}
}

export async function deleteUpload(id) {
  if (!sql || !id) return { ok: false };
  await ensureUploadsTable();
  try { await sql`DELETE FROM uploads WHERE id = ${id}`; } catch {}
  return { ok: true, id };
}

/** A user's resumable uploads, newest first. */
export async function listUploads(email, { limit = 50 } = {}) {
  if (!sql) return [];
  await ensureUploadsTable();
  const e = String(email || '').trim().toLowerCase();
  try {
    const rows = await sql`
      SELECT * FROM uploads
      WHERE lower(coalesce(created_by, '')) = ${e}
      ORDER BY created_at DESC LIMIT ${Math.min(Number(limit) || 50, 200)}`;
    return rows.map(shapeUpload);
  } catch { return []; }
}

/** Uploads untouched since `cutoff` — abandoned, for the maintenance sweep. */
export async function listStaleUploads(cutoff) {
  if (!sql) return [];
  await ensureUploadsTable();
  try {
    const rows = await sql`SELECT * FROM uploads WHERE updated_at < ${Number(cutoff)} ORDER BY updated_at ASC LIMIT 500`;
    return rows.map(shapeUpload);
  } catch { return []; }
}

// ── Issued upload keys ───────────────────────────────────────────────────────
//
// Which object keys were handed to whom for an upload: presign names the key
// of a single PUT, multipart create the key of a multipart upload. POST
// /api/files records a file only at a key issued to the person recording it.
//
// Before this, a row could be recorded at ANY key in the bucket. Recording
// makes the recorder the file's creator — who may open it, move it and delete
// it — so naming another file's key (the listing hands keys out) was a way to
// read or trash someone else's bytes, and naming an untracked one (a desktop
// mount's, another app's) a way to read it. The quota check made it worse:
// over a limit, the route deleted the object it was told about. Now the key
// must be one this person was given, which also makes it provably theirs to
// delete. The row is taken when the file is recorded, so a key is recorded
// once; unclaimed rows expire (UPLOAD_KEY_TTL_MS) and maintenance prunes them.

// Long enough for the slowest honest path: a presigned PUT is signed for ten
// minutes but may take longer to finish, and multipart re-issues its key when
// it completes, however many days it took to get there.
export const UPLOAD_KEY_TTL_MS = 24 * 60 * 60 * 1000;

const ensureUploadKeysTable = lazySchema('ensureUploadKeysTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS upload_keys (
      storage_key TEXT NOT NULL,
      email       TEXT NOT NULL,
      bucket      TEXT NOT NULL DEFAULT '',
      issued_at   BIGINT NOT NULL,
      PRIMARY KEY (storage_key, email)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS upload_keys_issued_idx ON upload_keys (issued_at)`;
});

/**
 * Record that `email` was handed `key`, in `bucket`, to upload to (again:
 * refreshes the clock). The bucket is kept so that deleting an upload that
 * came in over a limit deletes it where it was issued, and nowhere else.
 */
export async function issueUploadKey(key, email, { bucket = '' } = {}) {
  const e = normEmail(email);
  if (!sql || !key || !e) throw new Error('Cannot record the upload.');
  await ensureUploadKeysTable();
  const now = Date.now();
  await withSchemaRetry(ensureUploadKeysTable, () => sql`
    INSERT INTO upload_keys (storage_key, email, bucket, issued_at) VALUES (${String(key)}, ${e}, ${String(bucket || '')}, ${now})
    ON CONFLICT (storage_key, email) DO UPDATE SET issued_at = EXCLUDED.issued_at, bucket = EXCLUDED.bucket`);
}

/**
 * Take `key` for recording, if it was issued to `email` within the TTL:
 * → { bucket } once, null for a key never issued to them, expired, or
 * already taken. One statement, so two requests racing to record the same
 * upload cannot both win.
 */
export async function claimUploadKey(key, email) {
  const e = normEmail(email);
  if (!sql || !key || !e) return null;
  await ensureUploadKeysTable();
  const rows = await withSchemaRetry(ensureUploadKeysTable, () => sql`
    DELETE FROM upload_keys
    WHERE storage_key = ${String(key)} AND email = ${e} AND issued_at >= ${Date.now() - UPLOAD_KEY_TTL_MS}
    RETURNING bucket`);
  return rows.length ? { bucket: rows[0].bucket || '' } : null;
}

/** Drop issued keys older than `cutoff` that nobody recorded. → how many. */
export async function pruneUploadKeys(cutoff) {
  if (!sql) return 0;
  await ensureUploadKeysTable();
  const rows = await withSchemaRetry(ensureUploadKeysTable, () => sql`
    DELETE FROM upload_keys WHERE issued_at < ${Number(cutoff)} RETURNING storage_key`);
  return rows.length;
}

// ── Delta sync ───────────────────────────────────────────────────────────────
// Tombstones outlive both the row and the trash purge. Retention has to exceed
// the longest plausible client absence: a device that has been off for longer
// than we keep tombstones cannot be brought back into sync incrementally and
// has to re-enumerate from scratch. A year is cheap — these rows are tiny.

const ensureTombstonesTable = lazySchema('ensureTombstonesTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS file_tombstones (
      id          TEXT PRIMARY KEY,
      seq         BIGINT NOT NULL,
      folder      TEXT,
      storage_key TEXT,
      deleted_at  BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS file_tombstones_seq_idx ON file_tombstones (seq)`;
});

/**
 * Everything that changed after `cursor`, oldest first.
 *
 * Returns { changed, deleted, cursor, done }. `done` is true when the page was
 * not full, meaning the client has caught up — that is the signal to stop
 * paging, not an empty `changed` array (a page can be all deletions).
 *
 * Pass cursor 0 for a full enumeration: every row carries a seq, so the same
 * code path serves both first sync and incremental catch-up.
 */
/**
 * What changed since `cursor`, as `principal` may see it, within `scope`
 * (buildDeltaQuery): `changed` holds the rows they may see, and `deleted`
 * the ids of everything else that changed, including hard deletes. An id is
 * all a deletion carries — no name, folder or key — so it tells a caller
 * nothing about a file it could not have listed.
 *
 * `principal` is required. The feed used to serve every row to anyone
 * signed in, presigned; there is no default that could bring that back.
 */
export async function listFileChanges({ cursor = 0, limit = 500, principal, scope = {} } = {}) {
  if (!principal) throw new Error('listFileChanges needs a principal');
  if (!sql) return { changed: [], deleted: [], cursor: 0, done: true };
  await ensureFilesTable();
  await ensureTombstonesTable();
  // The access rule reads file_acl; on a database where nothing has made it
  // yet, every non-admin page would fail.
  await ensureFileAclTable();
  const q = buildDeltaQuery({ cursor, limit, principal, scope });
  const from = q.cursor;
  const n = q.limit;

  try {
    // Both sides are read to the same limit and then merged, so a burst of
    // deletions cannot starve out changes or vice versa.
    const [rows, tombs] = await Promise.all([
      withSchemaRetry(ensureFilesTable, () => sql.unsafe(q.text, q.params)),
      sql.unsafe('SELECT id, seq FROM file_tombstones WHERE seq > $1 ORDER BY seq ASC LIMIT $2', [from, n]),
    ]);

    // The new cursor is the highest seq we can honestly claim to have
    // delivered. When either side filled its page there may be more below the
    // other side's highest seq, so take the LOWER of the two maxima — advancing
    // past an undelivered row would skip it permanently.
    const maxChanged = rows.length ? Number(rows[rows.length - 1].seq) : null;
    const maxDeleted = tombs.length ? Number(tombs[tombs.length - 1].seq) : null;
    const full = rows.length >= n || tombs.length >= n;

    let next;
    if (!full) {
      next = Math.max(maxChanged ?? from, maxDeleted ?? from, from);
    } else if (maxChanged != null && maxDeleted != null) {
      next = Math.min(maxChanged, maxDeleted);
    } else {
      next = maxChanged ?? maxDeleted ?? from;
    }

    const delivered = rows.filter((r) => Number(r.seq) <= next);
    const gone = [
      ...delivered.filter((r) => r.shown !== true).map((r) => ({ id: r.id, seq: Number(r.seq) })),
      ...tombs.filter((t) => Number(t.seq) <= next).map((t) => ({ id: t.id, seq: Number(t.seq) })),
    ].sort((a, b) => a.seq - b.seq);

    return {
      changed: delivered.filter((r) => r.shown === true).map(shapeFile),
      deleted: gone,
      cursor: next,
      done: !full,
    };
  } catch (e) {
    // Thrown, not answered with an empty "done" page: a device told it is
    // up to date when the read failed would stop asking until the next write.
    console.warn('[listFileChanges] failed:', e.message);
    throw e;
  }
}

/** The newest change cursor, for a client that wants to start from "now". */
export async function currentChangeCursor() {
  if (!sql) return 0;
  try {
    // A sequence that has never been advanced reports last_value = 1 with
    // is_called = false. Reading it naively would hand back 1 before anything
    // was issued, and a client starting "from now" would then never be told
    // about the very first file.
    const rows = await sql`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS cur FROM files_change_seq`;
    return Number(rows?.[0]?.cur) || 0;
  } catch { return 0; }
}

/**
 * Every matching file, paged internally.
 *
 * For server-side callers that genuinely need the whole set — folder rename,
 * bucket reconciliation, the maintenance sweep. `cap` is a guard rail, not a
 * target: crossing it means the caller should be streaming instead, so it says
 * so rather than silently truncating.
 */
export async function listAllFiles(opts = {}, principal = { isAdmin: true }, { cap = 50000 } = {}) {
  const out = [];
  let cursor = null;
  for (;;) {
    const page = await listFilesForUser({ ...opts, limit: 500, cursor }, principal);
    out.push(...page.files);
    if (!page.cursor || out.length >= cap) {
      if (page.cursor && out.length >= cap) {
        console.warn(`[listAllFiles] hit the ${cap} cap with more rows remaining`);
      }
      break;
    }
    cursor = page.cursor;
  }
  return out;
}

/**
 * Tags are stored lowercased and de-duplicated.
 *
 * The listing matches them with jsonb containment, which is case-sensitive, so
 * normalizing on write is what preserves the case-insensitive search the old
 * JavaScript filter did. Normalizing on read instead would defeat the index.
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

/** Update a file's S3 object key (after re-keying for a folder rename/move). */
/**
 * Point a row at a different object. Used after a physical move — a folder
 * rename, or a per-file move.
 *
 * Advances the sequence: a client holding the old key would otherwise keep
 * asking for an object that is no longer there, and never find out why.
 */
export async function setFileStorageKey(id, storageKey) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  await sql`
    UPDATE files
    SET storage_key = ${storageKey}, version = COALESCE(version, 1) + 1,
        updated_at = ${Date.now()}, seq = nextval('files_change_seq')
    WHERE id = ${id}`;
  return { ok: true };
}


export async function createFile(data = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  if (!data.url) throw new Error('A file URL is required.');
  const id = crypto.randomUUID();
  const now = Date.now();
  // New files default to 'org' (visible to all signed-in users) to preserve the
  // Library's current openness; restrict per-file via setFileVisibility.
  const visibility = data.visibility || 'org';
  const rows = await sql`
    INSERT INTO files (id, name, folder, kind, mime, size, url, storage, storage_key, tags, notes, visibility, thumbnail_url, thumbnail_key, filmstrip_key, metadata, content_hash, created_by, created_at, updated_at, seq)
    VALUES (
      ${id}, ${(data.name || 'Untitled').trim()}, ${data.folder || ''}, ${data.kind || 'other'}, ${data.mime || null},
      ${data.size != null ? Number(data.size) : null}, ${data.url}, ${data.storage || 'blob'}, ${data.storageKey || null},
      ${sql.json(normalizeTags(data.tags))}, ${data.notes || null}, ${visibility},
      ${data.thumbnailUrl || null}, ${data.thumbnailKey || null}, ${data.filmstripKey || null},
      ${sql.json(data.metadata && typeof data.metadata === 'object' ? data.metadata : {})}, ${data.contentHash || null}, ${data.createdBy || null},
      ${data.createdAt != null ? Number(data.createdAt) : now}, ${data.updatedAt != null ? Number(data.updatedAt) : now},
      nextval('files_change_seq')
    )
    RETURNING *
  `;
  const row = rows[0];
  // Not in the INSERT: see recordPosterKey. An upload never fails for want
  // of its player poster.
  if (row && data.posterKey) row.poster_key = await recordPosterKey(id, data.posterKey);
  return shapeFile(row);
}

/**
 * List files with push-down filters. Returns { files, total }.
 *   folder      — exact folder match
 *   folderPrefix — folder AND its descendants (nested tree)
 *   q           — name/tags/notes/caption substring
 *   kind        — string or string[]
 *   tags + tagMode('all'|'any') — JSONB containment
 *   createdAfter / createdBefore — epoch ms
 *   sort        — 'new'|'old'|'name'|'size'
 *   limit / offset
 * Privacy filtering is applied by listFilesForUser, which wraps this.
 */
// A generated thumbnail — under the dedicated `_thumbs/` prefix (new) or named
// `<rand>-thumb-<name>.<img>` next to files (legacy, ingested by old syncs).
// Mirror of storage.isThumbnailKey, kept inline so db.js stays edge-safe.
function _isThumbArtifact(key) {
  if (!key) return false;
  const k = String(key);
  if (k.startsWith('_thumbs/') || k.includes('/_thumbs/')) return true;
  const base = k.slice(k.lastIndexOf('/') + 1);
  return /-thumb-[^/]*\.(jpe?g|png|webp)$/i.test(base);
}
// OS junk (.DS_Store, AppleDouble ._*, Thumbs.db, …) — never show as files.
function _isSystemKey(key) {
  if (!key) return false;
  const base = String(key).slice(String(key).lastIndexOf('/') + 1);
  return base === '.DS_Store' || base === '.localized' || base === 'Thumbs.db' || base === 'desktop.ini' || base.startsWith('._');
}

export async function listFiles(opts = {}) {
  // Unfiltered by access — for server-side callers that legitimately see
  // everything (bucket sync, the maintenance cron). User-facing reads must go
  // through listFilesForUser.
  return listFilesForUser(opts, { isAdmin: true });
}

/**
 * The listing read. One indexed query, with access, filtering, ordering and
 * paging all decided in the database.
 *
 * Returns { files, cursor, total? }. `cursor` is an opaque token for the next
 * page, or null at the end. `total` is only computed when opts.withTotal is
 * set: counting matched rows costs a second full scan of the predicate, and
 * almost every caller only needs to know whether more exist.
 */
export async function listFilesForUser(opts = {}, principal = {}) {
  if (!sql) return { files: [], cursor: null, total: 0 };
  try {
    await ensureFilesTable();
    await ensureFileAclTable();
    await ensureFolderAclTable();

    const { text, params, countText, countParams, limit, sort } = buildFileQuery({ opts, principal });
    // sql.unsafe takes pre-built text + bound parameters. The text comes from
    // lib/file-query.js, which never interpolates a value — every value is a
    // $n placeholder — so "unsafe" here means "not a tagged template", not
    // "unparameterized".
    const rows = await withSchemaRetry(ensureFilesTable, () => sql.unsafe(text, params));
    const files = rows.map(shapeFile);

    const out = { files, cursor: nextCursor(rows, sort, limit) };
    if (opts.withTotal) {
      const counted = await sql.unsafe(countText, countParams);
      out.total = Number(counted?.[0]?.n) || 0;
    }
    return out;
  } catch (e) {
    console.warn('[listFilesForUser] failed:', e.message);
    return { files: [], cursor: null, total: 0 };
  }
}

/**
 * Tree-ready folder rows: { folder, name, parent, depth, count }. `count` is
 * the direct file count; every ancestor path is synthesized so a file at
 * a/b/c.png makes folders "a" and "a/b" appear even if never explicitly created.
 */
export async function listFileFolders({ storagePrefix, filespace } = {}) {
  if (!sql) return [];
  try {
    await ensureFilesTable();
    const sp = storagePrefix != null ? String(storagePrefix).replace(/^\/+|\/+$/g, '') : null;
    const rows = sp
      ? await sql`SELECT folder, COUNT(*)::int AS n FROM files WHERE deleted_at IS NULL AND storage_key LIKE ${escapeLike(sp) + '/%'} GROUP BY folder ORDER BY folder ASC`
      : await sql`SELECT folder, COUNT(*)::int AS n FROM files WHERE deleted_at IS NULL GROUP BY folder ORDER BY folder ASC`;
    const counts = new Map();   // path -> direct file count
    const all = new Set();      // all folder paths (incl. ancestors)
    const addAncestors = (p) => {
      if (!p) return;
      const segs = p.split('/');
      let path = '';
      for (const s of segs) { path = path ? `${path}/${s}` : s; all.add(path); }
    };
    for (const r of rows) {
      const name = r.folder || '';
      if (name) { counts.set(name, Number(r.n) || 0); addAncestors(name); }
    }
    for (const name of await listFolderNames(filespace)) { all.add(name); addAncestors(name); }
    return [...all].sort((a, b) => a.localeCompare(b)).map((folder) => ({
      folder,
      name: folder.includes('/') ? folder.slice(folder.lastIndexOf('/') + 1) : folder,
      parent: _folderParent(folder),
      depth: _folderDepth(folder),
      count: counts.get(folder) || 0,
    }));
  } catch (e) {
    console.warn('[listFileFolders] failed:', e.message);
    return [];
  }
}

/**
 * Patch a file row. Every field is COALESCE'd, so an absent key leaves the
 * column alone — this is a PATCH, not a PUT.
 *
 * Metadata is MERGED (`||`), not replaced. It used to be replaced, which made
 * a partial patch silently destructive: sending `{ metadata: { client: 'x' } }`
 * from a form that only edits one field deleted `width` and `height`, and the
 * aspect-ratio facet for that file with them. bulkPatchFileMetadata already
 * merged, so the two entry points disagreed about what a metadata patch means.
 * They now agree. A caller that genuinely wants to drop a key sets it to null
 * explicitly, which merge preserves as a null rather than erasing the field.
 */
export async function updateFile(id, fields = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const now = Date.now();
  const patch = fields.metadata && typeof fields.metadata === 'object' && !Array.isArray(fields.metadata)
    ? sql.json(fields.metadata)
    : null;
  const rows = await sql`
    UPDATE files SET
      name = COALESCE(${fields.name ?? null}, name),
      folder = COALESCE(${fields.folder ?? null}, folder),
      tags = COALESCE(${fields.tags !== undefined ? sql.json(normalizeTags(fields.tags)) : null}, tags),
      notes = COALESCE(${fields.notes ?? null}, notes),
      -- No thumbnail here: a thumbnail is set only through setFileThumbnail
      -- (or createFile), which take keys the server named. See PATCH.
      metadata = CASE
        WHEN ${patch}::jsonb IS NULL THEN metadata
        ELSE COALESCE(metadata, '{}'::jsonb) || ${patch}::jsonb
      END,
      version = COALESCE(version, 1) + 1,
      updated_at = ${now},
      seq = nextval('files_change_seq')
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? shapeFile(rows[0]) : null;
}

/**
 * Merge a metadata patch into many files at once (bulk tagging). `patch` is a
 * shallow object of field→value; it's merged over each file's existing metadata
 * (jsonb ||). Returns the count updated. Used by the Space bulk-edit bar.
 */
export async function bulkPatchFileMetadata(ids, patch) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!list.length || !patch || typeof patch !== 'object') return { updated: 0 };
  const rows = await sql`
    UPDATE files
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json(patch)},
        version = COALESCE(version, 1) + 1,
        updated_at = ${Date.now()},
        -- Without this the change is invisible to /api/files/delta, so a
        -- bulk re-tag would never reach a synced device. Every write a
        -- client must learn about advances the sequence.
        seq = nextval('files_change_seq')
    WHERE id = ANY(${list}) AND deleted_at IS NULL
    RETURNING id
  `;
  return { updated: rows.length };
}

// Admin-defined metadata field schema (which "meta tags" exist for Space).
// Pass { fresh: true, strict: true } before writing it back: a read that fails
// otherwise comes back null, which reads as "the default schema", and saving
// a field on top of that would erase every field the admin has added.
export async function getFileMetadataSchema(opts) {
  const v = await getSetting('file.metadata.schema', opts);
  return v && typeof v === 'object' ? v : null;
}
export async function setFileMetadataSchema(value, updatedBy) {
  return setSetting('file.metadata.schema', value && typeof value === 'object' ? value : {}, updatedBy);
}

/**
 * Soft-delete: mark a file as trashed. `trashKey` records where the S3 object
 * was moved (so it leaves the mounted drive but can be restored). The bytes are
 * NOT removed here — the API route handles the S3 move; this just flags the row.
 */
export async function softDeleteFile(id, { trashKey = null, deletedBy = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    UPDATE files SET deleted_at = ${Date.now()}, trash_key = ${trashKey}, deleted_by = ${deletedBy},
      updated_at = ${Date.now()}, seq = nextval('files_change_seq')
    WHERE id = ${id} RETURNING *`);
  return rows[0] ? shapeFile(rows[0]) : null;
}

/**
 * Restore a trashed file (clears the trash flags). S3 move-back is done by
 * the route; `storageKey` is where it put the object, when that is not the
 * key the file had before (a newer file took the name in the meantime).
 */
export async function restoreFile(id, { storageKey = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    UPDATE files SET deleted_at = NULL, trash_key = NULL, deleted_by = NULL,
      storage_key = COALESCE(${storageKey}, storage_key),
      version = COALESCE(version, 1) + 1,
      updated_at = ${Date.now()}, seq = nextval('files_change_seq')
    WHERE id = ${id} AND deleted_at IS NOT NULL RETURNING *`);
  return rows[0] ? shapeFile(rows[0]) : null;
}

/** Trashed files older than `cutoffMs` (their deleted_at), for the trash purge sweep (TRASH_RETENTION_DAYS). */
export async function listExpiredTrash(cutoffMs) {
  if (!sql) return [];
  await ensureFilesTable();
  try {
    const rows = await sql`SELECT * FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffMs}`;
    return rows.map(shapeFile);
  } catch (e) { console.warn('[listExpiredTrash] failed:', e.message); return []; }
}

/**
 * The trash, newest first, for Admin → Trash. Paged by (deleted_at, id):
 * `before` is the last row's { deletedAt, id } from the previous page.
 */
export async function listTrashedFiles({ before = null, limit = 100 } = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const at = before?.deletedAt != null ? Number(before.deletedAt) : null;
  const id = before?.id != null ? String(before.id) : '';
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT * FROM files
    WHERE deleted_at IS NOT NULL
      AND (${at}::bigint IS NULL OR (deleted_at, id) < (${at}::bigint, ${id}::text))
    ORDER BY deleted_at DESC, id DESC
    LIMIT ${lim}`);
  return rows.map(shapeFile);
}

/** Trashed rows by id — what a restore or purge acts on. Live rows are not returned. */
export async function getTrashedFiles(ids = []) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!sql || !list.length) return [];
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT * FROM files WHERE id = ANY(${list}::text[]) AND deleted_at IS NOT NULL`);
  return rows.map(shapeFile);
}

/**
 * Does any other row still point at this object? The trash purge asks before
 * deleting a key a trashed row never moved away from: by the time it runs,
 * a new upload may have been given the same name in the same folder.
 */
export async function storageKeyInUse(key, { exceptId = null } = {}) {
  if (!sql || !key) return false;
  await ensureFilesTable();
  const rows = await sql`
    SELECT 1 FROM files
    WHERE (storage_key = ${key} OR trash_key = ${key}) AND id <> ${exceptId || ''}
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * The object purging a trashed row deletes, or null for none. Where the trash
 * move put it (`trash_key`) — never the key the file had while live, which
 * may belong to a newer upload by now. A row trashed without a move (before
 * trash_key existed, or while off S3) still sits at its own key; that is
 * deleted only when no other row uses it (`keyInUse`).
 */
export function purgeTarget(row, { keyInUse = false } = {}) {
  if (!row) return null;
  if (row.trashKey) return row.trashKey;
  if (row.storage === 's3' && row.storageKey && !keyInUse) return row.storageKey;
  return null;
}

/** Permanently remove a file's catalog record + dependents. S3 bytes are deleted by the route. */
export async function deleteFile(id) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  await ensureTombstonesTable();
  // Record the deletion BEFORE removing the row. A sync client that was offline
  // when this happened has no other way to learn the file is gone — without a
  // tombstone it shows a ghost forever, and no amount of re-enumeration fixes
  // it. Writing it first means a crash mid-delete leaves a harmless tombstone
  // for a row that still exists, rather than a vanished row nobody is told about.
  try {
    const prior = await sql`SELECT folder, storage_key FROM files WHERE id = ${id}`;
    const row = prior[0];
    if (row) {
      await sql`
        INSERT INTO file_tombstones (id, seq, folder, storage_key, deleted_at)
        VALUES (${id}, nextval('files_change_seq'), ${row.folder || ''}, ${row.storage_key || null}, ${Date.now()})
        ON CONFLICT (id) DO UPDATE
          SET seq = EXCLUDED.seq, deleted_at = EXCLUDED.deleted_at`;
    }
  } catch (e) { console.warn('[deleteFile] tombstone:', e.message); }
  try { await sql`DELETE FROM files WHERE id = ${id}`; } catch (e) { console.warn('[deleteFile] failed:', e.message); }
  // Clean up dependents (no FKs) so deleting a file doesn't orphan links/grants.
  try { await sql`DELETE FROM file_shares WHERE file_id = ${id}`; } catch {}
  try { await sql`DELETE FROM file_acl WHERE file_id = ${id}`; } catch {}
  return { ok: true };
}

export async function setFileVisibility(id, visibility) {
  if (!sql || !id) return null;
  await ensureFilesTable();
  const v = ['owner', 'org', 'custom'].includes(visibility) ? visibility : 'owner';
  // Visibility decides who may see the row, so a device has to be told.
  const rows = await sql`
    UPDATE files
    SET visibility = ${v}, version = COALESCE(version, 1) + 1,
        updated_at = ${Date.now()}, seq = nextval('files_change_seq')
    WHERE id = ${id} RETURNING *`;
  return rows[0] ? shapeFile(rows[0]) : null;
}

export async function getFileById(id) {
  if (!sql) return null;
  try {
    await ensureFilesTable();
    const rows = await sql`SELECT * FROM files WHERE id = ${id} LIMIT 1`;
    return rows[0] ? shapeFile(rows[0]) : null;
  } catch (e) {
    console.warn('[getFileById] failed:', e.message);
    return null;
  }
}

// ─── Files folders — persisted so empty folders survive a reload. ──
const ensureFoldersTable = lazySchema('ensureFoldersTable', async () => {
  await sql`CREATE TABLE IF NOT EXISTS folders (name TEXT PRIMARY KEY, created_at BIGINT NOT NULL)`;
  // Nested-tree columns. `name` is the full slash path (materialized path);
  // `parent` is the path minus the last segment.
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent TEXT DEFAULT ''`;
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS depth INT DEFAULT 0`;
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'org'`;
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_by TEXT`;
  // Which filespace (bucket prefix) this folder belongs to. '' / NULL = legacy/global.
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS filespace TEXT DEFAULT ''`;
  await sql`CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent)`;
});

function _folderParent(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
function _folderDepth(path) {
  return path === '' ? 0 : path.split('/').length;
}

/** Persist a folder path AND every ancestor (so the tree is complete). */
export async function createFolder(name, { createdBy, filespace } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFoldersTable();
  const clean = String(name || '').replace(/^\/+|\/+$/g, '').trim();
  if (!clean) throw new Error('Folder name required.');
  const fs = String(filespace || '');
  const now = Date.now();
  const segs = clean.split('/');
  let path = '';
  for (const seg of segs) {
    path = path ? `${path}/${seg}` : seg;
    await sql`INSERT INTO folders (name, parent, depth, created_by, filespace, created_at)
      VALUES (${path}, ${_folderParent(path)}, ${_folderDepth(path)}, ${createdBy || null}, ${fs}, ${now})
      ON CONFLICT (name) DO NOTHING`;
  }
  return { name: clean };
}

/** Delete a folder; with {cascade} also prune its subtree + folder ACL rows. */
export async function deleteFolder(name, { cascade = false } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFoldersTable();
  const clean = String(name || '').replace(/^\/+|\/+$/g, '').trim();
  if (!clean) return { ok: false };
  try {
    if (cascade) {
      await sql`DELETE FROM folders WHERE name = ${clean} OR name LIKE ${escapeLike(clean) + '/%'}`;
      try { await sql`DELETE FROM folder_access WHERE folder = ${clean} OR folder LIKE ${escapeLike(clean) + '/%'}`; } catch {}
    } else {
      await sql`DELETE FROM folders WHERE name = ${clean}`;
    }
  } catch (e) { console.warn('[deleteFolder] failed:', e.message); }
  return { ok: true };
}

/**
 * Live files in `folder` and everything beneath it: the rows a folder rename,
 * move or delete acts on. Unfiltered by access — the caller has already
 * decided, with canModifyFolder, that this principal may restructure the
 * folder as a whole.
 */
export async function listFolderSubtreeFiles(folder) {
  if (!sql) return [];
  await ensureFilesTable();
  const a = String(folder || '');
  if (!a) return [];
  const rows = await sql`
    SELECT id, name, folder, storage, storage_key FROM files
    WHERE deleted_at IS NULL AND (folder = ${a} OR folder LIKE ${escapeLike(a) + '/%'})`;
  return rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder || '', storage: r.storage, storageKey: r.storage_key }));
}

/**
 * Does anything live at `path` — a folder row, or a live file in it or
 * beneath it? A rename refuses to land on one: merging two trees silently is
 * how files end up somewhere nobody asked for.
 *
 * Deliberately across every filespace. folders.name is the whole primary key,
 * so a row another filespace holds at `path` would fail the rename's UPDATE
 * anyway; refusing up front is the same answer without copying objects first.
 */
export async function folderPathInUse(path) {
  if (!sql) return false;
  await ensureFoldersTable();
  await ensureFilesTable();
  const pat = escapeLike(path) + '/%';
  const rows = await sql`
    SELECT
      EXISTS (SELECT 1 FROM folders WHERE name = ${path} OR name LIKE ${pat}) AS dir,
      EXISTS (SELECT 1 FROM files WHERE deleted_at IS NULL
        AND (folder = ${path} OR folder LIKE ${pat})) AS file`;
  return Boolean(rows[0]?.dir || rows[0]?.file);
}

/**
 * Rename or move a folder subtree in the catalog, in ONE statement.
 *
 * `moves` are files whose objects have already been COPIED to their new keys
 * ({ id, folder, toKey }); `catalog` are files with no object to move
 * ({ id, folder }). Files, folder rows, their parents and folder grants all
 * change together or not at all — this module cannot use sql.begin (see the
 * client notes at the top), and a single statement is atomic without one.
 * That is what lets the route promise "renamed, or nothing changed".
 *
 * `tag` is the scope's folders.filespace value ('' for the unscoped library).
 * Folder rows of another filespace are left alone. `moveGrants` is false when
 * files of another scope stay behind at the old path; the grants are then
 * copied to the new path rather than moved, so those files keep theirs.
 */
export async function renameFolder(from, to, { tag = '', moves = [], catalog = [], moveGrants = true, createdBy = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFoldersTable();
  await ensureFolderAclTable();
  await ensureFilesTable();
  const a = String(from || '');
  const b = String(to || '');
  if (!a || !b || a === b) return { ok: false };
  if (b.startsWith(a + '/')) throw new Error('Cannot move a folder into itself.');
  const pat = escapeLike(a) + '/%';
  const now = Date.now();

  const rows = [...moves, ...catalog];
  const ids = rows.map((r) => r.id);
  const folders = rows.map((r) => r.folder);
  const keys = rows.map((r) => r.toKey || null);

  const dirs = await sql`SELECT name FROM folders WHERE (name = ${a} OR name LIKE ${pat}) AND COALESCE(filespace, '') IN (${tag}, '')`;
  const oldNames = dirs.map((d) => d.name);
  const newNames = oldNames.map((n) => rebase(n, a, b));
  // The destination's ancestors, so a move into a folder that so far exists
  // only because files are in it leaves a complete tree behind.
  const anc = [];
  for (let p = _folderParent(b); p; p = _folderParent(p)) anc.push(p);
  if (!oldNames.includes(a)) anc.unshift(b);

  const [r] = await sql`
    WITH moved AS (
      UPDATE files f SET
        folder = m.folder,
        storage_key = COALESCE(m.key, f.storage_key),
        version = COALESCE(f.version, 1) + 1,
        updated_at = ${now},
        seq = nextval('files_change_seq')
      FROM unnest(${ids}::text[], ${folders}::text[], ${keys}::text[]) AS m(id, folder, key)
      WHERE f.id = m.id AND f.deleted_at IS NULL
      RETURNING f.id
    ), dirs AS (
      UPDATE folders d SET
        name = m.name,
        parent = CASE WHEN position('/' in m.name) = 0 THEN '' ELSE regexp_replace(m.name, '/[^/]*$', '') END,
        depth = array_length(string_to_array(m.name, '/'), 1)
      FROM unnest(${oldNames}::text[], ${newNames}::text[]) AS m(old, name)
      WHERE d.name = m.old
      RETURNING d.name
    ), anc AS (
      INSERT INTO folders (name, parent, depth, created_by, filespace, created_at)
      SELECT p,
        CASE WHEN position('/' in p) = 0 THEN '' ELSE regexp_replace(p, '/[^/]*$', '') END,
        array_length(string_to_array(p, '/'), 1), ${createdBy}, ${tag}, ${now}
      FROM unnest(${anc}::text[]) AS p
      ON CONFLICT DO NOTHING
      RETURNING name
    ), grants AS (
      INSERT INTO folder_access (folder, subject_type, subject, role, granted_by, granted_at)
      SELECT ${b}::text || substring(folder from ${a.length + 1}::int), subject_type, subject, role, granted_by, granted_at
      FROM folder_access WHERE folder = ${a} OR folder LIKE ${pat}
      ON CONFLICT DO NOTHING
      RETURNING folder
    ), dropped AS (
      DELETE FROM folder_access WHERE ${moveGrants} AND (folder = ${a} OR folder LIKE ${pat})
      RETURNING folder
    )
    SELECT (SELECT count(*) FROM moved)::int AS files, (SELECT count(*) FROM dirs)::int AS folders`;
  return { ok: true, from: a, to: b, files: r?.files || 0, folders: r?.folders || 0 };
}

/** Folder rows strictly beneath `name` visible in this scope (empty subfolders included). */
export async function listFolderRowsUnder(name, { tag = '' } = {}) {
  if (!sql) return [];
  await ensureFoldersTable();
  const rows = await sql`SELECT name FROM folders WHERE name LIKE ${escapeLike(name) + '/%'}
    AND COALESCE(filespace, '') IN (${tag}, '')`;
  return rows.map((r) => r.name);
}

/** The filespace tag on the folder row at `name`, or null when there is none. */
export async function folderRowTag(name) {
  if (!sql) return null;
  await ensureFoldersTable();
  const [row] = await sql`SELECT COALESCE(filespace, '') AS tag FROM folders WHERE name = ${name}`;
  return row ? row.tag : null;
}

/**
 * Drop the folder rows at and beneath `name` in this scope, after a delete has
 * trashed the files. Grants go too, unless live files (another scope's, or
 * ones that could not be trashed) still sit at the path.
 */
export async function deleteFolderRows(name, { tag = '' } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFoldersTable();
  await ensureFolderAclTable();
  await ensureFilesTable();
  const a = String(name || '');
  if (!a) return { ok: false };
  const pat = escapeLike(a) + '/%';
  await sql`DELETE FROM folders WHERE (name = ${a} OR name LIKE ${pat}) AND COALESCE(filespace, '') IN (${tag}, '')`;
  const [left] = await sql`SELECT count(*)::int AS n FROM files WHERE deleted_at IS NULL AND (folder = ${a} OR folder LIKE ${pat})`;
  if (!left?.n) await sql`DELETE FROM folder_access WHERE folder = ${a} OR folder LIKE ${pat}`;
  return { ok: true, remaining: left?.n || 0 };
}

async function listFolderNames(filespace) {
  if (!sql) return [];
  try {
    await ensureFoldersTable();
    // Each scope's own folders: a drive's are the ones made in it (tagged with
    // its prefix), the library's the untagged ones. Untagged folders used to
    // be shown in every drive as well, so a drive made a moment ago already
    // held the library's top-level folders. A folder that has files is found
    // from the files anyway (listFileFolders); this list is what adds the
    // empty ones, and an empty folder belongs to the place it was made.
    const rows = filespace != null && String(filespace) !== ''
      ? await sql`SELECT name FROM folders WHERE filespace = ${String(filespace)} ORDER BY name ASC`
      : await sql`SELECT name FROM folders WHERE filespace IS NULL OR filespace = '' ORDER BY name ASC`;
    return rows.map((r) => r.name);
  } catch { return []; }
}

/**
 * The folders a sync client should show even when they hold nothing: a
 * drive's own (every member sees the drive's folders), or the library's,
 * narrowed to the ones this principal was granted unless they are an admin.
 * Folders that hold files come with the files; this is only the empty ones'
 * way in, and it is sent whole each time because a folder can be made,
 * renamed or removed without writing any file row.
 */
export async function listSyncFolders(principal = {}, { storagePrefix } = {}) {
  const sp = storagePrefix ? String(storagePrefix).replace(/^\/+|\/+$/g, '') : '';
  const names = await listFolderNames(sp || null);
  if (sp || principal.isAdmin) return names;
  const grants = Array.isArray(principal.folderGrants) ? principal.folderGrants : [];
  return names.filter((n) => grants.some((g) => g === '' || n === g || n.startsWith(`${g}/`)));
}

// ─── File share links — public, revocable links to a Files file. ──
const ensureSharesTable = lazySchema('ensureSharesTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS file_shares (
      token TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      created_by TEXT,
      created_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS file_shares_file_idx ON file_shares (file_id)`;
  // Link modes: 'public' (token only) | 'private' (token + signed-in + ACL).
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'public'`;
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS expires_at BIGINT`;
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS password_hash TEXT`;
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0`;
  // Folder shares: a row can target a whole folder instead of one file.
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'file'`;
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS folder TEXT`;
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS storage_prefix TEXT`;
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS brief_id TEXT`;
  try { await sql`ALTER TABLE file_shares ALTER COLUMN file_id DROP NOT NULL`; } catch {}
  // Wrong-password lockout for password links (MAX_PASSWORD_FAILURES in
  // lib/shares.js): failures since the last lock, and when the lock lifts.
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS pw_failures INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS pw_locked_until BIGINT`;
  // Links one person made: their Account page, the person drawer, and the
  // clean-up when they are removed.
  await sql`CREATE INDEX IF NOT EXISTS file_shares_created_by_idx ON file_shares (created_by)`;
});

export async function createShare({ fileId, createdBy, mode = 'public', expiresInDays, password } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureSharesTable();
  if (!fileId) throw new Error('fileId required.');
  const m = mode === 'private' ? 'private' : 'public';
  // A private link never carries a password: access there is the session and
  // the file's own ACL, so a password would only be a second, weaker lock.
  const pw = m === 'public' && password ? String(password) : null;
  const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
  // Reuse only a link that is exactly this one: plain, unexpiring, same mode.
  // Reusing on (file, mode) alone handed back the existing public link when a
  // PASSWORD-protected one was asked for — the password was silently dropped.
  if (!pw && !expiresAt) {
    const existing = await sql`
      SELECT token FROM file_shares
      WHERE file_id = ${fileId} AND mode = ${m} AND password_hash IS NULL AND expires_at IS NULL
      ORDER BY created_at ASC LIMIT 1`;
    if (existing[0]) return { token: existing[0].token, mode: m, reused: true };
  }
  const token = newShareToken();
  const passwordHash = pw ? await hashSharePassword(pw) : null;
  await sql`INSERT INTO file_shares (token, file_id, created_by, created_at, mode, expires_at, password_hash)
    VALUES (${token}, ${fileId}, ${createdBy || null}, ${Date.now()}, ${m}, ${expiresAt}, ${passwordHash})`;
  return { token, mode: m, reused: false };
}

/**
 * One share row as stored, for the public page and the download route —
 * which check expiry, lockout and the password themselves (lib/shares.js),
 * and count a view only once access is granted. No side effects here.
 */
export async function getShareRow(token) {
  if (!sql || !token) return null;
  await ensureSharesTable();
  const rows = await sql`SELECT * FROM file_shares WHERE token = ${token} LIMIT 1`;
  return rows[0] || null;
}

export async function recordShareView(token) {
  if (!sql || !token) return;
  try { await sql`UPDATE file_shares SET view_count = view_count + 1 WHERE token = ${token}`; } catch {}
}

/**
 * A wrong password. Counts it, and on the MAX_PASSWORD_FAILURES-th locks the
 * link for PASSWORD_LOCK_MS and starts the count again. One statement, so two
 * guesses racing each other cannot both slip under the limit.
 */
export async function recordShareFailure(token) {
  if (!sql || !token) return null;
  const now = Date.now();
  const rows = await sql`
    UPDATE file_shares SET
      pw_failures = CASE WHEN pw_failures + 1 >= ${MAX_PASSWORD_FAILURES} THEN 0 ELSE pw_failures + 1 END,
      pw_locked_until = CASE WHEN pw_failures + 1 >= ${MAX_PASSWORD_FAILURES} THEN ${now + PASSWORD_LOCK_MS} ELSE pw_locked_until END
    WHERE token = ${token}
    RETURNING pw_failures, pw_locked_until`;
  const r = rows[0];
  return r ? { failures: Number(r.pw_failures) || 0, lockedUntil: r.pw_locked_until != null ? Number(r.pw_locked_until) : null } : null;
}

export async function clearShareFailures(token) {
  if (!sql || !token) return;
  try { await sql`UPDATE file_shares SET pw_failures = 0, pw_locked_until = NULL WHERE token = ${token} AND (pw_failures > 0 OR pw_locked_until IS NOT NULL)`; } catch {}
}

// Every file inside a folder subtree, scoped to a filespace prefix. Used for
// public folder shares (the share IS the grant, so this bypasses per-file ACL).
export async function listFilesInFolder(folder, storagePrefix) {
  if (!sql) return [];
  await ensureFilesTable();
  const path = String(folder || '');
  const sp = storagePrefix ? String(storagePrefix).replace(/^\/+|\/+$/g, '') : null;
  const rows = sp
    ? await sql`SELECT * FROM files WHERE deleted_at IS NULL AND storage_key LIKE ${escapeLike(sp) + '/%'} ORDER BY folder ASC, name ASC`
    : await sql`SELECT * FROM files WHERE deleted_at IS NULL ORDER BY folder ASC, name ASC`;
  return rows
    .map(shapeFile)
    .filter((f) => f && (f.folder === path || (path === '' ? true : f.folder.startsWith(path + '/'))));
}

// Create (or reuse) a share link for a whole folder within a filespace.
export async function createFolderShare({ folder, storagePrefix, createdBy, mode = 'public', expiresInDays, password } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureSharesTable();
  const path = String(folder ?? '');
  const sp = storagePrefix ? String(storagePrefix).replace(/^\/+|\/+$/g, '') : null;
  const m = mode === 'private' ? 'private' : 'public';
  const existing = await sql`SELECT token FROM file_shares WHERE kind = 'folder' AND folder = ${path} AND storage_prefix IS NOT DISTINCT FROM ${sp} AND mode = ${m} ORDER BY created_at ASC LIMIT 1`;
  if (existing[0]) return { token: existing[0].token, mode: m, reused: true };
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
  const passwordHash = password ? await hashSharePassword(password) : null;
  await sql`INSERT INTO file_shares (token, file_id, kind, folder, storage_prefix, created_by, created_at, mode, expires_at, password_hash)
    VALUES (${token}, ${null}, 'folder', ${path}, ${sp}, ${createdBy || null}, ${Date.now()}, ${m}, ${expiresAt}, ${passwordHash})`;
  return { token, mode: m, reused: false };
}

// Create (or reuse) a short share link for a brief.
export async function createBriefShare({ briefId, createdBy, mode = 'public', expiresInDays, password } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureSharesTable();
  if (!briefId) throw new Error('briefId required.');
  const m = mode === 'private' ? 'private' : 'public';
  const existing = await sql`SELECT token FROM file_shares WHERE kind = 'brief' AND brief_id = ${briefId} AND mode = ${m} ORDER BY created_at ASC LIMIT 1`;
  if (existing[0]) return { token: existing[0].token, mode: m, reused: true };
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 10); // shortlink
  const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
  const passwordHash = password ? await hashSharePassword(password) : null;
  await sql`INSERT INTO file_shares (token, file_id, kind, brief_id, created_by, created_at, mode, expires_at, password_hash)
    VALUES (${token}, ${null}, 'brief', ${briefId}, ${createdBy || null}, ${Date.now()}, ${m}, ${expiresAt}, ${passwordHash})`;
  return { token, mode: m, reused: false };
}

export async function listSharesForBrief(briefId) {
  if (!sql || !briefId) return [];
  await ensureSharesTable();
  try {
    const rows = await sql`SELECT token, mode, expires_at, view_count, created_at, (password_hash IS NOT NULL) AS has_password FROM file_shares WHERE kind = 'brief' AND brief_id = ${briefId} ORDER BY created_at ASC`;
    return rows.map((r) => ({ token: r.token, mode: r.mode || 'public', expiresAt: r.expires_at != null ? Number(r.expires_at) : null, viewCount: Number(r.view_count) || 0, hasPassword: !!r.has_password, createdAt: Number(r.created_at) || null }));
  } catch { return []; }
}

export async function listSharesForFolder(folder, storagePrefix) {
  if (!sql) return [];
  await ensureSharesTable();
  const path = String(folder ?? '');
  const sp = storagePrefix ? String(storagePrefix).replace(/^\/+|\/+$/g, '') : null;
  try {
    const rows = await sql`SELECT token, mode, expires_at, view_count, created_at, (password_hash IS NOT NULL) AS has_password FROM file_shares WHERE kind = 'folder' AND folder = ${path} AND storage_prefix IS NOT DISTINCT FROM ${sp} ORDER BY created_at ASC`;
    return rows.map((r) => ({ token: r.token, mode: r.mode || 'public', expiresAt: r.expires_at != null ? Number(r.expires_at) : null, viewCount: Number(r.view_count) || 0, hasPassword: !!r.has_password, createdAt: Number(r.created_at) || null }));
  } catch { return []; }
}

/** Resolve a share token. Returns {kind:'file',file} | {kind:'folder',folder,files} | {expired} | {needsPassword} | null. */
export async function getShareByToken(token, { password } = {}) {
  if (!sql) return null;
  try {
    await ensureSharesTable();
    const rows = await sql`SELECT * FROM file_shares WHERE token = ${token} LIMIT 1`;
    const s = rows[0];
    if (!s) return null;
    if (s.expires_at && Number(s.expires_at) < Date.now()) return { expired: true };
    if (s.password_hash) {
      if (!password) return { needsPassword: true, mode: s.mode || 'public' };
      if (!(await verifySharePassword(password, s.password_hash))) return { needsPassword: true, wrong: true, mode: s.mode || 'public' };
    }
    if ((s.kind || 'file') === 'folder') {
      const files = await listFilesInFolder(s.folder || '', s.storage_prefix || null);
      try { await sql`UPDATE file_shares SET view_count = view_count + 1 WHERE token = ${token}`; } catch {}
      const name = (s.folder || '').split('/').pop() || 'All files';
      return { token, kind: 'folder', folder: s.folder || '', folderName: name, files, mode: s.mode || 'public' };
    }
    const file = await getFileById(s.file_id);
    if (!file) return null;
    try { await sql`UPDATE file_shares SET view_count = view_count + 1 WHERE token = ${token}`; } catch {}
    return { token, kind: 'file', file, mode: s.mode || 'public', fileId: s.file_id };
  } catch (e) { console.warn('[getShareByToken] failed:', e.message); return null; }
}

export async function listSharesForFile(fileId) {
  if (!sql || !fileId) return [];
  await ensureSharesTable();
  try {
    const rows = await sql`SELECT token, mode, expires_at, view_count, created_at, created_by, (password_hash IS NOT NULL) AS has_password FROM file_shares WHERE file_id = ${fileId} ORDER BY created_at DESC`;
    return rows.map((r) => ({ token: r.token, mode: r.mode || 'public', expiresAt: r.expires_at != null ? Number(r.expires_at) : null, viewCount: Number(r.view_count) || 0, hasPassword: !!r.has_password, createdAt: Number(r.created_at) || null, createdBy: r.created_by || null }));
  } catch { return []; }
}

/**
 * What a token points at, with no side effects.
 *
 * getShareByToken is the public resolver: it checks passwords, expiry and
 * bumps the view count. Authorizing a revoke needs none of that and must not
 * do any of it — counting a view because someone deleted a link would be
 * nonsense.
 */
export async function getShareTarget(token) {
  if (!sql || !token) return null;
  await ensureSharesTable();
  try {
    const rows = await sql`SELECT token, kind, file_id, folder, storage_prefix, created_by FROM file_shares WHERE token = ${token} LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      token: r.token,
      kind: r.kind || 'file',
      fileId: r.file_id || null,
      folder: r.folder || null,
      storagePrefix: r.storage_prefix || null,
      createdBy: r.created_by || null,
    };
  } catch { return null; }
}

/**
 * Every link, for Admin → Shared links: the file, the kind, who made it and
 * whether they are still here (suspended, or removed altogether — a link
 * whose creator has no people or invite row is orphaned). Live links only
 * unless `includeExpired`.
 *
 *   kind       public | password | private
 *   creator    an email
 *   expiringWithinMs  only links that expire within this long
 *   orphaned   only links whose creator is gone
 */
export async function listAllShares({ kind = null, creator = null, expiringWithinMs = null, orphaned = false, includeExpired = false, offset = 0, limit = 100 } = {}) {
  if (!sql) return { rows: [], total: 0 };
  await Promise.all([ensureSharesTable(), ensureFilesTable(), ensurePeopleTable(), ensureInviteRequestsTable()]);
  const now = Date.now();
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const off = Math.max(0, Number(offset) || 0);
  const who = creator ? String(creator).trim().toLowerCase() : null;
  const until = expiringWithinMs != null ? now + Number(expiringWithinMs) : null;
  const rows = await withSchemaRetry([ensureSharesTable, ensurePeopleTable], () => sql`
    SELECT s.token, s.file_id, s.kind AS target, s.mode, (s.password_hash IS NOT NULL) AS has_password,
           s.created_by, s.created_at, s.expires_at, s.view_count,
           f.name AS file_name, f.deleted_at AS file_deleted_at,
           p.status AS creator_status, p.pause_links AS creator_pause_links,
           (p.email IS NULL AND i.email IS NULL) AS creator_gone,
           COUNT(*) OVER ()::int AS total
    FROM file_shares s
    LEFT JOIN files f ON f.id = s.file_id
    LEFT JOIN people p ON p.email = lower(s.created_by)
    LEFT JOIN invite_requests i ON i.email = lower(s.created_by)
    WHERE (${includeExpired} OR s.expires_at IS NULL OR s.expires_at >= ${now})
      AND (${who}::text IS NULL OR lower(s.created_by) = ${who})
      AND (${until}::bigint IS NULL OR (s.expires_at IS NOT NULL AND s.expires_at <= ${until}::bigint))
      AND (NOT ${orphaned} OR (p.email IS NULL AND i.email IS NULL))
      AND (${kind}::text IS NULL
           OR (${kind} = 'private' AND s.mode = 'private')
           OR (${kind} = 'password' AND s.mode <> 'private' AND s.password_hash IS NOT NULL)
           OR (${kind} = 'public' AND s.mode <> 'private' AND s.password_hash IS NULL))
    ORDER BY s.created_at DESC, s.token
    LIMIT ${lim} OFFSET ${off}`);
  return {
    rows: rows.map((r) => ({
      token: r.token,
      fileId: r.file_id || null,
      fileName: r.file_name || null,
      fileTrashed: r.file_deleted_at != null,
      target: r.target || 'file',
      kind: (r.mode || 'public') === 'private' ? 'private' : r.has_password ? 'password' : 'public',
      createdBy: r.created_by || null,
      creator: r.creator_gone ? 'removed' : r.creator_status === 'suspended' ? 'suspended' : 'active',
      paused: r.creator_status === 'suspended' && r.creator_pause_links !== false,
      createdAt: numOrNull(r.created_at),
      expiresAt: numOrNull(r.expires_at),
      viewCount: Number(r.view_count) || 0,
    })),
    total: rows[0] ? Number(rows[0].total) || 0 : 0,
  };
}

/** Revoke many links at once. Returns what was removed, for the audit row. */
export async function deleteShares(tokens = []) {
  const list = (Array.isArray(tokens) ? tokens : []).map(String).filter(Boolean);
  if (!sql || !list.length) return [];
  await ensureSharesTable();
  const rows = await withSchemaRetry(ensureSharesTable, () => sql`
    DELETE FROM file_shares WHERE token = ANY(${list}::text[]) RETURNING token, file_id, created_by`);
  return rows.map((r) => ({ token: r.token, fileId: r.file_id || null, createdBy: r.created_by || null }));
}

export async function deleteShare(token) {
  if (!sql) throw new Error('Database not configured');
  await ensureSharesTable();
  try { await sql`DELETE FROM file_shares WHERE token = ${token}`; } catch (e) { console.warn('[deleteShare] failed:', e.message); }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Library v2 — access control + privacy read path (Phase 1)
//
// The invariant: AUTHORIZE → FILTER → PRESIGN. Every list read funnels through
// listFilesForUser, which filters rows the viewer can't see BEFORE any S3 URL
// is minted (presign happens in the route, only on survivors). Per-file
// visibility: 'org' (any signed-in user), 'owner' (uploader + admins), 'custom'
// (uploader + admins + file_acl grants). Folder ACL (folder_access) adds
// path-inherited grants. Admins bypass everything.
// ─────────────────────────────────────────────────────────────────────────
const ensureFolderAclTable = lazySchema('ensureFolderAclTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS folder_access (
      folder TEXT NOT NULL,
      subject_type TEXT NOT NULL,   -- 'user' | 'role'
      subject TEXT NOT NULL,        -- email | role id
      role TEXT NOT NULL DEFAULT 'viewer', -- viewer | editor | owner
      granted_by TEXT,
      granted_at BIGINT NOT NULL,
      PRIMARY KEY (folder, subject_type, subject)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS vfa_subject_idx ON folder_access (subject_type, subject)`;
  await sql`CREATE INDEX IF NOT EXISTS vfa_folder_idx ON folder_access (folder)`;
});

const ensureFileAclTable = lazySchema('ensureFileAclTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS file_acl (
      file_id TEXT NOT NULL,
      scope TEXT NOT NULL,          -- 'user' | 'role'
      principal TEXT NOT NULL,      -- email | role id
      access TEXT NOT NULL DEFAULT 'viewer',
      granted_by TEXT,
      granted_at BIGINT NOT NULL,
      PRIMARY KEY (file_id, scope, principal)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS file_acl_file_idx ON file_acl (file_id)`;
});

const _ancestorsOf = (folder) => {
  const out = [''];
  if (!folder) return out;
  const segs = folder.split('/'); let p = '';
  for (const s of segs) { p = p ? `${p}/${s}` : s; out.push(p); }
  return out;
};

export async function grantFolderAccess({ folder, subjectType, subject, role = 'viewer', grantedBy } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFolderAclTable();
  const st = subjectType === 'role' ? 'role' : 'user';
  const subj = st === 'user' ? String(subject || '').trim().toLowerCase() : String(subject || '').trim();
  if (folder == null || !subj) throw new Error('folder + subject required');
  const r = ['viewer', 'editor', 'owner'].includes(role) ? role : 'viewer';
  const now = Date.now();
  await sql`INSERT INTO folder_access (folder, subject_type, subject, role, granted_by, granted_at)
    VALUES (${folder}, ${st}, ${subj}, ${r}, ${grantedBy || null}, ${now})
    ON CONFLICT (folder, subject_type, subject) DO UPDATE SET role = ${r}, granted_by = ${grantedBy || null}, granted_at = ${now}`;
  return { ok: true };
}
export async function revokeFolderAccess({ folder, subjectType, subject } = {}) {
  if (!sql) return { ok: false };
  await ensureFolderAclTable();
  const subj = subjectType === 'role' ? String(subject || '').trim() : String(subject || '').trim().toLowerCase();
  await sql`DELETE FROM folder_access WHERE folder = ${folder} AND subject_type = ${subjectType === 'role' ? 'role' : 'user'} AND subject = ${subj}`;
  return { ok: true };
}
export async function listFolderGrants(folder) {
  if (!sql) return [];
  await ensureFolderAclTable();
  try {
    const rows = await sql`SELECT * FROM folder_access WHERE folder = ${folder} ORDER BY granted_at ASC`;
    return rows.map((r) => ({ folder: r.folder, subjectType: r.subject_type, subject: r.subject, role: r.role, grantedAt: Number(r.granted_at) || null }));
  } catch { return []; }
}

/** All folder paths the principal can see via folder grants (self + descendants implied by prefix-match at query time). */
async function folderGrantsForPrincipal(principal) {
  if (!sql) return new Set();
  await ensureFolderAclTable();
  const email = (principal?.email || '').toLowerCase();
  const roleId = principal?.roleId || null;
  try {
    const rows = await sql`
      SELECT folder FROM folder_access
      WHERE (subject_type = 'user' AND subject = ${email})
         OR (subject_type = 'role' AND subject = ${roleId})`;
    return new Set(rows.map((r) => r.folder));
  } catch { return new Set(); }
}

async function fileAclMap(fileIds, principal) {
  // Returns Set of fileIds the principal is explicitly granted via file_acl.
  if (!sql || !fileIds.length) return new Set();
  await ensureFileAclTable();
  const email = (principal?.email || '').toLowerCase();
  const roleId = principal?.roleId || null;
  try {
    const rows = await sql`
      SELECT DISTINCT file_id FROM file_acl
      WHERE file_id = ANY(${fileIds})
        AND ((scope = 'user' AND principal = ${email}) OR (scope = 'role' AND principal = ${roleId}))`;
    return new Set(rows.map((r) => r.file_id));
  } catch { return new Set(); }
}

export async function getFileAcl(fileId) {
  if (!sql || !fileId) return [];
  await ensureFileAclTable();
  try {
    const rows = await sql`SELECT * FROM file_acl WHERE file_id = ${fileId} ORDER BY granted_at ASC`;
    return rows.map((r) => ({ scope: r.scope, principal: r.principal, access: r.access }));
  } catch { return []; }
}

/** Replace a file's ACL with the given users[]+roles[] and set its visibility. */
export async function setFileAcl(fileId, { visibility, users = [], roles = [], grantedBy } = {}) {
  if (!sql || !fileId) return { ok: false };
  await ensureFileAclTable();
  const now = Date.now();
  await sql`DELETE FROM file_acl WHERE file_id = ${fileId}`;
  for (const u of users) {
    const e = String(u || '').trim().toLowerCase(); if (!e) continue;
    await sql`INSERT INTO file_acl (file_id, scope, principal, access, granted_by, granted_at) VALUES (${fileId}, 'user', ${e}, 'viewer', ${grantedBy || null}, ${now}) ON CONFLICT DO NOTHING`;
  }
  for (const r of roles) {
    const rid = String(r || '').trim(); if (!rid) continue;
    await sql`INSERT INTO file_acl (file_id, scope, principal, access, granted_by, granted_at) VALUES (${fileId}, 'role', ${rid}, 'viewer', ${grantedBy || null}, ${now}) ON CONFLICT DO NOTHING`;
  }
  // Who may see the file just changed, so a syncing device has to hear of
  // it: a grant brings the file into someone's drive, a revoke takes it out.
  // setFileVisibility bumps too; this covers a change to the grants alone.
  if (visibility) await setFileVisibility(fileId, visibility);
  else await sql`UPDATE files SET seq = nextval('files_change_seq') WHERE id = ${fileId}`;
  return { ok: true };
}

/**
 * The privacy chokepoint. Lists files (with the same push-down filters as
 * listFiles) then drops any the principal can't see. Admins see all; owners
 * see their own; 'org' files are visible to all signed-in users; 'owner'/'custom'
 * require a file_acl grant or a folder grant on an ancestor folder.
 */

/** Can a single principal see this (already-loaded) file? Used by share/ACL routes. */
export async function canAccessFile(file, principal = {}) {
  if (!file) return false;
  if (principal.isAdmin) return true;
  // Inside a drive they are not a member of, only a grant on the file itself
  // opens it (lib/drive-access.js). Membership is necessary, not sufficient:
  // the rules below still decide within the drive.
  const drive = driveAccess(file.storageKey, await driveScopeOf(principal));
  if (drive.inDrive && !drive.read) return (await fileAclMap([file.id], principal)).has(file.id);
  const email = (principal.email || '').toLowerCase();
  if ((file.createdBy || '').toLowerCase() === email) return true;
  if (file.visibility === 'org') return true;
  const granted = await fileAclMap([file.id], principal);
  if (granted.has(file.id)) return true;
  const fg = await folderGrantsForPrincipal(principal);
  return _ancestorsOf(file.folder).some((a) => fg.has(a));
}

/**
 * WRITE authorization for a single file — deliberately not the same question
 * as canAccessFile.
 *
 * canAccessFile answers "may they see it", and it answers yes for any file
 * with visibility 'org', which is the default every upload gets. Reusing it
 * to guard a rename or a delete would mean every member of the workspace can
 * delete every file in it. Seeing and changing are different rights.
 *
 * The decision is split in two: this pure function holds the rule, and
 * canModifyFile below does the lookups. Same shape as credentialPlan in
 * lib/storage.js, and for the same reason — the rule is the part where a
 * mistake is silent, so it has to be testable without a database.
 *
 * `fileAccess` is this principal's explicit grant on the file ('viewer' |
 * 'editor' | 'owner' | null); `folderRoles` are their grants on the file's
 * folder and its ancestors.
 */
const WRITE_ROLES = new Set(['editor', 'owner']);

/**
 * `action` is the capability the write needs — 'files.edit' for a rename or
 * a retag, 'files.delete' for the trash (lib/roles.js). A role without it
 * never writes, whatever a per-file grant says: the UI hides the control,
 * and this is the half a crafted request cannot route around. Pass null to
 * ask only about the file — "could they change it, were their role to
 * allow" — which is what the link routes want, since each kind of link is
 * its own capability, checked there.
 */
export function fileWriteDecision({ file, principal = {}, fileAccess = null, folderRoles = [], drive = null, action = 'files.edit' } = {}) {
  if (!file) return { allowed: false, reason: 'no-file' };
  if (action && !principal.isAdmin && !principalHasCap(principal, action)) return { allowed: false, reason: 'role' };
  if (principal.isAdmin) return { allowed: true, reason: 'admin' };

  // Inside a drive, the drive decides (lib/drive-access.js): its editors and
  // owners change anything in it, as their desktop mount already lets them;
  // its viewers change nothing, even what they uploaded, as their read-only
  // mount does not. A grant on the file itself still counts — it is how one
  // file is handed to someone outside the drive.
  if (drive?.inDrive) {
    if (drive.write) return { allowed: true, reason: 'drive-editor' };
    if (WRITE_ROLES.has(fileAccess)) return { allowed: true, reason: 'file-grant' };
    return { allowed: false, reason: drive.read ? 'drive-viewer' : 'not-a-member' };
  }

  const email = String(principal.email || '').toLowerCase();
  if (email && String(file.createdBy || '').toLowerCase() === email) return { allowed: true, reason: 'creator' };
  if (WRITE_ROLES.has(fileAccess)) return { allowed: true, reason: 'file-grant' };
  if (folderRoles.some((r) => WRITE_ROLES.has(r))) return { allowed: true, reason: 'folder-grant' };

  // Visibility is deliberately not consulted: 'org' means visible to the
  // workspace, not writable by it.
  return { allowed: false, reason: 'no-grant' };
}

/**
 * Which of these files the principal may write. Returns a Set of ids.
 *
 * Batched on purpose: the bulk metadata editor hands over a whole selection,
 * and asking per file would be two queries each. Two queries total instead,
 * then the pure rule per file.
 */
export async function modifiableFileIds(files, principal = {}, { action = 'files.edit' } = {}) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  const out = new Set();
  if (!list.length) return out;
  if (action && !principal.isAdmin && !principalHasCap(principal, action)) return out;
  if (principal.isAdmin) {
    for (const f of list) out.add(f.id);
    return out;
  }

  const email = String(principal.email || '').toLowerCase();
  const roleId = principal.roleId || null;

  const access = new Map();     // file id → most permissive explicit grant
  let folderRoleMap = new Map(); // folder path → role
  if (sql) {
    try {
      await ensureFileAclTable();
      const rows = await sql`
        SELECT file_id, access FROM file_acl
        WHERE file_id = ANY(${list.map((f) => f.id)})
          AND ((scope = 'user' AND principal = ${email}) OR (scope = 'role' AND principal = ${roleId}))`;
      for (const r of rows) if (WRITE_ROLES.has(r.access)) access.set(r.file_id, r.access);
    } catch { /* unreadable grant is no grant */ }
    try {
      await ensureFolderAclTable();
      const rows = await sql`
        SELECT folder, role FROM folder_access
        WHERE (subject_type = 'user' AND subject = ${email}) OR (subject_type = 'role' AND subject = ${roleId})`;
      folderRoleMap = new Map(rows.map((r) => [r.folder, r.role]));
    } catch { /* same */ }
  }

  const scope = await driveScopeOf(principal);
  for (const f of list) {
    const folderRoles = _ancestorsOf(f.folder).map((a) => folderRoleMap.get(a)).filter(Boolean);
    const drive = driveAccess(f.storageKey, scope);
    const d = fileWriteDecision({ file: f, principal, fileAccess: access.get(f.id) || null, folderRoles, drive, action });
    if (d.allowed) out.add(f.id);
  }
  return out;
}

/**
 * Reduce a set of folder grants to the single strongest one.
 *
 * Pure, so the precedence is testable without a database — and precedence is
 * the part that matters: a principal with both a viewer and an owner grant
 * (one direct, one inherited from an ancestor) holds owner, not viewer.
 */
export function strongestFolderRole(roles = []) {
  const held = new Set(roles.filter(Boolean));
  if (held.has('owner')) return 'owner';
  if (held.has('editor')) return 'editor';
  if (held.has('viewer')) return 'viewer';
  return null;
}

/**
 * What a folder role permits. Two questions, deliberately separate:
 *
 *   'modify' — rename, move, delete. These re-key objects in the bucket and,
 *              with cascade, trash every file underneath.
 *   'grant'  — change who can reach the folder. Stricter, and the same bar
 *              the per-file ACL route applies: granting access is how access
 *              spreads, so it belongs to whoever owns the thing.
 */
export function folderRoleAllows(role, action) {
  if (action === 'grant') return role === 'owner';
  if (action === 'modify') return role === 'owner' || role === 'editor';
  return false;
}

/**
 * Does any folder row at `folder` or beneath it belong to a scope other than
 * `tag` — the library's (untagged) or another drive's? folders.name is the
 * whole primary key, so one path can hold one scope's row while another
 * scope's files sit at the same path; the rename and delete queries touch
 * rows tagged `tag` or untagged, which is why this matters (folderRoleFor).
 */
async function folderRowsOutsideScope(folder, tag) {
  await ensureFoldersTable();
  const a = String(folder || '');
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM folders
      WHERE (name = ${a} OR name LIKE ${escapeLike(a) + '/%'}) AND COALESCE(filespace, '') <> ${String(tag)}
    ) AS outside`;
  return Boolean(row?.outside);
}

/**
 * The most permissive folder role this principal holds on `folder` or any of
 * its ancestors, or null.
 *
 * Folder grants are inherited downward — a grant on "Campaigns" applies to
 * "Campaigns/Spring" — which is why this walks ancestors rather than looking
 * for an exact match.
 *
 * `driveRole` is their (ceiling-capped) role in the drive the operation is
 * scoped to, and `tag` that drive's folders.filespace value. A drive's
 * editors and owners restructure ITS folders: their desktop mount already
 * lets them, and the web used to refuse them with a 403 because only folder
 * grants counted. But only its own. Folder names are not yet per-drive, and
 * the rename and delete queries act on untagged (library) rows as well as
 * the drive's — so a path where the library or another drive holds a folder
 * row, at it or anywhere beneath it, is not the drive's to restructure, and
 * the drive role does not count there: folder grants alone decide, as they
 * did before drive roles counted at all. Whether their ROLE lets them manage
 * folders is the caller's question (can(principal, 'folders.manage')).
 */
export async function folderRoleFor(folder, principal = {}, { driveRole = null, tag = null } = {}) {
  if (principal.isAdmin) return 'owner';
  if (!sql) return null;
  let fromDrive = null;
  if (WRITE_ROLES.has(driveRole) && tag) {
    // Unreadable is not the drive's: fail to "no drive role", never to it.
    try { fromDrive = (await folderRowsOutsideScope(folder, tag)) ? null : driveRole; } catch { fromDrive = null; }
  }
  const email = String(principal.email || '').toLowerCase();
  const roleId = principal.roleId || null;
  try {
    await ensureFolderAclTable();
    const rows = await sql`
      SELECT role FROM folder_access
      WHERE folder = ANY(${_ancestorsOf(folder)})
        AND ((subject_type = 'user' AND subject = ${email}) OR (subject_type = 'role' AND subject = ${roleId}))`;
    return strongestFolderRole([...rows.map((r) => r.role), fromDrive]);
  } catch { return fromDrive; }
}

/**
 * May this principal restructure a folder — rename it, move it, delete it?
 *
 * These are the operations that re-key objects in the bucket and, with
 * cascade, trash every file underneath. They are not "is anybody signed in",
 * which is what guarded them before.
 */
export async function canModifyFolder(folder, principal = {}, opts = {}) {
  return folderRoleAllows(await folderRoleFor(folder, principal, opts), 'modify');
}

/**
 * May this principal change who can reach a folder?
 *
 * Stricter than modifying it, and deliberately the same bar the per-file ACL
 * route applies: granting access is how access spreads, so it belongs to the
 * people who own the thing rather than to everyone who can edit it.
 */
export async function canGrantFolderAccess(folder, principal = {}) {
  return folderRoleAllows(await folderRoleFor(folder, principal), 'grant');
}

/**
 * Look up the grants fileWriteDecision needs for one file, then apply it.
 * `action` as there: the capability the write needs, or null for the file
 * alone.
 */
export async function canModifyFile(file, principal = {}, { action = 'files.edit' } = {}) {
  if (!file) return false;
  return (await modifiableFileIds([file], principal, { action })).has(file.id);
}

/**
 * folder → how many files directly in it this principal may see, across the
 * whole scope: the listing's predicate aggregated rather than paged (see
 * buildFolderCountQuery). A failure reads as nothing visible, as a failed
 * listing does, so the tree falls back to granted folders — never to more.
 */
async function visibleFolderCounts(principal, opts = {}) {
  if (!sql) return new Map();
  try {
    await ensureFilesTable();
    await ensureFileAclTable();
    const { text, params } = buildFolderCountQuery({ opts, principal });
    // Pre-built text with $n placeholders, as in listFilesForUser.
    const rows = await withSchemaRetry(ensureFilesTable, () => sql.unsafe(text, params));
    return new Map(rows.map((r) => [r.folder || '', Number(r.n) || 0]));
  } catch (e) {
    console.warn('[visibleFolderCounts] failed:', e.message);
    return new Map();
  }
}

/**
 * Folder tree filtered to what the principal can see (no leaking hidden folders).
 *
 * A folder stays when it holds a file they may see, is an ancestor of one, or
 * is granted to them outright. Its `count` is the files in it they may see,
 * not every file in it, so the tree does not tell them how much is hidden.
 */
export async function listFileFoldersForUser(principal = {}, opts = {}) {
  const folders = await listFileFolders(opts);
  if (principal.isAdmin) return folders;
  const visible = await visibleFolderCounts(principal, { storagePrefix: opts.storagePrefix });
  // Keep folders that contain a visible file (incl. ancestors) or are explicitly granted.
  const keep = new Set();
  for (const folder of visible.keys()) for (const a of _ancestorsOf(folder)) if (a) keep.add(a);
  const fg = await folderGrantsForPrincipal(principal);
  for (const g of fg) if (g) keep.add(g);
  return folders
    .filter((f) => keep.has(f.folder))
    .map((f) => ({ ...f, count: visible.get(f.folder) || 0 }));
}

/**
 * The principal for an email, from lib/authz.js — imported lazily, because
 * authz imports this module. Callers that already hold one pass it in and
 * this is never reached.
 */
async function principalFor(email, principal) {
  if (principal) return principal;
  const { getPrincipal } = await import('./authz.js');
  return getPrincipal(email);
}

/**
 * Resolve a filespace the web user is allowed to use (admins: any; others: only
 * granted). Returns the full record (with its secret, for server-side use) and
 * `role`, their role in it after the ceiling (lib/roles.js capDriveRole), or
 * null. Used by the Space routes to scope upload/list/sync to a filespace's
 * bucket prefix.
 */
export async function getFilespaceForUser(email, id, principal = null) {
  if (!id) return null;
  const p = await principalFor(email, principal);
  const role = p.isAdmin ? 'owner' : (p.driveScope?.roles?.[id] || null);
  if (!role) return null;
  const fs = await getFilespace(id);
  return fs ? { ...fs, role } : null;
}

/**
 * The same, for putting something INTO the drive — an upload, a new folder, a
 * move or rename that writes under its prefix: admins, and its editors and
 * owners. A viewer can open a drive and not change it, on the web as on the
 * desktop, where their mount is read-only — and so can someone granted
 * editor whose platform role caps them at viewer.
 */
export async function getFilespaceForWrite(email, id, principal = null) {
  const fs = await getFilespaceForUser(email, id, principal);
  if (!fs) return null;
  return canWriteDrive(fs.role) ? fs : null;
}

/**
 * Every drive, and this principal's role in each: what driveAccess needs.
 * Taken from the principal when getPrincipal put it there; built otherwise,
 * so a hand-built principal is held to the boundary too rather than
 * slipping past it.
 */
async function driveScopeOf(principal = {}) {
  if (principal.isAdmin) return { drives: [], roles: {}, isAdmin: true };
  if (principal.driveScope) return principal.driveScope;
  return (await principalFor(principal.email, null)).driveScope || { drives: [], roles: {}, isAdmin: false };
}

/** The same for an email, for routes that check a key before any row exists (uploads). */
export async function driveScopeFor(email, principal = null) {
  const p = await principalFor(email, principal);
  return p.isAdmin ? { drives: [], roles: {}, isAdmin: true } : p.driveScope;
}

/**
 * Every drive and this address's GRANTED role in each — before any ceiling.
 * lib/authz.js caps the roles by the person's platform role; nothing else
 * should read this directly.
 *
 * Its own two queries, and strict: for a boundary, "no drives" would mean "no
 * boundary", so a failed read throws and the request fails rather than
 * seeing into them.
 */
export async function loadDriveGrants(email) {
  if (!sql) return { drives: [], roles: {}, isAdmin: false };
  await ensureFilespacesTables();
  const e = String(email || '').trim().toLowerCase();
  const [drives, mine] = await withSchemaRetry(ensureFilespacesTables, () => Promise.all([
    sql`SELECT id, prefix, share_kinds, quota_bytes FROM filespaces`,
    sql`SELECT filespace_id, role FROM filespace_access WHERE user_email = ${e}`,
  ]));
  return {
    drives: drives.map((d) => ({
      id: d.id,
      prefix: d.prefix,
      shareKinds: parseShareKinds(d.share_kinds),
      quotaBytes: d.quota_bytes != null ? Number(d.quota_bytes) : null,
    })),
    roles: Object.fromEntries(mine.map((r) => [r.filespace_id, r.role || 'viewer'])),
    isAdmin: false,
  };
}

/** Folder paths granted to this email or role id — for the listing's grant clause. */
export async function folderGrantsFor(email, roleId) {
  return [...(await folderGrantsForPrincipal({ email: String(email || '').toLowerCase(), roleId }))];
}

/**
 * Filespaces the web user may pick in Space (admins see all), each with their
 * role in it after the ceiling.
 *
 * For display only — the drive list beside the files, pickers, usage — so a
 * failed read shows no drives for a moment instead of turning the whole page
 * into an error. Nothing that decides access reads this; those paths use the
 * principal's drive scope and fail when it cannot be read.
 */
export async function listFilespacesForSpace(email, principal = null) {
  const p = await principalFor(email, principal);
  let list;
  try {
    list = p.isAdmin
      ? (await listFilespaces()).map((f) => ({ ...f, role: 'owner' }))
      : (await listFilespacesForUser(email)).map((f) => ({ ...f, role: p.driveScope?.roles?.[f.id] || null })).filter((f) => f.role);
  } catch (e) {
    console.warn('[listFilespacesForSpace] failed:', e.message);
    return [];
  }
  return list.map((f) => ({ id: f.id, name: f.name, bucket: f.bucket, prefix: f.prefix, region: f.region || null, role: f.role || 'viewer' }));
}

/**
 * The request principal used by every Library privacy check. A thin wrapper
 * now: lib/authz.js getPrincipal builds the one principal the web, the
 * desktop and STS all share, so they cannot reach different answers.
 */
export async function buildPrincipal(email) {
  const { getPrincipal } = await import('./authz.js');
  return getPrincipal(email);
}


// ─────────────────────────────────────────────────────────────────────────
// Filespaces (Onyx Desktop — desktop S3 mount client)
//
// A "filespace" is a named bucket+prefix scope that admins create and grant
// per-user access to. The Onyx Desktop desktop app lists the filespaces a
// signed-in user may see, then asks /api/space/sts for short-lived AWS
// credentials scoped to exactly that bucket+prefix (see lib/storage.js →
// s3AssumeRoleForFilespace) and mounts it as a FUSE drive via rclone.
//
// Two tables, same lazy-create idiom as the rest of this file:
//   filespaces        — the registry (one row per scope)
//   filespace_access  — per-user grants (composite PK), roles viewer|editor|owner
//
// Env-admins (isAdmin) are implicit owners of every filespace and are NEVER
// persisted as grant rows — authorization layers admin on top at the route.
// ─────────────────────────────────────────────────────────────────────────
const ensureFilespacesTables = lazySchema('ensureFilespacesTables', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS filespaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bucket TEXT NOT NULL,
      prefix TEXT NOT NULL,
      region TEXT,
      role_arn TEXT,
      created_by TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS filespaces_updated_idx ON filespaces (updated_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS filespace_access (
      filespace_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      granted_by TEXT,
      granted_at BIGINT NOT NULL,
      PRIMARY KEY (filespace_id, user_email)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS filespace_access_email_idx ON filespace_access (user_email)`;
  // Per-filespace credentials: a filespace can carry its OWN bucket keys
  // (different key pair / endpoint than the global Storage config). When set,
  // the web Space and the STS minter use these instead of the master keys —
  // so admins can add a totally separate bucket. Null = inherit the global.
  await sql`ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS access_key TEXT`;
  await sql`ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS secret_key TEXT`;
  await sql`ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS endpoint TEXT`;
  // Per-drive settings. quota_bytes caps what the drive may hold (NULL = no
  // limit); ai_allowed opts a drive in to AI tools, off by default because a
  // client's media may not be sent to a provider that trains on it;
  // share_kinds lists the link kinds allowed for files in it, comma-separated
  // (NULL = every kind, '' = none).
  await sql`ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS quota_bytes BIGINT`;
  await sql`ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS ai_allowed BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE filespaces ADD COLUMN IF NOT EXISTS share_kinds TEXT`;
});

const FILESPACE_ROLES = ['viewer', 'editor', 'owner'];

/**
 * filespaces.share_kinds → a list of link kinds, or null for "every kind".
 * NULL is every kind; an empty string is the empty list — no links at all.
 * The two must not be confused: an admin who turns every kind off for a
 * drive has asked for the opposite of "every kind", and reading '' as NULL
 * gave them exactly that.
 */
export function parseShareKinds(value) {
  if (value == null) return null;
  return String(value).split(',').map((k) => k.trim()).filter(Boolean);
}

/** The inverse: a list (possibly empty) → its column value; anything else → NULL. */
export function formatShareKinds(kinds) {
  return Array.isArray(kinds) ? kinds.map(String).join(',') : null;
}
export function isFilespaceRole(role) {
  return FILESPACE_ROLES.includes(String(role || '').trim());
}

function normPrefix(p) {
  return String(p || '').replace(/^\/+|\/+$/g, '');
}

// includeSecret: only the server-side single-record getters (getFilespace,
// getFilespaceForUser) pass true — so the raw secret never rides along in a
// list that might reach a client. Client-facing shapes carry only `hasSecret`.
function shapeFilespace(r, includeSecret = false) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    bucket: r.bucket,
    prefix: r.prefix,
    region: r.region || null,
    roleArn: r.role_arn || null,
    accessKeyId: r.access_key || null,
    endpoint: r.endpoint || null,
    hasSecret: !!r.secret_key,
    ...(includeSecret === true ? { secretAccessKey: r.secret_key || null } : {}),
    quotaBytes: r.quota_bytes != null ? Number(r.quota_bytes) : null,
    aiAllowed: r.ai_allowed === true,
    shareKinds: parseShareKinds(r.share_kinds),
    createdBy: r.created_by || null,
    createdAt: Number(r.created_at) || null,
    updatedAt: Number(r.updated_at) || null,
    memberCount: r.member_count != null ? Number(r.member_count) : undefined,
  };
}

function shapeMember(r) {
  if (!r) return null;
  return {
    filespaceId: r.filespace_id,
    email: r.user_email,
    role: r.role || 'viewer',
    grantedBy: r.granted_by || null,
    grantedAt: Number(r.granted_at) || null,
  };
}

export async function createFilespace({ name, bucket, prefix, region, roleArn, accessKeyId, secretAccessKey, endpoint, createdBy } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilespacesTables();
  const id = crypto.randomUUID();
  const now = Date.now();
  const rows = await sql`
    INSERT INTO filespaces (id, name, bucket, prefix, region, role_arn, access_key, secret_key, endpoint, created_by, created_at, updated_at)
    VALUES (
      ${id}, ${String(name || 'Untitled filespace').trim()}, ${String(bucket || '').trim()},
      ${normPrefix(prefix)}, ${region || null}, ${roleArn || null},
      ${accessKeyId ? String(accessKeyId).trim() : null}, ${secretAccessKey ? String(secretAccessKey) : null}, ${endpoint ? String(endpoint).trim() : null},
      ${createdBy || null}, ${now}, ${now}
    )
    RETURNING *
  `;
  return shapeFilespace(rows[0]);
}

/**
 * Every drive. A failed read throws rather than answering [], which would be
 * read as "there are no drives": the library feed would then take drive
 * files for library files, and the overlap checks on creating a drive would
 * pass against nothing.
 */
export async function listFilespaces() {
  if (!sql) return [];
  await ensureFilespacesTables();
  const rows = await withSchemaRetry(ensureFilespacesTables, () => sql`
    SELECT f.*, (SELECT COUNT(*)::int FROM filespace_access a WHERE a.filespace_id = f.id) AS member_count
    FROM filespaces f
    ORDER BY f.updated_at DESC
    LIMIT 500
  `);
  // Not map(shapeFilespace): map's index would land in includeSecret, and
  // every drive after the first would carry its secret key to the client.
  return rows.map((r) => shapeFilespace(r));
}

export async function getFilespace(id) {
  if (!sql || !id) return null;
  await ensureFilespacesTables();
  const rows = await sql`SELECT * FROM filespaces WHERE id = ${id} LIMIT 1`;
  // includeSecret: this single-record getter feeds server-side credential
  // resolution (cfgForFilespace / the STS minter). Never returned to a client.
  return shapeFilespace(rows[0], true);
}
// Alias — some call sites read more naturally as getFilespaceById.
export const getFilespaceById = getFilespace;

export async function updateFilespace(id, fields = {}) {
  if (!sql || !id) return null;
  await ensureFilespacesTables();
  const existing = await getFilespace(id);
  if (!existing) return null;
  const m = { ...existing, ...fields };
  const now = Date.now();
  // Credentials: no access key ⇒ clear the secret too (fall back to the global
  // config). With a key, a blank secret means "keep the stored one".
  const hasKey = !!(m.accessKeyId && String(m.accessKeyId).trim());
  const accessKey = hasKey ? String(m.accessKeyId).trim() : null;
  const secretKey = !hasKey
    ? null
    : ((fields.secretAccessKey != null && String(fields.secretAccessKey).trim())
        ? String(fields.secretAccessKey)
        : (existing.secretAccessKey || null));
  const shareKinds = formatShareKinds(m.shareKinds);
  const rows = await withSchemaRetry(ensureFilespacesTables, () => sql`
    UPDATE filespaces SET
      name = ${String(m.name || existing.name)}, bucket = ${String(m.bucket || existing.bucket)},
      prefix = ${normPrefix(m.prefix)}, region = ${m.region || null}, role_arn = ${m.roleArn || null},
      access_key = ${accessKey},
      secret_key = ${secretKey},
      endpoint = ${m.endpoint ? String(m.endpoint).trim() : null},
      quota_bytes = ${m.quotaBytes != null ? Number(m.quotaBytes) : null},
      ai_allowed = ${m.aiAllowed === true},
      share_kinds = ${shareKinds},
      updated_at = ${now}
    WHERE id = ${id}
    RETURNING *
  `);
  return shapeFilespace(rows[0], true);
}

export async function deleteFilespace(id) {
  if (!sql || !id) return { ok: false };
  await ensureFilespacesTables();
  // No FK between the tables — prune the child grant rows first, then the row.
  await sql`DELETE FROM filespace_access WHERE filespace_id = ${id}`;
  await sql`DELETE FROM filespaces WHERE id = ${id}`;
  return { ok: true, id };
}

/** Drives this address created — what the self-serve limit counts. */
export async function countFilespacesCreatedBy(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!sql || !e) return 0;
  await ensureFilespacesTables();
  const rows = await withSchemaRetry(ensureFilespacesTables, () => sql`
    SELECT COUNT(*)::int AS n FROM filespaces WHERE lower(created_by) = ${e}`);
  return Number(rows[0]?.n) || 0;
}

/**
 * Live catalog rows stored under a filespace's prefix: what deleting the
 * filespace would leave behind. Deleting a filespace never touches these (or
 * the objects), so the confirm has to say how many there are. Served by the
 * storage_key text_pattern_ops index.
 */
export async function countFilesUnderPrefix(prefix) {
  const p = normPrefix(prefix);
  if (!sql || !p) return { files: 0, bytes: 0 };
  const like = `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
  const rows = await sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(size), 0)::bigint AS bytes
    FROM files WHERE deleted_at IS NULL AND storage_key LIKE ${like}
  `;
  return { files: Number(rows[0]?.n) || 0, bytes: Number(rows[0]?.bytes) || 0 };
}

/**
 * Does any file row — live or in the trash — have its object under this
 * prefix? A new self-serve drive must not be laid over files that are
 * already stored (a deleted drive's leftovers, say): its owner would be
 * handed all of them, other people's private ones included. Trashed rows
 * count because restoring one puts it back at that key.
 */
export async function prefixHoldsFiles(prefix) {
  const p = normPrefix(prefix);
  if (!sql || !p) return false;
  await ensureFilesTable();
  const like = `${escapeLike(p)}/%`;
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT EXISTS (SELECT 1 FROM files WHERE storage_key LIKE ${like}) AS held`);
  return Boolean(rows[0]?.held);
}

// ── Storage: what is using the space ──────────────────────────────────────
// Read by /storage and /storage/duplicates, which are admin pages: these
// describe every file in the library, so the pages gate them and nothing
// here filters by who is asking. Sizes are the catalog's (set from the
// bucket's own HEAD at upload); previews under _thumbs/ have no rows and are
// not counted.

const usageOf = (r) => ({ files: Number(r?.files) || 0, bytes: Number(r?.bytes) || 0 });

/** Live files in the whole library, and the bytes they take. */
export async function libraryUsage() {
  if (!sql) return { files: 0, bytes: 0 };
  await ensureFilesTable();
  const rows = await sql`SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes FROM files WHERE deleted_at IS NULL`;
  return usageOf(rows[0]);
}

/**
 * Live files by kind and by format, the largest, the trash, and what is kept
 * outside every drive. `drivePrefixes` are the filespaces' prefixes; a file
 * under none of them is only reachable from All files.
 */
export async function storageReport({ largest = 20, drivePrefixes = [] } = {}) {
  if (!sql) return null;
  await ensureFilesTable();
  const likes = drivePrefixes.map(normPrefix).filter(Boolean)
    .map((p) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`);
  const [live, kinds, formats, big, trash, outside] = await Promise.all([
    sql`SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes FROM files WHERE deleted_at IS NULL`,
    sql`
      SELECT kind, COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes
      FROM files WHERE deleted_at IS NULL
      GROUP BY kind ORDER BY bytes DESC`,
    // The extension, lowercased, as the format: what someone would call the
    // file ("MOV", "PSD"), where the mime type is often generic.
    sql`
      SELECT kind, lower(substring(name from '\\.([A-Za-z0-9]{1,8})$')) AS ext,
             COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes
      FROM files WHERE deleted_at IS NULL
      GROUP BY 1, 2 ORDER BY bytes DESC LIMIT 24`,
    sql`
      SELECT * FROM files
      WHERE deleted_at IS NULL AND size IS NOT NULL
      ORDER BY size DESC, id LIMIT ${largest}`,
    sql`SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes FROM files WHERE deleted_at IS NOT NULL`,
    likes.length
      ? sql`
          SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes
          FROM files WHERE deleted_at IS NULL AND NOT (COALESCE(storage_key, '') LIKE ANY(${likes}))`
      : null,
  ]);
  return {
    live: usageOf(live[0]),
    kinds: kinds.map((r) => ({ kind: r.kind || 'other', ...usageOf(r) })),
    formats: formats.map((r) => ({ kind: r.kind || 'other', ext: r.ext || null, ...usageOf(r) })),
    largest: big.map(shapeFile),
    trash: usageOf(trash[0]),
    outsideDrives: outside ? usageOf(outside[0]) : usageOf(live[0]),
  };
}

/**
 * Duplicates: live files that share a content hash and a size — the same
 * bytes, stored more than once. Groups come worst first (the most space a
 * clean-up would give back), each with its files oldest first.
 */
export async function listDuplicateFiles({ limit = 200 } = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  const groups = await sql`
    SELECT content_hash, size, COUNT(*)::int AS n
    FROM files
    WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND size > 0
    GROUP BY content_hash, size
    HAVING COUNT(*) > 1
    ORDER BY (COUNT(*) - 1) * size DESC, content_hash
    LIMIT ${limit}
  `;
  if (!groups.length) return [];
  const rows = await sql`
    SELECT * FROM files
    WHERE deleted_at IS NULL AND size > 0
      AND content_hash = ANY(${groups.map((g) => g.content_hash)})
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map(shapeFile);
}

/** How many duplicates there are, what removing them would free, and how many files have no hash yet. */
export async function duplicateSummary() {
  if (!sql) return { groups: 0, extra: 0, bytes: 0, unhashed: 0 };
  await ensureFilesTable();
  const [dup, missing] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS groups, COALESCE(SUM(n - 1), 0)::int AS extra,
             COALESCE(SUM((n - 1) * size), 0)::bigint AS bytes
      FROM (
        SELECT size, COUNT(*) AS n FROM files
        WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND size > 0
        GROUP BY content_hash, size HAVING COUNT(*) > 1
      ) d`,
    sql`
      SELECT COUNT(*)::int AS n FROM files
      WHERE deleted_at IS NULL AND content_hash IS NULL AND storage = 's3' AND storage_key IS NOT NULL`,
  ]);
  return {
    groups: Number(dup[0]?.groups) || 0,
    extra: Number(dup[0]?.extra) || 0,
    bytes: Number(dup[0]?.bytes) || 0,
    unhashed: Number(missing[0]?.n) || 0,
  };
}

/**
 * Live bucket files with no content hash, by id after `after` — the rows the
 * duplicate scan still has to HEAD. Paged by id so one scan passes over each
 * row once, even the ones whose object is gone and so never get a hash.
 */
export async function listFilesMissingHash({ after = '', limit = 200 } = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  return sql`
    SELECT id, storage_key, size FROM files
    WHERE deleted_at IS NULL AND content_hash IS NULL AND storage = 's3'
      AND storage_key IS NOT NULL AND id > ${String(after || '')}
    ORDER BY id LIMIT ${limit}
  `;
}

/**
 * Record a file's content hash (and its size, if the row never had one).
 * Deliberately not a sync-visible write — no version or seq bump: the bytes
 * did not change, and announcing it would have every synced device fetch
 * every file again (a File Provider keys content on the hash). A device
 * picks the hash up with the row's next real change.
 */
export async function setFileContentHash(id, hash, size = null) {
  if (!sql || !id || !hash) return false;
  await ensureFilesTable();
  const rows = await sql`
    UPDATE files SET content_hash = ${hash}, size = COALESCE(size, ${size != null ? Number(size) : null})
    WHERE id = ${id} AND content_hash IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

// First path segments Onyx writes to on its own. A filespace rooted at one of
// these would mount thumbnails or the trash as if they were files.
const RESERVED_FILESPACE_ROOTS = new Set(['_thumbs', '_trash']);

/**
 * Why a filespace's name/bucket/prefix can't be saved ({ status, error }), or null. Pure: `others`
 * is every OTHER filespace. Two filespaces may nest (a team space and a
 * client space inside it is a real setup), but two with the same bucket and
 * prefix are the same scope under two names, and two with the same name make
 * the switcher ambiguous.
 */
export function filespaceSetupProblem({ name, bucket, prefix } = {}, others = []) {
  const n = String(name || '').trim();
  const p = normPrefix(prefix);
  const bad = (error) => ({ status: 400, error });
  if (!n) return bad('Give the filespace a name.');
  if (n.length > 80) return bad('Keep the name under 80 characters.');
  if (!p) return bad('A filespace needs a prefix. It cannot be the whole bucket.');
  if (p.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return bad('The prefix has an empty or relative segment.');
  if (RESERVED_FILESPACE_ROOTS.has(p.split('/')[0])) return bad(`"${p.split('/')[0]}" is reserved for Onyx's own objects.`);
  const lower = n.toLowerCase();
  if (others.some((o) => String(o.name || '').trim().toLowerCase() === lower)) return { status: 409, error: `A filespace called "${n}" already exists.` };
  const b = String(bucket || '').trim();
  const same = others.find((o) => String(o.bucket || '').trim() === b && normPrefix(o.prefix) === p);
  if (same) return { status: 409, error: `"${same.name}" already uses ${b}/${p}.` };
  return null;
}

/**
 * May `actor` change `targetEmail`'s grant on a filespace? Returns null when
 * allowed, else { status, error }.
 *
 * Admins manage every filespace. Filespace owners manage their own filespace's
 * members — the same bar folderRoleAllows(role, 'grant') sets for folders:
 * access spreads through whoever owns the thing. Editors and viewers do not.
 * Owners cannot change their own grant (an owner demoting or removing
 * themselves by accident would need an admin to undo), and may only add people
 * who can already sign in, so a typo does not sit as a grant for an address
 * nobody controls.
 */
export function filespaceMemberDecision({ actor = {}, actorRole = null, targetEmail, targetIsAdmin = false, targetCanSignIn = true, grant = true, role = 'viewer' } = {}) {
  const e = String(targetEmail || '').trim().toLowerCase();
  if (!e || !e.includes('@')) return { status: 400, error: 'Enter an email address.' };
  if (!actor.isAdmin && actorRole !== 'owner') return { status: 403, error: 'Only admins and owners of this filespace can manage its members.' };
  if (grant && targetIsAdmin) return { status: 400, error: 'This person is an admin. Admins already reach every filespace.' };
  if (grant && !isFilespaceRole(role)) return { status: 400, error: 'Unknown role.' };
  if (!actor.isAdmin) {
    if (e === String(actor.email || '').trim().toLowerCase()) return { status: 403, error: 'You cannot change your own access. Ask another owner or an admin.' };
    if (grant && !targetCanSignIn) return { status: 400, error: `${e} cannot sign in yet. Ask an admin to invite them first.` };
  }
  return null;
}

/**
 * Filespaces a given user has been granted, annotated with their role.
 *
 * A failed read throws. It used to answer [], and "no drives" is a real
 * answer to a device: the Mac took a drive feed's 404 on a passing database
 * error for a drive taken away, and set about deleting its offline copies.
 * Callers that face a device turn the error into a 503 to retry.
 */
export async function listFilespacesForUser(email) {
  if (!sql || !email) return [];
  await ensureFilespacesTables();
  const e = String(email).trim().toLowerCase();
  const rows = await withSchemaRetry(ensureFilespacesTables, () => sql`
    SELECT f.*, a.role AS access_role
    FROM filespaces f
    JOIN filespace_access a ON a.filespace_id = f.id
    WHERE a.user_email = ${e}
    ORDER BY f.updated_at DESC
  `);
  return rows.map((r) => ({ ...shapeFilespace(r), role: r.access_role || 'viewer' }));
}

export async function grantFilespaceAccess({ filespaceId, email, role = 'viewer', grantedBy } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilespacesTables();
  const e = String(email || '').trim().toLowerCase();
  if (!filespaceId || !e) throw new Error('filespaceId and email required');
  const r = isFilespaceRole(role) ? role : 'viewer';
  const now = Date.now();
  const rows = await sql`
    INSERT INTO filespace_access (filespace_id, user_email, role, granted_by, granted_at)
    VALUES (${filespaceId}, ${e}, ${r}, ${grantedBy || null}, ${now})
    ON CONFLICT (filespace_id, user_email)
    DO UPDATE SET role = ${r}, granted_by = ${grantedBy || null}, granted_at = ${now}
    RETURNING *
  `;
  return shapeMember(rows[0]);
}
// Alias for shorter call sites.
export const grantAccess = grantFilespaceAccess;

export async function revokeFilespaceAccess({ filespaceId, email } = {}) {
  if (!sql) return { ok: false };
  await ensureFilespacesTables();
  const e = String(email || '').trim().toLowerCase();
  if (!filespaceId || !e) return { ok: false };
  await sql`DELETE FROM filespace_access WHERE filespace_id = ${filespaceId} AND user_email = ${e}`;
  return { ok: true };
}
export const revokeAccess = revokeFilespaceAccess;

export async function listFilespaceMembers(filespaceId) {
  if (!sql || !filespaceId) return [];
  await ensureFilespacesTables();
  try {
    const rows = await sql`
      SELECT * FROM filespace_access WHERE filespace_id = ${filespaceId} ORDER BY granted_at ASC
    `;
    return rows.map(shapeMember);
  } catch (e) {
    console.warn('[listFilespaceMembers] failed:', e.message);
    return [];
  }
}

/** Existence check used by the STS + browse routes (admins bypass at the route). */
export async function userCanAccessFilespace({ filespaceId, email } = {}) {
  if (!sql || !filespaceId || !email) return false;
  await ensureFilespacesTables();
  const e = String(email).trim().toLowerCase();
  try {
    const rows = await sql`
      SELECT 1 FROM filespace_access WHERE filespace_id = ${filespaceId} AND user_email = ${e} LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** The granted role for a user in a filespace, or null if none. */
export async function getFilespaceRole({ filespaceId, email } = {}) {
  if (!sql || !filespaceId || !email) return null;
  await ensureFilespacesTables();
  const e = String(email).trim().toLowerCase();
  try {
    const rows = await sql`
      SELECT role FROM filespace_access WHERE filespace_id = ${filespaceId} AND user_email = ${e} LIMIT 1
    `;
    return rows[0]?.role || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Desktop auth (Onyx Desktop ↔ Onyx)
//
// Native desktop apps have no browser cookies, so they authenticate via a
// short-lived authorization CODE minted from an already-signed-in browser
// session, then exchanged (over HTTPS, bound by PKCE) for a long-lived bearer
// TOKEN. Tokens are hashed at rest (we store sha256hex, never the raw value)
// and carried in the Authorization header on every /api/space/* request,
// where lib/desktop-guard.js re-checks the live allowlist.
//
//   desktop_auth_codes — single-use codes (kind 'pkce' | 'pairing'), short TTL
//   desktop_tokens     — long-lived bearer tokens, stored hashed
// ─────────────────────────────────────────────────────────────────────────
const ensureDesktopAuthTables = lazySchema('ensureDesktopAuthTables', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS desktop_auth_codes (
      code TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code_challenge TEXT,
      kind TEXT NOT NULL DEFAULT 'pkce',
      label TEXT,
      claimed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS desktop_auth_codes_expires_idx ON desktop_auth_codes (expires_at)`;
  // For a 'web' code: the device token that asked for it. The web session it
  // becomes carries that id, and ends when the token is revoked.
  await sql`ALTER TABLE desktop_auth_codes ADD COLUMN IF NOT EXISTS device_token_id TEXT`;
  await sql`
    CREATE TABLE IF NOT EXISTS desktop_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      label TEXT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT,
      last_used_at BIGINT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS desktop_tokens_email_idx ON desktop_tokens (email)`;
});

// Web Crypto only (no node:crypto) — this module is reached by auth.js, which
// middleware.js pulls into the EDGE runtime, where node: builtins are banned.
// crypto.subtle / crypto.getRandomValues / btoa / TextEncoder are all global
// in both the edge and node runtimes.
function _randBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function _hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
function _b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Crockford base32 (no I/L/O/U) — human-typable, uppercase. 12 chars = 60 bits,
// which makes online brute force of a pairing code infeasible within its short TTL.
const _CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function _base32(nChars) {
  const b = _randBytes(nChars);
  let s = '';
  for (let i = 0; i < nChars; i++) s += _CROCKFORD[b[i] & 31];
  return s;
}
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return _hex(new Uint8Array(buf));
}
function randomTokenRaw() {
  return 'dt_live_' + _b64url(_randBytes(32));
}

/**
 * Mint a desktop authorization code. kind 'pkce' stores the code_challenge
 * (S256, base64url(sha256(verifier))); kind 'pairing' has no challenge and is
 * claimed in the browser before the desktop can exchange it.
 */
export async function createDesktopAuthCode({ email, codeChallenge = null, kind = 'pkce', label = null, deviceTokenId = null, ttlMs = 5 * 60 * 1000 } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureDesktopAuthTables();
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('email required');
  // Pairing codes are typed by a human (Crockford base32, 60 bits). PKCE codes
  // are machine-handled → longer/opaque (192 bits).
  const code = kind === 'pairing'
    ? _base32(12)
    : _b64url(_randBytes(24));
  const now = Date.now();
  const expiresAt = now + ttlMs;
  await withSchemaRetry(ensureDesktopAuthTables, () => sql`
    INSERT INTO desktop_auth_codes (code, email, code_challenge, kind, label, device_token_id, claimed, created_at, expires_at)
    VALUES (${code}, ${e}, ${codeChallenge}, ${kind}, ${label}, ${deviceTokenId}, ${kind !== 'pairing'}, ${now}, ${expiresAt})
  `);
  try { await sql`DELETE FROM desktop_auth_codes WHERE expires_at < ${now}`; } catch {}
  return { code, expiresAt };
}

/** Single-use consume — atomically deletes and returns the row (or null). */
export async function consumeDesktopAuthCode(code) {
  if (!sql || !code) return null;
  await ensureDesktopAuthTables();
  const now = Date.now();
  const rows = await sql`
    DELETE FROM desktop_auth_codes WHERE code = ${code} AND expires_at >= ${now}
    RETURNING *
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    code: r.code, email: r.email, codeChallenge: r.code_challenge || null, kind: r.kind, label: r.label || null,
    claimed: !!r.claimed, deviceTokenId: r.device_token_id || null,
  };
}

/**
 * The Auth.js user row for an address, created if it is missing — for minting
 * a web session from a device token (/api/desktop/web-session). The address
 * is already approved by then; the row normally exists from the sign-in that
 * authorized the device.
 */
export async function getOrCreateAuthUser(email) {
  if (!sql) throw new Error('Database not configured');
  await ensureAuthTables();
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('email required');
  const found = await sql`SELECT id, name, email FROM "user" WHERE lower(email) = ${e} LIMIT 1`;
  if (found[0]) return found[0];
  await sql`INSERT INTO "user" (id, email) VALUES (${crypto.randomUUID()}, ${e}) ON CONFLICT (email) DO NOTHING`;
  const rows = await sql`SELECT id, name, email FROM "user" WHERE lower(email) = ${e} LIMIT 1`;
  return rows[0] || null;
}

/**
 * Create a long-lived desktop bearer token. Returns the RAW token exactly once
 * (the caller hands it to the desktop); only sha256hex is stored.
 */
export async function createDesktopToken({ email, label = null, ttlMs = 90 * 24 * 60 * 60 * 1000 } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureDesktopAuthTables();
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('email required');
  const raw = randomTokenRaw();
  const hash = await sha256hex(raw);
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = ttlMs ? now + ttlMs : null;
  await sql`
    INSERT INTO desktop_tokens (id, token_hash, email, label, created_at, expires_at, last_used_at)
    VALUES (${id}, ${hash}, ${e}, ${label}, ${now}, ${expiresAt}, ${now})
  `;
  return { id, token: raw, email: e, label, expiresAt };
}

/** Resolve a raw bearer token to its row (verifies hash + expiry). Null if invalid. */
export async function getDesktopTokenByRaw(raw) {
  if (!sql || !raw) return null;
  await ensureDesktopAuthTables();
  const hash = await sha256hex(raw);
  const now = Date.now();
  const rows = await sql`
    SELECT * FROM desktop_tokens
    WHERE token_hash = ${hash} AND (expires_at IS NULL OR expires_at >= ${now})
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, email: r.email, label: r.label || null, createdAt: Number(r.created_at) || null, expiresAt: r.expires_at != null ? Number(r.expires_at) : null };
}

export async function touchDesktopToken(id) {
  if (!sql || !id) return;
  await ensureDesktopAuthTables();
  try { await sql`UPDATE desktop_tokens SET last_used_at = ${Date.now()} WHERE id = ${id}`; } catch {}
}

export async function revokeDesktopToken(id) {
  if (!sql || !id) return { ok: false };
  await ensureDesktopAuthTables();
  await sql`DELETE FROM desktop_tokens WHERE id = ${id}`;
  return { ok: true, id };
}

export async function listDesktopTokens(email) {
  if (!sql || !email) return [];
  await ensureDesktopAuthTables();
  const e = String(email).trim().toLowerCase();
  try {
    const rows = await sql`SELECT id, email, label, created_at, expires_at, last_used_at FROM desktop_tokens WHERE email = ${e} ORDER BY created_at DESC`;
    return rows.map((r) => ({ id: r.id, email: r.email, label: r.label || null, createdAt: Number(r.created_at) || null, expiresAt: r.expires_at != null ? Number(r.expires_at) : null, lastUsedAt: r.last_used_at != null ? Number(r.last_used_at) : null }));
  } catch { return []; }
}

