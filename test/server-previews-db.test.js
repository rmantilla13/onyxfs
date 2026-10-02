// Which files the server claims to draw (lib/db.js claimServerPreviews),
// against a real database. Runs with TEST_DATABASE_URL pointing at a
// throwaway database, and skips without one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.SCHEMA_MANAGED = '0';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const db = await import('../lib/db.js');
const T = `sp${Math.random().toString(36).slice(2, 8)}`;
const made = [];

before(async () => { if (live) await db.ensureSchema(); });
after(async () => {
  if (live) for (const id of made) await db.sql`DELETE FROM files WHERE id = ${id}`.catch(() => {});
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

async function file(name, { mime = 'image/jpeg', size = 1000, kind = 'image', thumb = null, age = 10 * 60_000, storage = 's3' } = {}) {
  const f = await db.createFile({ name, url: `http://s3.test/b/${T}/${name}`, size, folder: T, storage, storageKey: `${T}/${name}`, mime, kind, createdBy: 'x@sp.test' });
  made.push(f.id);
  await db.sql`UPDATE files SET created_at = ${Date.now() - age}, thumbnail_key = ${thumb} WHERE id = ${f.id}`;
  return f;
}
const mine = (rows) => rows.filter((r) => r.folder === T).map((r) => r.name).sort();

describe('what the server claims to draw', { skip }, () => {
  test('images without a thumbnail, in a format it reads, old enough, not too big', async () => {
    await file('a.jpg');
    await file('b.PNG', { mime: '' });                       // known by its name
    await file('c.heic', { mime: 'image/heic' });            // not sharp's
    await file('d.jpg', { thumb: '_thumbs/x.webp' });        // has one
    const young = await file('e.jpg', { age: 30_000 });      // its browser may be drawing it now
    await file('f.jpg', { size: 10_000_000_000 });           // too big
    await file('g.mov', { mime: 'video/quicktime', kind: 'video' });
    const claimed = await db.claimServerPreviews({ limit: 50, maxBytes: 450 * 1024 * 1024 });
    assert.deepEqual(mine(claimed), ['a.jpg', 'b.PNG']);
    // The clock jumps ahead below, which would make it old enough too.
    await db.sql`DELETE FROM files WHERE id = ${young.id}`;
    // Claimed: not again until it is due, and never past the tries.
    assert.deepEqual(mine(await db.claimServerPreviews({ limit: 50, maxBytes: 450 * 1024 * 1024 })), []);
    const later = Date.now() + 60 * 60_000;
    assert.deepEqual(mine(await db.claimServerPreviews({ limit: 50, maxBytes: 450 * 1024 * 1024, now: later })), ['a.jpg', 'b.PNG']);
    await db.claimServerPreviews({ limit: 50, maxBytes: 450 * 1024 * 1024, now: later + 60 * 60_000 });
    assert.deepEqual(mine(await db.claimServerPreviews({ limit: 50, maxBytes: 450 * 1024 * 1024, now: later + 2 * 60 * 60_000 })), [], 'three tries, then left');
  });

  test('a claim is not a change to the file', async () => {
    const f = await file('h.jpg');
    const [before] = await db.sql`SELECT updated_at, seq FROM files WHERE id = ${f.id}`;
    await db.claimServerPreviews({ limit: 50, maxBytes: 450 * 1024 * 1024 });
    const [after] = await db.sql`SELECT updated_at, seq, preview_tries FROM files WHERE id = ${f.id}`;
    assert.equal(String(after.updated_at), String(before.updated_at));
    assert.equal(String(after.seq), String(before.seq));
    assert.equal(after.preview_tries, 1);
    await db.setServerPreviewError(f.id, 'Too many pixels');
    assert.equal((await db.sql`SELECT preview_error FROM files WHERE id = ${f.id}`)[0].preview_error, 'Too many pixels');
  });

  test('thumbnails without a placeholder are claimed for one; those with one are not', async () => {
    const without = await file('i.jpg', { thumb: '_thumbs/i.webp' });
    const withOne = await file('j.jpg', { thumb: '_thumbs/j.webp' });
    await db.sql`UPDATE files SET metadata = '{"placeholder":"data:image/webp;base64,AAAA"}'::jsonb WHERE id = ${withOne.id}`;
    const claimed = await db.claimServerPlaceholders({ limit: 100 });
    assert.ok(claimed.some((r) => r.id === without.id));
    assert.ok(!claimed.some((r) => r.id === withOne.id));
  });
});
