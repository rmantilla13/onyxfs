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
import {
  buildFileQuery, buildDeltaQuery, buildFolderCountQuery, buildTranscriptQueueQuery, buildProxyQueueQuery, buildProxyCandidateQuery,
  buildVisibleIdsQuery, nextCursor, FILE_COLUMNS, settleFeedCursor, THUMB_ARTIFACT_RE, SYSTEM_KEY_RE, THUMB_HINTS, SYSTEM_HINTS,
} from './file-query.js';
import {
  GRID_POSTER_BOX, GRID_POSTER_MAX_EDGE, XS_POSTER_BOX, PLAYER_POSTER_MAX_EDGE, IMAGE_PREVIEW_MAX_EDGE, PREVIEW_ORIGINAL_MAX_BYTES,
} from './poster.js';
import { escapeLike, rebase, cleanFolder as cleanFolderPath, nfc, isAscii, respellPath } from './folder-ops.js';
import {
  buildLinkFilesQuery, buildLinkCountQuery, buildLinkFoldersQuery, buildLinkFileQuery, buildLinkAnyQuery,
} from './folder-links.js';
import { newShareToken, hashSharePassword, verifySharePassword, MAX_PASSWORD_FAILURES, PASSWORD_LOCK_MS } from './shares.js';
import { MAX_SIGN_IN_FAILURES, SIGN_IN_LOCK_MS } from './passwords.js';
import { driveAccess, drivePatterns, canWriteDrive } from './drive-access.js';
import { createHash } from 'node:crypto';
import { avatarPath } from './avatars.js';
import { deriveReviewStatus } from './review.js';
import { effectiveKind, MEDIA_KEYS, isProxyKey } from './media.js';
import { isTranscribableKind } from './transcripts.js';
import { isProxyableKind, isStale as isProxyStale, shouldProxy, PROXY_MIN_BYTES } from './proxies.js';

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
 * in the admin panel — wipes the user's access record entirely (an admin can
 * add them again from scratch). To keep a record that they were turned away,
 * deny the request (status 'denied') or suspend the person instead.
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
             s.expires_at, s.view_count, s.created_at, f.name AS file_name,
             s.folder, s.storage_prefix,
             (SELECT d.name FROM filespaces d WHERE s.kind = 'folder' AND d.prefix = s.storage_prefix
               ORDER BY lower(d.name), d.id LIMIT 1) AS drive_name
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
      // A folder link: the folder, and its drive — none for the library's.
      ...(l.kind === 'folder' ? { folder: l.folder || null, driveName: l.drive_name || null, library: !l.storage_prefix } : {}),
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
 * tokens and codes, a sign-in password, their picture, the links they made, notifications
 * addressed to them, and their people, invite and Auth.js user rows (the
 * last cascades to their sessions and accounts). There are no foreign keys
 * here, so each is its own statement; a failure part-way leaves a person
 * with fewer grants, never more.
 *
 * A drive they are the only owner of is not left with none: `by`, the admin
 * removing them, becomes its owner in the statement that takes their grants
 * (lib/drive-access.js). The preview names those drives (`soleOwnerOf`), and
 * the result the ones `by` now owns (`claimed`).
 */
export async function removePerson(email, { apply = false, by = null } = {}) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  await Promise.all([
    ensurePeopleTable(), ensureInviteRequestsTable(), ensureFilespacesTables(), ensureFolderAclTable(),
    ensureFileAclTable(), ensureDesktopAuthTables(), ensureAvatarsTable(), ensureSharesTable(),
    ensureNotificationsTable(), ensureFilesTable(), ensureAuthTables(), ensureSignInPasswordsTable(),
  ]);
  const [[c], sole] = await withSchemaRetry([ensurePeopleTable, ensureSharesTable], () => Promise.all([sql`
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
      EXISTS (SELECT 1 FROM "user" WHERE lower(email) = ${e}) AS has_user`, sql`
    SELECT f.id, f.name FROM filespace_access a JOIN filespaces f ON f.id = a.filespace_id
     WHERE a.user_email = ${e} AND a.role = 'owner'
       AND NOT EXISTS (SELECT 1 FROM filespace_access o
                        WHERE o.filespace_id = a.filespace_id AND o.role = 'owner' AND o.user_email <> ${e})
     ORDER BY lower(f.name), f.id`]));
  const impact = {
    email: e,
    drives: c.drives, folderGrants: c.folder_grants, fileGrants: c.file_grants,
    devices: c.devices, links: c.links, notifications: c.notifications,
    filesKept: c.files, bytesKept: Number(c.bytes) || 0,
    soleOwnerOf: sole.map((d) => ({ id: d.id, name: d.name })),
    exists: !!(c.has_person || c.has_invite || c.has_user),
  };
  if (!apply) return impact;

  const claimant = fallbackFor(by, e);
  const claimed = await sql`
    WITH gone AS (
      DELETE FROM filespace_access WHERE user_email = ${e} RETURNING filespace_id, role
    ), orphaned AS (
      SELECT g.filespace_id FROM gone g JOIN filespaces f ON f.id = g.filespace_id
       WHERE g.role = 'owner'
         AND NOT EXISTS (SELECT 1 FROM filespace_access o
                          WHERE o.filespace_id = g.filespace_id AND o.role = 'owner' AND o.user_email <> ${e})
    ), claimed AS (
      INSERT INTO filespace_access (filespace_id, user_email, role, granted_by, granted_at)
      SELECT filespace_id, ${claimant}, 'owner', ${claimant}, ${Date.now()} FROM orphaned
       WHERE ${claimant}::text IS NOT NULL
      ON CONFLICT (filespace_id, user_email)
      DO UPDATE SET role = 'owner', granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
      RETURNING filespace_id
    )
    SELECT f.id, f.name FROM claimed c JOIN filespaces f ON f.id = c.filespace_id
     ORDER BY lower(f.name), f.id`;
  await sql`DELETE FROM folder_access WHERE subject_type = 'user' AND subject = ${e}`;
  await sql`DELETE FROM file_acl WHERE scope = 'user' AND principal = ${e}`;
  await sql`DELETE FROM desktop_tokens WHERE email = ${e}`;
  await sql`DELETE FROM desktop_auth_codes WHERE email = ${e}`;
  // Newer than the rest: a managed database may not have the table until
  // the cron runs ensureSchema, and a removal must not stop half-done there.
  await withSchemaRetry(ensureSignInPasswordsTable, () => sql`DELETE FROM sign_in_passwords WHERE email = ${e}`);
  await sql`DELETE FROM user_avatars WHERE email = ${e}`;
  await sql`DELETE FROM file_shares WHERE lower(created_by) = ${e}`;
  await sql`DELETE FROM notifications WHERE lower(user_email) = ${e}`;
  await sql`DELETE FROM people WHERE email = ${e}`;
  await sql`DELETE FROM invite_requests WHERE lower(email) = ${e}`;
  await sql`DELETE FROM "user" WHERE lower(email) = ${e}`;
  return { ...impact, removed: true, claimed: claimed.map((d) => ({ id: d.id, name: d.name })) };
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
  // Which smaller siblings of the grid thumbnail exist ('sm', 'xs' —
  // lib/poster.js), comma-separated; null for none. Only the sizes: the keys
  // are derived from thumbnail_key (thumbSiblingKey in lib/media.js), so a
  // row can never name another object as one. Nullable, so every existing
  // row simply has none until a browser makes them.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS thumb_sizes TEXT`;
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
  // The server's own previews (lib/server-previews.js): how often it has
  // tried a file, when last, and why the last try failed — so a file it
  // cannot draw is tried a few times, not every minute for ever.
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_tries INT DEFAULT 0`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_tried_at BIGINT`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_error TEXT`;
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

  // ── The file's own dates ──────────────────────────────────────────────
  // When the file itself was made and last changed, as where it came from
  // says (epoch ms): the Mac's file system, the browser's File.lastModified,
  // a photo's or a video's capture date. created_at and updated_at stay what
  // they are — when the row was written and last touched — so "Added" and
  // the change feed mean what they did, while Finder and the web can show a
  // photo from September 5th as that, not as its upload day. NULL for every
  // row recorded before, and whenever the source did not say; readers fall
  // back to the row's times (fileCreatedAt ?? createdAt, fileModifiedAt ??
  // updatedAt).
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS file_created_at BIGINT`;
  await sql`ALTER TABLE files ADD COLUMN IF NOT EXISTS file_modified_at BIGINT`;

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
//   files_unmoved_trash_idx
//                       a just-trashed file whose object has not moved to
//                       the trash yet, by its key: what an upload wanting that
//                       key looks for (trashedRowAtKey). Few rows at a time.
//   files_trash_key_idx where a trashed file's object was moved to. With the
//                       two above, it answers storageKeyInUse from indexes —
//                       asked on every upload recorded — where an OR across
//                       the three read the whole table.
//   files_filmstrip_key_idx
//                       whether any row holds a filmstrip key: previewKeysInUse,
//                       on every upload with previews and every preview
//                       recorded after it, beside the thumbnail and poster
//                       indexes ensureFilesTable makes. Partial, like both
//                       trash ones: most rows have neither.
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
  // Activity: when anything about a file last changed here (SORTS.activity).
  ['files_folder_updated_idx', 'ON files (folder, updated_at, id) WHERE deleted_at IS NULL'],
  // Modified and Created, as the list shows them: the file's own date, else
  // the row's (SORTS.modified and SORTS.created).
  ['files_folder_modified_idx', 'ON files (folder, (coalesce(file_modified_at, updated_at)), id) WHERE deleted_at IS NULL'],
  ['files_folder_file_created_idx', 'ON files (folder, (coalesce(file_created_at, created_at)), id) WHERE deleted_at IS NULL'],
  ['files_folder_mime_idx', "ON files (folder, (coalesce(mime, '')), id) WHERE deleted_at IS NULL"],
  ['files_live_key_idx', 'ON files (storage_key text_pattern_ops) INCLUDE (size) WHERE deleted_at IS NULL'],
  ['files_name_trgm_idx', 'ON files USING GIN (name gin_trgm_ops) WHERE deleted_at IS NULL', 'pg_trgm'],
  // What one person has added: their storage quota (usedBytesBy) and the
  // People list's Storage column, without reading every row they own.
  ['files_created_by_size_idx', 'ON files (created_by, size) WHERE deleted_at IS NULL'],
  ['files_unmoved_trash_idx', 'ON files (storage_key) WHERE deleted_at IS NOT NULL AND trash_key IS NULL'],
  ['files_trash_key_idx', 'ON files (trash_key) WHERE trash_key IS NOT NULL'],
  ['files_filmstrip_key_idx', 'ON files (filmstrip_key) WHERE filmstrip_key IS NOT NULL'],
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

// ── The server's own previews ────────────────────────────────────────────
// lib/server-previews.js draws what no browser or Mac has: an image that
// still has no thumbnail a while after it was added (uploaded from a phone,
// too big for a tab, in a folder no editor opens), and the large preview of
// one whose thumbnail came without it. Claimed a few at a time by the
// previews cron, each claim counted, so a file that cannot be drawn is
// tried SERVER_PREVIEW_TRIES times, a while apart, and then left.

export const SERVER_PREVIEW_TRIES = 3;
// The formats sharp decodes in the build Vercel runs (no HEIC, RAW or PSD:
// those stay the Mac's).
const SERVER_PREVIEW_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/avif', 'image/gif'];
const SERVER_PREVIEW_NAMES = '\\.(jpe?g|png|webp|tiff?|avif|gif)$';

/**
 * Claim up to `limit` images for the server to draw: live, in storage, no
 * thumbnail, added at least `olderThan` ms ago (the browser that uploaded
 * it draws one itself in that time), no bigger than `maxBytes`, in a format
 * it decodes, and not tried too often or too lately. Each claim counts as a
 * try. FOR UPDATE SKIP LOCKED: two runs never take the same file.
 * Neither updated_at nor seq moves — a claim is not a change to the file.
 */
export async function claimServerPreviews({ limit = 4, maxBytes, olderThan = 120_000, retryAfter = 15 * 60_000, now = Date.now() } = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    WITH c AS (
      SELECT id FROM files
      WHERE deleted_at IS NULL AND storage = 's3' AND thumbnail_key IS NULL AND kind = 'image'
        AND storage_key IS NOT NULL
        AND created_at < ${now - olderThan}
        AND COALESCE(size, 0) > 0 AND size <= ${maxBytes}
        AND (lower(COALESCE(mime, '')) = ANY(${SERVER_PREVIEW_MIMES}::text[]) OR name ~* ${SERVER_PREVIEW_NAMES})
        AND COALESCE(preview_tries, 0) < ${SERVER_PREVIEW_TRIES}
        AND (preview_tried_at IS NULL OR preview_tried_at < ${now - retryAfter})
      ORDER BY created_at DESC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE files f SET preview_tries = COALESCE(f.preview_tries, 0) + 1, preview_tried_at = ${now}
    FROM c WHERE f.id = c.id
    RETURNING f.*`);
  return rows.map(shapeFile);
}

/**
 * Claim up to `limit` files that have a thumbnail but no placeholder (made
 * before placeholders were): the grid shows an empty box until the picture
 * loads. Drawn from the thumbnail's smallest copy, so a claim costs a few
 * kilobytes. Counted against the same tries as a preview.
 */
export async function claimServerPlaceholders({ limit = 8, retryAfter = 15 * 60_000, now = Date.now() } = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    WITH c AS (
      SELECT id FROM files
      WHERE deleted_at IS NULL AND thumbnail_key IS NOT NULL
        AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'placeholder')
        AND COALESCE(preview_tries, 0) < ${SERVER_PREVIEW_TRIES}
        AND (preview_tried_at IS NULL OR preview_tried_at < ${now - retryAfter})
      ORDER BY created_at DESC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE files f SET preview_tries = COALESCE(f.preview_tries, 0) + 1, preview_tried_at = ${now}
    FROM c WHERE f.id = c.id
    RETURNING f.*`);
  return rows.map(shapeFile);
}

/**
 * Claim up to `limit` images for the server to draw the large preview of:
 * those with a thumbnail — a browser's or a Mac's — but no preview, where
 * lib/preview-jobs.js imagePreviewExpected says they should have one
 * (IMAGE_PREVIEW_EXPECTED, from the size on record; a size not on record is
 * learned by drawing). Without one, Quick Look, the file page and the iPhone
 * open the original, which may be tens of megabytes. Otherwise as
 * claimServerPreviews: live, in storage, added a while ago, no bigger than
 * `maxBytes`, in a format sharp reads, and counted against the same tries.
 * A size on record past `maxPixels` is not claimed: the draw would refuse
 * it, after reading the whole original.
 */
export async function claimServerPosters({
  limit = 4, maxBytes, maxPixels = null, olderThan = 120_000, retryAfter = 15 * 60_000, now = Date.now(),
} = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    WITH c AS (
      SELECT f.id FROM ${PREVIEW_FILES()}
      WHERE f.deleted_at IS NULL AND f.storage = 's3' AND f.thumbnail_key IS NOT NULL AND f.poster_key IS NULL
        AND f.storage_key IS NOT NULL
        AND f.created_at < ${now - olderThan}
        AND COALESCE(f.size, 0) > 0 AND f.size <= ${maxBytes}
        AND (t.m = ANY(${SERVER_PREVIEW_MIMES}::text[]) OR f.name ~* ${SERVER_PREVIEW_NAMES})
        AND COALESCE(f.preview_tries, 0) < ${SERVER_PREVIEW_TRIES}
        AND (f.preview_tried_at IS NULL OR f.preview_tried_at < ${now - retryAfter})
        AND k.kind = 'image' AND ${IMAGE_PREVIEW_EXPECTED()}
        ${maxPixels ? sql`AND (d.w IS NULL OR d.h IS NULL OR d.w * d.h <= ${maxPixels}::float8)` : sql``}
      ORDER BY f.created_at DESC
      LIMIT ${limit}
      FOR UPDATE OF f SKIP LOCKED
    )
    UPDATE files f SET preview_tries = COALESCE(f.preview_tries, 0) + 1, preview_tried_at = ${now}
    FROM c WHERE f.id = c.id
    RETURNING f.*`);
  return rows.map(shapeFile);
}

/**
 * Record the large preview the server drew for an image claimed by
 * claimServerPosters, as setFilePoster records a browser's: the thumbnail,
 * its siblings, its placeholder and seq are left alone, and width and height
 * are filled in only where the row has none. Only while the row is as it
 * was claimed — live, with the same thumbnail, and still no preview: one a
 * browser or a Mac recorded meanwhile wins, and new contents come with a new
 * thumbnail, of which ours is not the preview. One statement, so nothing
 * lands between the look and the write.
 *
 * `posterKey` null records the size alone: the picture, its size learned,
 * needs no preview, and is not claimed for one again. Resolves whether the
 * row took it; when it did not, the caller removes its preview.
 */
export async function setServerPoster(id, posterKey, media = {}, { thumbnailKey } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const fallback = {};
  for (const k of ['width', 'height']) if (Number(media?.[k]) > 0) fallback[k] = Math.round(Number(media[k]));
  const rows = await sql`
    UPDATE files
    SET metadata = ${sql.json(fallback)}::jsonb || COALESCE(metadata, '{}'::jsonb),
        poster_key = ${posterKey || null}
    WHERE id = ${id} AND deleted_at IS NULL AND thumbnail_key = ${thumbnailKey ?? null} AND poster_key IS NULL
    RETURNING id`;
  return rows.length > 0;
}

/** Why the server's last try at a file failed, for Admin → Previews; null when it did not. */
export async function setServerPreviewError(id, error) {
  if (!sql) return;
  await sql`UPDATE files SET preview_error = ${error ? String(error).slice(0, 300) : null} WHERE id = ${id}`;
}

/** Whether a file has a thumbnail now (another hand may have drawn one meanwhile). */
export async function fileThumbnailKey(id) {
  if (!sql) return null;
  const [r] = await sql`SELECT thumbnail_key FROM files WHERE id = ${id}`;
  return r?.thumbnail_key || null;
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
export async function setFileThumbnail(id, thumbnailKey, media = {}, posterKey = null, thumbSizes = null, { placeholder = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  // The old thumbnail's placeholder (lib/placeholder.js) goes with it: a tiny
  // copy of a picture the tile no longer shows. The new one's, when it came.
  const facts = { ...media, ...(placeholder ? { placeholder } : {}) };
  const rows = await sql`
    UPDATE files
    SET thumbnail_key = ${thumbnailKey}, thumbnail_url = NULL, thumb_status = 'ready',
        metadata = (COALESCE(metadata, '{}'::jsonb) - 'placeholder') || ${sql.json(facts)}::jsonb,
        seq = nextval('files_change_seq')
    WHERE id = ${id}
    RETURNING *`;
  const row = rows[0];
  if (!row) return null;
  if (posterKey || row.poster_key) row.poster_key = await recordPosterKey(id, posterKey || null);
  // A new thumbnail's siblings are the ones that came with it, or none: the
  // old ones were drawn from the old picture.
  const sizes = sizesText(thumbSizes);
  if (sizes || row.thumb_sizes) row.thumb_sizes = await recordThumbSizes(id, sizes, { thumbnailKey });
  return shapeFile(row);
}

/**
 * Record a video's hover-scrub sheet (lib/filmstrip-client.js) on an existing
 * row: its key, and its geometry (lib/media.js filmstripFacts) as
 * metadata.filmstrip, where the player reads it. What an upload does when its
 * sheet was still being drawn as the file was recorded. Like a thumbnail, and
 * for the same reasons, this is not an edit: version and updated_at stay
 * put, and seq moves, so a device picks the new preview up. Resolves the
 * row, or null for no row.
 */
export async function setFileFilmstrip(id, filmstripKey, filmstrip) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await sql`
    UPDATE files
    SET filmstrip_key = ${filmstripKey},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({ filmstrip })}::jsonb,
        seq = nextval('files_change_seq')
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? shapeFile(rows[0]) : null;
}

/**
 * Record the placeholder (lib/placeholder.js) of the thumbnail a row has —
 * drawn by an editor's browser from that thumbnail's smallest sibling, for a
 * row whose thumbnail came before placeholders did. `thumbnailKey` is the
 * thumbnail it was drawn from, and must still be the row's: a placeholder of
 * a picture since replaced is not recorded. Not an edit (version and
 * updated_at stay put); seq moves, as for a thumbnail, so listings and
 * devices pick it up. Resolves the row, 'changed' when the thumbnail is not
 * that one any more, or null for no live row.
 */
export async function setFilePlaceholder(id, placeholder, { thumbnailKey } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await sql`
    UPDATE files
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({ placeholder })}::jsonb,
        seq = nextval('files_change_seq')
    WHERE id = ${id} AND deleted_at IS NULL AND thumbnail_key = ${thumbnailKey ?? null}
    RETURNING *`;
  if (rows[0]) return shapeFile(rows[0]);
  const [live] = await sql`SELECT 1 FROM files WHERE id = ${id} AND deleted_at IS NULL`;
  return live ? 'changed' : null;
}

/**
 * Record an image's large preview for the thumbnail the row already has —
 * drawn by a writer's browser from the original it fetched to show it
 * (lib/thumbnail-client.js). The thumbnail, its siblings and seq are left
 * alone: the grid shows the same picture as before, and a preview is not a
 * change devices sync. Width and height are filled in only where the row
 * has none. Resolves the row, or null for no row.
 */
export async function setFilePoster(id, posterKey, media = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const fallback = {};
  for (const k of ['width', 'height']) if (Number(media?.[k]) > 0) fallback[k] = Math.round(Number(media[k]));
  const rows = await sql`
    UPDATE files
    SET metadata = ${sql.json(fallback)}::jsonb || COALESCE(metadata, '{}'::jsonb)
    WHERE id = ${id}
    RETURNING *`;
  const row = rows[0];
  if (!row) return null;
  row.poster_key = await recordPosterKey(id, posterKey);
  return shapeFile(row);
}

const THUMB_SIZE_NAMES = ['sm', 'xs'];

/** ['xs', 'sm', 'zz'] → 'sm,xs'; nothing known → null. The order is THUMB_SIZES' (lib/media.js). */
function sizesText(sizes) {
  const want = new Set((Array.isArray(sizes) ? sizes : String(sizes || '').split(',')).map((v) => String(v).trim()));
  const out = THUMB_SIZE_NAMES.filter((v) => want.has(v));
  return out.length ? out.join(',') : null;
}

/**
 * Write a row's thumb_sizes — which smaller siblings of its thumbnail exist —
 * on its own and best-effort, as recordPosterKey does and for the same reason:
 * a deploy that lands before the column exists still records thumbnails.
 * Resolves what was stored ('sm,xs' or null), or null on failure.
 *
 * `thumbnailKey`, when given, must still be the row's: siblings are drawn
 * from one thumbnail, and a thumbnail replaced in the meantime has none yet.
 * Not a change devices sync (the siblings are web-only), so seq stays put.
 */
