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
const { lazySchema, withDeadline, shapeMagicLinkRedirect } = await import('../lib/db.js');

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
