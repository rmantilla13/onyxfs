// Every query in lib/db.js carries a deadline, enforced at the driver.
//
// Why this exists: production logged 36 gateway timeouts in three hours,
// across every route that touches Postgres — including /api/health, whose
// only statement is SELECT 1. Each sat the full 300 seconds before Vercel
// killed it. `withDeadline` guarded five queries out of 194; a wedged pooled
// connection hung the other 189 until the platform gave up.
//
// Moving the deadline into the driver is a change to EVERY query in the app,
// so it is tested against a real Postgres rather than a stub. The interesting
// cases are not "does a timeout fire" — they are the three ways a blanket
// wrapper can quietly break a working app:
//
//   · a fragment (sql`AND kind = ${k}` interpolated into another template)
//     must stay a fragment and must NOT be executed or armed;
//   · .unsafe(text, params), which is how half this module queries;
//   · the client must still work AFTER a deadline fires, or one slow
//     statement poisons the rest of the request.
//
// Runs only when a Postgres is reachable. Set TEST_DATABASE_URL to a throwaway
// database; without it the file skips rather than failing the suite.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const URL_ = process.env.TEST_DATABASE_URL;
const describeDb = URL_ ? describe : describe.skip;

describeDb('driver-level query deadlines', () => {
  let raw, sql, postgres, withQueryDeadlines;

  before(async () => {
    ({ default: postgres } = await import('postgres'));
    ({ withQueryDeadlines } = await import('../lib/db.js'));
    raw = postgres(URL_, { prepare: false, max: 1, idle_timeout: 20, transform: { undefined: null } });
    sql = withQueryDeadlines(raw, 700);
  });

  after(async () => { await raw?.end({ timeout: 5 }); });

  test('an ordinary query still returns its rows', async () => {
    const rows = await sql`SELECT 1 AS n, 'x' AS s`;
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].n), 1);
    assert.equal(rows[0].s, 'x');
  });

  test('parameters are still parameters, not interpolation', async () => {
    const evil = "'; DROP TABLE nope; --";
    const rows = await sql`SELECT ${evil}::text AS v`;
    assert.equal(rows[0].v, evil);
  });

  test('.unsafe(text, params) works and is armed', async () => {
    const rows = await sql.unsafe('SELECT $1::int AS n', [7]);
    assert.equal(Number(rows[0].n), 7);
  });

  test('a fragment interpolated into another query is not executed on its own', async () => {
    // THE regression this wrapper could cause. A fragment is a Query object
    // that is never awaited; arming it on creation would either execute it as
    // a standalone statement (a syntax error) or leave a timer running.
    const where = sql`WHERE n > ${1}`;
    const rows = await sql`SELECT * FROM (SELECT 1 AS n UNION SELECT 2) t ${where}`;
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].n), 2);
  });

  test('several fragments compose', async () => {
    const a = sql`AND n < ${3}`;
    const b = sql`AND n > ${1}`;
    const rows = await sql`SELECT * FROM (SELECT generate_series(1,5) AS n) t WHERE true ${a} ${b}`;
    assert.deepEqual(rows.map((r) => Number(r.n)), [2]);
  });

  describe('when a statement outlives its deadline', () => {
    test('it rejects at the deadline instead of running to completion', async () => {
      const t0 = Date.now();
      await assert.rejects(
        () => sql`SELECT pg_sleep(30)`,
        (e) => /exceeded 700ms and was cancelled/.test(e.message),
      );
      const took = Date.now() - t0;
      // The point of the whole change: bounded, and nowhere near the 30s the
      // statement asked for (nor the platform's 300s).
      assert.ok(took < 5_000, `rejected after ${took}ms, which is not a deadline`);
    });

    test('the error names the statement, so a log line is diagnosable', async () => {
      await assert.rejects(
        () => sql`SELECT pg_sleep(30) /* marker */`,
        (e) => e.message.includes('pg_sleep'),
      );
    });

    test('the client still works afterwards', async () => {
      // If a timed-out query left the connection unusable, this fix would be
      // worse than the bug: one slow statement would poison the request.
      await assert.rejects(() => sql`SELECT pg_sleep(30)`);
      const rows = await sql`SELECT 42 AS n`;
      assert.equal(Number(rows[0].n), 42);
    });

    test('the statement is actually cancelled server-side, not just abandoned', async () => {
      // Abandoning it would leave pg_sleep(30) holding a pooler connection for
      // 30 more seconds — the convoy that caused this in the first place.
      await assert.rejects(() => sql`SELECT pg_sleep(30) /* cancel-probe */`);
      await new Promise((r) => setTimeout(r, 500));
      // `pid <> pg_backend_pid()` is not optional: without it this statement
      // matches its own text in pg_stat_activity and the check can never pass.
      const [{ n }] = await sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE query LIKE '%cancel-probe%' AND state = 'active' AND pid <> pg_backend_pid()`;
      assert.equal(n, 0, 'the cancelled statement is still running on the server');
    });
  });

  test('a deadline is per-query, not per-client', async () => {
    await assert.rejects(() => sql`SELECT pg_sleep(30)`);
    for (let i = 0; i < 3; i++) {
      const rows = await sql`SELECT ${i}::int AS n`;
      assert.equal(Number(rows[0].n), i);
    }
  });

  test('awaiting the same query twice does not double-arm', async () => {
    const q = sql`SELECT 5 AS n`;
    const [a, b] = [await q, await q];
    assert.equal(Number(a[0].n), 5);
    assert.equal(Number(b[0].n), 5);
  });
});

// ── What we are actually dialling ──────────────────────────────────────────
// Production reached a state where every query timed out but nothing errored:
// /api/files answered 200 with an empty library because the read blew its
// deadline. Timeouts landing exactly on the deadline, on every query
// including SELECT 1, point at time spent GETTING a connection rather than
// running a statement — and the usual cause is a connection string aimed at
// Postgres directly instead of at the pooler.
//
// That is invisible from outside: DATABASE_URL is a secret, so the one number
// that settles it (the port) cannot be read from the dashboard. The app
// reports it itself, which makes the redaction below a security property and
// not a nicety.

const { describeConnection } = await import('../lib/db.js');

describe('describeConnection', () => {
  const SECRET = 'sup3r-s3cret-pw';
  const url = (host, port, qs = '') => `postgresql://postgres.abc:${SECRET}@${host}:${port}/postgres${qs}`;

  test('never puts the password or user in the label', () => {
    // THE property. This string goes to a log aggregator.
    for (const host of ['aws-0-us-east-1.pooler.supabase.com', 'db.abcdefghij.supabase.co', 'localhost']) {
      for (const port of ['5432', '6543']) {
        const { label, warn } = describeConnection(url(host, port, '?sslmode=require'));
        const emitted = `${label} ${warn || ''}`;
        assert.ok(!emitted.includes(SECRET), `password leaked for ${host}:${port}`);
        assert.ok(!emitted.includes('postgres.abc'), `username leaked for ${host}:${port}`);
      }
    }
  });

  test('names the transaction pooler and says nothing more', () => {
    const { label, warn } = describeConnection(url('aws-0-us-east-1.pooler.supabase.com', '6543'));
    assert.match(label, /transaction mode/);
    assert.equal(warn, null, 'the correct configuration must not produce a warning');
  });

  test('flags the session-mode pooler', () => {
    // Port 5432 on the pooler host is session mode: one server connection per
    // client for the whole session, which serverless exhausts immediately.
    const { label, warn } = describeConnection(url('aws-0-us-east-1.pooler.supabase.com', '5432'));
    assert.match(label, /SESSION mode/);
    assert.match(warn, /6543/);
  });

  test('flags the direct connection, which is the one that produces this symptom', () => {
    const { label, warn } = describeConnection(url('db.abcdefghij.supabase.co', '5432'));
    assert.match(label, /DIRECT/);
    assert.match(warn, /pooler\.supabase\.com/);
    assert.match(warn, /6543/);
  });

  test('a non-Supabase host is described without a verdict', () => {
    const { label, warn } = describeConnection(url('localhost', '5432'));
    assert.match(label, /localhost:5432/);
    assert.equal(warn, null);
  });

  test('the port is reported even when the URL omits it', () => {
    const { label } = describeConnection('postgresql://u:p@example.com/postgres');
    assert.match(label, /example\.com:5432/, 'an absent port still decides pooler vs direct');
  });

  test('query parameters are surfaced, since pgbouncer/sslmode change behaviour', () => {
    const { label } = describeConnection(url('localhost', '5432', '?sslmode=require&pgbouncer=true'));
    assert.match(label, /sslmode=require/);
    assert.match(label, /pgbouncer=true/);
  });

  test('an unparseable string does not throw at module load', () => {
    // This runs at import time. Throwing here would take down every route
    // rather than logging that the variable is malformed.
    const { label } = describeConnection('this is not a url');
    assert.match(label, /unparseable/);
  });
});