export async function recordThumbSizes(id, sizes, { thumbnailKey } = {}) {
  if (!sql) return null;
  const text = sizesText(sizes);
  try {
    const rows = thumbnailKey
      ? await sql`UPDATE files SET thumb_sizes = ${text} WHERE id = ${id} AND thumbnail_key = ${thumbnailKey} RETURNING thumb_sizes`
      : await sql`UPDATE files SET thumb_sizes = ${text} WHERE id = ${id} RETURNING thumb_sizes`;
    return rows[0] ? rows[0].thumb_sizes || null : null;
  } catch (e) {
    console.warn('[recordThumbSizes]', e.message);
    return null;
  }
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
 * Record a sound's waveform (lib/waveform.js, checked by waveformFacts) — drawn
 * by a browser or a Mac from the file's bytes. Like a thumbnail, not an edit:
 * version and updated_at stay put. seq moves, so the devices' listings pick
 * the shape up as they pick up a new thumbnail.
 *
 * `contentHash`, when given, is the contents the waveform was drawn from: a
 * file whose contents were replaced meanwhile is left alone (its media facts
 * were cleared with them, and its own waveform is still to come). Resolves
 * the row, 'changed' for that, or null for no live row.
 */
export async function setFileWaveform(id, waveform, { contentHash } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  const rows = await sql`
    UPDATE files
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({ waveform })}::jsonb,
        seq = nextval('files_change_seq')
    WHERE id = ${id} AND deleted_at IS NULL
      AND (${contentHash ?? null}::text IS NULL OR content_hash IS NOT DISTINCT FROM ${contentHash ?? null}::text)
    RETURNING *`;
  if (rows[0]) return shapeFile(rows[0]);
  if (contentHash == null) return null;
  const [live] = await sql`SELECT 1 FROM files WHERE id = ${id} AND deleted_at IS NULL`;
  return live ? 'changed' : null;
}

// A live row that lib/media.js's effectiveKind calls a video: its kind, or for
// the 'other' rows web uploads used to be recorded as, its mime type or name —
// tested in fileKind's order, image first.
const IS_VIDEO_ROW = () => sql`
  deleted_at IS NULL AND (
    kind = 'video' OR (
      coalesce(nullif(kind, ''), 'other') = 'other'
      AND NOT (lower(coalesce(mime, '')) LIKE 'image/%' OR lower(coalesce(name, '')) ~ '[.](png|jpe?g|webp|gif|svg|avif|heic|heif|tiff?)$')
      AND (lower(coalesce(mime, '')) LIKE 'video/%' OR lower(coalesce(name, '')) ~ '[.](mp4|webm|mov|m4v|ogv)$')
    )
  )`;
// …with no frame model yet, and not one the probe has already failed to read.
const NO_FRAME_MODEL = () => sql`(metadata -> 'fps') IS NULL AND coalesce(metadata ->> 'fpsUnknown', '') <> 'true'`;

/**
 * Videos with no frame model yet, after `after` in id order, for Admin →
 * Usage's "Probe all videos" (POST /api/admin/storage/probe): a resumable
 * pass that looks at each row once. Whole rows, shaped: the probe needs the
 * storage, key and url.
 */
export async function listVideosMissingFrameModel({ after = '', limit = 50 } = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  const rows = await sql`
    SELECT * FROM files
    WHERE ${IS_VIDEO_ROW()} AND ${NO_FRAME_MODEL()} AND id > ${String(after || '')}
    ORDER BY id LIMIT ${Math.min(Math.max(1, Number(limit) || 50), 500)}`;
  return rows.map(shapeFile);
}

/** { videos, missing, unreadable }: how many live videos there are, how many have no frame model yet, and how many the probe could not read. */
export async function frameModelSummary() {
  const empty = { videos: 0, missing: 0, unreadable: 0 };
  if (!sql) return empty;
  try {
    await ensureFilesTable();
    const [r] = await sql`
      SELECT count(*)::int AS videos,
             count(*) FILTER (WHERE ${NO_FRAME_MODEL()})::int AS missing,
             count(*) FILTER (WHERE metadata ->> 'fpsUnknown' = 'true')::int AS unreadable
      FROM files WHERE ${IS_VIDEO_ROW()}`;
    return r || empty;
  } catch (e) {
    console.warn('[frameModelSummary]', e.message);
    return empty;
  }
}

// ── Previews: what a browser can draw of a file, and what it lacks ─────────
// Admin → Previews counts the library's thumbnails and hands its run the
// files to draw. lib/preview-jobs.js states both rules in JS — which files a
// browser draws (previewClass), and what one lacks (previewGaps) — and this
// is the same again in SQL, so the page's counts, the files a run is handed
// and what the browser then does agree. test/previews-db.test.js holds the
// two to each other, sizes included.
//
// PREVIEW_FILES is `files f` with what the rules read, worked out once per
// row in lateral subqueries:
//   k.kind     lib/media.js effectiveKind
//   p.class    previewClass: 'image', 'video', 'heic', 'tiff', 'never', or
//              NULL for anything that is not a picture or a video
//   d.w, d.h   the size on record: NULL unless both are positive numbers
//   d.ours     a thumbnail the server named (isThumbKey)
//   d.thumbed  any thumbnail, one of the old ones included
//   z.*        the widths lib/poster.js draws the grid poster, the xs sibling
//              and a player poster at, and the grid poster's long edge (an
//              image's preview is measured against it), from its own
//              constants — NULL without a size, which greatest() alone would
//              not give: it skips a NULL, and greatest(1, NULL) is 1.
//              Math.round is written floor(x + 0.5), which is how JS rounds;
//              a float8 round() breaks ties to even. The long edge is
//              rounded once, from the source's: rounding keeps order, so it
//              is the larger of the two rounded edges.
const PREVIEW_FILES = () => sql`
  files f
  CROSS JOIN LATERAL (SELECT lower(coalesce(f.mime, '')) AS m, lower(coalesce(f.name, '')) AS n) t
  CROSS JOIN LATERAL (SELECT CASE
      WHEN coalesce(f.kind, '') NOT IN ('', 'other') THEN f.kind
      WHEN t.m LIKE 'image/%' OR t.n ~ '[.](png|jpe?g|webp|gif|svg|avif|heic|heif|tiff?)$' THEN 'image'
      WHEN t.m LIKE 'video/%' OR t.n ~ '[.](mp4|webm|mov|m4v|ogv)$' THEN 'video'
      ELSE 'other'
    END AS kind) k
  CROSS JOIN LATERAL (SELECT CASE
      WHEN k.kind = 'image' AND (t.m IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp')
        OR (t.m NOT LIKE 'image/%' AND t.n ~ '[.](jpe?g|png|gif|webp|avif|bmp)$')) THEN 'image'
      WHEN k.kind = 'video' AND (t.m IN ('video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg')
        OR (t.m NOT LIKE 'video/%' AND t.n ~ '[.](mp4|m4v|webm|mov|ogv)$')) THEN 'video'
      WHEN k.kind = 'image' AND (t.m IN ('image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence')
        OR t.n ~ '[.](heic|heif)$') THEN 'heic'
      WHEN k.kind = 'image' AND (t.m IN ('image/tiff', 'image/tif') OR t.n ~ '[.]tiff?$') THEN 'tiff'
      WHEN k.kind IN ('image', 'video') THEN 'never'
    END AS class) p
  CROSS JOIN LATERAL (SELECT
      CASE WHEN f.metadata ->> 'width' ~ '^[0-9]+([.][0-9]+)?$' THEN nullif((f.metadata ->> 'width')::float8, 0) END AS w,
      CASE WHEN f.metadata ->> 'height' ~ '^[0-9]+([.][0-9]+)?$' THEN nullif((f.metadata ->> 'height')::float8, 0) END AS h,
      coalesce(f.thumbnail_key ~ '^_thumbs/[0-9a-f-]{36}[.](webp|jpg)$', false) AS ours,
      (f.thumbnail_key IS NOT NULL OR f.thumbnail_url IS NOT NULL) AS thumbed) d
  CROSS JOIN LATERAL (SELECT
      CASE WHEN d.w IS NOT NULL AND d.h IS NOT NULL THEN greatest(1, floor(d.w * least(1,
        greatest(${GRID_POSTER_BOX.width}::float8 / d.w, ${GRID_POSTER_BOX.height}::float8 / d.h),
        ${GRID_POSTER_MAX_EDGE}::float8 / greatest(d.w, d.h)) + 0.5)) END AS grid_w,
      CASE WHEN d.w IS NOT NULL AND d.h IS NOT NULL THEN greatest(1, floor(d.w * least(1,
        greatest(${XS_POSTER_BOX.width}::float8 / d.w, ${XS_POSTER_BOX.height}::float8 / d.h)) + 0.5)) END AS xs_w,
      CASE WHEN d.w IS NOT NULL AND d.h IS NOT NULL THEN greatest(1,
        floor(d.w * least(1, ${PLAYER_POSTER_MAX_EDGE}::float8 / greatest(d.w, d.h)) + 0.5)) END AS player_w,
      CASE WHEN d.w IS NOT NULL AND d.h IS NOT NULL THEN greatest(1, floor(greatest(d.w, d.h) * least(1,
        greatest(${GRID_POSTER_BOX.width}::float8 / d.w, ${GRID_POSTER_BOX.height}::float8 / d.h),
        ${GRID_POSTER_MAX_EDGE}::float8 / greatest(d.w, d.h)) + 0.5)) END AS grid_long) z`;

// Not a file at all — a generated preview or OS junk — as the listing has it
// (lib/file-query.js artifactClauses): each regex behind its LIKE hint, and a
// row whose key another row holds as its thumbnail.
const PREVIEW_NOT_ARTIFACT = () => sql`
  (f.storage_key IS NULL OR f.storage_key NOT LIKE ALL(${THUMB_HINTS}::text[]) OR f.storage_key !~ ${THUMB_ARTIFACT_RE})
  AND (f.storage_key IS NULL OR f.storage_key NOT LIKE ALL(${SYSTEM_HINTS}::text[]) OR f.storage_key !~ ${SYSTEM_KEY_RE})
  AND NOT EXISTS (SELECT 1 FROM files a WHERE a.thumbnail_key = f.storage_key)`;

/**
 * Live files in the bucket, in `prefix` (a drive's) and in `folder` and the
 * folders inside it, when given — the part of a run's scope that reads only
 * plain columns. The folder is matched as the files view matches it: with no
 * drive, in every place that has one of that name, since the library's view
 * lists files from everywhere.
 */
function previewPlace({ prefix = null, folder = null } = {}) {
  const p = normPrefix(prefix);
  return sql`
    f.deleted_at IS NULL AND f.storage = 's3'
    ${p ? sql`AND f.storage_key LIKE ${`${escapeLike(p)}/%`}` : sql``}
    ${folder ? sql`AND (f.folder = ${folder} OR starts_with(f.folder, ${`${folder}/`}))` : sql``}`;
}

/** previewPlace, of `kinds` (effectiveKind's words), and files at all. */
function previewScope({ kinds = ['image', 'video'], prefix = null, folder = null } = {}) {
  return sql`${previewPlace({ prefix, folder })} AND k.kind = ANY(${kinds}::text[]) AND ${PREVIEW_NOT_ARTIFACT()}`;
}

// lib/poster.js thumbSiblingSizes, which makes a sibling only under 0.8x the
// grid poster's width — and the xs is the smaller, so it decides whether
// there is any — and playerPosterFor, which makes a poster only from 1.25x.
// A size not on record expects both, as the tiles do.
const SIBLINGS_EXPECTED = () => sql`(z.xs_w IS NULL OR z.xs_w < z.grid_w * 0.8)`;
const POSTER_EXPECTED = () => sql`(z.player_w IS NULL OR z.player_w >= z.grid_w * 1.25)`;
// lib/preview-jobs.js imagePreviewExpected, which is lib/poster.js
// imagePreviewFor: never a GIF (by its type, or by its name when it has
// none, as lib/preview-wanted.js imageMime reads it); otherwise a preview,
// unless the picture's long edge is within 1.25x its grid poster's, or
// within the preview's own with an original small enough to serve as one.
// A size not on record expects one.
const IMAGE_PREVIEW_EXPECTED = () => sql`(
  NOT (t.m ~ 'gif' OR (t.m = '' AND t.n ~ '[.]gif$'))
  AND (z.grid_long IS NULL OR (greatest(d.w, d.h) > z.grid_long * 1.25
    AND NOT (greatest(d.w, d.h) <= ${IMAGE_PREVIEW_MAX_EDGE}::float8
      AND coalesce(f.size, 0) > 0 AND f.size <= ${PREVIEW_ORIGINAL_MAX_BYTES}::bigint))))`;
// What should have a large picture (poster_key): a video its player poster,
// an image its preview.
const POSTER_WANTED = () => sql`((k.kind = 'video' AND ${POSTER_EXPECTED()}) OR (k.kind = 'image' AND ${IMAGE_PREVIEW_EXPECTED()}))`;
// What a thumbnail of ours lacks (previewGaps). Lacking one of ours is
// lacking them all: NOT d.ours.
const PREVIEW_SIZES_GAP = () => sql`(d.ours AND f.thumb_sizes IS NULL AND ${SIBLINGS_EXPECTED()})`;
const PREVIEW_PLACEHOLDER_GAP = () => sql`(d.ours AND (f.metadata ->> 'placeholder') IS NULL)`;
const PREVIEW_POSTER_GAP = () => sql`(d.ours AND f.poster_key IS NULL AND ${POSTER_WANTED()})`;
const PREVIEW_MISSING = () => sql`(NOT d.ours OR ${PREVIEW_SIZES_GAP()} OR ${PREVIEW_PLACEHOLDER_GAP()} OR ${PREVIEW_POSTER_GAP()})`;
// The same, loosely, from plain columns alone: true of every row
// PREVIEW_MISSING is (a thumbnail not of ours — the old worker's — never had
// siblings or a placeholder; only a row effectiveKind may call a video or an
// image lacks a poster), and false of a complete one, which it spares every
// expression above. Postgres tests the cheaper condition first.
const PREVIEW_MAYBE_MISSING = () => sql`
  (f.thumbnail_key IS NULL OR f.thumb_sizes IS NULL OR (f.metadata ->> 'placeholder') IS NULL
    OR (f.poster_key IS NULL AND coalesce(f.kind, '') IN ('', 'other', 'image', 'video')))`;

/**
 * The files a run is handed, each of which previewJob gives a job: with
 * 'everything', all of `classes` (those this browser draws); with 'missing',
 * those of them that lack anything — and, whatever the file is, one whose
 * thumbnail of ours lacks only what is drawn from that thumbnail, which any
 * browser can make.
 */
function previewListed({ classes, mode }) {
  return mode === 'everything'
    ? sql`(p.class = ANY(${classes}::text[]))`
    : sql`(${PREVIEW_MAYBE_MISSING()}
      AND ((p.class = ANY(${classes}::text[]) AND ${PREVIEW_MISSING()}) OR ${PREVIEW_SIZES_GAP()} OR ${PREVIEW_PLACEHOLDER_GAP()}))`;
}

const PREVIEW_PAGE_MAX = 200;
// How many rows of its scope, in id order, a page of a run looks through for
// its files. A page is those rows' candidates, up to its limit, so it costs
// about the same however few of them a run wants, and a run reads its scope
// once, a window at a time. Asked plainly for "the next 50 that lack
// something", Postgres read the whole rest of the table for every page of a
// sparse run. Measured at 300,000 files, 7% of them lacking something: 0.8 s
// a page, six minutes of the database's time over a run's 450 pages; in
// windows, under 20 ms a page and six seconds for the run.
const PREVIEW_WINDOW = 2000;

/**
 * Admin → Previews' counts: for each previewClass (image, video, heic, tiff,
 * never), over live files in the bucket — in `prefix`, a drive's, when
 * given — how many there are, how many have a thumbnail (`thumbs`; `legacy`
 * of them one of the old ones, which a run draws again whole), and how many
 * of those lack their smaller sizes, their placeholder or their large
 * picture (`noPoster`: a video's player poster, an image's preview), where
 * they should have them.
 *
 * One pass over the table, grouped by class: it reads every live row, as the
 * Usage page's report does, and no index would spare that, since it counts
 * them all — 0.65 s at 300,000 files, measured. It runs when an admin opens
 * the page and never on a path anyone else takes. It throws when the
 * database does, so a count that could not be read is never shown as
 * nothing to do.
 */
export async function previewSummary({ prefix = null } = {}) {
  const zero = () => ({ files: 0, thumbs: 0, legacy: 0, noSizes: 0, noPlaceholder: 0, noPoster: 0 });
  const out = { image: zero(), video: zero(), heic: zero(), tiff: zero(), never: zero() };
  if (!sql) return out;
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT p.class,
           count(*)::int AS files,
           count(*) FILTER (WHERE d.thumbed)::int AS thumbs,
           count(*) FILTER (WHERE d.thumbed AND NOT d.ours)::int AS legacy,
           count(*) FILTER (WHERE d.thumbed AND f.thumb_sizes IS NULL AND ${SIBLINGS_EXPECTED()})::int AS no_sizes,
           count(*) FILTER (WHERE d.thumbed AND (f.metadata ->> 'placeholder') IS NULL)::int AS no_placeholder,
           count(*) FILTER (WHERE d.thumbed AND f.poster_key IS NULL AND ${POSTER_WANTED()})::int AS no_poster
    FROM ${PREVIEW_FILES()}
    WHERE ${previewScope({ prefix })} AND p.class IS NOT NULL
    GROUP BY p.class`);
  for (const r of rows) {
    if (!out[r.class]) continue;
    out[r.class] = {
      files: r.files, thumbs: r.thumbs, legacy: r.legacy,
      noSizes: r.no_sizes, noPlaceholder: r.no_placeholder, noPoster: r.no_poster,
    };
  }
  return out;
}

/**
 * One page of the files an Admin → Previews run works through (previewListed
 * over previewScope), in id order after `after`: { files, after, done }.
 * Whole rows, shaped; the route presigns them.
 *
 * Keyset-paged on the primary key, a window at a time (PREVIEW_WINDOW): the
 * next rows of the place in id order, then those of them the run wants. So
 * a page may hold fewer files than `limit`, or none, and not be the last —
 * `after` is where the next one starts, and `done` says there is no next.
 * No index would do the same: one on what a row lacks could not stay small,
 * since every document and sound lacks a thumbnail for good. `window` is for
 * the tests.
 */
export async function listPreviewCandidates({
  classes = ['image', 'video'], kinds, prefix = null, folder = null, mode = 'missing', after = '', limit = 50, window = PREVIEW_WINDOW,
} = {}) {
  const from = String(after || '');
  if (!sql) return { files: [], after: from, done: true };
  await ensureFilesTable();
  const n = Math.min(Math.max(1, Math.floor(Number(limit)) || 50), PREVIEW_PAGE_MAX);
  const span = Math.min(Math.max(1, Math.floor(Number(window)) || PREVIEW_WINDOW), 10_000);
  const ids = (await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT f.id FROM files f
    WHERE f.id > ${from} AND ${previewPlace({ prefix, folder })}
    ORDER BY f.id
    LIMIT ${span}`)).map((r) => r.id);
  if (!ids.length) return { files: [], after: from, done: true };
  const rows = await sql`
    SELECT f.* FROM ${PREVIEW_FILES()}
    WHERE f.id = ANY(${ids}::text[]) AND ${previewScope({ kinds, prefix, folder })} AND ${previewListed({ classes, mode })}
    ORDER BY f.id
    LIMIT ${n}`;
  const full = rows.length >= n;
  return {
    files: rows.map(shapeFile),
    after: full ? rows[rows.length - 1].id : ids[ids.length - 1],
    done: !full && ids.length < span,
  };
}

/**
 * What a run over this scope comes to, asked as it starts: `total`, the files
 * listPreviewCandidates will hand it, and those it leaves out because this
 * browser cannot draw them — `heic` and `tiff`, which Safari can, and
 * `never`, which no browser can. With 'missing', only files lacking
 * something are counted. One pass over the scope, once a run: 0.3 s for the
 * whole of 300,000 files, measured.
 */
export async function countPreviewCandidates({ classes = ['image', 'video'], kinds, prefix = null, folder = null, mode = 'missing' } = {}) {
  const none = { total: 0, heic: 0, tiff: 0, never: 0 };
  if (!sql) return none;
  await ensureFilesTable();
  const [r] = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT count(*) FILTER (WHERE ${previewListed({ classes, mode })})::int AS total,
           count(*) FILTER (WHERE NOT ${previewListed({ classes, mode })} AND p.class = 'heic')::int AS heic,
           count(*) FILTER (WHERE NOT ${previewListed({ classes, mode })} AND p.class = 'tiff')::int AS tiff,
           count(*) FILTER (WHERE NOT ${previewListed({ classes, mode })} AND p.class = 'never')::int AS never
    FROM ${PREVIEW_FILES()}
    WHERE ${previewScope({ kinds, prefix, folder })} AND p.class IS NOT NULL
      ${mode === 'everything' ? sql`` : sql`AND ${PREVIEW_MAYBE_MISSING()} AND ${PREVIEW_MISSING()}`}`);
  return r ? { total: r.total, heic: r.heic, tiff: r.tiff, never: r.never } : none;
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

/**
 * Which of these preview keys (thumbnail, player poster, filmstrip) another
 * row already uses. A preview key is a random name, but not a secret one: it
 * is in every signed thumbnail URL and on every row a listing or a share page
 * sends. Recording one another file uses would let someone who can edit a
 * file of their own keep another file's preview — one they have since lost
 * access to — signed on their row for as long as they like. So a write takes
 * only a key no other row holds. Throws when it cannot tell, and callers fail
 * closed.
 *
 * Every key is looked for in all three columns, one column at a time: each
 * branch is its own index's (files_thumbnail_key_idx, files_poster_key_idx,
 * files_filmstrip_key_idx). An OR across the columns in one WHERE, as this
 * was, is served by none of them, and read the whole table once per key on
 * every upload with previews.
 */
export async function previewKeysInUse(keys = [], { exceptId = null } = {}) {
  const list = [...new Set(keys.filter(Boolean).map(String))];
  if (!sql || !list.length) return new Set();
  await ensureFilesTable();
  const except = exceptId || '';
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT f.thumbnail_key AS k FROM files f WHERE f.thumbnail_key = ANY(${list}::text[]) AND f.id <> ${except}
    UNION
    SELECT f.poster_key FROM files f WHERE f.poster_key = ANY(${list}::text[]) AND f.id <> ${except}
    UNION
    SELECT f.filmstrip_key FROM files f WHERE f.filmstrip_key = ANY(${list}::text[]) AND f.id <> ${except}`);
  return new Set(rows.map((r) => r.k));
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
    thumbSizes: sizesText(r.thumb_sizes) ? sizesText(r.thumb_sizes).split(',') : [],
    deletedAt: r.deleted_at ? Number(r.deleted_at) : null, trashKey: r.trash_key || null,
    deletedBy: r.deleted_by || null,
    version: r.version != null ? Number(r.version) : 1,
    contentHash: r.content_hash || null,
    reviewStatus: r.review_status || null,
    openComments: r.open_comments != null ? Number(r.open_comments) : 0,
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    createdBy: r.created_by || null, createdAt: Number(r.created_at) || null, updatedAt: Number(r.updated_at) || null,
    seq: r.seq != null ? Number(r.seq) : null,
    fileCreatedAt: r.file_created_at != null ? Number(r.file_created_at) : null,
    fileModifiedAt: r.file_modified_at != null ? Number(r.file_modified_at) : null,
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
  // The file an upload is new contents for (lib/replace-content.js), or NULL
  // for a new file. Kept on the row because `complete` issues the key again,
  // however many days later, and must bind it to the same file.
  await sql`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS replace_of TEXT`;
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
  replaceOf: r.replace_of || null,
  createdBy: r.created_by || null,
  createdAt: Number(r.created_at) || null,
  updatedAt: Number(r.updated_at) || null,
});

