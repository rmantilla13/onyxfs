// drizzle-orm/postgres-js rewrites the serializers of the client it is given:
// json, jsonb and the timestamp types become pass-throughs. When Auth.js's
// adapter was built over the shared `sql`, every sql.json() in lib/db.js sent
// a raw object to the driver as soon as auth.js loaded — saving a setting and
// recording an upload both failed with ERR_INVALID_ARG_TYPE.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

// Nothing connects until a query runs, so a placeholder URL is enough for the
// structural check.
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
const db = await import('../lib/db.js');

test('building the Auth.js drizzle handle leaves the shared client alone', () => {
  const before = { ...db.sql.options.serializers };
  db.getDb();
  for (const type of ['114', '3802', '1184', '1114']) {
    assert.equal(db.sql.options.serializers[type], before[type], `serializer ${type} was replaced`);
  }
  assert.equal(db.sql.options.serializers['3802']({ a: 1 }), '{"a":1}');
});

test('jsonb writes still work after auth has loaded', { skip: !live && 'TEST_DATABASE_URL not reachable' }, async () => {
  db.getDb();
  const key = `test.drizzle-client.${Date.now()}`;
  try {
    await db.setSetting(key, { ok: true, list: ['a', 'b'] });
    assert.deepEqual(await db.getSetting(key, { fresh: true }), { ok: true, list: ['a', 'b'] });
  } finally {
    await db.deleteSetting(key).catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
    await db.getDb().$client?.end?.({ timeout: 5 }).catch(() => {});
  }
});
