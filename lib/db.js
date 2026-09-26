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
import { resolveRole } from './roles.js';
import { buildFileQuery, buildDeltaQuery, buildFolderCountQuery, nextCursor, FILE_COLUMNS } from './file-query.js';
import { escapeLike, rebase } from './folder-ops.js';
import { newShareToken, hashSharePassword, verifySharePassword, MAX_PASSWORD_FAILURES, PASSWORD_LOCK_MS } from './shares.js';
import { driveAccess, drivePatterns, canWriteDrive } from './drive-access.js';
import { createHash } from 'node:crypto';
import { avatarPath } from './avatars.js';
import { deriveReviewStatus } from './review.js';

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

function createSqlClient() {
  if (!connectionString) {
    return unusableClient('Database is not configured — set DATABASE_URL and redeploy. See /api/health.');
  }
  try {
    return postgres(connectionString, {
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
 * So the read path heals itself. 42703 is undefined_column, which for this
 * codebase means exactly one thing: the guard is ahead of the database. Apply
 * it and retry. Anything else rethrows — this must not become a blanket retry
 * that hides a real error behind a second attempt.
 */
// When the last repair for a guard was attempted, so a database that stays
// behind the code cannot turn every request into another round of DDL.
const repairAttempts = new Map();
const REPAIR_COOLDOWN_MS = 60_000;

export async function withSchemaRetry(guard, run) {
  try {
    return await run();
  } catch (e) {
    if (e?.code !== '42703') throw e;

    // `force()`, NOT `force(true)`. This mattered: force(true) clears the
    // memo, so every failing request started its OWN repair. On the day the
    // `files.version` column was missing, seventeen /api/files requests meant
    // seventeen ALTER TABLE statements, each wanting ACCESS EXCLUSIVE on
    // `files`. A pending ACCESS EXCLUSIVE request blocks every reader queued
    // behind it, so the self-heal became the outage: the reads it was meant
    // to rescue were the ones waiting on its lock. Without the refresh the
    // repair happens once per instance and later callers await that one.
    const last = repairAttempts.get(guard);
    if (last && Date.now() - last < REPAIR_COOLDOWN_MS) {
      // Already tried recently and the column is still missing, so the repair
      // is not working. Surface the real error rather than queue more DDL.
      throw e;
    }
    repairAttempts.set(guard, Date.now());

    console.warn('[db] schema is behind the code (%s) — applying the guard once and retrying', e.message);
    await guard.force();
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
  if (hit && hit.expires > Date.now()) return hit.value;

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
    if (!fresh) settingsCache.set(key, { value: null, expires: Date.now() + SETTINGS_FAIL_TTL_MS });
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

  // Pull admin emails from env. Same defaults as auth-allowlist.js for
  // consistency — Ricky + hi@rickymantilla.com when env is unset.
  const adminEmails = String(process.env.ADMIN_EMAILS || 'ricky@example.com,hi@rickymantilla.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s.includes('@'));

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
 * Update an existing invite request — admin approval/denial flow. Stamps
 * reviewedAt + reviewedBy automatically. Returns the updated row.
 */
export async function updateInviteRequest(id, { status, reviewedBy, reviewNote }) {
  if (!sql) throw new Error('Database not configured');
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
 * person can request access again from scratch). For a persistent block that
 * survives re-requests, use status 'banned' via updateInviteRequest instead.
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
 * Fully remove a user: revoke their access grant (the invite row the allowlist
 * reads) and delete their auth account, which cascades sessions and accounts so
 * any browser they are signed in on stops working. Desktop tokens need no
 * separate step — lib/desktop-guard.js re-checks the allowlist on every
 * request, so they stop within one request.
 * Their authored content (createdBy = email) is left intact. Env-level
 * ADMIN_EMAILS aren't affected here — block those by editing the env var.
 */
export async function removeUserAccount(email) {
  if (!sql) throw new Error('Database not configured');
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { ok: false };
  try { await ensureInviteRequestsTable(); await sql`DELETE FROM invite_requests WHERE lower(email) = ${e}`; } catch (err) { console.warn('[removeUserAccount] invite:', err.message); }
  try { await sql`DELETE FROM "user" WHERE lower(email) = ${e}`; } catch (err) { console.warn('[removeUserAccount] user:', err.message); }
  return { ok: true, email: e };
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
 * approved row for this email. Note: env-driven admin emails are handled
 * separately in lib/auth-allowlist.js → isEmailGrantedAccess(); this function
 * only looks at the DB.
 */
export async function isEmailApprovedInvite(email) {
  if (!sql) return false;
  try {
    await ensureInviteRequestsTable();
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return false;
    const rows = await sql`
      SELECT 1 FROM invite_requests
      WHERE email = ${normalized} AND status = 'approved'
      LIMIT 1
    `;
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

  // ── Review ──────────────────────────────────────────────────────────────
  // What the grid badges and the "Review status" facet read, kept on the row
  // so a listing never has to aggregate comments. Server-owned: written only
  // by refreshReviewStatus from the review tables, never through metadata or
  // PATCH. Neither bumps version, seq or updated_at — a comment is not an edit
  // of the file, and a syncing device has nothing to learn from one.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS review_status TEXT`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS open_comments INT NOT NULL DEFAULT 0`;

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
 * Record a video's frame model — its exact rate, frame count and start
 * timecode (lib/mp4-probe.js, validated by mediaFacts) — merged into its
 * metadata, with width/height/duration filled in only where the row has none.
 *
 * Like a thumbnail, and for the same reasons, this is not an edit: version and
 * updated_at stay put, since the detail page backfills it merely by being
 * opened. Nor is seq bumped — nothing a device does reads a frame rate.
 */
export async function setFileFrameModel(id, facts = {}, fallback = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await sql`
    UPDATE files
    SET metadata = ${sql.json(fallback)}::jsonb || COALESCE(metadata, '{}'::jsonb) || ${sql.json(facts)}::jsonb
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? shapeFile(rows[0]) : null;
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
    version: r.version != null ? Number(r.version) : 1,
    contentHash: r.content_hash || null,
    reviewStatus: r.review_status || null,
    openComments: r.open_comments != null ? Number(r.open_comments) : 0,
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
export async function softDeleteFile(id, { trashKey = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await sql`
    UPDATE files SET deleted_at = ${Date.now()}, trash_key = ${trashKey}, updated_at = ${Date.now()},
      seq = nextval('files_change_seq')
    WHERE id = ${id} RETURNING *`;
  return rows[0] ? shapeFile(rows[0]) : null;
}

/** Restore a trashed file (clears the trash flags). S3 move-back is done by the route. */
export async function restoreFile(id) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await sql`
    UPDATE files SET deleted_at = NULL, trash_key = NULL, updated_at = ${Date.now()},
      seq = nextval('files_change_seq')
    WHERE id = ${id} RETURNING *`;
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
  // And its review: the comments, decisions, watchers and read markers of a
  // file that no longer exists are nobody's to read. One statement per table,
  // each on its own: a table that was never created is not a failed delete.
  await deleteReviewRows(id);
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

export async function deleteShare(token) {
  if (!sql) throw new Error('Database not configured');
  await ensureSharesTable();
  try { await sql`DELETE FROM file_shares WHERE token = ${token}`; } catch (e) { console.warn('[deleteShare] failed:', e.message); }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Review — comments pinned to frames, reviewers' decisions, and who follows
// a file. The rules (who may, what a comment may hold, how a status is
// derived) are in lib/review.js; this is only storage.
//
// One sequence, review_change_seq, stamps every insert AND every update of a
// comment or a decision, so "what changed on this file since X" is one
// indexed range read: the review feed an open review panel polls every few
// seconds. It is the files_change_seq idea again, and for the same reason —
// updated_at is not a cursor, two writes in one millisecond straddle it.
//
// No foreign keys, as everywhere in this file; deleteFile clears these rows
// by hand (deleteReviewRows). Nothing here uses sql.begin (see the client
// notes at the top), so each write is one statement, and the file's derived
// status is refreshed by a second one — which the feed re-checks, so a race
// between two writers heals on the next read rather than sticking.
// ─────────────────────────────────────────────────────────────────────────
const ensureReviewTables = lazySchema('ensureReviewTables', async () => {
  await sql`CREATE SEQUENCE IF NOT EXISTS review_change_seq`;
  await sql`
    CREATE TABLE IF NOT EXISTS review_comments (
      id           TEXT PRIMARY KEY,
      file_id      TEXT NOT NULL,
      stack_id     TEXT,
      parent_id    TEXT,
      author_email TEXT,
      guest_id     TEXT,
      author_name  TEXT,
      body         TEXT NOT NULL,
      anchor       TEXT NOT NULL DEFAULT 'general',
      frame_in     INT,
      frame_out    INT,
      fps_num      INT,
      fps_den      INT,
      point_x      REAL,
      point_y      REAL,
      annotation   JSONB,
      mentions     JSONB,
      audience     TEXT NOT NULL DEFAULT 'all',
      share_token  TEXT,
      resolved_at  BIGINT,
      resolved_by  TEXT,
      edited_at    BIGINT,
      deleted_at   BIGINT,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL,
      seq          BIGINT NOT NULL DEFAULT nextval('review_change_seq')
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS review_comments_file_seq_idx ON review_comments (file_id, seq)`;
  await sql`CREATE INDEX IF NOT EXISTS review_comments_parent_idx ON review_comments (parent_id) WHERE parent_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS review_comments_stack_idx ON review_comments (stack_id) WHERE stack_id IS NOT NULL`;
  // One row per reviewer per file: their current decision. Taking it back
  // re-stamps the row as 'withdrawn' rather than deleting it, because a
  // deleted row moves no cursor and every open panel would keep showing it.
  await sql`
    CREATE TABLE IF NOT EXISTS review_decisions (
      file_id     TEXT NOT NULL,
      reviewer    TEXT NOT NULL,
      status      TEXT NOT NULL,
      note        TEXT,
      share_token TEXT,
      decided_at  BIGINT NOT NULL,
      seq         BIGINT NOT NULL DEFAULT nextval('review_change_seq'),
      PRIMARY KEY (file_id, reviewer)
    )
  `;
  // Who hears about a file: its uploader, everyone who has commented on it,
  // and everyone mentioned in it.
  await sql`
    CREATE TABLE IF NOT EXISTS review_watchers (
      file_id         TEXT NOT NULL,
      email           TEXT NOT NULL,
      added_at        BIGINT NOT NULL,
      muted           BOOLEAN NOT NULL DEFAULT false,
      last_emailed_at BIGINT,
      PRIMARY KEY (file_id, email)
    )
  `;
  // How far each person has read a file's review, for the unread dots.
  await sql`
    CREATE TABLE IF NOT EXISTS review_reads (
      subject  TEXT NOT NULL,
      file_id  TEXT NOT NULL,
      last_seq BIGINT NOT NULL,
      read_at  BIGINT NOT NULL,
      PRIMARY KEY (subject, file_id)
    )
  `;
});

// Production runs no DDL on the request path (SCHEMA_MANAGED), so between a
// deploy and `npm run doctor` these tables do not exist. Rather than every
// review request failing in that window, the first to hit a missing table
// (42P01) or column (42703) applies the guard, once per instance per minute,
// and retries — withSchemaRetry's rule, for a guard of its own.
let reviewRepairAt = 0;
async function withReviewSchema(run) {
  try {
    return await run();
  } catch (e) {
    if (e?.code !== '42P01' && e?.code !== '42703') throw e;
    if (Date.now() - reviewRepairAt < REPAIR_COOLDOWN_MS) throw e;
    reviewRepairAt = Date.now();
    console.warn('[db] review schema is behind the code (%s) — applying the guard once and retrying', e.message);
    await ensureReviewTables.force();
    return run();
  }
}

// The most one feed page delivers. An open panel starts from 0, so this is
// also how many comments a first load returns before it pages.
export const REVIEW_FEED_LIMIT = 500;

function shapeReviewComment(r) {
  if (!r) return null;
  const deleted = r.deleted_at != null;
  const num = (v) => (v != null ? Number(v) : null);
  return {
    id: r.id,
    fileId: r.file_id,
    parentId: r.parent_id || null,
    author: { email: r.author_email || null, name: r.author_name || null, guest: !!r.guest_id },
    // A deleted comment keeps its place in the thread and loses its words:
    // replies still make sense, and what was taken back is not handed out.
    body: deleted ? '' : r.body,
    anchor: r.anchor || 'general',
    frameIn: num(r.frame_in),
    frameOut: num(r.frame_out),
    fps: r.fps_num && r.fps_den ? { num: Number(r.fps_num), den: Number(r.fps_den) } : null,
    pointX: num(r.point_x),
    pointY: num(r.point_y),
    annotation: !deleted && r.annotation && typeof r.annotation === 'object' ? r.annotation : null,
    mentions: !deleted && Array.isArray(r.mentions) ? r.mentions : [],
    audience: r.audience || 'all',
    resolvedAt: num(r.resolved_at),
    resolvedBy: r.resolved_by || null,
    editedAt: num(r.edited_at),
    deletedAt: num(r.deleted_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    seq: num(r.seq),
  };
}

function shapeReviewDecision(r) {
  if (!r) return null;
  const reviewer = String(r.reviewer || '');
  return {
    reviewer,
    email: reviewer.startsWith('user:') ? reviewer.slice(5) : null,
    status: r.status,
    note: r.note || null,
    decidedAt: r.decided_at != null ? Number(r.decided_at) : null,
    seq: r.seq != null ? Number(r.seq) : null,
  };
}

/**
 * What changed on a file's review since `after`: { comments, decisions,
 * cursor, more }, oldest first.
 *
 * `cursor` is the highest seq it can honestly claim to have delivered. When
 * the comments fill the page there may be more below a decision's seq, so
 * the cursor stops at the last comment and later decisions wait for the next
 * page — advancing past an undelivered row would skip it for good.
 *
 * `audience: 'all'` leaves out internal comments; it is for guests (review
 * links), who never see them. Signed-in readers get everything.
 */
export async function listReviewFeed(fileId, { after = 0, limit = REVIEW_FEED_LIMIT, audience = null } = {}) {
  if (!sql) return { comments: [], decisions: [], cursor: 0, more: false };
  await ensureReviewTables();
  const from = Math.max(0, Math.floor(Number(after) || 0));
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || REVIEW_FEED_LIMIT)), REVIEW_FEED_LIMIT);
  return withReviewSchema(async () => {
    const comments = audience === 'all'
      ? await sql`SELECT * FROM review_comments WHERE file_id = ${fileId} AND seq > ${from} AND audience = 'all' ORDER BY seq ASC LIMIT ${n}`
      : await sql`SELECT * FROM review_comments WHERE file_id = ${fileId} AND seq > ${from} ORDER BY seq ASC LIMIT ${n}`;
    const decisions = await sql`SELECT * FROM review_decisions WHERE file_id = ${fileId} AND seq > ${from} ORDER BY seq ASC`;
    const more = comments.length >= n;
    const lastComment = comments.length ? Number(comments[comments.length - 1].seq) : from;
    const cursor = more
      ? lastComment
      : Math.max(from, lastComment, ...decisions.map((d) => Number(d.seq)));
    return {
      comments: comments.map(shapeReviewComment),
      decisions: decisions.filter((d) => Number(d.seq) <= cursor).map(shapeReviewDecision),
      cursor,
      more,
    };
  });
}

/**
 * The file's review status and open-comment count, counted from the review
 * tables now — and written to the file row when they differ from `known`
 * (what the row said), so the grid's badge follows. The rule itself is
 * deriveReviewStatus in lib/review.js.
 */
export async function refreshReviewStatus(fileId, known = null) {
  if (!sql) return { status: null, openComments: 0 };
  await ensureReviewTables();
  const [c] = await withReviewSchema(() => sql`
    SELECT
      (SELECT count(*) FROM review_comments WHERE file_id = ${fileId} AND parent_id IS NULL AND resolved_at IS NULL AND deleted_at IS NULL)::int AS open,
      (SELECT count(*) FROM review_comments WHERE file_id = ${fileId} AND deleted_at IS NULL)::int AS live,
      (SELECT count(*) FROM review_decisions WHERE file_id = ${fileId} AND status = 'changes_requested')::int AS changes,
      (SELECT count(*) FROM review_decisions WHERE file_id = ${fileId} AND status = 'approved')::int AS approved`);
  // Review links arrive with the share kinds; until one exists this is 0,
  // and a database with no file_shares table has none either.
  let links = 0;
  try {
    const [l] = await sql`SELECT count(*)::int AS n FROM file_shares WHERE file_id = ${fileId} AND kind = 'review'`;
    links = l?.n || 0;
  } catch { /* no links table yet */ }
  const summary = { status: deriveReviewStatus({ ...c, links }), openComments: c.open };
  if (!known || known.status !== summary.status || known.openComments !== summary.openComments) {
    await withSchemaRetry(ensureFilesTable, () => sql`
      UPDATE files SET review_status = ${summary.status}, open_comments = ${summary.openComments} WHERE id = ${fileId}`);
  }
  return summary;
}

/** One comment, shaped, or null. */
export async function getReviewComment(id) {
  if (!sql || !id) return null;
  await ensureReviewTables();
  const rows = await withReviewSchema(() => sql`SELECT * FROM review_comments WHERE id = ${id} LIMIT 1`);
  return shapeReviewComment(rows[0]);
}

/**
 * Record a comment or reply. `value` is validateComment's output (lib/review.js);
 * the route has already decided the author may post it and resolved
 * `parentId` to the top of its thread.
 */
export async function createReviewComment({ fileId, authorEmail, authorName = null, value }) {
  if (!sql) throw new Error('Database not configured');
  await ensureReviewTables();
  const v = value || {};
  const id = crypto.randomUUID();
  const now = Date.now();
  const rows = await withReviewSchema(() => sql`
    INSERT INTO review_comments (
      id, file_id, parent_id, author_email, author_name, body, anchor,
      frame_in, frame_out, fps_num, fps_den, point_x, point_y,
      annotation, mentions, audience, created_at, updated_at
    ) VALUES (
      ${id}, ${fileId}, ${v.parentId || null}, ${String(authorEmail || '').toLowerCase() || null}, ${authorName},
      ${v.body || ''}, ${v.anchor || 'general'},
      ${v.frameIn ?? null}, ${v.frameOut ?? null}, ${v.fps?.num ?? null}, ${v.fps?.den ?? null},
      ${v.pointX ?? null}, ${v.pointY ?? null},
      ${v.annotation ? sql.json(v.annotation) : null}, ${sql.json(v.mentions || [])},
      ${v.audience === 'internal' ? 'internal' : 'all'}, ${now}, ${now}
    )
    RETURNING *`);
  return shapeReviewComment(rows[0]);
}

/** Change a comment's words (and so its mentions). Marks it edited. Null for a deleted or missing one. */
export async function editReviewComment(id, { body, mentions = [] }) {
  if (!sql) throw new Error('Database not configured');
  await ensureReviewTables();
  const now = Date.now();
  const rows = await withReviewSchema(() => sql`
    UPDATE review_comments
    SET body = ${String(body)}, mentions = ${sql.json(mentions)}, edited_at = ${now}, updated_at = ${now},
        seq = nextval('review_change_seq')
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING *`);
  return shapeReviewComment(rows[0]);
}

/** Resolve or reopen a thread. */
export async function resolveReviewComment(id, { resolved, by }) {
  if (!sql) throw new Error('Database not configured');
  await ensureReviewTables();
  const now = Date.now();
  const rows = await withReviewSchema(() => sql`
    UPDATE review_comments
    SET resolved_at = ${resolved ? now : null}, resolved_by = ${resolved ? String(by || '').toLowerCase() : null},
        updated_at = ${now}, seq = nextval('review_change_seq')
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING *`);
  return shapeReviewComment(rows[0]);
}

/** Soft-delete: the row stays, so a thread keeps its shape; its words go (shapeReviewComment). */
export async function deleteReviewComment(id) {
  if (!sql) throw new Error('Database not configured');
  await ensureReviewTables();
  const now = Date.now();
  const rows = await withReviewSchema(() => sql`
    UPDATE review_comments
    SET deleted_at = ${now}, updated_at = ${now}, seq = nextval('review_change_seq')
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING *`);
  return shapeReviewComment(rows[0]);
}

/**
 * Set a reviewer's decision on a file, or withdraw it (`status: null`).
 * `reviewer` is 'user:<email>' (lib/review.js userReviewer) or, from review
 * links, 'guest:<id>'. Null when there was nothing to withdraw.
 */
export async function setReviewDecision({ fileId, reviewer, status, note = null, shareToken = null }) {
  if (!sql) throw new Error('Database not configured');
  await ensureReviewTables();
  const now = Date.now();
  const rows = status
    ? await withReviewSchema(() => sql`
        INSERT INTO review_decisions (file_id, reviewer, status, note, share_token, decided_at)
        VALUES (${fileId}, ${reviewer}, ${status}, ${note}, ${shareToken}, ${now})
        ON CONFLICT (file_id, reviewer) DO UPDATE
          SET status = EXCLUDED.status, note = EXCLUDED.note, share_token = EXCLUDED.share_token,
              decided_at = EXCLUDED.decided_at, seq = nextval('review_change_seq')
        RETURNING *`)
    : await withReviewSchema(() => sql`
        UPDATE review_decisions
        SET status = 'withdrawn', note = NULL, decided_at = ${now}, seq = nextval('review_change_seq')
        WHERE file_id = ${fileId} AND reviewer = ${reviewer} AND status <> 'withdrawn'
        RETURNING *`);
  return shapeReviewDecision(rows[0]);
}

/** Follow a file's review. Idempotent; a muted watcher stays muted. */
export async function addReviewWatchers(fileId, emails = []) {
  if (!sql) return;
  const list = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@')))];
  if (!fileId || !list.length) return;
  await ensureReviewTables();
  await withReviewSchema(() => sql`
    INSERT INTO review_watchers (file_id, email, added_at)
    SELECT ${fileId}, e, ${Date.now()} FROM unnest(${list}::text[]) AS e
    ON CONFLICT (file_id, email) DO NOTHING`);
}

/** Everyone following a file who has not muted it. */
export async function listReviewWatchers(fileId) {
  if (!sql || !fileId) return [];
  await ensureReviewTables();
  const rows = await withReviewSchema(() => sql`SELECT email FROM review_watchers WHERE file_id = ${fileId} AND NOT muted`);
  return rows.map((r) => r.email);
}

/** How far `subject` ('user:<email>') had read this file's review: a seq, 0 for never. */
export async function getReviewRead(subject, fileId) {
  if (!sql || !subject || !fileId) return 0;
  await ensureReviewTables();
  const rows = await withReviewSchema(() => sql`SELECT last_seq FROM review_reads WHERE subject = ${subject} AND file_id = ${fileId}`);
  return rows[0] ? Number(rows[0].last_seq) : 0;
}

/** Move `subject`'s read marker forward to `seq` (never back). */
export async function markReviewRead(subject, fileId, seq) {
  if (!sql || !subject || !fileId || !(Number(seq) > 0)) return;
  await ensureReviewTables();
  const now = Date.now();
  await withReviewSchema(() => sql`
    INSERT INTO review_reads (subject, file_id, last_seq, read_at)
    VALUES (${subject}, ${fileId}, ${Number(seq)}, ${now})
    ON CONFLICT (subject, file_id) DO UPDATE
      SET last_seq = GREATEST(review_reads.last_seq, EXCLUDED.last_seq), read_at = EXCLUDED.read_at`);
}

/**
 * Display names for addresses: the name given with an access request, then
 * the sign-in provider's, else nothing (the caller falls back to the address).
 * Returns a Map of email → name. Either table may be missing on a young
 * database; that is simply no names.
 */
export async function displayNamesFor(emails = []) {
  const out = new Map();
  const list = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  if (!sql || !list.length) return out;
  const take = (rows) => {
    for (const r of rows) {
      const name = String(r.name || '').trim();
      if (name && !out.has(r.email)) out.set(r.email, name);
    }
  };
  try { take(await sql`SELECT lower(email) AS email, name FROM invite_requests WHERE lower(email) = ANY(${list})`); } catch { /* none */ }
  try { take(await sql`SELECT lower(email) AS email, name FROM "user" WHERE lower(email) = ANY(${list})`); } catch { /* none */ }
  return out;
}

/**
 * People an @mention could name, matching `q` on address or name: everyone
 * who has signed in or been let in. Who of them may READ the file is not
 * decided here — the route checks each against canAccessFile, so a mention
 * can never name, or reveal, someone outside the file's audience.
 */
export async function listMentionCandidates({ q = '', limit = 200 } = {}) {
  if (!sql) return [];
  const term = String(q || '').trim().toLowerCase().slice(0, 100);
  const pattern = `%${escapeLike(term)}%`;
  const n = Math.min(Math.max(1, Number(limit) || 200), 500);
  const people = new Map();
  const take = (rows) => {
    for (const r of rows) {
      const e = String(r.email || '').toLowerCase();
      if (!e.includes('@')) continue;
      const prev = people.get(e);
      if (!prev || (!prev.name && r.name)) people.set(e, { email: e, name: r.name ? String(r.name) : null });
    }
  };
  try {
    take(await sql`
      SELECT email, name FROM invite_requests
      WHERE status = 'approved' AND (lower(email) LIKE ${pattern} OR lower(coalesce(name, '')) LIKE ${pattern})
      ORDER BY email LIMIT ${n}`);
  } catch { /* no invites table yet */ }
  try {
    take(await sql`
      SELECT email, name FROM "user"
      WHERE email IS NOT NULL AND (lower(email) LIKE ${pattern} OR lower(coalesce(name, '')) LIKE ${pattern})
      ORDER BY email LIMIT ${n}`);
  } catch { /* no users yet */ }
  return [...people.values()].sort((a, b) => a.email.localeCompare(b.email)).slice(0, n);
}

/** A file's review rows, gone with the file (deleteFile). */
async function deleteReviewRows(fileId) {
  if (!sql || !fileId) return;
  try { await sql`DELETE FROM review_comments WHERE file_id = ${fileId}`; } catch {}
  try { await sql`DELETE FROM review_decisions WHERE file_id = ${fileId}`; } catch {}
  try { await sql`DELETE FROM review_watchers WHERE file_id = ${fileId}`; } catch {}
  try { await sql`DELETE FROM review_reads WHERE file_id = ${fileId}`; } catch {}
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

export function fileWriteDecision({ file, principal = {}, fileAccess = null, folderRoles = [], drive = null } = {}) {
  if (!file) return { allowed: false, reason: 'no-file' };
  // A platform-level viewer never writes, whatever a per-file grant says.
  // The files UI already hides write controls from them; this is the half
  // that a request cannot route around.
  if (principal.roleId === 'viewer' && !principal.isAdmin) return { allowed: false, reason: 'platform-viewer' };
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
export async function modifiableFileIds(files, principal = {}) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  const out = new Set();
  if (!list.length) return out;
  if (principal.roleId === 'viewer' && !principal.isAdmin) return out;
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
    const d = fileWriteDecision({ file: f, principal, fileAccess: access.get(f.id) || null, folderRoles, drive });
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
 * The most permissive folder role this principal holds on `folder` or any of
 * its ancestors, or null.
 *
 * Folder grants are inherited downward — a grant on "Campaigns" applies to
 * "Campaigns/Spring" — which is why this walks ancestors rather than looking
 * for an exact match.
 */
export async function folderRoleFor(folder, principal = {}) {
  if (principal.isAdmin) return 'owner';
  if (principal.roleId === 'viewer') return null;
  if (!sql) return null;
  const email = String(principal.email || '').toLowerCase();
  const roleId = principal.roleId || null;
  try {
    await ensureFolderAclTable();
    const rows = await sql`
      SELECT role FROM folder_access
      WHERE folder = ANY(${_ancestorsOf(folder)})
        AND ((subject_type = 'user' AND subject = ${email}) OR (subject_type = 'role' AND subject = ${roleId}))`;
    return strongestFolderRole(rows.map((r) => r.role));
  } catch { return null; }
}

/**
 * May this principal restructure a folder — rename it, move it, delete it?
 *
 * These are the operations that re-key objects in the bucket and, with
 * cascade, trash every file underneath. They are not "is anybody signed in",
 * which is what guarded them before.
 */
export async function canModifyFolder(folder, principal = {}) {
  return folderRoleAllows(await folderRoleFor(folder, principal), 'modify');
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

/** Look up the grants fileWriteDecision needs for one file, then apply it. */
export async function canModifyFile(file, principal = {}) {
  if (!file) return false;
  return (await modifiableFileIds([file], principal)).has(file.id);
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
 * Resolve a filespace the web user is allowed to use (admins: any; others: only
 * granted). Returns { id, name, bucket, prefix, region, role } or null. Used by
 * the Space routes to scope upload/list/sync to a filespace's bucket prefix.
 */
export async function getFilespaceForUser(email, id) {
  if (!id) return null;
  let admin = false;
  try { const { isAdmin } = await import('./auth-allowlist.js'); admin = isAdmin(String(email || '').toLowerCase()); } catch {}
  if (!admin) {
    const list = await listFilespacesForUser(email);
    if (!list.some((f) => f.id === id)) return null;
  }
  // Resolve the full record (with per-filespace secret) for server-side use.
  return getFilespace(id);
}

/**
 * The same, for putting something INTO the drive — an upload, a new folder, a
 * move or rename that writes under its prefix: admins, and its editors and
 * owners. A viewer can open a drive and not change it, on the web as on the
 * desktop, where their mount is read-only.
 */
export async function getFilespaceForWrite(email, id) {
  if (!id) return null;
  let admin = false;
  try { const { isAdmin } = await import('./auth-allowlist.js'); admin = isAdmin(String(email || '').toLowerCase()); } catch {}
  if (!admin) {
    const mine = (await listFilespacesForUser(email)).find((f) => f.id === id);
    if (!mine || !canWriteDrive(mine.role)) return null;
  }
  return getFilespace(id);
}

/**
 * Every drive, and this principal's role in each: what driveAccess needs.
 * Taken from the principal when buildPrincipal put it there; looked up
 * otherwise, so a hand-built principal is held to the boundary too rather
 * than slipping past it.
 */
async function driveScopeOf(principal = {}) {
  if (principal.isAdmin) return { drives: [], roles: {}, isAdmin: true };
  if (principal.driveScope) return principal.driveScope;
  return loadDriveScope(principal.email);
}

/** The same for an email, for routes that check a key before any row exists (uploads). */
export async function driveScopeFor(email) {
  let admin = false;
  try { const { isAdmin } = await import('./auth-allowlist.js'); admin = isAdmin(String(email || '').toLowerCase()); } catch {}
  return admin ? { drives: [], roles: {}, isAdmin: true } : loadDriveScope(email);
}

// Its own queries rather than listFilespaces(), which answers [] on an error:
// for a boundary, "no drives" would mean "no boundary". This throws instead,
// and a request that cannot learn the drives fails rather than seeing into
// them.
async function loadDriveScope(email) {
  if (!sql) return { drives: [], roles: {}, isAdmin: false };
  await ensureFilespacesTables();
  const e = String(email || '').trim().toLowerCase();
  const [drives, mine] = await Promise.all([
    sql`SELECT id, prefix FROM filespaces`,
    sql`SELECT filespace_id, role FROM filespace_access WHERE user_email = ${e}`,
  ]);
  return {
    drives: drives.map((d) => ({ id: d.id, prefix: d.prefix })),
    roles: Object.fromEntries(mine.map((r) => [r.filespace_id, r.role || 'viewer'])),
    isAdmin: false,
  };
}

/** Filespaces the web user may pick in Space (admins see all). */
export async function listFilespacesForSpace(email) {
  let admin = false;
  try { const { isAdmin } = await import('./auth-allowlist.js'); admin = isAdmin(String(email || '').toLowerCase()); } catch {}
  const list = admin ? (await listFilespaces()).map((f) => ({ ...f, role: 'owner' })) : await listFilespacesForUser(email);
  return list.map((f) => ({ id: f.id, name: f.name, bucket: f.bucket, prefix: f.prefix, region: f.region || null, role: f.role || 'viewer' }));
}

/**
 * Build the request principal { email, isAdmin, roleId } used by every Library
 * privacy check. Lazy imports avoid a cycle (auth-allowlist imports db).
 */
export async function buildPrincipal(email) {
  const e = String(email || '').trim().toLowerCase();
  let admin = false, roleId = null;
  try { const { isAdmin } = await import('./auth-allowlist.js'); admin = isAdmin(e); } catch {}
  try {
    const { resolveRole } = await import('./roles.js');
    const role = resolveRole(e, await getRolesConfig(), { isAdmin: admin });
    roleId = role?.id || (typeof role === 'string' ? role : null);
  } catch {}
  // Folder grants come along because access is now decided inside the listing
  // query rather than by filtering its results. One small query here replaces
  // a per-file ancestor walk over the whole table.
  let folderGrants = [];
  let driveScope;
  let patterns;
  if (!admin) {
    try { folderGrants = [...(await folderGrantsForPrincipal({ email: e, roleId }))]; } catch {}
    // The drives this person belongs to, for the listing query's drive clause
    // and the single-file checks. Not caught: see loadDriveScope.
    driveScope = await loadDriveScope(e);
    patterns = {
      all: drivePatterns(driveScope.drives),
      mine: drivePatterns(driveScope.drives.filter((d) => driveScope.roles[d.id])),
    };
  }
  return {
    email: e, isAdmin: admin, roleId, folderGrants,
    ...(driveScope ? { driveScope, drivePatterns: patterns } : {}),
  };
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
});

const FILESPACE_ROLES = ['viewer', 'editor', 'owner'];
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
    ...(includeSecret ? { secretAccessKey: r.secret_key || null } : {}),
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

export async function listFilespaces() {
  if (!sql) return [];
  await ensureFilespacesTables();
  try {
    const rows = await sql`
      SELECT f.*, (SELECT COUNT(*)::int FROM filespace_access a WHERE a.filespace_id = f.id) AS member_count
      FROM filespaces f
      ORDER BY f.updated_at DESC
      LIMIT 500
    `;
    return rows.map(shapeFilespace);
  } catch (e) {
    console.warn('[listFilespaces] failed:', e.message);
    return [];
  }
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
  const rows = await sql`
    UPDATE filespaces SET
      name = ${String(m.name || existing.name)}, bucket = ${String(m.bucket || existing.bucket)},
      prefix = ${normPrefix(m.prefix)}, region = ${m.region || null}, role_arn = ${m.roleArn || null},
      access_key = ${accessKey},
      secret_key = ${secretKey},
      endpoint = ${m.endpoint ? String(m.endpoint).trim() : null},
      updated_at = ${now}
    WHERE id = ${id}
    RETURNING *
  `;
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

/** Filespaces a given user has been granted, annotated with their role. */
export async function listFilespacesForUser(email) {
  if (!sql || !email) return [];
  await ensureFilespacesTables();
  const e = String(email).trim().toLowerCase();
  try {
    const rows = await sql`
      SELECT f.*, a.role AS access_role
      FROM filespaces f
      JOIN filespace_access a ON a.filespace_id = f.id
      WHERE a.user_email = ${e}
      ORDER BY f.updated_at DESC
    `;
    return rows.map((r) => ({ ...shapeFilespace(r), role: r.access_role || 'viewer' }));
  } catch (err) {
    console.warn('[listFilespacesForUser] failed:', err.message);
    return [];
  }
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
export async function createDesktopAuthCode({ email, codeChallenge = null, kind = 'pkce', label = null, ttlMs = 5 * 60 * 1000 } = {}) {
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
  await sql`
    INSERT INTO desktop_auth_codes (code, email, code_challenge, kind, label, claimed, created_at, expires_at)
    VALUES (${code}, ${e}, ${codeChallenge}, ${kind}, ${label}, ${kind !== 'pairing'}, ${now}, ${expiresAt})
  `;
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
  return { code: r.code, email: r.email, codeChallenge: r.code_challenge || null, kind: r.kind, label: r.label || null, claimed: !!r.claimed };
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