export async function createUpload(data = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureUploadsTable();
  const id = crypto.randomUUID();
  const now = Date.now();
  const rows = await withSchemaRetry(ensureUploadsTable, () => sql`
    INSERT INTO uploads (id, upload_id, storage_key, filename, size, mime, folder, filespace_id, part_size, replace_of, created_by, created_at, updated_at)
    VALUES (${id}, ${data.uploadId}, ${data.storageKey}, ${data.filename}, ${data.size != null ? Number(data.size) : null},
            ${data.mime || null}, ${data.folder || ''}, ${data.filespaceId || null}, ${Number(data.partSize)},
            ${data.replaceOf || null}, ${data.createdBy || null}, ${now}, ${now})
    RETURNING *`);
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
  // The file a key was issued to hold new contents for (lib/replace-content.js),
  // or NULL for a new file. A key is taken only for what it was issued for:
  // new contents cannot be recorded as a file of their own, nor an upload
  // for a new file swapped into one that exists.
  await sql`ALTER TABLE upload_keys ADD COLUMN IF NOT EXISTS replace_of TEXT`;
});

/**
 * Record that `email` was handed `key`, in `bucket`, to upload to (again:
 * refreshes the clock). The bucket is kept so that deleting an upload that
 * came in over a limit deletes it where it was issued, and nowhere else.
 * `replaceOf` binds the key to new contents for that file id.
 */
export async function issueUploadKey(key, email, { bucket = '', replaceOf = null } = {}) {
  const e = normEmail(email);
  if (!sql || !key || !e) throw new Error('Cannot record the upload.');
  await ensureUploadKeysTable();
  const now = Date.now();
  await withSchemaRetry(ensureUploadKeysTable, () => sql`
    INSERT INTO upload_keys (storage_key, email, bucket, issued_at, replace_of)
    VALUES (${String(key)}, ${e}, ${String(bucket || '')}, ${now}, ${replaceOf ? String(replaceOf) : null})
    ON CONFLICT (storage_key, email) DO UPDATE
      SET issued_at = EXCLUDED.issued_at, bucket = EXCLUDED.bucket, replace_of = EXCLUDED.replace_of`);
}

/**
 * Take `key` for recording, if it was issued to `email` within the TTL, for
 * the same purpose — a new file, or (`replaceOf`) new contents for that one:
 * → { bucket } once, null for a key never issued to them, expired, issued
 * for something else, or already taken. One statement, so two requests
 * racing to record the same upload cannot both win.
 */
export async function claimUploadKey(key, email, { replaceOf = null } = {}) {
  const e = normEmail(email);
  if (!sql || !key || !e) return null;
  await ensureUploadKeysTable();
  const rows = await withSchemaRetry(ensureUploadKeysTable, () => sql`
    DELETE FROM upload_keys
    WHERE storage_key = ${String(key)} AND email = ${e} AND issued_at >= ${Date.now() - UPLOAD_KEY_TTL_MS}
      AND replace_of IS NOT DISTINCT FROM ${replaceOf ? String(replaceOf) : null}::text
    RETURNING bucket`);
  return rows.length ? { bucket: rows[0].bucket || '' } : null;
}

/**
 * Is `key` spoken for by an upload still in flight — issued within the TTL
 * and not yet recorded — that the one asking (`by`) may not share? An object
 * is not in the bucket until its PUT lands, so a key chosen by asking the
 * bucket alone goes to every upload that starts before the first one lands,
 * and whichever lands last overwrites the others: another person's file, or
 * new contents already swapped into a file (lib/replace-content.js), whose
 * live object that key has become. Someone may share a key they hold for a
 * new file of their own — retrying their own upload keeps its name — but
 * never one bound to new contents; and new contents (`forReplacement`)
 * share nothing. Throws when it cannot tell; callers decide.
 */
export async function uploadKeyHeld(key, { by = null, forReplacement = false } = {}) {
  if (!sql || !key) return false;
  await ensureUploadKeysTable();
  const rows = await withSchemaRetry(ensureUploadKeysTable, () => sql`
    SELECT 1 FROM upload_keys
    WHERE storage_key = ${String(key)} AND issued_at >= ${Date.now() - UPLOAD_KEY_TTL_MS}
      AND (${!!forReplacement}::boolean OR replace_of IS NOT NULL OR email <> ${normEmail(by)})
    LIMIT 1`);
  return rows.length > 0;
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
    // How far a cursor may honestly go (changeHorizon), read BEFORE the rows:
    // everything at or below it had finished by then, so the reads below see
    // all of it. Read after, a change committing in between would be under
    // the horizon but missing from the page.
    const horizon = await changeHorizon();
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

    // Everything up to `next` goes out, but the cursor stops at the horizon:
    // what is above it comes again next time (a device applies it twice to
    // no effect) rather than a change still being written below it being
    // passed over for good.
    const settled = settleFeedCursor({ from, next, full, horizon });
    return {
      changed: delivered.filter((r) => r.shown === true).map(shapeFile),
      deleted: gone,
      cursor: settled.cursor,
      done: settled.done,
    };
  } catch (e) {
    // Thrown, not answered with an empty "done" page: a device told it is
    // up to date when the read failed would stop asking until the next write.
    console.warn('[listFileChanges] failed:', e.message);
    throw e;
  }
}

// ── How far a change cursor may go ──────────────────────────────────────────
// A change's seq is taken from files_change_seq when its statement runs, but
// the row is seen only when the statement commits — and statements commit in
// their own order. A folder rename of a few thousand rows takes its seqs and
// commits seconds later; a thumbnail or an upload that started after it
// commits first, with a higher seq. A device that read the feed in between
// was handed the higher seq as its cursor and never asked below it again, so
// the rename never reached it: Finder showed the old names until a re-sync.
//
// So the feed never hands out a cursor past a seq it knows has settled:
// every change at or below it has committed or rolled back. It knows that
// from marks — (when, the sequence's value, the snapshot's xmax, kept as
// next_xid) — taken as
// the feed is read, at most one a second. A change with a seq at or below a
// mark's took that seq before the mark was taken, and has a transaction id
// within a moment of it (the id is assigned as the row is written, right
// after the seq is drawn). So any later observation's xmax, taken at least
// CHANGE_SETTLE seconds on, is above that id; and once the oldest
// transaction still running is at or past that xmax, the change is done.
// With nothing running at all, a mark that old has settled outright.
const CHANGE_SETTLE = '2 seconds';
const CHANGE_MARKS_KEPT = '15 minutes';

const ensureChangeMarksTable = lazySchema('ensureChangeMarksTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS change_marks (
      at   TIMESTAMPTZ NOT NULL,
      seq  BIGINT NOT NULL,
      next_xid BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS change_marks_at_idx ON change_marks (at)`;
});

/**
 * The highest seq a feed may put in a cursor now: one statement that also
 * leaves a mark (at most one a second) and prunes old ones, keeping the last
 * CHANGE_MARKS_KEPT of them however long ago that was. 0 when nothing has
 * settled yet (a cursor then stays where it is); undefined when the marks
 * could not be read at all, and a cursor goes as far as its page, as it did
 * before there were marks — a sync that stalls on a broken table is worse
 * than the rare change this guards against.
 */
export async function changeHorizon() {
  if (!sql) return undefined;
  await ensureChangeMarksTable();
  try {
    const rows = await withSchemaRetry(ensureChangeMarksTable, () => sql`
      WITH obs AS (
        SELECT clock_timestamp() AS t, txid_current_snapshot() AS s,
               (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM files_change_seq) AS seq
      ), mark AS (
        INSERT INTO change_marks (at, seq, next_xid)
        SELECT obs.t, obs.seq, txid_snapshot_xmax(obs.s) FROM obs
         WHERE NOT EXISTS (SELECT 1 FROM change_marks c WHERE c.at > obs.t - interval '1 second')
        RETURNING 1
      ), prune AS (
        DELETE FROM change_marks c
         WHERE c.at < (SELECT max(at) FROM change_marks) - ${CHANGE_MARKS_KEPT}::interval
        RETURNING 1
      )
      SELECT COALESCE(max(m.seq), 0) AS safe
        FROM change_marks m, obs
       WHERE m.at <= obs.t - ${CHANGE_SETTLE}::interval
         AND (txid_snapshot_xmin(obs.s) = txid_snapshot_xmax(obs.s)
              OR (SELECT n.next_xid FROM change_marks n
                   WHERE n.at >= m.at + ${CHANGE_SETTLE}::interval
                   ORDER BY n.at ASC LIMIT 1) <= txid_snapshot_xmin(obs.s))
    `);
    return Number(rows?.[0]?.safe) || 0;
  } catch (e) {
    console.warn('[changeHorizon] failed:', e.message);
    return undefined;
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
  await followTranscriptKeys([{ id, toKey: storageKey }]);
  await sql`
    UPDATE files
    SET storage_key = ${storageKey}, version = COALESCE(version, 1) + 1,
        updated_at = ${Date.now()}, seq = nextval('files_change_seq')
    WHERE id = ${id}`;
  return { ok: true };
}

/**
 * New contents for a file (lib/replace-content.js): the row points at
 * `toKey`, an object holding the new bytes, and everything that described
 * the old bytes goes with them — size, hash, the previews (the thumbnail and
 * its siblings, the poster, the strip) and the media facts in metadata
 * (MEDIA_KEYS) — so they are made again from the new ones. The id, name,
 * folder, tags, the library's own metadata fields, comments, links and
 * grants stay: it is the same file. version, updated_at and seq move, so an
 * If-Match on the old version fails and every device is told.
 *
 * Unlike setFileStorageKey, the transcript does NOT follow: these are other
 * bytes, and a transcript whose source_key is the old key reads as stale by
 * itself, which is the truth.
 *
 * Conditional on the row still being live at `fromKey`, the key the new
 * object was placed beside. A file moved, trashed or given other contents
 * while these were uploading is not overwritten: null, and the caller
 * decides. Resolves the row as it now is.
 */
export async function replaceFileContent(id, { fromKey, toKey, url, size = null, mime = null, kind = null, contentHash = null, fileModifiedAt = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  if (!id || !fromKey || !toKey || !url) throw new Error('replaceFileContent needs the file, both keys and a URL.');
  await ensureFilesTable();
  const now = Date.now();
  // The file's own modified date moves with its bytes: to the one the new
  // contents came with, else to now. Never left behind — a device that keys
  // what it holds on size and modified date would go on serving the old
  // bytes. Its created date is the file's, and stays.
  const modified = fileModifiedAt != null ? Number(fileModifiedAt) : now;
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    UPDATE files SET
      storage_key = ${toKey},
      url = ${url},
      size = ${size != null ? Number(size) : null},
      mime = COALESCE(${mime}::text, mime),
      kind = COALESCE(${kind}::text, kind),
      content_hash = ${contentHash},
      file_modified_at = ${modified},
      thumbnail_key = NULL, thumbnail_url = NULL, poster_key = NULL, thumb_sizes = NULL,
      filmstrip_key = NULL, thumb_status = NULL,
      metadata = COALESCE(metadata, '{}'::jsonb) - ${[...MEDIA_KEYS]}::text[],
      version = COALESCE(version, 1) + 1,
      updated_at = ${now},
      seq = nextval('files_change_seq')
    WHERE id = ${String(id)} AND deleted_at IS NULL AND storage_key = ${fromKey}
    RETURNING *`);
  return rows[0] ? shapeFile(rows[0]) : null;
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
  // The file's own dates, in the INSERT so a device's first sight of the row
  // carries them. withSchemaRetry: a deploy that lands before the guard has
  // added the columns heals on the first upload, as the listing does.
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    INSERT INTO files (id, name, folder, kind, mime, size, url, storage, storage_key, tags, notes, visibility, thumbnail_url, thumbnail_key, filmstrip_key, metadata, content_hash, created_by, created_at, updated_at, file_created_at, file_modified_at, seq)
    VALUES (
      ${id}, ${(data.name || 'Untitled').trim()}, ${data.folder || ''}, ${data.kind || 'other'}, ${data.mime || null},
      ${data.size != null ? Number(data.size) : null}, ${data.url}, ${data.storage || 'blob'}, ${data.storageKey || null},
      ${sql.json(normalizeTags(data.tags))}, ${data.notes || null}, ${visibility},
      ${data.thumbnailUrl || null}, ${data.thumbnailKey || null}, ${data.filmstripKey || null},
      ${sql.json(data.metadata && typeof data.metadata === 'object' ? data.metadata : {})}, ${data.contentHash || null}, ${data.createdBy || null},
      ${data.createdAt != null ? Number(data.createdAt) : now}, ${data.updatedAt != null ? Number(data.updatedAt) : now},
      ${data.fileCreatedAt != null ? Number(data.fileCreatedAt) : null}, ${data.fileModifiedAt != null ? Number(data.fileModifiedAt) : null},
      nextval('files_change_seq')
    )
    RETURNING *
  `);
  const row = rows[0];
  // Not in the INSERT: see recordPosterKey. An upload never fails for want
  // of its player poster, nor of its thumbnail's siblings.
  if (row && data.posterKey) row.poster_key = await recordPosterKey(id, data.posterKey);
  if (row && data.thumbnailKey && sizesText(data.thumbSizes)) {
    row.thumb_sizes = await recordThumbSizes(id, data.thumbSizes, { thumbnailKey: data.thumbnailKey });
  }
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

    // A collection reads folder rows' tags and metadata as well.
    if (opts.collection) await ensureFoldersTable();

    const { text, params, countText, countParams, limit, sort } = buildFileQuery({ opts, principal });
    // sql.unsafe takes pre-built text + bound parameters. The text comes from
    // lib/file-query.js, which never interpolates a value — every value is a
    // $n placeholder — so "unsafe" here means "not a tagged template", not
    // "unparameterized".
    const rows = await withSchemaRetry(opts.collection ? [ensureFilesTable, ensureFoldersTable] : ensureFilesTable, () => sql.unsafe(text, params));
    const files = rows.map(shapeFile);

    const out = { files, cursor: nextCursor(rows, sort, limit) };
    if (opts.withTotal) {
      const counted = await sql.unsafe(countText, countParams);
      out.total = Number(counted?.[0]?.n) || 0;
      out.totalBytes = Number(counted?.[0]?.bytes) || 0;
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
    // What the scope's folders carry themselves, for the tree's editor and
    // badges. Only rows with something on them; the rest have neither.
    const meta = await listFolderMeta(filespace).catch(() => new Map());
    return [...all].sort((a, b) => a.localeCompare(b)).map((folder) => ({
      folder,
      name: folder.includes('/') ? folder.slice(folder.lastIndexOf('/') + 1) : folder,
      parent: _folderParent(folder),
      depth: _folderDepth(folder),
      count: counts.get(folder) || 0,
      ...(meta.get(folder) || {}),
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
 * Point a trashed file at the copy of its object in the trash — only while it
 * is still trashed, not yet moved, and at the key that was copied: a restore,
 * another mover or a new key in between leaves it as it is (lib/trash-move.js).
 * No seq: a trashed row is on no device, and where its bytes wait changes
 * nothing anyone is shown. → whether it was pointed.
 */
export async function setTrashKeyIfUnmoved(id, { trashKey, storageKey } = {}) {
  if (!sql || !id || !trashKey || !storageKey) return false;
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    UPDATE files SET trash_key = ${trashKey}
    WHERE id = ${id} AND deleted_at IS NOT NULL AND trash_key IS NULL AND storage_key = ${storageKey}
    RETURNING id`);
  return rows.length > 0;
}

/**
 * The trashed file whose object still sits at `key` — trashed, not yet moved —
 * when no live file has the key: what an upload that wants the key moves out
 * of the way first (lib/trash-move.js vacateTrashedKey). Null otherwise.
 */
