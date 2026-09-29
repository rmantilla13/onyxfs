// The two questions every upload asks of the files table before it is
// recorded — is this object key another row's (storageKeyInUse), is this
// preview key (previewKeysInUse) — against a real Postgres: what they answer,
// and that indexes answer it. Each was an OR across columns that no index
// could serve, so both read the whole table, once per upload (and the
// preview one once per key).
//
// Runs only with TEST_DATABASE_URL, and skips cleanly without one. The plans
// are read with auto_explain, which takes a role that may LOAD it; without
// one, only that test skips.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
const describeDb = live ? describe : describe.skip;

const T = Math.random().toString(36).slice(2, 8);
const key = (name) => `files/kiu-${T}/${name}`;
const thumb = () => `_thumbs/${randomUUID()}.webp`;
const poster = () => `_thumbs/${randomUUID()}.poster.webp`;
const strip = () => `_thumbs/${randomUUID()}.strip.webp`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describeDb('storageKeyInUse and previewKeysInUse (database)', () => {
  let db;
  const made = [];

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    // The other database tests run ensureSchema at the same moment. On a
    // database that lacks an index, two CONCURRENTLY builds of it can
    // deadlock, and Postgres cancels one (leaving the index INVALID, which
    // the next run drops and builds again). Run again rather than fail.
    let failed = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      failed = (await db.ensureSchema()).filter((r) => !r.ok);
      if (!failed.some((r) => /deadlock/i.test(r.error))) break;
      await sleep(250 + Math.random() * 500);
    }
    assert.deepEqual(failed, [], 'every guard runs on this database');
  });

  after(async () => {
    if (!db) return;
    await db.sql`DELETE FROM files WHERE id = ANY(${made})`.catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  const file = async (fields) => {
    const f = await db.createFile({ url: 'https://s3.test/b/x', name: `kiu-${randomUUID()}.mov`, storage: 's3', createdBy: `kiu-${T}@example.com`, ...fields });
    made.push(f.id);
    return f;
  };

  test('a live file holds its key — for every row but itself', async () => {
    const k = key('live.mov');
    assert.equal(await db.storageKeyInUse(k), false, 'nobody has it yet');
    const f = await file({ storageKey: k });
    assert.equal(await db.storageKeyInUse(k), true);
    assert.equal(await db.storageKeyInUse(k, { exceptId: f.id }), false);
    assert.equal(await db.storageKeyInUse(key('live.mo')), false, 'the whole key, not a prefix of it');
  });

  test('a trashed file holds its key until its object moves to the trash, then only the trash key', async () => {
    const k = key('trashed.mov');
    const trashKey = `_trash/${randomUUID()}/${k}`;
    const f = await file({ storageKey: k });
    await db.softDeleteFile(f.id, { trashKey: null });
    assert.equal(await db.storageKeyInUse(k), true, 'its object is still at the key');
    assert.equal(await db.storageKeyInUse(k, { exceptId: f.id }), false);
    assert.equal(await db.setTrashKeyIfUnmoved(f.id, { trashKey, storageKey: k }), true);
    // lib/trash-move.js relies on this: a moved file's old key is free, and a
    // new upload may take it (Finder's Replace deletes, then copies).
    assert.equal(await db.storageKeyInUse(k), false, 'moved out: the old key is free');
    assert.equal(await db.storageKeyInUse(trashKey), true, 'its object is at the trash key now');
    assert.equal(await db.storageKeyInUse(trashKey, { exceptId: f.id }), false);
    const again = await file({ storageKey: k });
    assert.equal(await db.storageKeyInUse(k), true, 'the file put back under the name holds it');
    assert.equal(await db.storageKeyInUse(k, { exceptId: again.id }), false, 'and the trashed one does not');
  });

  test('a preview key is in use in any of the three columns, trashed rows included', async () => {
    const t = thumb(); const p = poster(); const s = strip();
    const holder = await file({ storageKey: key('holder.mov'), thumbnailKey: t, posterKey: p, filmstripKey: s });
    const mine = await file({ storageKey: key('mine.mov') });
    assert.deepEqual([...await db.previewKeysInUse([t, p, s, t], { exceptId: mine.id })].sort(), [p, s, t].sort());
    assert.equal((await db.previewKeysInUse([t, p, s], { exceptId: holder.id })).size, 0, "a file's own keys are not taken");
    assert.equal((await db.previewKeysInUse([thumb(), poster(), strip()])).size, 0, 'fresh keys are free');
    // Whatever column a key sits in, it is looked for in all three: a row
    // written before keys were checked may hold one in another's column.
    const odd = thumb();
    await db.sql`UPDATE files SET filmstrip_key = ${odd} WHERE id = ${mine.id}`;
    assert.deepEqual([...await db.previewKeysInUse([odd])], [odd]);
    // A trashed row keeps its previews for a restore.
    await db.softDeleteFile(holder.id, { trashKey: null });
    assert.deepEqual([...await db.previewKeysInUse([t], { exceptId: mine.id })], [t]);
  });

  test('both are answered from indexes, never by reading the table', async (t) => {
    try {
      await db.sql`LOAD 'auto_explain'`;
    } catch (e) {
      t.skip(`auto_explain cannot be loaded here (${e.message})`);
      return;
    }
    // Built CONCURRENTLY by ensureFileIndexes, maybe by another test file
    // that got there first, and copied below only once they are.
    const want = ['files_live_key_idx', 'files_unmoved_trash_idx', 'files_trash_key_idx', 'files_thumbnail_key_idx', 'files_poster_key_idx', 'files_filmstrip_key_idx'];
    let valid = 0;
    for (let i = 0; i < 100 && valid < want.length; i++) {
      const [row] = await db.sql`
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = ANY(${want}) AND i.indisvalid`;
      valid = row.n;
      if (valid < want.length) await sleep(100);
    }
    assert.equal(valid, want.length, 'the indexes exist and are built');

    // What a planner does with a table of a few test rows says nothing: any
    // index, or none, is as cheap as another. So the plans are read against
    // a stand-in the size of a real library — the same columns and indexes,
    // copied from `files`, and 20,000 rows — as a temporary table, which
    // only this connection sees (lib/db.js has one) and which every
    // unqualified `files` on it finds before the real one.
    const plans = [];
    const warn = console.warn;
    console.warn = (...args) => {
      const text = args.join(' ');
      if (/Query Text:/.test(text)) plans.push(text);
      else warn(...args);
    };
    const planOf = async (run) => {
      plans.length = 0;
      await run();
      return plans.find((p) => /FROM files/.test(p)) || '';
    };
    try {
      await db.sql`CREATE TEMP TABLE files (LIKE public.files INCLUDING ALL)`;
      await db.sql`
        INSERT INTO files (id, name, url, storage, storage_key, created_at, updated_at, thumbnail_key, poster_key, filmstrip_key, deleted_at, trash_key)
        SELECT 'k' || g, 'f' || g, 'https://s3.test/' || g, 's3', 'files/k/' || g || '.mov', g, g,
               CASE WHEN g % 5 <> 0 THEN '_thumbs/' || md5(g::text)::uuid || '.webp' END,
               CASE WHEN g % 10 = 0 THEN '_thumbs/' || md5('p' || g)::uuid || '.poster.webp' END,
               CASE WHEN g % 10 = 0 THEN '_thumbs/' || md5('s' || g)::uuid || '.strip.webp' END,
               CASE WHEN g % 20 = 0 THEN g END,
               CASE WHEN g % 20 = 0 AND g % 100 <> 0 THEN '_trash/k' || g || '/files/k/' || g || '.mov' END
        FROM generate_series(1, 20000) g`;
      await db.sql`ANALYZE files`;
      await db.sql`SET auto_explain.log_min_duration = 0`;
      await db.sql`SET auto_explain.log_level = 'warning'`;

      const keyPlan = await planOf(() => db.storageKeyInUse('files/k/new.mov'));
      assert.ok(keyPlan, 'the plan came back (auto_explain, through lib/db.js onnotice)');
      assert.equal(keyPlan.match(/Index Cond: \(storage_key = /g)?.length, 2, `live, and trashed but not moved\n${keyPlan}`);
      assert.match(keyPlan, /Index Cond: \(trash_key = /, keyPlan);
      assert.doesNotMatch(keyPlan, /Seq Scan/, keyPlan);

      const previewPlan = await planOf(() => db.previewKeysInUse([thumb(), poster(), strip()]));
      for (const column of ['thumbnail_key', 'poster_key', 'filmstrip_key']) {
        assert.match(previewPlan, new RegExp(`Index Cond: \\(${column} = ANY`), previewPlan);
      }
      assert.doesNotMatch(previewPlan, /Seq Scan/, previewPlan);
    } finally {
      console.warn = warn;
      await db.sql`DROP TABLE IF EXISTS pg_temp.files`.catch(() => {});
      await db.sql`RESET auto_explain.log_min_duration`.catch(() => {});
      await db.sql`RESET auto_explain.log_level`.catch(() => {});
    }
  });
});
