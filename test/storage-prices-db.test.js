// storage_prices against a real Postgres, and the route that writes it
// (PUT and DELETE /api/admin/storage-prices): set, replace, clear and list;
// who set a price and when; dollars kept exactly as typed; the 400s a bad
// field gets and the 404 an account the library does not use gets; and an
// audit row for each change.
//
// Runs only with TEST_DATABASE_URL (a database you can write to), and skips
// cleanly without one, like the other database tests. The session is
// stubbed ('@/auth' → the admin this file makes up), and so are the accounts
// in use ('@/lib/storage-accounts'): they come from the deployment's storage
// config, which another test file sets while it runs, and changing it here
// would race it. Every row is under a random host and removed at the end.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const URL_ = process.env.TEST_DATABASE_URL;

async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; }
  catch { return false; }
  finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}

const live = await reachable(URL_);
const describeDb = live ? describe : describe.skip;

const T = `sp${Math.random().toString(36).slice(2, 8)}`;
const ADMIN = `admin-${T}@prices.test`;
const B2 = `b2|s3.${T}.backblazeb2.com|`;
const MINIO = `other|minio.${T}.test:9000|`;
const UNUSED = `wasabi|s3.${T}.wasabisys.com|`;

process.env.DATABASE_URL = live ? URL_ : 'postgres://nobody@127.0.0.1:1/none';
process.env.ADMIN_EMAILS = ADMIN;
process.env.SCHEMA_MANAGED = '0';