export async function trashedRowAtKey(key) {
  if (!sql || !key) return null;
  await ensureFilesTable();
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT * FROM files f
    WHERE f.storage_key = ${key} AND f.deleted_at IS NOT NULL AND f.trash_key IS NULL
      AND NOT EXISTS (SELECT 1 FROM files o WHERE o.storage_key = ${key} AND o.deleted_at IS NULL)
    ORDER BY f.deleted_at DESC
    LIMIT 1`);
  return rows[0] ? shapeFile(rows[0]) : null;
}

/**
 * Trashed files whose object has not moved to the trash yet, oldest first:
 * in the bucket, no larger than `maxBytes`, and not sharing their object with
 * another row (the delete leaves such an object alone, and so does the move).
 * For the maintenance sweep (lib/trash-move.js moveLeftoverTrash).
 */
export async function listUnmovedTrash({ limit = 200, maxBytes } = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  const n = Math.min(Math.max(1, Number(limit) || 200), 1000);
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : null;
  const rows = await withSchemaRetry(ensureFilesTable, () => sql`
    SELECT * FROM files f
    WHERE f.deleted_at IS NOT NULL AND f.trash_key IS NULL
      AND f.storage = 's3' AND f.storage_key IS NOT NULL
      AND (${cap}::bigint IS NULL OR coalesce(f.size, 0) <= ${cap}::bigint)
      AND NOT EXISTS (
        SELECT 1 FROM files o
        WHERE o.id <> f.id
          AND ((o.storage_key = f.storage_key AND (o.deleted_at IS NULL OR o.trash_key IS NULL)) OR o.trash_key = f.storage_key))
    ORDER BY f.deleted_at ASC
    LIMIT ${n}`);
  return rows.map(shapeFile);
}

/**
 * Restore a trashed file (clears the trash flags). S3 move-back is done by
 * the route; `storageKey` is where it put the object, when that is not the
 * key the file had before (a newer file took the name in the meantime).
 */
export async function restoreFile(id, { storageKey = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilesTable();
  // Restored to a new key (a newer file took the old one): the same bytes.
  if (storageKey) await followTranscriptKeys([{ id, toKey: storageKey }]);
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
 * Is another row's object at this key? A live file's; a trashed file's still
 * waiting there to move to the trash (trash_key NULL); or one moved to the
 * trash at this key. The trash purge asks before deleting a key a trashed row
 * never moved away from: by the time it runs, a new upload may have been
 * given the same name in the same folder.
 *
 * A trashed file whose object HAS moved no longer holds its old key, though
 * the row still names it (a restore puts it back there if it is free). It
 * used to count, and so a file put back under the name of one just deleted —
 * Finder's Replace deletes, then copies — was refused when it was recorded:
 * "That stored object already belongs to a file in the library".
 *
 * Asked on every upload recorded, so it is three questions, each one an
 * index answers — a live file at the key (files_live_key_idx), a trashed one
 * still there (files_unmoved_trash_idx), one moved to the trash at it
 * (files_trash_key_idx) — and it stops at the first yes. The same rows as
 * `(storage_key = key AND (deleted_at IS NULL OR trash_key IS NULL)) OR
 * trash_key = key`, which no index could serve: that read the whole table.
 */
export async function storageKeyInUse(key, { exceptId = null } = {}) {
  if (!sql || !key) return false;
  await ensureFilesTable();
  const except = exceptId || '';
  const rows = await sql`
    SELECT EXISTS (SELECT 1 FROM files WHERE storage_key = ${key} AND deleted_at IS NULL AND id <> ${except})
        OR EXISTS (SELECT 1 FROM files WHERE storage_key = ${key} AND deleted_at IS NOT NULL AND trash_key IS NULL AND id <> ${except})
        OR EXISTS (SELECT 1 FROM files WHERE trash_key = ${key} AND id <> ${except}) AS used`;
  return rows[0]?.used === true;
}

/**
 * Which of `keys` a file holds, each decided as storageKeyInUse decides one
 * (and with the same three indexed questions): a Set. For a caller about to
 * delete objects it put there itself, so that none a row has come to point
 * at meanwhile — a folder rename running twice at once — goes with them.
 */
export async function storageKeysInUse(keys = []) {
  const list = [...new Set(keys.filter(Boolean).map(String))];
  if (!sql || !list.length) return new Set();
  await ensureFilesTable();
  const rows = await sql`
    SELECT k FROM unnest(${list}::text[]) AS k
    WHERE EXISTS (SELECT 1 FROM files WHERE storage_key = k AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM files WHERE storage_key = k AND deleted_at IS NOT NULL AND trash_key IS NULL)
       OR EXISTS (SELECT 1 FROM files WHERE trash_key = k)`;
  return new Set(rows.map((r) => r.k));
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
  // And its transcript and its proxy, which are nobody's once the file is
  // purged. The proxy OBJECT is left to the same sweep that collects the file's
  // own bytes — this function does not reach storage.
  await deleteTranscriptRow(id);
  await deleteProxyRow(id);
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
//
// A folder row is a name within a SCOPE: a drive's (`filespace` holds the
// drive's prefix, as the folder routes tag it) or the library's ('' — or
// NULL, from before the column existed, which reads as ''). So two drives
// can each have a "Selects", and each scope creates, lists, renames and
// deletes only its own: every query below names its scope with inScope(),
// the expression the unique index is on.
const ensureFoldersTable = lazySchema('ensureFoldersTable', async () => {
  await sql`CREATE TABLE IF NOT EXISTS folders (name TEXT PRIMARY KEY, created_at BIGINT NOT NULL)`;
  // Nested-tree columns. `name` is the full slash path (materialized path);
  // `parent` is the path minus the last segment.
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent TEXT DEFAULT ''`;
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS depth INT DEFAULT 0`;
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'org'`;
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_by TEXT`;
  // Which scope the folder belongs to: a drive's prefix, or '' (NULL) for the library.
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS filespace TEXT DEFAULT ''`;
  await sql`CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent)`;
  // A folder's identity: its name within its scope. Every existing row
  // already satisfies it (names were unique outright), so building it
  // rewrites nothing. Writes name no conflict target (ON CONFLICT DO
  // NOTHING), so they hold with or without the old primary key on the name
  // alone — which, while it stands, still keeps each name to one scope
  // (createFolder says when that is the answer).
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS folders_scope_name_idx ON folders ((COALESCE(filespace, '')), name)`;
  // And that old key goes, after the index above is in place, so a name is
  // never without a unique rule. This is the one step a redeploy cannot
  // undo. Code from before per-drive names — anything before the commit
  // that added the index above — inserts with ON CONFLICT (name), which
  // fails without this key (42P10: every folder create), and renames rows
  // by name alone (every scope's folder of that name). To go back that far,
  // put the key back first; it takes one row per name, so the library's is
  // kept where there is one, else the oldest, and the others are deleted:
  //   BEGIN;
  //   DELETE FROM folders f USING folders g
  //    WHERE f.name = g.name AND f.ctid <> g.ctid
  //      AND (COALESCE(f.filespace, '') <> '', f.created_at, f.ctid)
  //        > (COALESCE(g.filespace, '') <> '', g.created_at, g.ctid);
  //   ALTER TABLE folders ADD CONSTRAINT folders_pkey PRIMARY KEY (name);
  //   COMMIT;
  // Code from the commit that added the index on needs none of this: it is
  // right with the key or without it.
  await sql`ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_pkey`;
  // The key made the name NOT NULL. Kept so whatever the server version does
  // with a dropped key's columns; a no-op where it is already so.
  await sql`ALTER TABLE folders ALTER COLUMN name SET NOT NULL`;
  // A folder's tags and metadata, which the files inside it inherit as far
  // as collections are concerned (lib/collections.js). The same shapes as a
  // file's: tags a lower-case list, metadata the workspace's fields.
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE folders ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
});

/** The rows of one scope: a drive's prefix, or '' for the library (whose rows may read NULL). */
const inScope = (tag) => sql`COALESCE(filespace, '') = ${String(tag || '')}`;

function _folderParent(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
function _folderDepth(path) {
  return path === '' ? 0 : path.split('/').length;
}

/**
 * Persist a folder path AND every ancestor (so the tree is complete), in one
 * scope: `filespace` is the drive's prefix, '' for the library.
 * → { name, created, existed }: `created` when this call made the folder,
 * `existed` when its scope already had it. Neither means another scope has
 * the name and the old primary key on the name alone still stands (see
 * ensureFoldersTable): until it goes, the name is not this scope's to use.
 */
export async function createFolder(name, { createdBy, filespace } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFoldersTable();
  const clean = String(name || '').replace(/^\/+|\/+$/g, '').trim();
  if (!clean) throw new Error('Folder name required.');
  const tag = String(filespace || '');
  const now = Date.now();
  let created = false;
  let path = '';
  for (const seg of clean.split('/')) {
    path = path ? `${path}/${seg}` : seg;
    // No conflict target: this scope's row, or the old key on the name
    // alone while it stands — either way, not inserted.
    const rows = await sql`INSERT INTO folders (name, parent, depth, created_by, filespace, created_at)
      VALUES (${path}, ${_folderParent(path)}, ${_folderDepth(path)}, ${createdBy || null}, ${tag}, ${now})
      ON CONFLICT DO NOTHING
      RETURNING name`;
    if (path === clean) created = rows.length > 0;
  }
  if (created) return { name: clean, created: true, existed: false };
  const here = await sql`SELECT 1 AS one FROM folders WHERE ${inScope(tag)} AND name = ${clean}`;
  return { name: clean, created: false, existed: here.length > 0 };
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
  // The preview keys too: a folder deleted with the trash off takes its
  // files' previews with it (lib/preview-gc.js).
  const rows = await sql`
    SELECT id, name, folder, storage, storage_key, thumbnail_key, poster_key, filmstrip_key FROM files
    WHERE deleted_at IS NULL AND (folder = ${a} OR folder LIKE ${escapeLike(a) + '/%'})`;
  return rows.map((r) => ({
    id: r.id, name: r.name, folder: r.folder || '', storage: r.storage, storageKey: r.storage_key,
    thumbnailKey: r.thumbnail_key || null, posterKey: r.poster_key || null, filmstripKey: r.filmstrip_key || null,
  }));
}

// Any character outside ASCII, as a regular expression Postgres reads: a
// path with none has one spelling only, and is never looked up.
const NON_ASCII_RE = '[^\u0001-\u007f]';

/**
 * The stored folder paths in a scope that are not plain ASCII — the only
 * ones that can be spelled more than one way (composed or decomposed) — for
 * respellPath: a drive's (`prefix`: its files; `tag`: its folder rows), or
 * the library's (its rows, and files anywhere, as its view lists them).
 */
export async function folderSpellings({ tag = '', prefix = null } = {}) {
  if (!sql) return [];
  await ensureFoldersTable();
  await ensureFilesTable();
  const within = prefix ? `${String(prefix).replace(/^\/+|\/+$/g, '')}/` : null;
  const rows = await sql`
    SELECT DISTINCT folder AS p FROM files
     WHERE deleted_at IS NULL AND folder ~ ${NON_ASCII_RE}
       AND (${within}::text IS NULL OR starts_with(coalesce(storage_key, ''), ${within}::text))
    UNION
    SELECT name AS p FROM folders WHERE ${inScope(tag)} AND name ~ ${NON_ASCII_RE}
    LIMIT 5000`;
  return rows.map((r) => r.p).filter(Boolean);
}

/**
 * A folder path as it is to be written or looked up in a scope: cleaned,
 * composed (NFC), then spelled as a folder already there spells it
 * (respellPath) — so "Café" typed, sent by a Mac or by a browser reaches the
 * one "Café" there is, whichever way its name was stored.
 */
export async function canonicalFolder(path, { tag = '', prefix = null } = {}) {
  const clean = nfc(cleanFolderPath(path));
  if (!clean || isAscii(clean)) return clean;
  try {
    return respellPath(clean, await folderSpellings({ tag: normPrefix(tag), prefix: prefix ? normPrefix(prefix) : null }));
  } catch (e) {
    console.warn('[canonicalFolder] spellings unread:', e.message);
    return clean;
  }
}

/**
 * Does anything live at `path` in this scope — a folder row, or a live file
 * in it or beneath it? A rename refuses to land on one: merging two trees
 * silently is how files end up somewhere nobody asked for.
 *
 * In the scope as its own view shows it: a drive (`prefix`) holds its own
 * rows and the files stored under its prefix; the library (no prefix) its
 * own rows and every file at the path, since the library's view lists files
 * from everywhere. Another drive's "Selects" is no obstacle to this one's.
 */
export async function folderPathInUse(path, { tag = '', prefix = null } = {}) {
  if (!sql) return false;
  await ensureFoldersTable();
  await ensureFilesTable();
  const pat = escapeLike(path) + '/%';
  const within = prefix ? `${String(prefix).replace(/^\/+|\/+$/g, '')}/` : null;
  const rows = await sql`
    SELECT
      EXISTS (SELECT 1 FROM folders WHERE ${inScope(tag)} AND (name = ${path} OR name LIKE ${pat})) AS dir,
      EXISTS (SELECT 1 FROM files WHERE deleted_at IS NULL
        AND (folder = ${path} OR folder LIKE ${pat})
        AND (${within}::text IS NULL OR starts_with(coalesce(storage_key, ''), ${within}::text))) AS file`;
  return Boolean(rows[0]?.dir || rows[0]?.file);
}

/**
 * Folder grants that would follow a rename from `from` to `to` (renameFolder
 * says when they do), but cannot, because they would reach past this scope:
 * grants are keyed by the path alone (folder_access), so a grant at `to`
 * covers every scope's `to` — another scope's folder rows there, or files
 * there this scope does not hold. False when there are none to follow.
 * `outside` counts the files another scope keeps at `from` (planRename).
 * Asked after folderPathInUse(to) has said no, when any file still at `to`
 * is another scope's.
 */
export async function renameSpreadsGrants(from, to, { tag = '', outside = 0 } = {}) {
  if (!sql) return false;
  // A drive's path another scope also uses: its grants are not the drive's
  // to take along, and stay where they are (renameFolder).
  if (tag && outside > 0) return false;
  await ensureFoldersTable();
  await ensureFolderAclTable();
  await ensureFilesTable();
  const a = String(from || '');
  const b = String(to || '');
  const [r] = await sql`
    SELECT
      EXISTS (SELECT 1 FROM folder_access WHERE folder = ${a} OR folder LIKE ${escapeLike(a) + '/%'}) AS granted,
      EXISTS (SELECT 1 FROM folders WHERE NOT ${inScope(tag)} AND (name = ${a} OR name LIKE ${escapeLike(a) + '/%'})) AS shared,
      EXISTS (SELECT 1 FROM folders WHERE NOT ${inScope(tag)} AND (name = ${b} OR name LIKE ${escapeLike(b) + '/%'})) AS dirs,
      EXISTS (SELECT 1 FROM files WHERE deleted_at IS NULL AND (folder = ${b} OR folder LIKE ${escapeLike(b) + '/%'})) AS files`;
  if (tag && r?.shared) return false;
  return Boolean(r?.granted && (r.dirs || r.files));
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
 * `tag` is the scope's folders.filespace value ('' for the unscoped library),
 * and only its rows move: another scope's folder of the same name stays
 * where it is.
 *
 * Folder grants are keyed by the path alone, so they are every scope's at
 * once, and follow the rename only as far as that stays inside this scope.
 * Never to a path another scope uses: they would reach its folder there. In
 * a drive, only from a path that is the drive's alone — no other scope's
 * rows at it, no other scope's files (`moveGrants` is false when files of
 * another scope stay behind) — and then moved, copy and removal together:
 * a grant on a path the library or another drive also uses is not the
 * drive's to take along, and its editors need hold none. In the library,
 * whose folders take a grant to restructure, as before: copied, and removed
 * from the old path unless another scope still uses it.
 *
 * Links to the folder, or to folders inside it, are this scope's alone
 * (file_shares.storage_prefix), so they always follow, in the same
 * statement: a link keeps opening onto the folder it was made for.
 */
export async function renameFolder(from, to, { tag = '', moves = [], catalog = [], moveGrants = true, createdBy = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFoldersTable();
  await ensureFolderAclTable();
  await ensureFilesTable();
  await ensureSharesTable();
  const a = String(from || '');
  const b = String(to || '');
  if (!a || !b || a === b) return { ok: false };
  if (b.startsWith(a + '/')) throw new Error('Cannot move a folder into itself.');
  const pat = escapeLike(a) + '/%';
  const bpat = escapeLike(b) + '/%';
  const now = Date.now();

  const rows = [...moves, ...catalog];
  const ids = rows.map((r) => r.id);
  const folders = rows.map((r) => r.folder);
  const keys = rows.map((r) => r.toKey || null);

  const dirs = await sql`SELECT name FROM folders WHERE (name = ${a} OR name LIKE ${pat}) AND ${inScope(tag)}`;
  const oldNames = dirs.map((d) => d.name);
  const newNames = oldNames.map((n) => rebase(n, a, b));
  // The destination's ancestors, so a move into a folder that so far exists
  // only because files are in it leaves a complete tree behind.
  const anc = [];
  for (let p = _folderParent(b); p; p = _folderParent(p)) anc.push(p);
  if (!oldNames.includes(a)) anc.unshift(b);

  // The objects moved, so their transcripts follow (before the rows change:
  // the old keys are read from them).
  await followTranscriptKeys(moves.map((m) => ({ id: m.id, toKey: m.toKey })));
  const [r] = await sql`
    WITH elsewhere AS (
      -- As the statement finds them, before anything below moves: whether
      -- another scope uses the new path (a folder row, or files there) or
      -- still uses the old one (a folder row of its own).
      SELECT
        (EXISTS (SELECT 1 FROM folders WHERE NOT ${inScope(tag)} AND (name = ${b} OR name LIKE ${bpat}))
          OR EXISTS (SELECT 1 FROM files WHERE deleted_at IS NULL AND (folder = ${b} OR folder LIKE ${bpat}))) AS to_used,
        EXISTS (SELECT 1 FROM folders WHERE NOT ${inScope(tag)} AND (name = ${a} OR name LIKE ${pat})) AS from_used
    ), moved AS (
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
      WHERE d.name = m.old AND COALESCE(d.filespace, '') = ${tag}
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
      FROM folder_access, elsewhere
      WHERE NOT elsewhere.to_used
        AND (${!tag} OR (${moveGrants} AND NOT elsewhere.from_used))
        AND (folder = ${a} OR folder LIKE ${pat})
      ON CONFLICT DO NOTHING
      RETURNING folder
    ), dropped AS (
      -- Removed only once they have followed, and only from a path no other
      -- scope still uses.
      DELETE FROM folder_access USING elsewhere
      WHERE ${moveGrants} AND NOT elsewhere.to_used AND NOT elsewhere.from_used
        AND (folder = ${a} OR folder LIKE ${pat})
      RETURNING folder
    ), links AS (
      -- This scope's links to the folder, or to a folder inside it, follow
      -- it — unlike grants, a link is one scope's alone, so always. Left at
      -- the old name, a link would open onto whatever is next put there.
      UPDATE file_shares s SET folder = ${b}::text || substr(s.folder, char_length(${a}::text) + 1)
      WHERE s.kind = 'folder' AND s.storage_prefix IS NOT DISTINCT FROM ${folderLinkScopeValue(tag)}::text
        AND (s.folder = ${a} OR starts_with(s.folder, ${`${a}/`}::text))
      RETURNING s.token
    )
    SELECT (SELECT count(*) FROM moved)::int AS files, (SELECT count(*) FROM dirs)::int AS folders,
           (SELECT count(*) FROM links)::int AS links`;
  return { ok: true, from: a, to: b, files: r?.files || 0, folders: r?.folders || 0, links: r?.links || 0 };
}

// ─────────────────────────────────────────────────────────────────────────
// A folder rename's copies, while it is under way
//
// A rename copies every object to its new key before the catalog moves
// (PATCH /api/files/folders), so a call that stops part-way — cut off by
// the time limit, or answering 202 to come back for the rest — leaves copies
// at keys nothing in the catalog points to. The next call has to tell those
// from anything else found there, which it may not overwrite. So each copy
// is noted here before it is made, with the key it copies, and forgotten
// once the rename is done or undone.
//
//   folder_move_copies — a new key, the key it is a copy of, and when
// ─────────────────────────────────────────────────────────────────────────
const ensureFolderMoveCopiesTable = lazySchema('ensureFolderMoveCopiesTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS folder_move_copies (
      to_key   TEXT PRIMARY KEY,
      from_key TEXT NOT NULL,
      noted_at BIGINT NOT NULL
    )
  `;
});

/** Note that each of `moves` ({ fromKey, toKey }) is about to be copied. */
export async function noteFolderMoveCopies(moves = []) {
  const list = moves.filter((m) => m?.fromKey && m?.toKey);
  if (!sql || !list.length) return;
  await ensureFolderMoveCopiesTable();
  const now = Date.now();
  await withSchemaRetry(ensureFolderMoveCopiesTable, () => sql`
    INSERT INTO folder_move_copies (to_key, from_key, noted_at)
    SELECT t, f, ${now} FROM unnest(${list.map((m) => String(m.toKey))}::text[], ${list.map((m) => String(m.fromKey))}::text[]) AS c(t, f)
    ON CONFLICT (to_key) DO UPDATE SET from_key = EXCLUDED.from_key, noted_at = EXCLUDED.noted_at`);
}

/** What each of `toKeys` was noted as a copy of: Map toKey → fromKey. */
export async function folderMoveCopiesAt(toKeys = []) {
  const list = [...new Set(toKeys.filter(Boolean).map(String))];
  if (!sql || !list.length) return new Map();
  await ensureFolderMoveCopiesTable();
  const rows = await withSchemaRetry(ensureFolderMoveCopiesTable, () => sql`
    SELECT to_key, from_key FROM folder_move_copies WHERE to_key = ANY(${list}::text[])`);
  return new Map(rows.map((r) => [r.to_key, r.from_key]));
}

/** Forget `toKeys`: their rename is done, or undone. */
export async function forgetFolderMoveCopies(toKeys = []) {
  const list = [...new Set(toKeys.filter(Boolean).map(String))];
  if (!sql || !list.length) return;
  await ensureFolderMoveCopiesTable();
  await withSchemaRetry(ensureFolderMoveCopiesTable, () => sql`
    DELETE FROM folder_move_copies WHERE to_key = ANY(${list}::text[])`);
}

/** This scope's folder rows strictly beneath `name` (empty subfolders included). */
export async function listFolderRowsUnder(name, { tag = '' } = {}) {
  if (!sql) return [];
  await ensureFoldersTable();
  const rows = await sql`SELECT name FROM folders WHERE name LIKE ${escapeLike(name) + '/%'} AND ${inScope(tag)}`;
  return rows.map((r) => r.name);
}

/**
 * Drop this scope's folder rows at and beneath `name`, after a delete has
 * trashed the files. Grants, keyed by the path alone, go too — unless
 * anything is still there in any scope: live files (another scope's, or
 * ones that could not be trashed) or another scope's folder of that name.
 *
 * And this scope's links to the folder and to folders inside it, always: a
 * link is to the folder that was deleted, and left in place it would open
 * onto whatever is next made at that name. Restoring the files from the
 * trash does not bring a link back; it can be made again.
 */
export async function deleteFolderRows(name, { tag = '' } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFoldersTable();
  await ensureFolderAclTable();
  await ensureFilesTable();
  await ensureSharesTable();
  const a = String(name || '');
  if (!a) return { ok: false };
  const pat = escapeLike(a) + '/%';
  await sql`DELETE FROM folders WHERE (name = ${a} OR name LIKE ${pat}) AND ${inScope(tag)}`;
  await withSchemaRetry(ensureSharesTable, () => sql`
    DELETE FROM file_shares
    WHERE kind = 'folder' AND storage_prefix IS NOT DISTINCT FROM ${folderLinkScopeValue(tag)}::text
      AND (folder = ${a} OR starts_with(folder, ${`${a}/`}::text))`);
  const [left] = await sql`
    SELECT
      (SELECT count(*)::int FROM files WHERE deleted_at IS NULL AND (folder = ${a} OR folder LIKE ${pat})) AS n,
      EXISTS (SELECT 1 FROM folders WHERE name = ${a} OR name LIKE ${pat}) AS dirs`;
  if (!left?.n && !left?.dirs) await sql`DELETE FROM folder_access WHERE folder = ${a} OR folder LIKE ${pat}`;
  return { ok: true, remaining: left?.n || 0 };
}

/**
 * The tags and metadata a scope's folders carry themselves — `tag` is the
 * scope (folders.filespace: a drive's prefix, '' for the library). A Map of
 * folder path → { tags, metadata }, only for folders with something on them.
 */
export async function listFolderMeta(tag = '') {
  if (!sql) return new Map();
  await ensureFoldersTable();
  const rows = await withSchemaRetry(ensureFoldersTable, () => sql`
    SELECT name, tags, metadata FROM folders
    WHERE ${inScope(tag)} AND (tags <> '[]'::jsonb OR metadata <> '{}'::jsonb)`);
  const out = new Map();
  for (const r of rows) {
    const tags = Array.isArray(r.tags) ? r.tags : [];
    const metadata = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    out.set(r.name, { ...(tags.length ? { tags } : {}), ...(Object.keys(metadata).length ? { metadata } : {}) });
  }
  return out;
}

/**
 * Set a folder's own tags (the whole list) and metadata (merged: a key sent
 * as null is cleared, as a file's is) in scope `tag`. A folder that so far
 * exists only because files are in it gets its row here, ancestors included,
 * as creating it would. `tags` and `metadata` arrive checked
 * (validateMetadataPatch); undefined leaves that half as it is.
 * Resolves { tags, metadata }.
 */
export async function setFolderMeta(name, { tag = '', tags, metadata, createdBy = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  const path = String(name || '');
  if (!path) throw new Error('A folder is needed.');
  await ensureFoldersTable();
  const now = Date.now();
  const paths = [];
  for (let p = path; p; p = _folderParent(p)) paths.push(p);
  await sql`
    INSERT INTO folders (name, parent, depth, created_by, filespace, created_at)
    SELECT p,
      CASE WHEN position('/' in p) = 0 THEN '' ELSE regexp_replace(p, '/[^/]*$', '') END,
      array_length(string_to_array(p, '/'), 1), ${createdBy}, ${String(tag || '')}, ${now}
    FROM unnest(${paths}::text[]) AS p
    ON CONFLICT DO NOTHING`;
  // sql.json, not a string cast to jsonb: the driver would encode the string
  // again, and store a JSON string where a list belongs.
  const t = tags === undefined ? null : sql.json([...new Set(tags.map((x) => String(x).trim().toLowerCase()).filter(Boolean))]);
  const m = metadata === undefined ? null : sql.json(metadata);
  const rows = await sql`
    UPDATE folders SET
      tags = COALESCE(${t}, tags),
      metadata = CASE WHEN ${m}::jsonb IS NULL THEN metadata ELSE jsonb_strip_nulls(metadata || ${m}) END
    WHERE name = ${path} AND ${inScope(tag)}
    RETURNING tags, metadata`;
  const r = rows[0] || {};
  return { tags: Array.isArray(r.tags) ? r.tags : [], metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {} };
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
    const rows = await sql`SELECT name FROM folders WHERE ${inScope(filespace)} ORDER BY name ASC`;
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
  // What a public or password link's recipients may do besides view: NULL,
  // 'comment' or 'approve' (SHARE_REVIEW in lib/share-kinds.js). NULL for
  // every link made before, which is what they were.
  await sql`ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS review TEXT`;
});

