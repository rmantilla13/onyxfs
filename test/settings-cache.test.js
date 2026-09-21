// One query for the settings table, not one per key.
//
// A page render asks for brand, roles, features and storage. Each was its own
// SELECT, and with max: 1 they ran sequentially on a single connection — four
// or more round trips before anything touched the files table. The table holds
// a handful of rows, so reading all of it costs what reading one row costs.
//
// The proof below is behavioural rather than instrumented: load one key, then
// delete every row OUT OF BAND, then ask for a DIFFERENT key. If it still has
// a value, the first read must have fetched it — there is nothing left in the
// database to find.

import { test, describe, before, after, beforeEach } from 'node:test';
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

const describeDb = (await reachable(URL_)) ? describe : describe.skip;

describeDb('the settings cache is filled by one read', () => {
  let db, raw, postgres;

  before(async () => {
    process.env.DATABASE_URL = URL_;
    ({ default: postgres } = await import('postgres'));
    raw = postgres(URL_, { prepare: false, max: 1, transform: { undefined: null } });
    db = await import('../lib/db.js');
  });

  after(async () => { await raw?.end({ timeout: 5 }).catch(() => {}); });

  beforeEach(async () => {
    await db.setSetting('alpha.config', { a: 1 });
    await db.setSetting('beta.config', { b: 2 });
    db.invalidateSetting();
  });

  test('a second key comes back after its row is gone', async () => {
    // THE point of the change.
    assert.deepEqual(await db.getSetting('alpha.config'), { a: 1 });
    await raw`DELETE FROM settings`;
    assert.deepEqual(
      await db.getSetting('beta.config'), { b: 2 },
      'beta was not loaded by the read for alpha — it is still one query per key',
    );
  });

  test('a key that was ASKED for and had no row is cached as absent', () => {
    // Only a key someone requested is remembered as missing; one nobody has
    // asked about is simply not in the cache and gets looked up on demand.
    // The first version of this test assumed otherwise and failed for a
    // reason that had nothing to do with the code.
    return (async () => {
      assert.equal(await db.getSetting('gamma.config'), null);
      await raw`INSERT INTO settings (key, value, updated_at) VALUES ('gamma.config', '{"g":3}'::jsonb, 0)`;
      assert.equal(await db.getSetting('gamma.config'), null, 'the absent answer should be cached');
      assert.deepEqual(await db.getSetting('gamma.config', { fresh: true }), { g: 3 });
      await raw`DELETE FROM settings WHERE key = 'gamma.config'`;
    })();
  });

  describe('the value survives the round trip', () => {
    // It did not. setSetting wrote `${JSON.stringify(value)}::jsonb`, correct
    // under the previous driver, which sent the string as text for the cast to
    // parse. postgres.js infers the parameter type from the column and encodes
    // it AGAIN, so the row held a jsonb string containing JSON. Every consumer
    // then did `typeof saved === 'object' ? saved : {}` and quietly took the
    // defaults — which is why a saved storage configuration never came back.

    test('what goes in is what comes out, and it is an object', async () => {
      const cfg = { provider: 's3', bucket: 'onyx-media', nested: { region: 'us-west-004' }, n: 1, on: true };
      await db.setSetting('round.config', cfg);
      db.invalidateSetting();
      const got = await db.getSetting('round.config');
      assert.equal(typeof got, 'object', 'a string here means it is double-encoded again');
      assert.deepEqual(got, cfg);
    });

    test('it is stored as a jsonb object, not a jsonb string', async () => {
      // The assertion that would have caught this on day one. jsonb_typeof is
      // the difference between a config that persists and one that silently
      // resets to defaults on every read.
      await db.setSetting('round.config', { a: 1 });
      const [{ t }] = await raw`SELECT jsonb_typeof(value) AS t FROM settings WHERE key = 'round.config'`;
      assert.equal(t, 'object', `stored as jsonb '${t}' — a 'string' is the double-encoding bug`);
    });

    test('a row written by the old double-encoding path is still readable', async () => {
      // Repair on read, so a working configuration saved before the fix does
      // not have to be typed in again.
      await raw`DELETE FROM settings WHERE key = 'legacy.config'`;
      await raw`INSERT INTO settings (key, value, updated_at)
                VALUES ('legacy.config', to_jsonb('{"bucket":"old-one"}'::text), 0)`;
      db.invalidateSetting();
      assert.deepEqual(await db.getSetting('legacy.config'), { bucket: 'old-one' });
      await raw`DELETE FROM settings WHERE key = 'legacy.config'`;
    });

    test('a setting that is genuinely a string is left alone', async () => {
      // The repair must not "helpfully" reinterpret a plain string value.
      await raw`DELETE FROM settings WHERE key = 'plain.config'`;
      await raw`INSERT INTO settings (key, value, updated_at) VALUES ('plain.config', to_jsonb('hello'::text), 0)`;
      db.invalidateSetting();
      assert.equal(await db.getSetting('plain.config'), 'hello');
      await raw`DELETE FROM settings WHERE key = 'plain.config'`;
    });
  });

  test('fresh: true still re-reads, and refills the rest of the cache', async () => {
    // The admin screens depend on this: a PUT on one lambda and the GET that
    // follows on another must not redisplay the value the save replaced.
    await db.getSetting('alpha.config');
    await raw`UPDATE settings SET value = '{"a":99}'::jsonb WHERE key = 'alpha.config'`;
    assert.deepEqual(await db.getSetting('alpha.config'), { a: 1 }, 'cache should still hold the old value');
    assert.deepEqual(await db.getSetting('alpha.config', { fresh: true }), { a: 99 });
  });

  test('setSetting invalidates its own key and leaves the others alone', async () => {
    await db.getSetting('alpha.config');
    await db.setSetting('alpha.config', { a: 7 });
    assert.deepEqual(await db.getSetting('alpha.config'), { a: 7 });
    await raw`DELETE FROM settings WHERE key = 'beta.config'`;
    assert.deepEqual(await db.getSetting('beta.config'), { b: 2 }, 'beta should still be cached');
  });

  test('a strict read still distinguishes absent from unreadable', async () => {
    // The behaviour that stopped a slow database silently erasing the storage
    // config: a caller about to WRITE must not be handed null for a failure.
    await raw`DELETE FROM settings`;
    db.invalidateSetting();
    assert.equal(await db.getSetting('alpha.config', { strict: true }), null,
      'absent is null even in strict mode; only a FAILED read throws');
  });
});