globalThis.__spSession = null;
globalThis.__spAccounts = [];
const AUTH = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__spSession; }')}`;
const ACCOUNTS = `data:text/javascript,${encodeURIComponent('export async function storageAccountsInUse() { return { mode: "s3", accounts: globalThis.__spAccounts }; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH, shortCircuit: true };
    if (specifier === '@/lib/storage-accounts') return { url: ACCOUNTS, shortCircuit: true };
    return next(specifier, context);
  },
});

describeDb('storage prices of our own (database)', () => {
  let db; let route;

  before(async () => {
    db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    assert.deepEqual(results.filter((r) => !r.ok), [], 'every guard runs on this database');
    route = await import('../app/api/admin/storage-prices/route.js');
    globalThis.__spSession = { user: { email: ADMIN } };
    globalThis.__spAccounts = [{ account: B2 }, { account: MINIO }];
  });

  after(async () => {
    if (!db) return;
    await db.sql`DELETE FROM storage_prices WHERE account IN (${B2}, ${MINIO}, ${UNUSED})`.catch(() => {});
    await db.sql`DELETE FROM audit_events WHERE actor = ${ADMIN}`.catch(() => {});
    await db.removePerson(ADMIN, { apply: true }).catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  const call = async (method, body) => {
    const res = await route[method](new Request('http://app.test/api/admin/storage-prices', {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => null), cache: res.headers.get('cache-control') };
  };
  const mine = async () => (await db.listStoragePrices()).filter((p) => [B2, MINIO, UNUSED].includes(p.account));

  test('the table: set, replace, list and clear, with who and when', async () => {
    const first = await db.setStoragePrice(UNUSED, {
      rate: 0.00595, unit: 'GB', base: 1024, freeBytes: 0, minimumBytes: 2 ** 40, fee: 0, note: 'Old contract',
    }, { by: ADMIN.toUpperCase() });
    assert.equal(first.rate, 0.00595, 'the dollars as typed');
    assert.equal(first.minimumBytes, 2 ** 40);
    assert.equal(first.setBy, ADMIN, 'who set it, lowercased');
    assert.ok(first.setAt > 0);

    const second = await db.setStoragePrice(UNUSED, {
      rate: 5.5, unit: 'TB', base: 1000, freeBytes: 10e9, minimumBytes: 0, fee: 12.34, note: null,
    }, { by: ADMIN });
    assert.deepEqual(
      (await mine()).filter((p) => p.account === UNUSED).map(({ setAt, ...p }) => p),
      [{ account: UNUSED, rate: 5.5, unit: 'TB', base: 1000, freeBytes: 10e9, minimumBytes: 0, fee: 12.34, note: null, setBy: ADMIN }],
      'one row per account, replaced whole',
    );
    assert.ok(second.setAt >= first.setAt);

    const removed = await db.removeStoragePrice(UNUSED);
    assert.equal(removed.rate, 5.5, 'the row it had, for the audit');
    assert.equal(await db.removeStoragePrice(UNUSED), null, 'clearing again finds nothing');
    assert.deepEqual(await mine(), []);
  });

  test('PUT sets a price for an account in use, and says what it saved', async () => {
    const r = await call('PUT', {
      account: B2, rate: '5.50', unit: 'TB', base: 1000, free: '10', freeUnit: 'GB', minimum: '', minimumUnit: 'TB', fee: '', note: 'Contract 2026',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.cache, 'no-store');
    assert.equal(r.body.price.account, B2);
    assert.equal(r.body.price.rate, 5.5);
    assert.equal(r.body.price.freeBytes, 10e9);
    assert.equal(r.body.price.setBy, ADMIN);
    assert.equal(r.body.price.note, 'Contract 2026');

    const again = await call('PUT', { account: B2, rate: 6, unit: 'TB', base: 1000 });
    assert.equal(again.status, 200);
    const [row] = (await mine()).filter((p) => p.account === B2);
    assert.equal(row.rate, 6, 'replaced');
    assert.equal(row.freeBytes, 0, 'fields left out are none, not kept');
    assert.equal(row.note, null);
  });

  test('a service with no list price can be given one', async () => {
    const r = await call('PUT', { account: MINIO, rate: 0, unit: 'TB', base: 1024, fee: 500, note: 'Our own servers' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.price.fee, 500);
  });

  test('a bad field is a 400 that says which, and nothing is saved', async () => {
    const before = await mine();
    for (const [body, pattern] of [
      [{ account: B2, rate: '6.95', unit: 'GB', base: 1000 }, /per TB or per GB/],
      [{ account: B2, rate: '-1', unit: 'TB', base: 1000 }, /0 or more/],
      [{ account: B2, rate: '5', unit: 'TB', base: 999 }, /1,024 GB/],
      [{ account: B2, rate: '5', unit: 'TB', base: 1000, note: 'x'.repeat(201) }, /200 characters/],
      [{ account: 'nowhere', rate: '5', unit: 'TB', base: 1000 }, /which account/],
      [[], /object/],
    ]) {
      const r = await call('PUT', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, pattern);
    }
    assert.deepEqual(await mine(), before);
  });

  test('an account the library keeps nothing on is a 404', async () => {
    const r = await call('PUT', { account: UNUSED, rate: 5, unit: 'TB', base: 1024 });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /does not keep files on that account/);
    assert.equal((await mine()).some((p) => p.account === UNUSED), false);
  });

  test('DELETE goes back to the list price, and any account’s price may go', async () => {
    const r = await call('DELETE', { account: B2 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, removed: true });
    assert.equal((await mine()).some((p) => p.account === B2), false);
    assert.deepEqual((await call('DELETE', { account: B2 })).body, { ok: true, removed: false }, 'nothing left to clear');
    // An account no longer in use keeps its price until someone removes it.
    await db.setStoragePrice(UNUSED, { rate: 1, unit: 'TB', base: 1024, freeBytes: 0, minimumBytes: 0, fee: 0, note: null }, { by: ADMIN });
    assert.deepEqual((await call('DELETE', { account: UNUSED })).body, { ok: true, removed: true });
    assert.equal((await call('DELETE', { account: 'b2|' })).status, 400);
  });

  test('each change is in the audit log, with what the price was and became', async () => {
    const rows = await db.sql`
      SELECT action, subject_id, subject_label, detail FROM audit_events
      WHERE actor = ${ADMIN} AND subject_type = 'storage-account'`;
    // Two in one millisecond have no order to go by, so as a set.
    assert.deepEqual(rows.map((r) => `${r.action} ${r.subject_id}`).sort(), [
      `storage.price.clear ${B2}`, `storage.price.clear ${UNUSED}`,
      `storage.price.set ${B2}`, `storage.price.set ${B2}`, `storage.price.set ${MINIO}`,
    ].sort());
    const sets = rows.filter((r) => r.action === 'storage.price.set' && r.subject_id === B2);
    const first = sets.find((r) => r.detail.from === null);
    const second = sets.find((r) => r.detail.from !== null);
    assert.equal(first.subject_label, `Backblaze B2 · s3.${T}.backblazeb2.com`);
    assert.equal(first.detail.to.rate, 5.5);
    assert.equal(second.detail.from.rate, 5.5);
    assert.equal(second.detail.to.rate, 6);
    const cleared = rows.find((r) => r.action === 'storage.price.clear' && r.subject_id === B2);
    assert.equal(cleared.detail.from.rate, 6);
    assert.equal(rows.some((r) => r.subject_id === UNUSED && r.action === 'storage.price.set'), false, 'the refused PUT left no trace');
  });

  test('without a session, nothing', async () => {
    globalThis.__spSession = null;
    try {
      assert.equal((await call('PUT', { account: B2, rate: 5, unit: 'TB', base: 1000 })).status, 401);
      assert.equal((await call('DELETE', { account: B2 })).status, 401);
    } finally {
      globalThis.__spSession = { user: { email: ADMIN } };
    }
  });
});