export async function createShare({ fileId, createdBy, mode = 'public', expiresInDays, password, review = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureSharesTable();
  if (!fileId) throw new Error('fileId required.');
  const m = mode === 'private' ? 'private' : 'public';
  // A private link never carries a password: access there is the session and
  // the file's own ACL, so a password would only be a second, weaker lock.
  const pw = m === 'public' && password ? String(password) : null;
  // Nor comments: it opens only for members, who comment on the file itself.
  const rv = m === 'public' && (review === 'comment' || review === 'approve') ? review : null;
  const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
  // Reuse only a link that is exactly this one: plain, unexpiring, same mode,
  // same review. Reusing on (file, mode) alone handed back the existing
  // public link when a PASSWORD-protected one was asked for — the password
  // was silently dropped — and would hand back a view-only link for one that
  // takes comments.
  if (!pw && !expiresAt) {
    const existing = await withSchemaRetry(ensureSharesTable, () => sql`
      SELECT token FROM file_shares
      WHERE file_id = ${fileId} AND mode = ${m} AND password_hash IS NULL AND expires_at IS NULL
        AND review IS NOT DISTINCT FROM ${rv}
      ORDER BY created_at ASC LIMIT 1`);
    if (existing[0]) return { token: existing[0].token, mode: m, review: rv, reused: true };
  }
  const token = newShareToken();
  const passwordHash = pw ? await hashSharePassword(pw) : null;
  await withSchemaRetry(ensureSharesTable, () => sql`
    INSERT INTO file_shares (token, file_id, created_by, created_at, mode, expires_at, password_hash, review)
    VALUES (${token}, ${fileId}, ${createdBy || null}, ${Date.now()}, ${m}, ${expiresAt}, ${passwordHash}, ${rv})`);
  return { token, mode: m, review: rv, reused: false };
}

/**
 * Change what a link's recipients may do (review: null, 'comment' or
 * 'approve'). The route has decided the caller may; a private link is never
 * given one. Returns the stored level, or undefined when there is no such
 * file link.
 */
export async function setShareReview(token, review) {
  if (!sql || !token) return undefined;
  await ensureSharesTable();
  const rv = review === 'comment' || review === 'approve' ? review : null;
  const rows = await withSchemaRetry(ensureSharesTable, () => sql`
    UPDATE file_shares SET review = ${rv}
    WHERE token = ${token} AND kind = 'file' AND (${rv}::text IS NULL OR mode <> 'private')
    RETURNING review`);
  return rows[0] ? rows[0].review || null : undefined;
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

/**
 * A folder link's scope as file_shares stores it: a drive's prefix (the
 * folders.filespace tag of the drive the folder is in), or NULL for the
 * library. The rows of one scope are never another's: a link to the
 * library's "Selects" is not one to a drive's.
 */
const folderLinkScopeValue = (tag) => (tag ? cleanFolderPath(tag) || null : null);

/**
 * Make (or reuse) a link to a whole folder in one scope — `storagePrefix` the
 * drive's prefix, or null for the library — public, or with a password. What
 * it reaches is decided live, on every request (lib/folder-links.js); this
 * only records which folder, in which scope, and how it opens. The route has
 * decided the caller may.
 *
 * Never a private link: one that opens only for people who can already open
 * the folder grants nothing, so it is refused rather than quietly made
 * public. Reused only when it is exactly this link — plain, unexpiring, no
 * password — as createShare does, so a password is never dropped by handing
 * back an open link that already exists; and only one this person made: a
 * folder link speaks for its maker while they may still share the folder
 * (lib/share-access.js), so someone else's is not theirs to be handed.
 * Tokens are newShareToken's 128 bits, like a file link's; this once made a
 * 12-hex (48-bit) one.
 */
export async function createFolderShare({ folder, storagePrefix = null, createdBy, mode = 'public', expiresInDays, password } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureSharesTable();
  const path = cleanFolderPath(folder);
  if (!path) throw new Error('A folder link needs a folder.');
  if (mode === 'private') throw new Error('A folder link is public or password-protected.');
  const sp = folderLinkScopeValue(storagePrefix);
  const pw = password ? String(password) : null;
  const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
  const maker = normEmail(createdBy) || null;
  if (!pw && !expiresAt && maker) {
    const existing = await withSchemaRetry(ensureSharesTable, () => sql`
      SELECT token FROM file_shares
      WHERE kind = 'folder' AND folder = ${path} AND storage_prefix IS NOT DISTINCT FROM ${sp}::text
        AND mode = 'public' AND password_hash IS NULL AND expires_at IS NULL
        AND lower(created_by) = ${maker}
      ORDER BY created_at ASC LIMIT 1`);
    if (existing[0]) return { token: existing[0].token, mode: 'public', reused: true };
  }
  const token = newShareToken();
  const passwordHash = pw ? await hashSharePassword(pw) : null;
  await withSchemaRetry(ensureSharesTable, () => sql`
    INSERT INTO file_shares (token, file_id, kind, folder, storage_prefix, created_by, created_at, mode, expires_at, password_hash, review)
    VALUES (${token}, ${null}, 'folder', ${path}, ${sp}, ${createdBy || null}, ${Date.now()}, 'public', ${expiresAt}, ${passwordHash}, ${null})`);
  return { token, mode: 'public', reused: false };
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

/**
 * The links to one folder in one scope (as createFolderShare takes it),
 * newest first, as listSharesForFile shapes a file's — never the password or
 * its hash. Only links to the folder itself: a link to a folder above it
 * reaches it too, and is listed on that folder.
 */
export async function listSharesForFolder(folder, storagePrefix = null) {
  if (!sql) return [];
  await ensureSharesTable();
  const path = cleanFolderPath(folder);
  if (!path) return [];
  const sp = folderLinkScopeValue(storagePrefix);
  try {
    const rows = await withSchemaRetry(ensureSharesTable, () => sql`
      SELECT token, mode, expires_at, view_count, created_at, created_by, (password_hash IS NOT NULL) AS has_password
      FROM file_shares
      WHERE kind = 'folder' AND folder = ${path} AND storage_prefix IS NOT DISTINCT FROM ${sp}::text
      ORDER BY created_at DESC`);
    return rows.map((r) => ({
      token: r.token, mode: r.mode || 'public', expiresAt: numOrNull(r.expires_at), viewCount: Number(r.view_count) || 0,
      hasPassword: !!r.has_password, createdAt: Number(r.created_at) || null, createdBy: r.created_by || null, review: null,
    }));
  } catch { return []; }
}

// ── What a folder link reaches ────────────────────────────────────────────
// The queries are lib/folder-links.js's, which holds the rule; these run
// them. `scope` is always the one lib/folder-links.js folderLinkScope made
// from the link's own row (lib/share-access.js), never anything a request
// said. Unlike the library's listing, a failure is not swallowed into an
// empty page: a guest shown "this folder is empty" because the database was
// slow would be told something untrue, so the caller says "try again".

/** One page of the files directly in `at`, and the cursor after it (null at the end). */
export async function listFolderLinkFiles(scope, { at, cursor = null, limit } = {}) {
  if (!sql) return { files: [], cursor: null };
  await ensureFilesTable();
  const q = buildLinkFilesQuery({ scope, at, cursor, limit });
  const rows = await withSchemaRetry(ensureFilesTable, () => sql.unsafe(q.text, q.params));
  const last = rows.length === q.limit ? rows[rows.length - 1] : null;
  return { files: rows.map(shapeFile), cursor: last ? { value: last.name, id: last.id } : null };
}

/** How many files are directly in `at`. */
export async function countFolderLinkFiles(scope, { at } = {}) {
  if (!sql) return 0;
  await ensureFilesTable();
  const q = buildLinkCountQuery({ scope, at });
  const rows = await withSchemaRetry(ensureFilesTable, () => sql.unsafe(q.text, q.params));
  return Number(rows[0]?.n) || 0;
}

/** The folders directly inside `at` that hold something the link reaches: [{ name, count }]. */
export async function listFolderLinkFolders(scope, { at } = {}) {
  if (!sql) return [];
  await ensureFilesTable();
  const q = buildLinkFoldersQuery({ scope, at });
  const rows = await withSchemaRetry(ensureFilesTable, () => sql.unsafe(q.text, q.params));
  return rows.map((r) => ({ name: r.name, count: Number(r.n) || 0 }));
}

/** One file by id if the link reaches it, else null. */
export async function getFolderLinkFile(scope, id) {
  if (!sql || !id) return null;
  await ensureFilesTable();
  const q = buildLinkFileQuery({ scope, id });
  const rows = await withSchemaRetry(ensureFilesTable, () => sql.unsafe(q.text, q.params));
  return rows[0] ? shapeFile(rows[0]) : null;
}

/**
 * Whether the link's folder is still there: a file it reaches, or the
 * folder's own row in its scope (an empty folder is still a folder). No to
 * both is a folder that was emptied and removed after the link was made.
 */
export async function folderLinkRootExists(scope) {
  if (!sql) return false;
  await ensureFilesTable();
  await ensureFoldersTable();
  const q = buildLinkAnyQuery({ scope });
  const [files] = await withSchemaRetry(ensureFilesTable, () => sql.unsafe(q.text, q.params));
  if (files?.any) return true;
  const dir = await sql`SELECT 1 AS one FROM folders WHERE ${inScope(scope.tag)} AND name = ${scope.root} LIMIT 1`;
  return dir.length > 0;
}

export async function listSharesForFile(fileId) {
  if (!sql || !fileId) return [];
  await ensureSharesTable();
  try {
    const rows = await withSchemaRetry(ensureSharesTable, () => sql`SELECT token, mode, expires_at, view_count, created_at, created_by, review, (password_hash IS NOT NULL) AS has_password FROM file_shares WHERE file_id = ${fileId} ORDER BY created_at DESC`);
    return rows.map((r) => ({ token: r.token, mode: r.mode || 'public', expiresAt: r.expires_at != null ? Number(r.expires_at) : null, viewCount: Number(r.view_count) || 0, hasPassword: !!r.has_password, createdAt: Number(r.created_at) || null, createdBy: r.created_by || null, review: r.review || null }));
  } catch { return []; }
}

/**
 * What a token points at, with no side effects.
 *
 * The public page resolves a link through lib/share-access.js, which checks
 * passwords and expiry and counts the view. Authorizing a revoke needs none
 * of that and must not do any of it — counting a view because someone
 * deleted a link would be nonsense.
 */
export async function getShareTarget(token) {
  if (!sql || !token) return null;
  await ensureSharesTable();
  try {
    const rows = await withSchemaRetry(ensureSharesTable, () => sql`
      SELECT token, kind, file_id, folder, storage_prefix, created_by, mode, expires_at, review,
             (password_hash IS NOT NULL) AS has_password
      FROM file_shares WHERE token = ${token} LIMIT 1`);
    const r = rows[0];
    if (!r) return null;
    return {
      token: r.token,
      kind: r.kind || 'file',
      fileId: r.file_id || null,
      folder: r.folder || null,
      storagePrefix: r.storage_prefix || null,
      createdBy: r.created_by || null,
      mode: r.mode || 'public',
      hasPassword: !!r.has_password,
      expiresAt: numOrNull(r.expires_at),
      review: r.review || null,
    };
  } catch { return null; }
}

/**
 * Every link, for Admin → Shared links: the file — or, for a link to a
 * folder, the folder and its drive — the kind, who made it and whether they
 * are still here (suspended, or removed altogether — a link whose creator
 * has no people or invite row is orphaned). Live links only unless
 * `includeExpired`.
 *
 *   kind       public | password | private
 *   creator    an email
 *   expiringWithinMs  only links that expire within this long
 *   orphaned   only links whose creator is gone
 */
export async function listAllShares({ kind = null, creator = null, expiringWithinMs = null, orphaned = false, includeExpired = false, offset = 0, limit = 100 } = {}) {
  if (!sql) return { rows: [], total: 0 };
  await Promise.all([ensureSharesTable(), ensureFilesTable(), ensurePeopleTable(), ensureInviteRequestsTable(), ensureFilespacesTables()]);
  const now = Date.now();
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const off = Math.max(0, Number(offset) || 0);
  const who = creator ? String(creator).trim().toLowerCase() : null;
  const until = expiringWithinMs != null ? now + Number(expiringWithinMs) : null;
  const rows = await withSchemaRetry([ensureSharesTable, ensurePeopleTable, ensureFilespacesTables], () => sql`
    SELECT s.token, s.file_id, s.kind AS target, s.mode, (s.password_hash IS NOT NULL) AS has_password,
           s.created_by, s.created_at, s.expires_at, s.view_count, s.review,
           s.folder, s.storage_prefix,
           (SELECT d.name FROM filespaces d WHERE s.kind = 'folder' AND d.prefix = s.storage_prefix
             ORDER BY lower(d.name), d.id LIMIT 1) AS drive_name,
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
      ...(r.target === 'folder' ? { folder: r.folder || null, driveName: r.drive_name || null, library: !r.storage_prefix } : {}),
      kind: (r.mode || 'public') === 'private' ? 'private' : r.has_password ? 'password' : 'public',
      // What its recipients may do besides view: 'comment' or 'approve'.
      review: r.review || null,
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
    DELETE FROM file_shares WHERE token = ANY(${list}::text[]) RETURNING token, file_id, created_by, review`);
  return rows.map((r) => ({ token: r.token, fileId: r.file_id || null, createdBy: r.created_by || null, review: r.review || null }));
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
  // What a review link's guests wrote lately, for the brake on how fast one
  // link can take comments (lib/share-review.js).
  await sql`CREATE INDEX IF NOT EXISTS review_comments_share_idx ON review_comments (share_token, created_at) WHERE share_token IS NOT NULL`;
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
  // A guest's name, as they gave it when they decided. A member's is looked
  // up when the feed is read (displayNamesFor); a guest has nowhere else it
  // is kept.
  await sql`ALTER TABLE review_decisions ADD COLUMN IF NOT EXISTS reviewer_name TEXT`;
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
    // A guest (someone a review link reached) has an id and the name they
    // gave, never an address. The id is harmless to hand out: what makes a
    // comment a guest's own is a cookie signed for it (lib/shares.js).
    author: { email: r.author_email || null, name: r.author_name || null, guest: !!r.guest_id, guestId: r.guest_id || null },
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
    // A guest's name is kept with their decision; a member's is looked up
    // by whoever reads the feed.
    name: r.reviewer_name || null,
    guest: reviewer.startsWith('guest:'),
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
 * `shareToken` is the feed for a review link's guests: never an internal
 * comment (a reply to an internal thread is internal itself, and its thread
 * is checked too); never a comment written through another link, nor
 * anything in a thread another link's guests started; and only this link's
 * guests' decisions. Each link is its own conversation with the team
 * (visibleToLink in lib/review.js is the same rule for one row). Signed-in
 * readers get everything.
 */
export async function listReviewFeed(fileId, { after = 0, limit = REVIEW_FEED_LIMIT, shareToken = null } = {}) {
  if (!sql) return { comments: [], decisions: [], cursor: 0, more: false };
  await ensureReviewTables();
  const from = Math.max(0, Math.floor(Number(after) || 0));
  const n = Math.min(Math.max(1, Math.floor(Number(limit) || REVIEW_FEED_LIMIT)), REVIEW_FEED_LIMIT);
  return withReviewSchema(async () => {
    const comments = shareToken
      ? await sql`
          SELECT c.* FROM review_comments c
          LEFT JOIN review_comments p ON p.id = c.parent_id
          WHERE c.file_id = ${fileId} AND c.seq > ${from} AND c.audience = 'all'
            AND (c.share_token IS NULL OR c.share_token = ${shareToken})
            AND (p.id IS NULL OR (p.audience = 'all' AND (p.share_token IS NULL OR p.share_token = ${shareToken})))
          ORDER BY c.seq ASC LIMIT ${n}`
      : await sql`SELECT * FROM review_comments WHERE file_id = ${fileId} AND seq > ${from} ORDER BY seq ASC LIMIT ${n}`;
    const decisions = shareToken
      ? await sql`SELECT * FROM review_decisions WHERE file_id = ${fileId} AND seq > ${from} AND share_token = ${shareToken} ORDER BY seq ASC`
      : await sql`SELECT * FROM review_decisions WHERE file_id = ${fileId} AND seq > ${from} ORDER BY seq ASC`;
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
  // A live link that takes comments means the file has been sent for review.
  // A database with no file_shares table, or no review column yet, has none.
  let links = 0;
  try {
    const [l] = await sql`
      SELECT count(*)::int AS n FROM file_shares
      WHERE file_id = ${fileId} AND kind = 'file' AND review IS NOT NULL AND mode <> 'private'
        AND (expires_at IS NULL OR expires_at > ${Date.now()})`;
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
 * One comment for a review link's route: { comment, audience, shareToken,
 * root } or null — the comment shaped, and what decides whether a link's
 * guests may see it (visibleToLink in lib/review.js): its audience, the link
 * it was written through, and its thread's top's (`root`, null for a top).
 * The tokens never leave the server: a token is a link.
 */
export async function getReviewCommentForLink(id) {
  if (!sql || !id) return null;
  await ensureReviewTables();
  const rows = await withReviewSchema(() => sql`
    SELECT c.*, p.id AS root_id, p.audience AS root_audience, p.share_token AS root_share_token
    FROM review_comments c LEFT JOIN review_comments p ON p.id = c.parent_id
    WHERE c.id = ${id} LIMIT 1`);
  const r = rows[0];
  if (!r) return null;
  return {
    comment: shapeReviewComment(r),
    audience: r.audience || 'all',
    shareToken: r.share_token || null,
    root: r.root_id ? { audience: r.root_audience || 'all', shareToken: r.root_share_token || null } : null,
  };
}

/**
 * Record a comment or reply. `value` is validateComment's output (lib/review.js);
 * the route has already decided the author may post it and resolved
 * `parentId` to the top of its thread. A member is `authorEmail`; a guest on
 * a review link is `guestId` and the name they gave, with the link's
 * `shareToken`, and no address.
 */
export async function createReviewComment({ fileId, authorEmail = null, authorName = null, guestId = null, shareToken = null, value }) {
  if (!sql) throw new Error('Database not configured');
  await ensureReviewTables();
  const v = value || {};
  const id = crypto.randomUUID();
  const now = Date.now();
  const rows = await withReviewSchema(() => sql`
    INSERT INTO review_comments (
      id, file_id, parent_id, author_email, guest_id, author_name, body, anchor,
      frame_in, frame_out, fps_num, fps_den, point_x, point_y,
      annotation, mentions, audience, share_token, created_at, updated_at
    ) VALUES (
      ${id}, ${fileId}, ${v.parentId || null},
      ${guestId ? null : String(authorEmail || '').toLowerCase() || null}, ${guestId || null}, ${authorName},
      ${v.body || ''}, ${v.anchor || 'general'},
      ${v.frameIn ?? null}, ${v.frameOut ?? null}, ${v.fps?.num ?? null}, ${v.fps?.den ?? null},
      ${v.pointX ?? null}, ${v.pointY ?? null},
      ${v.annotation ? sql.json(v.annotation) : null}, ${sql.json(guestId ? [] : v.mentions || [])},
      ${!guestId && v.audience === 'internal' ? 'internal' : 'all'}, ${shareToken || null}, ${now}, ${now}
    )
    RETURNING *`);
  return shapeReviewComment(rows[0]);
}

/**
 * How many comments a review link's guests have posted since `since` (ms),
 * all of them and `guestId`'s own — the brake on a link anyone may hold
 * (lib/share-review.js). One indexed range read.
 */
export async function countRecentLinkComments(shareToken, since, guestId = null) {
  if (!sql || !shareToken) return { link: 0, guest: 0 };
  await ensureReviewTables();
  const [r] = await withReviewSchema(() => sql`
    SELECT count(*)::int AS link, count(*) FILTER (WHERE guest_id = ${guestId})::int AS guest
    FROM review_comments WHERE share_token = ${shareToken} AND created_at > ${Number(since) || 0}`);
  return { link: r?.link || 0, guest: r?.guest || 0 };
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
 * links, 'guest:<id>' with the link's `shareToken` and the name the guest
 * gave (`reviewerName`). Null when there was nothing to withdraw.
 */
export async function setReviewDecision({ fileId, reviewer, status, note = null, shareToken = null, reviewerName = null }) {
  if (!sql) throw new Error('Database not configured');
  await ensureReviewTables();
  const now = Date.now();
  const rows = status
    ? await withReviewSchema(() => sql`
        INSERT INTO review_decisions (file_id, reviewer, status, note, share_token, reviewer_name, decided_at)
        VALUES (${fileId}, ${reviewer}, ${status}, ${note}, ${shareToken}, ${reviewerName}, ${now})
        ON CONFLICT (file_id, reviewer) DO UPDATE
          SET status = EXCLUDED.status, note = EXCLUDED.note, share_token = EXCLUDED.share_token,
              reviewer_name = EXCLUDED.reviewer_name,
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
 * active — let in by an approved invite, or an admin (who needs none) with an
 * account. A "user" row outlives the invite that let its owner in: a ban or a
 * removal leaves it behind, so on its own it names nobody. Who of these may
 * READ the file is not decided here — the route checks each against
 * canAccessFile, so a mention can never name, or reveal, someone outside the
 * file's audience.
 */
export async function listMentionCandidates({ q = '', limit = 200 } = {}) {
  if (!sql) return [];
  const term = String(q || '').trim().toLowerCase().slice(0, 100);
  const pattern = `%${escapeLike(term)}%`;
  const n = Math.min(Math.max(1, Number(limit) || 200), 500);
  let admin = () => false;
  try { ({ isAdmin: admin } = await import('./auth-allowlist.js')); } catch { /* no admins, then */ }
  try { await ensureInviteRequestsTable(); } catch { /* the queries below say so */ }
  const people = new Map();
  const take = (rows) => {
    for (const r of rows) {
      const e = String(r.email || '').toLowerCase();
      if (!e.includes('@')) continue;
      if (r.approved === false && !admin(e)) continue;
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
    // The sign-in provider's name for the people above, and the admins.
    take(await sql`
      SELECT u.email, u.name,
             EXISTS (SELECT 1 FROM invite_requests i WHERE i.email = lower(u.email) AND i.status = 'approved') AS approved
      FROM "user" u
      WHERE u.email IS NOT NULL AND (lower(u.email) LIKE ${pattern} OR lower(coalesce(u.name, '')) LIKE ${pattern})
      ORDER BY u.email LIMIT ${n}`);
  } catch { /* no users yet */ }
  // Not a suspended account: its rows outlive its access (people.status), and
  // a mention is a notification sent. Left out of the pool, not filtered
  // after, so it cannot take a candidate's place. When that cannot be read,
  // nobody is offered rather than someone who should not be.
  if (people.size) {
    try {
      await ensurePeopleTable();
      const suspended = await sql`
        SELECT email FROM people WHERE status = 'suspended' AND email = ANY(${[...people.keys()]})`;
      for (const r of suspended) people.delete(String(r.email).toLowerCase());
    } catch {
      return [];
    }
  }
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
// Transcripts — one row per video or audio file, made on a Mac.
//
// The server never transcribes and never sends media anywhere: it keeps the
// job and the result (lib/transcripts.js has the contract's rules). A job is
// queued from the web, claimed by Onyx for Mac with a 10-minute lease that
// each progress report renews, and finished by the claimer alone — every
// write after the claim names the claimer in its WHERE, so a Mac whose job
// was re-requested, deleted or taken over after its lease ran out finds
// nothing to update and is told it lost the job.
//
// Timestamps are TIMESTAMPTZ and compared against the database's now(), so
// leases are measured on one clock whatever the Macs' say. No foreign key,
// as everywhere here: deleteFile removes the row with the file.
// ─────────────────────────────────────────────────────────────────────────
const ensureTranscriptsTable = lazySchema('ensureTranscriptsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS transcripts (
      file_id         TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'queued',
      language        TEXT,
      result_language TEXT,
      engine          TEXT,
      source_key      TEXT,
      segments        JSONB,
      text            TEXT,
      progress        REAL,
      error           TEXT,
      requested_by    TEXT,
      requested_at    TIMESTAMPTZ,
      claimed_by      TEXT,
      claimed_device  TEXT,
      lease_until     TIMESTAMPTZ,
      finished_at     TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ DEFAULT now()
    )
  `;
  // The queue reads only the rows a Mac could take, oldest request first.
  await sql`CREATE INDEX IF NOT EXISTS transcripts_queue_idx ON transcripts (requested_at) WHERE status IN ('queued', 'working')`;
});

const tsOrNull = (v) => (v == null ? null : v instanceof Date ? v : new Date(v));

function shapeTranscript(r) {
  if (!r) return null;
  return {
    fileId: r.file_id,
    status: r.status,
    language: r.language || null,
    resultLanguage: r.result_language || null,
    engine: r.engine || null,
    sourceKey: r.source_key || null,
    segments: Array.isArray(r.segments) ? r.segments : [],
    text: r.text || '',
    progress: r.progress == null ? null : Number(r.progress),
    error: r.error || null,
    requestedBy: r.requested_by || null,
    requestedAt: tsOrNull(r.requested_at),
    claimedBy: r.claimed_by || null,
    claimedDevice: r.claimed_device || null,
    leaseUntil: tsOrNull(r.lease_until),
    finishedAt: tsOrNull(r.finished_at),
    updatedAt: tsOrNull(r.updated_at),
  };
}

// Production runs no DDL on the request path; the first request after a
// deploy that reads the table before `npm run doctor` applies the guard once
// and retries (withSchemaRetry).
const withTranscripts = (run) => withSchemaRetry(ensureTranscriptsTable, run);

/** A file's transcript row, or null. */
export async function getTranscript(fileId) {
  if (!sql || !fileId) return null;
  await ensureTranscriptsTable();
  const rows = await withTranscripts(() => sql`SELECT * FROM transcripts WHERE file_id = ${fileId}`);
  return shapeTranscript(rows[0]);
}

/**
 * Ask for a transcript, or ask again: status queued, the last run's error,
 * progress, claim and lease cleared, the request stamped — and the previous
 * segments kept, so the page still has something to show until a new run
 * replaces them. From any status: re-requesting a working job takes it away
 * from its Mac, whose next report finds no row it holds.
 */
export async function requestTranscript(fileId, { language = null, requestedBy = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureTranscriptsTable();
  const rows = await withTranscripts(() => sql`
    INSERT INTO transcripts (file_id, status, language, requested_by, requested_at, updated_at)
    VALUES (${fileId}, 'queued', ${language}, ${requestedBy}, now(), now())
    ON CONFLICT (file_id) DO UPDATE SET
      status = 'queued', language = EXCLUDED.language, error = NULL, progress = NULL,
      claimed_by = NULL, claimed_device = NULL, lease_until = NULL,
      requested_by = EXCLUDED.requested_by, requested_at = EXCLUDED.requested_at, updated_at = now()
    RETURNING *`);
  return shapeTranscript(rows[0]);
}

/** Remove a file's transcript. True when there was one. */
export async function deleteTranscript(fileId) {
  if (!sql || !fileId) return false;
  await ensureTranscriptsTable();
  const rows = await withTranscripts(() => sql`DELETE FROM transcripts WHERE file_id = ${fileId} RETURNING file_id`);
  return rows.length > 0;
}

/**
 * Take a job, atomically: one UPDATE that succeeds only on a row that is
 * queued, or working on a lease that has run out, of a file not in the
 * trash. Two Macs asking at once cannot both win — the second finds the row
 * already working. → { row } on success; { taken: true } when someone holds
 * it; { missing: true } when there is no job (none, done or failed).
 *
 * `sourceKey` is the file's storage key now: what the Mac will download, and
 * what `stale` is measured against once the result is in.
 */
export async function claimTranscript(fileId, { email, device = null, sourceKey = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureTranscriptsTable();
  // Twice at most: a row re-requested between the UPDATE and the look that
  // follows it is queued again, and worth one more try.
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await withTranscripts(() => sql`
      UPDATE transcripts SET
        status = 'working', claimed_by = ${email}, claimed_device = ${device},
        lease_until = now() + interval '10 minutes', progress = 0, error = NULL,
        source_key = ${sourceKey}, updated_at = now()
      WHERE file_id = ${fileId}
        AND (status = 'queued' OR (status = 'working' AND (lease_until IS NULL OR lease_until < now())))
        AND EXISTS (SELECT 1 FROM files f WHERE f.id = ${fileId} AND f.deleted_at IS NULL)
      RETURNING *`);
    if (rows[0]) return { row: shapeTranscript(rows[0]) };
    const [now] = await sql`SELECT status FROM transcripts WHERE file_id = ${fileId}`;
    if (now?.status === 'working') return { taken: true };
    if (now?.status !== 'queued') return { missing: true };
  }
  return { taken: true };
}

/**
 * A progress report from the claimer: stored, and the lease renewed for
 * another 10 minutes from now. Null when the job is not theirs and working
 * any more — re-requested, deleted, finished, or taken over.
 */
export async function reportTranscriptProgress(fileId, { email, progress }) {
  if (!sql) throw new Error('Database not configured');
  await ensureTranscriptsTable();
  const rows = await withTranscripts(() => sql`
    UPDATE transcripts SET progress = ${progress}, lease_until = now() + interval '10 minutes', updated_at = now()
    WHERE file_id = ${fileId} AND status = 'working' AND claimed_by = ${email}
    RETURNING *`);
  return shapeTranscript(rows[0]);
}

/** The claimer's run failed: why, and the lease let go. Null as above. */
export async function failTranscript(fileId, { email, error }) {
  if (!sql) throw new Error('Database not configured');
  await ensureTranscriptsTable();
  const rows = await withTranscripts(() => sql`
    UPDATE transcripts SET status = 'failed', error = ${error}, progress = NULL, lease_until = NULL, updated_at = now()
    WHERE file_id = ${fileId} AND status = 'working' AND claimed_by = ${email}
    RETURNING *`);
  return shapeTranscript(rows[0]);
}

/**
 * The claimer's result: the segments (checked by lib/transcripts.js
 * normalizeSegments) and their text, done, the lease let go. `sourceKey` is
 * the key it transcribed, as its claim handed it out. Null as above.
 */
export async function submitTranscript(fileId, { email, segments, text, resultLanguage = null, engine = null, sourceKey = null }) {
  if (!sql) throw new Error('Database not configured');
  await ensureTranscriptsTable();
  const rows = await withTranscripts(() => sql`
    UPDATE transcripts SET
      status = 'done', segments = ${sql.json(segments)}, text = ${text},
      result_language = ${resultLanguage}, engine = ${engine},
      source_key = COALESCE(${sourceKey}, source_key),
      progress = 1, error = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
    WHERE file_id = ${fileId} AND status = 'working' AND claimed_by = ${email}
    RETURNING *`);
  return shapeTranscript(rows[0]);
}

/**
 * Jobs this principal's Mac could take, oldest request first: at most
 * `limit`, each { file, language, requestedAt }. Authorize → filter, as
 * everywhere: the page is read through the listing's access rule
 * (buildTranscriptQueueQuery), then held to the write rule
 * (modifiableFileIds, drives included), and only video and audio stay. A
 * few pages at most are read past jobs they may see but not change.
 */
export async function listTranscriptJobs(principal, { limit = 10 } = {}) {
  if (!principal) throw new Error('listTranscriptJobs needs a principal');
  if (!sql) return [];
  await ensureFilesTable();
  await ensureFileAclTable();
  await ensureTranscriptsTable();
  const out = [];
  let after = null;
  for (let page = 0; page < 5 && out.length < limit; page++) {
    const q = buildTranscriptQueueQuery({ principal, limit: 100, after });
    const rows = await withSchemaRetry([ensureTranscriptsTable, ensureFilesTable], () => sql.unsafe(q.text, q.params));
    if (!rows.length) break;
    const files = rows.map(shapeFile);
    const mine = await modifiableFileIds(files, principal);
    rows.forEach((r, i) => {
      const file = files[i];
      if (out.length >= limit || !mine.has(file.id) || !isTranscribableKind(effectiveKind(file))) return;
      out.push({ file, language: r.transcript_language || null, requestedAt: tsOrNull(r.job_requested_at) });
    });
    if (rows.length < q.limit) break;
    const last = rows[rows.length - 1];
    after = { requestedAt: last.job_requested_at ? tsOrNull(last.job_requested_at).toISOString() : null, fileId: last.id };
  }
  return out;
}

/** A file's transcript, gone with the file (deleteFile). */
async function deleteTranscriptRow(fileId) {
  if (!sql || !fileId) return;
  try { await sql`DELETE FROM transcripts WHERE file_id = ${fileId}`; } catch {}
}

/**
 * A file's object moved (a rename, a move, a restore to a new key): the
 * same bytes under another name, so a transcript made of them follows —
 * otherwise `stale` would call every renamed file's transcript one "of an
 * earlier version". Only a transcript whose source is the key being left:
 * one of a genuinely older version stays stale. Best effort, and before the
 * files row changes, since the old key is read from it. `moves` is
 * [{ id, toKey }].
 */
async function followTranscriptKeys(moves = []) {
  const list = moves.filter((m) => m?.id && m.toKey);
  if (!sql || !list.length) return;
  try {
    await sql`
      UPDATE transcripts t SET source_key = m.key
      FROM unnest(${list.map((m) => String(m.id))}::text[], ${list.map((m) => String(m.toKey))}::text[]) AS m(id, key), files f
      WHERE t.file_id = m.id AND f.id = m.id AND t.source_key IS NOT NULL AND t.source_key = f.storage_key`;
  } catch { /* no table yet, or no transcript: nothing to follow */ }
}

// ─────────────────────────────────────────────────────────────────────────
// Saved views (lib/views.js): a person's own named filters, sort and display
// settings for the files page, kept here rather than in the browser so the
// web and the Mac app share them. Keyed by email, as every other per-person
// row. A view may be scoped to one drive (drive_id); the routes return it
// only while that drive is one its owner can open (visibleViews), and
// deleting a drive leaves its views to disappear the same way.
//
// The settings are JSONB in the shape lib/views.js validates on the way in
// and normalizes on the way out, so a new display setting needs no column.
// A view grants nothing: what it lists comes through the listing's own
// access rules, whoever saved it.
// ─────────────────────────────────────────────────────────────────────────
const ensureViewsTable = lazySchema('ensureViewsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS saved_views (
      id          TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      name        TEXT NOT NULL,
      drive_id    TEXT,
      filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
      sort        TEXT NOT NULL DEFAULT 'new',
      display     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `;
  // Every read is one person's views, oldest first.
  await sql`CREATE INDEX IF NOT EXISTS saved_views_owner_idx ON saved_views (owner_email, created_at)`;
});

const withViews = (run) => withSchemaRetry(ensureViewsTable, run);
const ownerOf = (email) => String(email || '').trim().toLowerCase();

function shapeView(r) {
  if (!r) return null;
  return {
    id: r.id,
    ownerEmail: r.owner_email,
    name: r.name,
    driveId: r.drive_id || null,
    filters: r.filters && typeof r.filters === 'object' ? r.filters : {},
    sort: r.sort || 'new',
    display: r.display && typeof r.display === 'object' ? r.display : {},
    createdAt: Number(r.created_at) || null,
    updatedAt: Number(r.updated_at) || null,
  };
}

/** Everything `email` has saved, oldest first — before any drive filtering, which is the caller's. */
export async function listSavedViews(email) {
  const e = ownerOf(email);
  if (!sql || !e) return [];
  await ensureViewsTable();
  const rows = await withViews(() => sql`
    SELECT * FROM saved_views WHERE owner_email = ${e} ORDER BY created_at ASC, id ASC`);
  return rows.map(shapeView);
}

/** Save a view for `email`. `view` is validated (lib/views.js validateViewInput) by the caller. */
export async function createSavedView(email, { name, driveId = null, filters = {}, sort = 'new', display = {} }) {
  const e = ownerOf(email);
  if (!sql) throw new Error('Database not configured');
  if (!e) throw new Error('createSavedView needs an owner');
  await ensureViewsTable();
  const now = Date.now();
  const rows = await withViews(() => sql`
    INSERT INTO saved_views (id, owner_email, name, drive_id, filters, sort, display, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${e}, ${name}, ${driveId || null}, ${sql.json(filters)}, ${sort}, ${sql.json(display)}, ${now}, ${now})
    RETURNING *`);
  return shapeView(rows[0]);
}

/**
 * Write a view's settings back — the whole of them, merged by the caller
 * from the stored row and the request. The owner is in the WHERE: an id
 * that is not theirs changes nothing and comes back null.
 */
export async function updateSavedView(id, email, { name, driveId = null, filters = {}, sort = 'new', display = {} }) {
  const e = ownerOf(email);
  if (!sql) throw new Error('Database not configured');
  if (!id || !e) return null;
  await ensureViewsTable();
  const rows = await withViews(() => sql`
    UPDATE saved_views SET
      name = ${name}, drive_id = ${driveId || null}, filters = ${sql.json(filters)},
      sort = ${sort}, display = ${sql.json(display)}, updated_at = ${Date.now()}
    WHERE id = ${String(id)} AND owner_email = ${e}
    RETURNING *`);
  return shapeView(rows[0]);
}

/** Delete one of `email`'s views. True when there was one to delete. */
export async function deleteSavedView(id, email) {
  const e = ownerOf(email);
  if (!sql || !id || !e) return false;
  await ensureViewsTable();
  const rows = await withViews(() => sql`DELETE FROM saved_views WHERE id = ${String(id)} AND owner_email = ${e} RETURNING id`);
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Starred folders — a person's shortcuts in the files sidebar, kept on the
// server so the web and the Mac app's window show the same ones. A star is
// (owner, drive, folder path): drive_id '' is the unscoped library, and the
// path is the folder as the listing names it within that scope.
//
// Like a view, a star grants nothing. The routes return one only while its
// drive is one its owner can open, and opening it goes through the listing's
// own access rules. A rename in a drive carries every star on that path
// along (renameFolderStars); deleting the folder drops them.
// ─────────────────────────────────────────────────────────────────────────
const ensureFolderStarsTable = lazySchema('ensureFolderStarsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS folder_stars (
      owner_email TEXT NOT NULL,
      drive_id    TEXT NOT NULL DEFAULT '',
      folder      TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      PRIMARY KEY (owner_email, drive_id, folder)
    )
  `;
  // A rename or delete finds every owner's stars on a path in one drive.
  await sql`CREATE INDEX IF NOT EXISTS folder_stars_path_idx ON folder_stars (drive_id, folder)`;
});

const withStars = (run) => withSchemaRetry(ensureFolderStarsTable, run);

/** Everything `email` has starred, oldest first — before any drive filtering, which is the caller's. */
export async function listFolderStars(email) {
  const e = ownerOf(email);
  if (!sql || !e) return [];
  await ensureFolderStarsTable();
  const rows = await withStars(() => sql`
    SELECT drive_id, folder, created_at FROM folder_stars WHERE owner_email = ${e} ORDER BY created_at ASC, folder ASC`);
  return rows.map((r) => ({ driveId: r.drive_id || '', folder: r.folder, createdAt: Number(r.created_at) || null }));
}

/** Star or unstar one folder for `email`. Idempotent either way. */
export async function setFolderStar(email, { driveId = '', folder, starred }) {
  const e = ownerOf(email);
  if (!sql) throw new Error('Database not configured');
  if (!e || !folder) return;
  await ensureFolderStarsTable();
  const d = String(driveId || '');
  const f = String(folder);
  if (starred) {
    await withStars(() => sql`
      INSERT INTO folder_stars (owner_email, drive_id, folder, created_at)
      VALUES (${e}, ${d}, ${f}, ${Date.now()})
      ON CONFLICT (owner_email, drive_id, folder) DO NOTHING`);
  } else {
    await withStars(() => sql`DELETE FROM folder_stars WHERE owner_email = ${e} AND drive_id = ${d} AND folder = ${f}`);
  }
}

/** A folder in `driveId` moved from `from` to `to`: every star on it, or under it, follows. */
export async function renameFolderStars(driveId, from, to) {
  if (!sql || !from || !to || from === to) return;
  await ensureFolderStarsTable();
  const d = String(driveId || '');
  const pat = escapeLike(from) + '/%';
  // A star already at the new path (someone starred both) keeps its place;
  // the old one goes rather than colliding with it.
  await withStars(() => sql`
    DELETE FROM folder_stars s WHERE s.drive_id = ${d} AND (s.folder = ${from} OR s.folder LIKE ${pat})
      AND EXISTS (
        SELECT 1 FROM folder_stars t WHERE t.owner_email = s.owner_email AND t.drive_id = ${d}
          AND t.folder = ${to} || substr(s.folder, ${from.length + 1}))`);
  await withStars(() => sql`
    UPDATE folder_stars SET folder = ${to} || substr(folder, ${from.length + 1})
    WHERE drive_id = ${d} AND (folder = ${from} OR folder LIKE ${pat})`);
}

/** A folder in `driveId` is gone: so are the stars on it and everything under it. */
export async function deleteFolderStars(driveId, folder) {
  if (!sql || !folder) return;
  await ensureFolderStarsTable();
  const d = String(driveId || '');
  await withStars(() => sql`
    DELETE FROM folder_stars WHERE drive_id = ${d} AND (folder = ${folder} OR folder LIKE ${escapeLike(folder) + '/%'})`);
}

// ─────────────────────────────────────────────────────────────────────────
// Collections — the files that meet a set of rules (lib/collections.js),
// shared with everyone who can open the drive they were made in (drive_id
// '' for All Files). The rules are JSONB in the shape lib/collections.js
// validates on the way in and normalizes on the way out. A collection grants
// nothing: its files are a listing under the listing's own access rules.
// Deleting a drive leaves its collections to disappear from every list, as
// its saved views do (collectionVisible).
// ─────────────────────────────────────────────────────────────────────────
const ensureCollectionsTable = lazySchema('ensureCollectionsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS collections (
      id          TEXT PRIMARY KEY,
      drive_id    TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL,
      match       TEXT NOT NULL DEFAULT 'all',
      rules       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by  TEXT,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS collections_drive_idx ON collections (drive_id, name)`;
});

const withCollections = (run) => withSchemaRetry(ensureCollectionsTable, run);

function shapeCollection(r) {
  if (!r) return null;
  return {
    id: r.id,
    driveId: r.drive_id || '',
    name: r.name,
    match: r.match === 'any' ? 'any' : 'all',
    rules: Array.isArray(r.rules) ? r.rules : [],
    createdBy: r.created_by || null,
    createdAt: Number(r.created_at) || null,
    updatedAt: Number(r.updated_at) || null,
  };
}

/** Every collection, by drive then name — before any visibility filtering, which is the caller's. */
export async function listCollections() {
  if (!sql) return [];
  await ensureCollectionsTable();
  const rows = await withCollections(() => sql`SELECT * FROM collections ORDER BY drive_id ASC, lower(name) ASC, id ASC`);
  return rows.map(shapeCollection);
}

export async function getCollection(id) {
  if (!sql || !id) return null;
  await ensureCollectionsTable();
  const rows = await withCollections(() => sql`SELECT * FROM collections WHERE id = ${String(id)}`);
  return shapeCollection(rows[0]);
}

/** Make a collection. `input` is validated (validateCollectionInput) by the caller. */
export async function createCollection({ name, driveId = '', match = 'all', rules = [] }, { createdBy = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureCollectionsTable();
  const now = Date.now();
  const rows = await withCollections(() => sql`
    INSERT INTO collections (id, drive_id, name, match, rules, created_by, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${driveId || ''}, ${name}, ${match}, ${sql.json(rules)}, ${createdBy}, ${now}, ${now})
    RETURNING *`);
  return shapeCollection(rows[0]);
}

/** Write a collection's name, match and rules back — merged by the caller from the row and the request. */
export async function updateCollection(id, { name, match, rules }) {
  if (!sql) throw new Error('Database not configured');
  await ensureCollectionsTable();
  const rows = await withCollections(() => sql`
    UPDATE collections SET name = ${name}, match = ${match}, rules = ${sql.json(rules)}, updated_at = ${Date.now()}
    WHERE id = ${String(id)}
    RETURNING *`);
  return shapeCollection(rows[0]);
}

export async function deleteCollection(id) {
  if (!sql || !id) return false;
  await ensureCollectionsTable();
  const rows = await withCollections(() => sql`DELETE FROM collections WHERE id = ${String(id)} RETURNING id`);
  return rows.length > 0;
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
/** The ids among `ids` that `principal` may see (buildVisibleIdsQuery). An admin sees them all. */
export async function visibleFileIds(ids, principal = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))];
  if (!list.length) return new Set();
  if (principal.isAdmin) return new Set(list);
  if (!sql) return new Set();
  await ensureFilesTable();
  await ensureFileAclTable();
  const { text, params } = buildVisibleIdsQuery({ ids: list, principal });
  const rows = await withSchemaRetry(ensureFilesTable, () => sql.unsafe(text, params));
  return new Set(rows.map((r) => r.id));
}

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
 * lets them. Only its own — and since folder names are per scope, every
 * path in the drive is the drive's own: its rename and delete act on its
 * folder rows and its files alone, never on the library's or another
 * drive's folder of the same name, and move or remove that name's folder
 * grants only as far as no other scope uses the path (renameFolder,
 * deleteFolderRows). Whether their ROLE lets them manage folders is the
 * caller's question (can(principal, 'folders.manage')).
 */
export async function folderRoleFor(folder, principal = {}, { driveRole = null, tag = null } = {}) {
  if (principal.isAdmin) return 'owner';
  if (!sql) return null;
  const fromDrive = WRITE_ROLES.has(driveRole) && tag ? driveRole : null;
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
 * Of `folders` — paths in the library, where no drive role counts — the ones
 * this principal may modify: canModifyFolder(path, principal, { tag: '' })
 * for each, in one query rather than one a path. Their folder grants, and for
 * each path the strongest held on it or a folder above it. A grant that
 * cannot be read is no grant.
 */
export async function modifiableLibraryFolders(folders = [], principal = {}) {
  const paths = [...new Set((folders || []).filter((f) => typeof f === 'string' && f))];
  if (principal.isAdmin) return new Set(paths);
  if (!sql || !paths.length) return new Set();
  const email = String(principal.email || '').toLowerCase();
  const roleId = principal.roleId || null;
  const held = new Map(); // folder → every role granted on it
  try {
    await ensureFolderAclTable();
    const rows = await sql`
      SELECT folder, role FROM folder_access
      WHERE (subject_type = 'user' AND subject = ${email}) OR (subject_type = 'role' AND subject = ${roleId})`;
    for (const r of rows) held.set(r.folder, [...(held.get(r.folder) || []), r.role]);
  } catch { return new Set(); }
  return new Set(paths.filter((p) => folderRoleAllows(strongestFolderRole(_ancestorsOf(p).flatMap((a) => held.get(a) || [])), 'modify')));
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
  // A drive's own folder rows are every member's, empty or not — the same
  // list a sync client gets (listSyncFolders). Callers pass a prefix only
  // for a drive the principal may open (storagePrefixFor), so this shows a
  // member nothing the Finder disk does not already show them.
  if (opts.storagePrefix) {
    for (const name of await listSyncFolders(principal, { storagePrefix: opts.storagePrefix })) {
      for (const a of _ancestorsOf(name)) if (a) keep.add(a);
    }
  }
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
// Env-admins (isAdmin) are implicit owners of every filespace: authorization
// layers admin on top at the route, and never reads an admin's grant rows.
// An admin holds one only as a drive's OWNER — who it belongs to — because a
// drive always has an owner (lib/drive-access.js says how that is kept). It
// changes nothing an admin can reach.
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
//
// Strictly `true`, and never passed to .map() by reference: map hands its
// callback the index as the second argument, which once gave every row of
// listFilespaces() after the first its secret (index 1, 2… is truthy).
export function shapeFilespace(r, includeSecret = false) {
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

/**
 * Make a drive. `owner` (an address) is made its owner in the same
 * statement, so a drive is never there without the owner it was made for:
 * the routes pass whoever made it, an admin as much as anyone else
 * (lib/drive-access.js).
 */
export async function createFilespace({ name, bucket, prefix, region, roleArn, accessKeyId, secretAccessKey, endpoint, createdBy, owner = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilespacesTables();
  const id = crypto.randomUUID();
  const now = Date.now();
  const ownerEmail = normEmail(owner) || null;
  const rows = await sql`
    WITH made AS (
      INSERT INTO filespaces (id, name, bucket, prefix, region, role_arn, access_key, secret_key, endpoint, created_by, created_at, updated_at)
      VALUES (
        ${id}, ${String(name || 'Untitled filespace').trim()}, ${String(bucket || '').trim()},
        ${normPrefix(prefix)}, ${region || null}, ${roleArn || null},
        ${accessKeyId ? String(accessKeyId).trim() : null}, ${secretAccessKey ? String(secretAccessKey) : null}, ${endpoint ? String(endpoint).trim() : null},
        ${createdBy || null}, ${now}, ${now}
      )
      RETURNING *
    ), owned AS (
      INSERT INTO filespace_access (filespace_id, user_email, role, granted_by, granted_at)
      SELECT id, ${ownerEmail}, 'owner', ${createdBy || null}, ${now} FROM made
       WHERE ${ownerEmail}::text IS NOT NULL
    )
    SELECT * FROM made
  `;
  forgetDriveStorage();
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

// Every drive with what reaching its objects takes (its secret included),
// for the storage layer only (lib/storage.js storageForKey): a drive in a
// bucket of its own, or with keys of its own, is signed, moved and trashed
// there, never in the base bucket. Never returned to a client. Read at most
// every 30 s per instance, and afresh after any change to a drive here.
let driveStorageCache = null;
export async function listDriveStorage() {
  if (!sql) return [];
  if (driveStorageCache && Date.now() - driveStorageCache.at < 30_000) return driveStorageCache.rows;
  await ensureFilespacesTables();
  const rows = await withSchemaRetry(ensureFilespacesTables, () => sql`SELECT * FROM filespaces LIMIT 500`);
  const shaped = rows.map((r) => shapeFilespace(r, true));
  driveStorageCache = { at: Date.now(), rows: shaped };
  return shaped;
}
function forgetDriveStorage() { driveStorageCache = null; }

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
  forgetDriveStorage();
  // Another folder in the bucket (allowed only while the drive has no files):
  // its empty folders are the drive's, so they follow it.
  if (rows[0] && normPrefix(rows[0].prefix) !== normPrefix(existing.prefix)) {
    await retagFolderRows(existing.prefix, rows[0].prefix);
  }
  return shapeFilespace(rows[0], true);
}

export async function deleteFilespace(id) {
  if (!sql || !id) return { ok: false };
  await ensureFilespacesTables();
  const existing = await getFilespace(id);
  // No FK between the tables — prune the child grant rows first, then the row.
  await sql`DELETE FROM filespace_access WHERE filespace_id = ${id}`;
  await sql`DELETE FROM filespaces WHERE id = ${id}`;
  forgetDriveStorage();
  // Its files stay, and fall back into the library; its empty folders go
  // with them, rather than sit tagged for a drive that is not there (and
  // turn up in the next drive made on the same folder).
  if (existing) await retagFolderRows(existing.prefix, '');
  // Links to its folders were the drive's, made by its editors: they do not
  // become links into the library. Kept only while another drive (in
  // another bucket) is at the same prefix, whose links they are too. They
  // stop opening either way (lib/folder-links.js folderLinkScope).
  if (existing) {
    const p = cleanFolderPath(existing.prefix);
    if (p) {
      await ensureSharesTable();
      await withSchemaRetry(ensureSharesTable, () => sql`
        DELETE FROM file_shares
        WHERE kind = 'folder' AND storage_prefix = ${p}
          AND NOT EXISTS (SELECT 1 FROM filespaces WHERE prefix = ${normPrefix(existing.prefix)})`).catch((e) => {
        console.warn('[deleteFilespace] its folder links were not removed:', e.message);
      });
    }
  }
  return { ok: true, id };
}

/**
 * Move one scope's folder rows to another (folders.filespace is a drive's
 * prefix, '' the library's): when a drive's folder in the bucket changes, or
 * the drive goes. A name the destination already has stays the
 * destination's, and the source's row of it goes. Nothing moves while
 * another drive still points at the old prefix (in another bucket), since
 * those rows are its too. Returns the rows moved.
 */
export async function retagFolderRows(fromPrefix, toPrefix) {
  const from = normPrefix(fromPrefix);
  const to = normPrefix(toPrefix);
  if (!sql || !from || from === to) return 0;
  await ensureFoldersTable();
  await ensureFilespacesTables();
  const sharing = await sql`SELECT 1 FROM filespaces WHERE prefix = ${from} LIMIT 1`;
  if (sharing.length) return 0;
  const moved = await sql`
    UPDATE folders f SET filespace = ${to}
     WHERE ${inScope(from)}
       AND NOT EXISTS (SELECT 1 FROM folders g WHERE COALESCE(g.filespace, '') = ${to} AND g.name = f.name)
    RETURNING f.name`;
  await sql`DELETE FROM folders WHERE ${inScope(from)}`;
  return moved.length;
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


// ── Proxy renditions ────────────────────────────────────────────────────────
//
// A streamable H.264 copy of a heavy master, made by a Mac and claimed through
// the same queue idiom as a transcript: a side table keyed by file_id, an
// atomic claim, and a lease that expires so a worker dying mid-transcode does
// not wedge the row for ever. See lib/proxies.js for the rendition itself and
// why transcoding cannot run on the server.

const ensureProxiesTable = lazySchema('ensureProxiesTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS proxies (
      file_id         TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'queued',
      proxy_key       TEXT,
      source_key      TEXT,
      width           INT,
      height          INT,
      size            BIGINT,
      duration        REAL,
      progress        REAL,
      error           TEXT,
      requested_by    TEXT,
      requested_at    TIMESTAMPTZ,
      claimed_by      TEXT,
      claimed_device  TEXT,
      lease_until     TIMESTAMPTZ,
      finished_at     TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ DEFAULT now()
    )
  `;
  // The queue reads only the rows a Mac could take, oldest request first.
  await sql`CREATE INDEX IF NOT EXISTS proxies_queue_idx ON proxies (requested_at) WHERE status IN ('queued', 'working')`;
});

function shapeProxy(r) {
  if (!r) return null;
  return {
    fileId: r.file_id,
    status: r.status,
    proxyKey: r.proxy_key || null,
    sourceKey: r.source_key || null,
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    size: r.size == null ? null : Number(r.size),
    duration: r.duration == null ? null : Number(r.duration),
    progress: r.progress == null ? null : Number(r.progress),
    error: r.error || null,
    requestedBy: r.requested_by || null,
    requestedAt: tsOrNull(r.requested_at),
    claimedBy: r.claimed_by || null,
    claimedDevice: r.claimed_device || null,
    leaseUntil: tsOrNull(r.lease_until),
    finishedAt: tsOrNull(r.finished_at),
    updatedAt: tsOrNull(r.updated_at),
  };
}

const withProxies = (run) => withSchemaRetry(ensureProxiesTable, run);

/** A file's proxy row, or null. */
export async function getProxy(fileId) {
  if (!sql || !fileId) return null;
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`SELECT * FROM proxies WHERE file_id = ${fileId}`);
  return shapeProxy(rows[0]);
}

/** Proxy rows for many files at once, as a Map — so a listing costs one query, not one per row. */
export async function getProxies(fileIds = []) {
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : []).filter(Boolean))];
  if (!sql || !ids.length) return new Map();
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`SELECT * FROM proxies WHERE file_id = ANY(${ids})`);
  return new Map(rows.map((r) => [r.file_id, shapeProxy(r)]));
}

/**
 * `proxyKey`, `proxyStatus` and `proxyStale` onto file rows, in one query for
 * the whole page.
 *
 * They are not columns on `files`: a proxy is a job with a lifecycle, and
 * putting its status in the files row would mean every progress report bumped
 * the row's `seq` and woke every syncing device. So it is joined on where it is
 * wanted — the detail page, and anywhere else that presigns for a player, since
 * presignFileUrls signs `proxyUrl` from `proxyKey`.
 *
 * Only a finished proxy of THIS file's current contents gets a key. A stale one
 * (the contents were replaced) is reported as stale with no key: it would play,
 * and show the wrong footage, so nothing should be able to reach it by
 * accident.
 */
export async function attachProxies(files = []) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return list;
  let byId;
  try { byId = await getProxies(list.map((f) => f?.id)); } catch { return list; }
  if (!byId.size) return list;
  return list.map((f) => {
    const row = f && byId.get(f.id);
    if (!row) return f;
    const stale = isProxyStale(row, f);
    return {
      ...f,
      proxyKey: row.status === 'done' && !stale ? row.proxyKey : null,
      proxyStatus: row.status,
      proxyStale: stale,
    };
  });
}

/**
 * The key of each file's finished, current proxy, as a Map of file id → key:
 * what attachProxies gives a caller that only plays the rendition — a
 * listing, a share link — and so has no use for a job still in the queue, or
 * one that failed. One query on the primary key for all of them, and none
 * for an empty list. A proxy of contents since replaced is left out, as
 * attachProxies withholds its key: it plays, and shows the wrong footage.
 */
export async function finishedProxyKeys(files = []) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f?.id);
  if (!sql || !list.length) return new Map();
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`
    SELECT file_id, status, proxy_key, source_key FROM proxies
    WHERE file_id = ANY(${list.map((f) => f.id)}) AND status = 'done' AND proxy_key IS NOT NULL`);
  const byId = new Map(list.map((f) => [f.id, f]));
  const out = new Map();
  for (const r of rows) {
    const row = shapeProxy(r);
    if (!isProxyStale(row, byId.get(row.fileId))) out.set(row.fileId, row.proxyKey);
  }
  return out;
}

