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
import { buildFileQuery, nextCursor, FILE_COLUMNS } from './file-query.js';

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
// These three matter on Vercel and are easy to get wrong:
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
//                    connection per invocation is the safe shape; the few
//                    Promise.all sites in this file serialize instead of
//                    running in parallel, which costs a little latency and no
//                    correctness.
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

// Every query this module issues, armed. Drizzle gets the same client, so the
// Auth.js adapter's reads are bounded too — those sit on the sign-in path,
// which is where a hang is most expensive.
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

let _db = null;
export function getDb() {
  if (!connectionString) {
    throw new Error('Database is not configured — set DATABASE_URL and redeploy. See /api/health.');
  }
  if (!_db) _db = drizzle(sql, { schema: authSchema });
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
    deletedAt: r.deleted_at ? Number(r.deleted_at) : null, trashKey: r.trash_key || null,
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
export async function listFileChanges({ cursor = 0, limit = 500 } = {}) {
  if (!sql) return { changed: [], deleted: [], cursor: 0, done: true };
  await ensureFilesTable();
  await ensureTombstonesTable();
  const from = Number(cursor) || 0;
  const n = Math.min(Math.max(Number(limit) || 500, 1), 1000);

  try {
    // Both sides are read to the same limit and then merged, so a burst of
    // deletions cannot starve out changes or vice versa.
    const [rows, tombs] = await Promise.all([
      withSchemaRetry(ensureFilesTable, () => sql.unsafe(`SELECT ${FILE_COLUMNS} FROM files WHERE seq > $1 ORDER BY seq ASC LIMIT $2`, [from, n])),
      sql.unsafe('SELECT id, seq, folder, storage_key, deleted_at FROM file_tombstones WHERE seq > $1 ORDER BY seq ASC LIMIT $2', [from, n]),
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

    return {
      changed: rows.filter((r) => Number(r.seq) <= next).map(shapeFile),
      deleted: tombs
        .filter((t) => Number(t.seq) <= next)
        .map((t) => ({ id: t.id, folder: t.folder || '', storageKey: t.storage_key || null, deletedAt: Number(t.deleted_at) || null })),
      cursor: next,
      done: !full,
    };
  } catch (e) {
    console.warn('[listFileChanges] failed:', e.message);
    return { changed: [], deleted: [], cursor: from, done: true };
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
    INSERT INTO files (id, name, folder, kind, mime, size, url, storage, storage_key, tags, notes, visibility, thumbnail_url, thumbnail_key, metadata, created_by, created_at, updated_at, seq)
    VALUES (
      ${id}, ${(data.name || 'Untitled').trim()}, ${data.folder || ''}, ${data.kind || 'other'}, ${data.mime || null},
      ${data.size != null ? Number(data.size) : null}, ${data.url}, ${data.storage || 'blob'}, ${data.storageKey || null},
      ${sql.json(normalizeTags(data.tags))}, ${data.notes || null}, ${visibility},
      ${data.thumbnailUrl || null}, ${data.thumbnailKey || null},
      ${sql.json(data.metadata && typeof data.metadata === 'object' ? data.metadata : {})}, ${data.createdBy || null},
      ${data.createdAt != null ? Number(data.createdAt) : now}, ${data.updatedAt != null ? Number(data.updatedAt) : now},
      nextval('files_change_seq')
    )
    RETURNING *
  `;
  return shapeFile(rows[0]);
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
      ? await sql`SELECT folder, COUNT(*)::int AS n FROM files WHERE deleted_at IS NULL AND storage_key LIKE ${sp + '/%'} GROUP BY folder ORDER BY folder ASC`
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
      thumbnail_url = COALESCE(${fields.thumbnailUrl ?? null}, thumbnail_url),
      thumbnail_key = COALESCE(${fields.thumbnailKey ?? null}, thumbnail_key),
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
export async function getFileMetadataSchema() {
  const v = await getSetting('file.metadata.schema');
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

/** Trashed files older than `cutoffMs` (their deleted_at), for the 60-day purge sweep. */
export async function listExpiredTrash(cutoffMs) {
  if (!sql) return [];
  await ensureFilesTable();
  try {
    const rows = await sql`SELECT * FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffMs}`;
    return rows.map(shapeFile);
  } catch (e) { console.warn('[listExpiredTrash] failed:', e.message); return []; }
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
      await sql`DELETE FROM folders WHERE name = ${clean} OR name LIKE ${clean + '/%'}`;
      try { await sql`DELETE FROM folder_access WHERE folder = ${clean} OR folder LIKE ${clean + '/%'}`; } catch {}
    } else {
      await sql`DELETE FROM folders WHERE name = ${clean}`;
    }
  } catch (e) { console.warn('[deleteFolder] failed:', e.message); }
  return { ok: true };
}

/** Rename/move a folder subtree: prefix-rewrite files + folders + folder ACL. */
export async function renameFolder(from, to) {
  if (!sql) throw new Error('Database not configured');
  await ensureFoldersTable();
  const a = String(from || '').replace(/^\/+|\/+$/g, '').trim();
  const b = String(to || '').replace(/^\/+|\/+$/g, '').trim();
  if (!a || !b || a === b) return { ok: false };
  if (b === a || b.startsWith(a + '/')) throw new Error('Cannot move a folder into itself.');
  // Files: exact + descendants.
  await sql`UPDATE files SET folder = ${b}, updated_at = ${Date.now()} WHERE folder = ${a}`;
  await sql`UPDATE files SET folder = ${b} || substring(folder from ${a.length + 1}), updated_at = ${Date.now()} WHERE folder LIKE ${a + '/%'}`;
  // Ensure destination ancestry exists, then move folder rows.
  await createFolder(b);
  const subs = await sql`SELECT name FROM folders WHERE name = ${a} OR name LIKE ${a + '/%'}`;
  for (const r of subs) {
    const np = r.name === a ? b : b + r.name.slice(a.length);
    await sql`UPDATE folders SET name = ${np}, parent = ${_folderParent(np)}, depth = ${_folderDepth(np)} WHERE name = ${r.name}`;
    try { await sql`UPDATE folder_access SET folder = ${np} WHERE folder = ${r.name}`; } catch {}
  }
  return { ok: true, from: a, to: b };
}

async function listFolderNames(filespace) {
  if (!sql) return [];
  try {
    await ensureFoldersTable();
    // When a filespace is given, return only folders created in it (plus legacy
    // folders with no filespace tag, so pre-existing empty folders don't vanish).
    const rows = filespace != null && String(filespace) !== ''
      ? await sql`SELECT name FROM folders WHERE filespace = ${String(filespace)} OR filespace IS NULL OR filespace = '' ORDER BY name ASC`
      : await sql`SELECT name FROM folders ORDER BY name ASC`;
    return rows.map((r) => r.name);
  } catch { return []; }
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
});

export async function createShare({ fileId, createdBy, mode = 'public', expiresInDays, password } = {}) {
  if (!sql) throw new Error('Database not configured');
  await ensureSharesTable();
  if (!fileId) throw new Error('fileId required.');
  const m = mode === 'private' ? 'private' : 'public';
  // One stable link per (file, mode) — reuse if present.
  const existing = await sql`SELECT token FROM file_shares WHERE file_id = ${fileId} AND mode = ${m} ORDER BY created_at ASC LIMIT 1`;
  if (existing[0]) return { token: existing[0].token, mode: m, reused: true };
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
  const passwordHash = password ? await sha256hex(password) : null;
  await sql`INSERT INTO file_shares (token, file_id, created_by, created_at, mode, expires_at, password_hash)
    VALUES (${token}, ${fileId}, ${createdBy || null}, ${Date.now()}, ${m}, ${expiresAt}, ${passwordHash})`;
  return { token, mode: m, reused: false };
}

// Every file inside a folder subtree, scoped to a filespace prefix. Used for
// public folder shares (the share IS the grant, so this bypasses per-file ACL).
export async function listFilesInFolder(folder, storagePrefix) {
  if (!sql) return [];
  await ensureFilesTable();
  const path = String(folder || '');
  const sp = storagePrefix ? String(storagePrefix).replace(/^\/+|\/+$/g, '') : null;
  const rows = sp
    ? await sql`SELECT * FROM files WHERE deleted_at IS NULL AND storage_key LIKE ${sp + '/%'} ORDER BY folder ASC, name ASC`
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
  const passwordHash = password ? await sha256hex(password) : null;
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
  const passwordHash = password ? await sha256hex(password) : null;
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
      if ((await sha256hex(password)) !== s.password_hash) return { needsPassword: true, wrong: true, mode: s.mode || 'public' };
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
    const rows = await sql`SELECT token, mode, expires_at, view_count, created_at, (password_hash IS NOT NULL) AS has_password FROM file_shares WHERE file_id = ${fileId} ORDER BY created_at ASC`;
    return rows.map((r) => ({ token: r.token, mode: r.mode || 'public', expiresAt: r.expires_at != null ? Number(r.expires_at) : null, viewCount: Number(r.view_count) || 0, hasPassword: !!r.has_password, createdAt: Number(r.created_at) || null }));
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
  if (visibility) await setFileVisibility(fileId, visibility);
  return { ok: true };
}

/** Tags present on files the principal can see (facet source). */
export async function listAllTags(principal) {
  const { files } = await listFilesForUser({}, principal);
  const set = new Map();
  for (const f of files) for (const t of (f.tags || [])) {
    const k = String(t); set.set(k.toLowerCase(), k);
  }
  return [...set.values()].sort((a, b) => a.localeCompare(b));
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

export function fileWriteDecision({ file, principal = {}, fileAccess = null, folderRoles = [] } = {}) {
  if (!file) return { allowed: false, reason: 'no-file' };
  // A platform-level viewer never writes, whatever a per-file grant says.
  // The files UI already hides write controls from them; this is the half
  // that a request cannot route around.
  if (principal.roleId === 'viewer' && !principal.isAdmin) return { allowed: false, reason: 'platform-viewer' };
  if (principal.isAdmin) return { allowed: true, reason: 'admin' };

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

  for (const f of list) {
    const folderRoles = _ancestorsOf(f.folder).map((a) => folderRoleMap.get(a)).filter(Boolean);
    const d = fileWriteDecision({ file: f, principal, fileAccess: access.get(f.id) || null, folderRoles });
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

/** Folder tree filtered to what the principal can see (no leaking hidden folders). */
export async function listFileFoldersForUser(principal = {}, opts = {}) {
  const folders = await listFileFolders(opts);
  if (principal.isAdmin) return folders;
  const { files } = await listFilesForUser({ storagePrefix: opts.storagePrefix }, principal);
  // Keep folders that contain a visible file (incl. ancestors) or are explicitly granted.
  const keep = new Set();
  for (const f of files) for (const a of _ancestorsOf(f.folder)) if (a) keep.add(a);
  const fg = await folderGrantsForPrincipal(principal);
  for (const g of fg) if (g) keep.add(g);
  return folders.filter((f) => keep.has(f.folder));
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
  if (!admin) {
    try { folderGrants = [...(await folderGrantsForPrincipal({ email: e, roleId }))]; } catch {}
  }
  return { email: e, isAdmin: admin, roleId, folderGrants };
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

