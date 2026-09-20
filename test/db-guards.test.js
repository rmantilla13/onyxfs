// Tests for the two pieces of lib/db.js that exist because of a production
// 504: a settings read that blocked until Vercel killed the invocation at
// 300s, preceded by the settings DDL running twice per request.
//
// Both helpers are pure enough to test without a database — lib/db.js loads
// with no connection string and only throws when a query is actually run.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.SCHEMA_MANAGED;
const { lazySchema, withDeadline, shapeMagicLinkRedirect, ensureSchema } = await import('../lib/db.js');

const tick = () => new Promise((r) => setImmediate(r));

describe('lazySchema', () => {
  test('concurrent callers share one run', async () => {
    // THE regression: a boolean flag set after the DDL let every caller that
    // arrived before the first finished run the DDL again.
    let runs = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const ensure = lazySchema('t', async () => { runs++; await gate; });
    const a = ensure();
    const b = ensure();
    const c = ensure();
    assert.equal(runs, 1, 'the DDL ran more than once for concurrent callers');
    release();
    await Promise.all([a, b, c]);
    assert.equal(runs, 1);
  });

  test('success is memoized across later calls', async () => {
    let runs = 0;
    const ensure = lazySchema('t', async () => { runs++; });
    await ensure();
    await ensure();
    await ensure();
    assert.equal(runs, 1);
  });

  test('a failure resolves, warns, and lets the next caller retry', async () => {
    // A broken guard must degrade — the query after it reports the real
    // error — and must not be cached as a success.
    let runs = 0;
    const ensure = lazySchema('t', async () => {
      runs++;
      if (runs === 1) throw new Error('permission denied');
    });
    const warn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      await assert.doesNotReject(() => ensure());
      await ensure();
    } finally {
      console.warn = warn;
    }
    assert.equal(runs, 2, 'the failed run was cached');
    assert.match(warned[0], /\[t\] failed: permission denied/);
  });
});

describe('SCHEMA_MANAGED', () => {
  test('production runs no DDL on the request path by default', async () => {
    // The default is the whole point: nobody remembers to set a flag, and
    // production is where request-path DDL does damage.
    let runs = 0;
    const ensure = lazySchema('default-prod-test', async () => { runs++; });
    const prev = process.env.NODE_ENV;
    delete process.env.SCHEMA_MANAGED;
    process.env.NODE_ENV = 'production';
    try {
      await ensure();
      assert.equal(runs, 0, 'a guard ran DDL on a production request');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('development still self-assembles a fresh database', async () => {
    let runs = 0;
    const ensure = lazySchema('default-dev-test', async () => { runs++; });
    const prev = process.env.NODE_ENV;
    delete process.env.SCHEMA_MANAGED;
    process.env.NODE_ENV = 'development';
    try {
      await ensure();
      assert.equal(runs, 1, 'the lazy guards are what make a dev database work');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('SCHEMA_MANAGED=0 forces the guards back on in production', async () => {
    let runs = 0;
    const ensure = lazySchema('override-test', async () => { runs++; });
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.SCHEMA_MANAGED = '0';
    try {
      await ensure();
      assert.equal(runs, 1, 'the escape hatch does not work');
    } finally {
      process.env.NODE_ENV = prev;
      delete process.env.SCHEMA_MANAGED;
    }
  });

  test('guards skip DDL on the request path but ensureSchema still runs them', async () => {
    let runs = 0;
    const ensure = lazySchema('managed-test', async () => { runs++; });
    process.env.SCHEMA_MANAGED = '1';
    try {
      await ensure();
      await ensure();
      assert.equal(runs, 0, 'a managed guard ran DDL on the request path');
      const results = await ensureSchema();
      const mine = results.find((r) => r.label === 'managed-test');
      assert.ok(mine?.ok, 'ensureSchema did not run the guard');
      assert.equal(runs, 1);
    } finally {
      delete process.env.SCHEMA_MANAGED;
    }
  });

  test('ensureSchema reports a failing guard instead of throwing', async () => {
    lazySchema('broken-test', async () => { throw new Error('nope'); });
    const warn = console.warn;
    console.warn = () => {};
    let results;
    try { results = await ensureSchema(); } finally { console.warn = warn; }
    const broken = results.find((r) => r.label === 'broken-test');
    assert.deepEqual(broken, { label: 'broken-test', ok: false, error: 'nope' });
  });
});

describe('withDeadline', () => {
  test('a prompt query resolves with its rows', async () => {
    const rows = await withDeadline(Promise.resolve([{ value: 1 }]), 1000, 'fast');
    assert.deepEqual(rows, [{ value: 1 }]);
  });

  test('a hung query is cancelled and rejects at the deadline', async () => {
    // The postgres.js shape: a thenable that also carries cancel().
    let cancelled = false;
    const hung = new Promise(() => {});
    hung.cancel = () => { cancelled = true; };
    const t0 = Date.now();
    await assert.rejects(() => withDeadline(hung, 30, 'settings read'), /settings read exceeded 30ms/);
    assert.ok(Date.now() - t0 < 1000, 'did not reject at the deadline');
    assert.equal(cancelled, true, 'the statement was not cancelled server-side');
  });

  test('a query without cancel() still times out', async () => {
    await assert.rejects(() => withDeadline(new Promise(() => {}), 20, 'plain'), /plain exceeded 20ms/);
    await tick();
  });

  test('a late rejection after the deadline is not unhandled', async () => {
    let reject;
    const q = new Promise((_, r) => { reject = r; });
    q.cancel = () => {};
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(() => withDeadline(q, 10, 'late'));
      reject(new Error('canceling statement due to user request'));
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(unhandled, null, `late rejection escaped: ${unhandled}`);
  });
});

describe('shapeMagicLinkRedirect', () => {
  test('exposes the target as targetUrl', () => {
    // Regression: the verify page read row.targetUrl off a raw snake_case row
    // and showed "expired" for every valid link.
    const out = shapeMagicLinkRedirect({ id: 'abc', target_url: 'https://x/cb?token=1', email: 'a@b.c', created_at: '10', expires_at: '20' });
    assert.equal(out.targetUrl, 'https://x/cb?token=1');
    assert.equal(out.expiresAt, 20);
    assert.equal(shapeMagicLinkRedirect(undefined), null);
  });
});

// ── Settings cache ──────────────────────────────────────────────────────────
// Settings are read on every render — including the 404s scanners generate —
// and written when an admin saves a form. The cache is what keeps a slow
// database from being slow once per request rather than once per minute.
describe('settings cache', () => {
  test('invalidateSetting() clears one key and, with no argument, all of them', async () => {
    const { invalidateSetting } = await import('../lib/db.js');
    // Exercised for real by setSetting/deleteSetting; here it just has to be
    // callable both ways without a database.
    assert.doesNotThrow(() => invalidateSetting('brand.config'));
    assert.doesNotThrow(() => invalidateSetting());
  });

  test('the render deadline is short enough to render behind', async () => {
    const { RENDER_DEADLINE_MS, QUERY_DEADLINE_MS } = await import('../lib/db.js');
    // A page that waits the full background deadline looks hung. This is the
    // number that decides how bad a struggling database feels.
    assert.ok(RENDER_DEADLINE_MS <= 5_000, `RENDER_DEADLINE_MS is ${RENDER_DEADLINE_MS}ms`);
    assert.ok(RENDER_DEADLINE_MS < QUERY_DEADLINE_MS);
  });
});