/**
 * Ask for a proxy. Re-requesting one that failed clears the failure and puts it
 * back in the queue; re-requesting one that is done rebuilds it, which is what
 * replacing a file's content needs.
 */
export async function requestProxy(fileId, { requestedBy = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureProxiesTable();
  // The key the previous run wrote, read before the upsert clears it: nothing
  // serves a proxy whose job is not `done`, so keeping the old object through a
  // re-run buys nothing and leaks it. The caller has the bucket and deletes it.
  const prior = await withProxies(() => sql`SELECT proxy_key FROM proxies WHERE file_id = ${fileId}`);
  const rows = await withProxies(() => sql`
    INSERT INTO proxies (file_id, status, requested_by, requested_at, updated_at)
    VALUES (${fileId}, 'queued', ${requestedBy}, now(), now())
    ON CONFLICT (file_id) DO UPDATE SET
      status = 'queued', error = NULL, progress = NULL, proxy_key = NULL,
      claimed_by = NULL, claimed_device = NULL, lease_until = NULL,
      requested_by = EXCLUDED.requested_by, requested_at = EXCLUDED.requested_at, updated_at = now()
    RETURNING *`);
  const row = shapeProxy(rows[0]);
  return row && { ...row, abandonedKey: prior[0]?.proxy_key || null };
}

/**
 * Remove a file's proxy job, and say which object it pointed at so the caller
 * can delete it. → { removed, key }. This module never reaches storage (it is
 * imported from the edge), so the object is always the caller's to delete.
 */
export async function deleteProxy(fileId) {
  if (!sql || !fileId) return { removed: false, key: null };
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`DELETE FROM proxies WHERE file_id = ${fileId} RETURNING proxy_key`);
  return { removed: rows.length > 0, key: rows[0]?.proxy_key || null };
}

/**
 * The proxy objects these files' jobs point at.
 *
 * Read BEFORE a purge: deleting the file deletes the job row, and with it the
 * only record of where the rendition lives — a gigabyte nothing can ever find
 * again. Returns keys only, and only well-formed ones.
 */
export async function proxyKeysFor(fileIds = []) {
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : [fileIds]).filter(Boolean).map(String))];
  if (!sql || !ids.length) return [];
  try {
    await ensureProxiesTable();
    const rows = await withProxies(() => sql`SELECT proxy_key FROM proxies WHERE file_id = ANY(${ids}) AND proxy_key IS NOT NULL`);
    return rows.map((r) => r.proxy_key).filter(isProxyKey);
  } catch (e) {
    console.warn('[proxyKeysFor]', e.message);
    return [];
  }
}

/**
 * Which of these proxy keys a job row still points at. Throws when it cannot
 * tell, and callers fail closed — deleting an object a job still names would
 * leave a `done` proxy that 404s mid-playback.
 */
export async function proxyKeysInUse(keys = []) {
  const list = [...new Set(keys.filter(Boolean).map(String))];
  if (!sql || !list.length) return new Set();
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`
    SELECT DISTINCT k FROM unnest(${list}::text[]) AS k
    WHERE EXISTS (SELECT 1 FROM proxies p WHERE p.proxy_key = k)`);
  return new Set(rows.map((r) => r.k));
}

/**
 * Take a job, atomically: one UPDATE that succeeds only on a row that is
 * queued, or working on a lease that has run out, of a file not in the trash.
 * Two Macs asking at once cannot both win. → { row } on success;
 * { taken: true } when someone holds it; { missing: true } when there is none.
 *
 * `sourceKey` is the file's storage key now: what the Mac will download, and
 * what `isStale` is measured against once the rendition is in. `proxyKey` is
 * where the rendition goes, named HERE from a fresh uuid rather than taken from
 * the worker later — so nothing a worker sends can aim a file's proxy at
 * another object, and a re-request lands under a new key that no cache holds.
 */
export async function claimProxy(fileId, { email, device = null, sourceKey = null, proxyKey = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureProxiesTable();
  // Twice at most, as claimTranscript does: a row re-requested between the
  // UPDATE and the look that follows it is queued again, and worth one more try.
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await withProxies(() => sql`
      UPDATE proxies SET
        status = 'working', claimed_by = ${email}, claimed_device = ${device},
        lease_until = now() + interval '10 minutes', progress = 0, error = NULL,
        source_key = ${sourceKey}, proxy_key = ${proxyKey}, updated_at = now()
      WHERE file_id = ${fileId}
        AND (status = 'queued' OR (status = 'working' AND (lease_until IS NULL OR lease_until < now())))
        AND EXISTS (SELECT 1 FROM files f WHERE f.id = ${fileId} AND f.deleted_at IS NULL)
      RETURNING *`);
    if (rows[0]) return { row: shapeProxy(rows[0]) };
    const [now] = await sql`SELECT status FROM proxies WHERE file_id = ${fileId}`;
    if (now?.status === 'working') return { taken: true };
    if (now?.status !== 'queued') return { missing: true };
  }
  return { taken: true };
}

/**
 * A progress report from the claimer: stored, and the lease renewed for another
 * ten minutes. Null when the job is not theirs and working any more —
 * re-requested, deleted, finished, or taken over.
 */
export async function reportProxyProgress(fileId, { email, progress }) {
  if (!sql) throw new Error('Database not configured');
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`
    UPDATE proxies SET progress = ${progress}, lease_until = now() + interval '10 minutes', updated_at = now()
    WHERE file_id = ${fileId} AND status = 'working' AND claimed_by = ${email}
    RETURNING *`);
  return shapeProxy(rows[0]);
}

/**
 * The rendition is in the bucket, under the key the claim named — which is why
 * this takes no key: the only object it can mark done is the one it handed out.
 * Recorded only while the job is still the claimer's, so a worker returning
 * after its lease expired and someone else took over cannot overwrite the
 * newer result.
 */
export async function finishProxy(fileId, { email, width = null, height = null, size = null, duration = null }) {
  if (!sql) throw new Error('Database not configured');
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`
    UPDATE proxies SET
      status = 'done', width = ${width}, height = ${height},
      size = ${size}, duration = ${duration}, progress = 1, error = NULL,
      lease_until = NULL, finished_at = now(), updated_at = now()
    WHERE file_id = ${fileId} AND status = 'working' AND claimed_by = ${email}
    RETURNING *`);
  return shapeProxy(rows[0]);
}

/** The claimer's run failed: why, and the lease let go. Null as above. */
export async function failProxy(fileId, { email, error }) {
  if (!sql) throw new Error('Database not configured');
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`
    UPDATE proxies SET status = 'failed', error = ${error}, progress = NULL,
      lease_until = NULL, updated_at = now()
    WHERE file_id = ${fileId} AND status = 'working' AND claimed_by = ${email}
    RETURNING *`);
  return shapeProxy(rows[0]);
}

/**
 * What a Mac could take, oldest request first: queued, or working on a lease
 * that has run out — and only on files this principal may SEE, then only those
 * they may CHANGE. The same two steps as listTranscriptJobs, for the same
 * reason: a bearer token is a principal, not a superuser, and a Mac offered a
 * job outside its drives would have the claim refuse it anyway.
 *
 * Only video stays, and the source height rides along from the file's own
 * metadata so the worker can pick the rendition without a probe.
 */
export async function listProxyJobs(principal, { limit = 10 } = {}) {
  if (!principal) throw new Error('listProxyJobs needs a principal');
  if (!sql) return [];
  await ensureFilesTable();
  await ensureFileAclTable();
  await ensureProxiesTable();
  const out = [];
  let after = null;
  for (let page = 0; page < 5 && out.length < limit; page++) {
    const q = buildProxyQueueQuery({ principal, limit: 100, after });
    const rows = await withSchemaRetry([ensureProxiesTable, ensureFilesTable], () => sql.unsafe(q.text, q.params));
    if (!rows.length) break;
    const files = rows.map(shapeFile);
    const mine = await modifiableFileIds(files, principal);
    rows.forEach((r, i) => {
      const file = files[i];
      if (out.length >= limit || !mine.has(file.id) || !isProxyableKind(effectiveKind(file))) return;
      out.push({ file, requestedAt: tsOrNull(r.job_requested_at) });
    });
    if (rows.length < q.limit) break;
    const last = rows[rows.length - 1];
    after = { requestedAt: last.job_requested_at ? tsOrNull(last.job_requested_at).toISOString() : null, fileId: last.id };
  }

  // Room left: large videos no one has asked for (buildProxyCandidateQuery),
  // newest first, so every large video comes to have a streamable version —
  // but only after everything someone did ask for, which a Mac takes first.
  // Nothing is written; the claim makes the job (queueProxyIfMissing).
  let since = null;
  for (let page = 0; page < 3 && out.length < limit; page++) {
    const q = buildProxyCandidateQuery({ principal, minBytes: PROXY_MIN_BYTES, limit: 100, after: since });
    const rows = await withSchemaRetry([ensureProxiesTable, ensureFilesTable], () => sql.unsafe(q.text, q.params));
    if (!rows.length) break;
    const files = rows.map(shapeFile);
    const mine = await modifiableFileIds(files, principal);
    for (const file of files) {
      if (out.length >= limit) break;
      if (mine.has(file.id) && shouldProxy(file)) out.push({ file, requestedAt: null });
    }
    if (rows.length < q.limit) break;
    const last = files[files.length - 1];
    since = { createdAt: last.createdAt, id: last.id };
  }
  return out;
}

/**
 * A queued job for a file that has none, and nothing if it has one — done,
 * failed or waiting, it is left as it is. For a claim of a large video the
 * queue offered with no job yet (listProxyJobs). → whether one was made.
 */
export async function queueProxyIfMissing(fileId, { requestedBy = null } = {}) {
  if (!sql || !fileId) return false;
  await ensureProxiesTable();
  const rows = await withProxies(() => sql`
    INSERT INTO proxies (file_id, status, requested_by, requested_at, updated_at)
    VALUES (${fileId}, 'queued', ${requestedBy}, now(), now())
    ON CONFLICT (file_id) DO NOTHING
    RETURNING file_id`);
  return rows.length > 0;
}

/** A file's proxy row, gone with the file (deleteFile). Best effort. */
async function deleteProxyRow(fileId) {
  if (!sql || !fileId) return;
  try { await sql`DELETE FROM proxies WHERE file_id = ${fileId}`; } catch {}
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
 * What a storage provider bills for, as far as the catalog knows it — for the
 * Usage page's monthly estimate (lib/storage-pricing.js), which puts each
 * part in the bucket it is kept in:
 *
 *   live, trash   files in a bucket. The trash is stored until it is purged:
 *                 a trashed object is moved to _trash/ in the bucket it was in.
 *   blob          files in Vercel Blob, uploaded before a bucket was set up
 *   trashByDrive  the trash under each drive's prefix, a drive inside another
 *                 counting toward both, as listDrivesWithUsage counts live files
 *   proxies       streaming renditions (lib/proxies.js), always in the Storage
 *                 bucket, by the size the Mac that made each one reported.
 *                 `unsized` were reported without one.
 *
 * Thumbnails, posters and filmstrips have no size on record and are not here.
 * One pass over the files, and the trash (few rows) matched to each drive. A
 * lateral join finding the deepest drive holding each file was the obvious
 * query, and took over a second at 500k files; these took 25 ms each, and the
 * nesting is worked out from them instead (lib/storage-report.js heldByDrive).
 */
export async function billableStorage() {
  if (!sql) return null;
  await ensureFilesTable();
  await ensureFilespacesTables();
  await ensureProxiesTable();
  const [totals, trash, proxies] = await Promise.all([
    sql`
      SELECT
        COUNT(*) FILTER (WHERE storage = 's3' AND deleted_at IS NULL)::int AS live_files,
        COALESCE(SUM(size) FILTER (WHERE storage = 's3' AND deleted_at IS NULL), 0)::bigint AS live_bytes,
        COUNT(*) FILTER (WHERE storage = 's3' AND deleted_at IS NOT NULL)::int AS trash_files,
        COALESCE(SUM(size) FILTER (WHERE storage = 's3' AND deleted_at IS NOT NULL), 0)::bigint AS trash_bytes,
        COUNT(*) FILTER (WHERE storage IS DISTINCT FROM 's3')::int AS blob_files,
        COALESCE(SUM(size) FILTER (WHERE storage IS DISTINCT FROM 's3'), 0)::bigint AS blob_bytes
      FROM files`,
    sql`
      SELECT f.id, COUNT(x.id)::int AS files, COALESCE(SUM(x.size), 0)::bigint AS bytes
      FROM filespaces f
      JOIN files x
        ON x.deleted_at IS NOT NULL
       AND x.storage_key ~>=~ (f.prefix || '/')
       AND x.storage_key ~<~ (f.prefix || '0')
      GROUP BY f.id`,
    withProxies(() => sql`
      SELECT COUNT(size)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes,
             COUNT(*) FILTER (WHERE size IS NULL)::int AS unsized
      FROM proxies WHERE status = 'done' AND proxy_key IS NOT NULL`),
  ]);
  const t = totals[0] || {};
  return {
    live: usageOf({ files: t.live_files, bytes: t.live_bytes }),
    trash: usageOf({ files: t.trash_files, bytes: t.trash_bytes }),
    blob: usageOf({ files: t.blob_files, bytes: t.blob_bytes }),
    trashByDrive: Object.fromEntries(trash.map((r) => [r.id, usageOf(r)])),
    proxies: { ...usageOf(proxies[0]), unsized: Number(proxies[0]?.unsized) || 0 },
  };
}

// ── Storage prices of our own ─────────────────────────────────────────────
// What storage costs this organisation where that is not the list price: a
// negotiated rate, a contract, or a service with no list price at all. One
// row per account the library is billed on — lib/storage-pricing.js
// storageLocation's `bill`, "provider|host|region" — because an allowance,
// a minimum and a fee are each per account. The Usage estimate prices an
// account by its row when it has one. Set on Admin → Storage → Prices
// (PUT /api/admin/storage-prices), which checks every field first
// (validateStoragePrice).
//
//   storage_prices — the rate in USD per `unit` ('TB' | 'GB') a month; how
//                    the provider counts (`base`, 1000 | 1024); the free
//                    storage and the least billed, in bytes; a flat monthly
//                    fee; a note; and who set it, when
//
// NUMERIC for the dollars, so a rate is kept exactly as it was typed.
// ─────────────────────────────────────────────────────────────────────────
const ensureStoragePricesTable = lazySchema('ensureStoragePricesTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS storage_prices (
      account        TEXT PRIMARY KEY,
      rate           NUMERIC NOT NULL,
      unit           TEXT NOT NULL,
      base           INT NOT NULL,
      free_bytes     BIGINT NOT NULL DEFAULT 0,
      minimum_bytes  BIGINT NOT NULL DEFAULT 0,
      fee            NUMERIC NOT NULL DEFAULT 0,
      note           TEXT,
      set_at         BIGINT NOT NULL,
      set_by         TEXT
    )
  `;
});

function shapeStoragePrice(r) {
  if (!r) return null;
  return {
    account: r.account,
    rate: Number(r.rate),
    unit: r.unit,
    base: Number(r.base),
    freeBytes: Number(r.free_bytes) || 0,
    minimumBytes: Number(r.minimum_bytes) || 0,
    fee: Number(r.fee) || 0,
    note: r.note || null,
    setAt: Number(r.set_at) || null,
    setBy: r.set_by || null,
  };
}

/** Every price of our own, by account. */
export async function listStoragePrices() {
  if (!sql) return [];
  await ensureStoragePricesTable();
  const rows = await withSchemaRetry(ensureStoragePricesTable, () => sql`SELECT * FROM storage_prices ORDER BY account`);
  return rows.map((r) => shapeStoragePrice(r));
}

/**
 * Set an account's price, replacing any it had. `price` is what
 * validateStoragePrice returned — nothing here checks it again. → the row.
 */
export async function setStoragePrice(account, price, { by = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  if (!account || !price) throw new Error('An account and a price are required.');
  await ensureStoragePricesTable();
  const rows = await withSchemaRetry(ensureStoragePricesTable, () => sql`
    INSERT INTO storage_prices (account, rate, unit, base, free_bytes, minimum_bytes, fee, note, set_at, set_by)
    VALUES (
      ${account}, ${price.rate}, ${price.unit}, ${price.base}, ${price.freeBytes || 0}, ${price.minimumBytes || 0},
      ${price.fee || 0}, ${price.note || null}, ${Date.now()}, ${by ? String(by).toLowerCase() : null}
    )
    ON CONFLICT (account) DO UPDATE SET
      rate = EXCLUDED.rate, unit = EXCLUDED.unit, base = EXCLUDED.base,
      free_bytes = EXCLUDED.free_bytes, minimum_bytes = EXCLUDED.minimum_bytes, fee = EXCLUDED.fee,
      note = EXCLUDED.note, set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by
    RETURNING *`);
  return shapeStoragePrice(rows[0]);
}

/** Take an account's price away, so it is priced from the list again. → the row it had, or null. */
export async function removeStoragePrice(account) {
  if (!sql || !account) return null;
  await ensureStoragePricesTable();
  const rows = await withSchemaRetry(ensureStoragePricesTable, () => sql`
    DELETE FROM storage_prices WHERE account = ${account} RETURNING *`);
  return shapeStoragePrice(rows[0]);
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

/**
 * Every drive with its member and owner counts and what is stored under its
 * prefix, in ONE grouped query — Admin → Drives and the Usage page used to
 * run countFilesUnderPrefix once per drive.
 *
 * The prefix match is a range on storage_key with the text_pattern_ops
 * operators (~>=~ ~<~), not LIKE: a pattern built from a column is not a
 * constant the planner can turn into an index range, while a range with
 * these operators is exactly what files_live_key_idx serves, one probe per
 * drive. 'prefix/' up to (not including) 'prefix0' is every key under
 * 'prefix/', as '0' is the byte after '/'. A drive inside another counts
 * toward both, as on the Usage page.
 */
export async function listDrivesWithUsage() {
  if (!sql) return [];
  await ensureFilespacesTables();
  await ensureFilesTable();
  const rows = await sql`
    SELECT f.*,
      (SELECT COUNT(*)::int FROM filespace_access a WHERE a.filespace_id = f.id) AS member_count,
      (SELECT COUNT(*)::int FROM filespace_access a WHERE a.filespace_id = f.id AND a.role = 'owner') AS owner_count,
      COUNT(x.id)::int AS files,
      COALESCE(SUM(x.size), 0)::bigint AS bytes
    FROM filespaces f
    LEFT JOIN files x
      ON x.deleted_at IS NULL
     AND x.storage_key ~>=~ (f.prefix || '/')
     AND x.storage_key ~<~ (f.prefix || '0')
    GROUP BY f.id
    ORDER BY lower(f.name), f.id
    LIMIT 500
  `;
  return rows.map((r) => ({
    ...shapeFilespace(r),
    ownerCount: Number(r.owner_count) || 0,
    files: Number(r.files) || 0,
    bytes: Number(r.bytes) || 0,
  }));
}

/**
 * Every drive's id and name with how many owners it has: Admin → Overview's
 * drive tile and "no owner" item. Not listDrivesWithUsage, which adds up
 * every file under every drive — work the Overview would throw away.
 */
export async function listDriveOwners() {
  if (!sql) return [];
  await ensureFilespacesTables();
  const rows = await sql`
    SELECT f.id, f.name,
      (SELECT COUNT(*)::int FROM filespace_access a WHERE a.filespace_id = f.id AND a.role = 'owner') AS owner_count
    FROM filespaces f
    ORDER BY lower(f.name), f.id
    LIMIT 500
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, ownerCount: Number(r.owner_count) || 0 }));
}

/** Live files under one drive's prefix, by kind — the drive drawer's "Usage by type". */
export async function driveKindUsage(prefix) {
  const p = normPrefix(prefix);
  if (!sql || !p) return [];
  await ensureFilesTable();
  const like = `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
  const rows = await sql`
    SELECT kind, COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes
    FROM files WHERE deleted_at IS NULL AND storage_key LIKE ${like}
    GROUP BY kind
  `;
  return rows.map((r) => ({ kind: r.kind || 'other', ...usageOf(r) }));
}

/**
 * Who added the most: live bytes by uploader, biggest first. Files with no
 * recorded uploader (from before uploads were attributed, or dropped into a
 * mount) are counted apart, as `unattributed`.
 */
export async function storageByPerson({ limit = 10 } = {}) {
  if (!sql) return { people: [], unattributed: { files: 0, bytes: 0 } };
  await ensureFilesTable();
  const [people, none] = await Promise.all([
    sql`
      SELECT lower(created_by) AS email, COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes
      FROM files WHERE deleted_at IS NULL AND COALESCE(created_by, '') <> ''
      GROUP BY 1 ORDER BY bytes DESC, email LIMIT ${limit}`,
    sql`
      SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes
      FROM files WHERE deleted_at IS NULL AND COALESCE(created_by, '') = ''`,
  ]);
  return { people: people.map((r) => ({ email: r.email, ...usageOf(r) })), unattributed: usageOf(none[0]) };
}

/** The library's live files and its trash, in one query — Admin → Overview's storage tile. */
export async function usageTotals() {
  if (!sql) return { live: { files: 0, bytes: 0 }, trash: { files: 0, bytes: 0 } };
  await ensureFilesTable();
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS live_files,
      COALESCE(SUM(size) FILTER (WHERE deleted_at IS NULL), 0)::bigint AS live_bytes,
      COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS trash_files,
      COALESCE(SUM(size) FILTER (WHERE deleted_at IS NOT NULL), 0)::bigint AS trash_bytes
    FROM files
  `;
  const r = rows[0] || {};
  return {
    live: usageOf({ files: r.live_files, bytes: r.live_bytes }),
    trash: usageOf({ files: r.trash_files, bytes: r.trash_bytes }),
  };
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
  if (!n) return bad('Give the drive a name.');
  if (n.length > 80) return bad('Keep the name under 80 characters.');
  if (!p) return bad('A drive needs a folder in the bucket. It cannot be the whole bucket.');
  if (p.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return bad('The folder in the bucket has an empty or relative part.');
  if (RESERVED_FILESPACE_ROOTS.has(p.split('/')[0])) return bad(`"${p.split('/')[0]}" is reserved for previews and the trash.`);
  const lower = n.toLowerCase();
  if (others.some((o) => String(o.name || '').trim().toLowerCase() === lower)) return { status: 409, error: `A drive called "${n}" already exists.` };
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
 *
 * An admin is a member only as an owner: they reach every drive already, so
 * a viewer or editor row would say nothing, where an owner row says whose
 * the drive is (lib/drive-access.js). A change that would leave the drive
 * with no owner is the statement's to refuse or hand on (grantFilespaceAccess,
 * revokeFilespaceAccess), not this.
 */
export function filespaceMemberDecision({ actor = {}, actorRole = null, targetEmail, targetIsAdmin = false, targetCanSignIn = true, grant = true, role = 'viewer' } = {}) {
  const e = String(targetEmail || '').trim().toLowerCase();
  if (!e || !e.includes('@')) return { status: 400, error: 'Enter an email address.' };
  if (!actor.isAdmin && actorRole !== 'owner') return { status: 403, error: 'Only admins and owners of this drive can manage its members.' };
  if (grant && targetIsAdmin && role !== 'owner') return { status: 400, error: 'This person is an admin and reaches every drive already. An admin can be a drive’s owner, but not a viewer or an editor.' };
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

/**
 * Where a change to `e`'s grant would leave a drive: their role in it now,
 * and whether anyone else owns it. A fragment, for the one statement that
 * makes the change, so both are read in that statement's own snapshot
 * rather than a moment before it.
 */
const ownersBefore = (filespaceId, e) => sql`
  SELECT (SELECT role FROM filespace_access WHERE filespace_id = ${filespaceId} AND user_email = ${e}) AS role,
         EXISTS (SELECT 1 FROM filespace_access
                  WHERE filespace_id = ${filespaceId} AND role = 'owner' AND user_email <> ${e}) AS others`;

// The fallback owner, unless it is the person being changed: making them the
// owner would only undo the change (ownerOfLastResort, lib/drive-access.js).
const fallbackFor = (fallbackOwner, e) => {
  const f = normEmail(fallbackOwner);
  return f && f !== e ? f : null;
};

/**
 * Give someone a role in a drive, or change theirs — never leaving the drive
 * with no owner (lib/drive-access.js). When the change takes its last owner
 * away (making them an editor or a viewer), `fallbackOwner`, the admin
 * making it, becomes the owner in the same statement; without one the
 * change is refused and nothing is written.
 *
 * → { member, claimedBy, refused }: the grant as it now stands (null when
 * refused), and who became the owner, when someone did.
 *
 * One statement, since this module cannot use sql.begin (see the client
 * notes at the top): it reads the drive's owners and writes in the same
 * snapshot. Two owners removed at the same instant, each by a statement
 * that saw the other, can still both go; Admin → Overview flags a drive
 * left like that, with the fix beside it.
 */
export async function grantFilespaceAccess({ filespaceId, email, role = 'viewer', grantedBy, fallbackOwner = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureFilespacesTables();
  const e = normEmail(email);
  if (!filespaceId || !e) throw new Error('filespaceId and email required');
  const r = isFilespaceRole(role) ? role : 'viewer';
  const fallback = fallbackFor(fallbackOwner, e);
  const now = Date.now();
  const [row] = await sql`
    WITH was AS (${ownersBefore(filespaceId, e)}),
    ok AS (
      SELECT (${r}::text = 'owner' OR was.role IS DISTINCT FROM 'owner' OR was.others OR ${fallback}::text IS NOT NULL) AS go,
             (${r}::text <> 'owner' AND was.role = 'owner' AND NOT was.others) AS orphans
        FROM was
    ), put AS (
      INSERT INTO filespace_access (filespace_id, user_email, role, granted_by, granted_at)
      SELECT ${filespaceId}, ${e}, ${r}, ${grantedBy || null}, ${now} FROM ok WHERE ok.go
      ON CONFLICT (filespace_id, user_email)
      DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
      RETURNING *
    ), claim AS (
      INSERT INTO filespace_access (filespace_id, user_email, role, granted_by, granted_at)
      SELECT ${filespaceId}, ${fallback}, 'owner', ${fallback}, ${now} FROM ok, put
       WHERE ok.orphans AND ${fallback}::text IS NOT NULL
      ON CONFLICT (filespace_id, user_email)
      DO UPDATE SET role = 'owner', granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
      RETURNING user_email
    )
    SELECT put.*, (SELECT user_email FROM claim) AS claimed_by, NOT ok.go AS refused
      FROM ok LEFT JOIN put ON true`;
  const refused = !!row?.refused;
  return { member: refused ? null : shapeMember(row), claimedBy: row?.claimed_by || null, refused };
}
// Alias for shorter call sites.
export const grantAccess = grantFilespaceAccess;

/**
 * Take someone's grant away — never leaving the drive with no owner: when
 * they are its last one, `fallbackOwner` (the admin removing them) becomes
 * its owner in the same statement, and without one nothing is removed.
 * → { ok, removed, claimedBy, refused }; grantFilespaceAccess says the rest.
 */
export async function revokeFilespaceAccess({ filespaceId, email, fallbackOwner = null } = {}) {
  if (!sql) return { ok: false };
  await ensureFilespacesTables();
  const e = normEmail(email);
  if (!filespaceId || !e) return { ok: false };
  const fallback = fallbackFor(fallbackOwner, e);
  const now = Date.now();
  const [row] = await sql`
    WITH was AS (${ownersBefore(filespaceId, e)}),
    ok AS (
      SELECT (was.role IS DISTINCT FROM 'owner' OR was.others OR ${fallback}::text IS NOT NULL) AS go,
             (was.role = 'owner' AND NOT was.others) AS orphans
        FROM was
    ), gone AS (
      DELETE FROM filespace_access a USING ok
       WHERE ok.go AND a.filespace_id = ${filespaceId} AND a.user_email = ${e}
      RETURNING a.role
    ), claim AS (
      INSERT INTO filespace_access (filespace_id, user_email, role, granted_by, granted_at)
      SELECT ${filespaceId}, ${fallback}, 'owner', ${fallback}, ${now} FROM ok, gone
       WHERE ok.orphans AND ${fallback}::text IS NOT NULL
      ON CONFLICT (filespace_id, user_email)
      DO UPDATE SET role = 'owner', granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
      RETURNING user_email
    )
    SELECT (SELECT COUNT(*) FROM gone)::int AS removed, (SELECT user_email FROM claim) AS claimed_by, NOT ok.go AS refused
      FROM ok`;
  const refused = !!row?.refused;
  return { ok: !refused, removed: Number(row?.removed) > 0, claimedBy: row?.claimed_by || null, refused };
}
export const revokeAccess = revokeFilespaceAccess;

/**
 * Make `by`, an admin, the owner of each of these drives that has no owner —
 * and only those: one that has an owner by now is left as it is, so this
 * never does more than the confirm in front of it named (Admin → Overview,
 * POST /api/admin/filespaces/claim). An admin who already holds a lesser
 * grant there has it raised. One statement. → [{ id, name }] claimed.
 */
export async function claimOwnerlessDrives(ids = [], by) {
  const e = normEmail(by);
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!sql || !e || !list.length) return [];
  await ensureFilespacesTables();
  const now = Date.now();
  const rows = await sql`
    WITH target AS (
      SELECT f.id, f.name FROM filespaces f
       WHERE f.id = ANY(${list}::text[])
         AND NOT EXISTS (SELECT 1 FROM filespace_access a WHERE a.filespace_id = f.id AND a.role = 'owner')
    ), claimed AS (
      INSERT INTO filespace_access (filespace_id, user_email, role, granted_by, granted_at)
      SELECT id, ${e}, 'owner', ${e}, ${now} FROM target
      ON CONFLICT (filespace_id, user_email)
      DO UPDATE SET role = 'owner', granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
      RETURNING filespace_id
    )
    SELECT t.id, t.name FROM target t JOIN claimed c ON c.filespace_id = t.id
     ORDER BY lower(t.name), t.id`;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

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
// Sign-in passwords
//
// Onyx signs people in with an emailed link. A few accounts cannot use one —
// App Review's, whose inbox nobody at Apple reads — so an admin can give an
// account a password (POST /api/admin/passwords), and the sign-in page takes
// it (lib/password-signin.js). Never an admin's account: that module says why.
//
// A table of its own rather than a column on people. Every read of a person
// is SELECT p.* into shapePerson, and a hash there would be one careless
// spread away from a response. Here it is read by getSignInPassword, for
// checking a password, and by nothing else.
//
//   sign_in_passwords — an address's scrypt hash (lib/passwords.js), who set
//                       it and when, and its wrong guesses since the last lock
// ─────────────────────────────────────────────────────────────────────────
const ensureSignInPasswordsTable = lazySchema('ensureSignInPasswordsTable', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS sign_in_passwords (
      email         TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      set_at        BIGINT NOT NULL,
      set_by        TEXT,
      failures      INT NOT NULL DEFAULT 0,
      locked_until  BIGINT
    )
  `;
});

/**
 * Give an address a password, replacing any it had and forgetting its wrong
 * guesses. `hash` is lib/passwords.js hashPassword's; the password itself
 * never reaches this module.
 */
export async function setSignInPassword(email, { hash, by = null } = {}) {
  if (!sql) throw new Error('Database not configured');
  const e = normEmail(email);
  if (!e.includes('@')) throw new Error('A valid email is required.');
  if (typeof hash !== 'string' || !hash.startsWith('scrypt$')) throw new Error('A password hash is required.');
  await ensureSignInPasswordsTable();
  const now = Date.now();
  const rows = await withSchemaRetry(ensureSignInPasswordsTable, () => sql`
    INSERT INTO sign_in_passwords (email, password_hash, set_at, set_by, failures, locked_until)
    VALUES (${e}, ${hash}, ${now}, ${by || null}, 0, NULL)
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      set_at        = EXCLUDED.set_at,
      set_by        = EXCLUDED.set_by,
      failures      = 0,
      locked_until  = NULL
    RETURNING email, set_at, set_by`);
  const r = rows[0];
  return { email: r.email, setAt: Number(r.set_at), setBy: r.set_by || null };
}

/** Take an address's password away. → whether it had one. */
export async function removeSignInPassword(email) {
  const e = normEmail(email);
  if (!sql || !e) return false;
  await ensureSignInPasswordsTable();
  const rows = await withSchemaRetry(ensureSignInPasswordsTable, () => sql`
    DELETE FROM sign_in_passwords WHERE email = ${e} RETURNING email`);
  return rows.length > 0;
}

/**
 * An address's password as stored — { hash, failures, lockedUntil, setAt }
 * or null — for checking one at sign-in and for nothing else. What shows who
 * has a password reads listSignInPasswordHolders, which has no hash in it.
 */
export async function getSignInPassword(email) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  await ensureSignInPasswordsTable();
  const rows = await withSchemaRetry(ensureSignInPasswordsTable, () => sql`
    SELECT password_hash, failures, locked_until, set_at FROM sign_in_passwords WHERE email = ${e} LIMIT 1`);
  const r = rows[0];
  if (!r) return null;
  return {
    hash: r.password_hash,
    failures: Number(r.failures) || 0,
    lockedUntil: r.locked_until != null ? Number(r.locked_until) : null,
    setAt: Number(r.set_at) || null,
  };
}

/**
 * A wrong password. Counts it, and on the MAX_SIGN_IN_FAILURES-th locks the
 * password for SIGN_IN_LOCK_MS and starts the count again — in one
 * statement, as a share link's lockout is, so guesses racing each other
 * cannot all slip in under the limit.
 */
export async function recordSignInPasswordFailure(email) {
  const e = normEmail(email);
  if (!sql || !e) return null;
  const now = Date.now();
  const rows = await withSchemaRetry(ensureSignInPasswordsTable, () => sql`
    UPDATE sign_in_passwords SET
      failures = CASE WHEN failures + 1 >= ${MAX_SIGN_IN_FAILURES} THEN 0 ELSE failures + 1 END,
      locked_until = CASE WHEN failures + 1 >= ${MAX_SIGN_IN_FAILURES} THEN ${now + SIGN_IN_LOCK_MS} ELSE locked_until END
    WHERE email = ${e}
    RETURNING failures, locked_until`);
  const r = rows[0];
  return r ? { failures: Number(r.failures) || 0, lockedUntil: r.locked_until != null ? Number(r.locked_until) : null } : null;
}

/** The right password: wrong guesses before it stop counting towards a lock. */
export async function clearSignInPasswordFailures(email) {
  const e = normEmail(email);
  if (!sql || !e) return;
  try {
    await sql`
      UPDATE sign_in_passwords SET failures = 0, locked_until = NULL
      WHERE email = ${e} AND (failures > 0 OR locked_until IS NOT NULL)`;
  } catch { /* the next sign-in counts from where this left it */ }
}

/** Every address with a password, for the admin panel: { email, setAt, setBy } — never the hash. */
export async function listSignInPasswordHolders() {
  if (!sql) return [];
  await ensureSignInPasswordsTable();
  const rows = await withSchemaRetry(ensureSignInPasswordsTable, () => sql`
    SELECT email, set_at, set_by FROM sign_in_passwords ORDER BY email`);
  return rows.map((r) => ({ email: r.email, setAt: Number(r.set_at) || null, setBy: r.set_by || null }));
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
  // For an 'oauth' code (an MCP client such as Claude, lib/oauth.js): the
  // client it was issued to and where it was sent, both checked again when
  // it is exchanged.
  await sql`ALTER TABLE desktop_auth_codes ADD COLUMN IF NOT EXISTS client_id TEXT`;
  await sql`ALTER TABLE desktop_auth_codes ADD COLUMN IF NOT EXISTS redirect_uri TEXT`;
  // OAuth clients that registered themselves (RFC 7591): only where they may
  // be sent back to, and what to call them. Public clients — no secret; PKCE
  // is what binds a code to whoever asked for it.
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at BIGINT NOT NULL
    )
  `;
  // When a person last allowed it: registering is open to anyone, so a
  // client no one ever allowed is cleared out after a day.
  await sql`ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS allowed_at BIGINT`;
});

/** Register an OAuth client (lib/oauth.js validateRegistration checked it). */
export async function registerOAuthClient({ name, redirectUris }) {
  if (!sql) throw new Error('Database not configured');
  await ensureDesktopAuthTables();
  const id = `onyx_${_b64url(_randBytes(18))}`;
  const now = Date.now();
  await withSchemaRetry(ensureDesktopAuthTables, () => sql`
    INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
    VALUES (${id}, ${name}, ${sql.json(redirectUris)}, ${now})`);
  await sql`DELETE FROM oauth_clients WHERE allowed_at IS NULL AND created_at < ${now - 24 * 60 * 60_000}`.catch(() => {});
  return { id, name, redirectUris, createdAt: now };
}

/** A person allowed the client: it is kept. */
export async function markOAuthClientAllowed(id) {
  if (!sql || !id) return;
  await sql`UPDATE oauth_clients SET allowed_at = ${Date.now()} WHERE id = ${String(id)}`.catch(() => {});
}

export async function getOAuthClient(id) {
  if (!sql || !id) return null;
  await ensureDesktopAuthTables();
  const [r] = await withSchemaRetry(ensureDesktopAuthTables, () => sql`SELECT * FROM oauth_clients WHERE id = ${String(id)}`);
  return r ? { id: r.id, name: r.name, redirectUris: Array.isArray(r.redirect_uris) ? r.redirect_uris : [], createdAt: Number(r.created_at) } : null;
}

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
export async function createDesktopAuthCode({ email, codeChallenge = null, kind = 'pkce', label = null, deviceTokenId = null, clientId = null, redirectUri = null, ttlMs = 5 * 60 * 1000 } = {}) {
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
    INSERT INTO desktop_auth_codes (code, email, code_challenge, kind, label, device_token_id, client_id, redirect_uri, claimed, created_at, expires_at)
    VALUES (${code}, ${e}, ${codeChallenge}, ${kind}, ${label}, ${deviceTokenId}, ${clientId}, ${redirectUri}, ${kind !== 'pairing'}, ${now}, ${expiresAt})
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
    clientId: r.client_id || null, redirectUri: r.redirect_uri || null,
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
  return {
    id: r.id, email: r.email, label: r.label || null, createdAt: Number(r.created_at) || null,
    expiresAt: r.expires_at != null ? Number(r.expires_at) : null,
    lastUsedAt: r.last_used_at != null ? Number(r.last_used_at) : null,
  };
}

/**
 * How often a device token's last use is written: at most once in this long.
 * Onyx for Mac asks something every few seconds while it syncs, and writing
 * the row on every request — some fifty thousand writes a day per Mac — kept
 * to the second a time the People list only sorts by and shows. Five minutes
 * is still finer than a person's own "last seen" (ten, lib/session.js).
 */
export const DESKTOP_TOKEN_TOUCH_MS = 5 * 60_000;

/**
 * Last used, for the People list and a person's devices; true when it was
 * written. `lastUsedAt` is the time on the row the caller just read
 * (getDesktopTokenByRaw): inside the window nothing is sent at all, and past
 * it the WHERE keeps two instances that both read the older time from both
 * writing.
 */
export async function touchDesktopToken(id, { lastUsedAt = null } = {}) {
  if (!sql || !id) return false;
  const now = Date.now();
  if (lastUsedAt != null && now - Number(lastUsedAt) < DESKTOP_TOKEN_TOUCH_MS) return false;
  await ensureDesktopAuthTables();
  try {
    const rows = await sql`
      UPDATE desktop_tokens SET last_used_at = ${now}
      WHERE id = ${id} AND (last_used_at IS NULL OR last_used_at < ${now - DESKTOP_TOKEN_TOUCH_MS})
      RETURNING id`;
    return rows.length > 0;
  } catch {
    return false;
  }
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

