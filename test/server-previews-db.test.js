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

  test('a claim for a large preview: pictures with a thumbnail that should have one and do not', async () => {
    const MB = 1024 * 1024;
    // Each has a thumbnail of ours, its sizes and its placeholder, so only
    // this claim wants it.
    const pic = async (name, { size = 20 * MB, metadata = { width: 6000, height: 4000 }, poster = null, thumb = true, ...over } = {}) => {
      const f = await file(name, { size, thumb: thumb ? `_thumbs/${crypto.randomUUID()}.webp` : null, ...over });
      await db.sql`
        UPDATE files SET metadata = ${db.sql.json({ ...metadata, placeholder: 'data:image/webp;base64,AAAA' })}::jsonb,
          thumb_sizes = 'sm,xs', poster_key = ${poster}
        WHERE id = ${f.id}`;
      return f;
    };
    await pic('pa.jpg');                                                       // opens from 20 MB
    await pic('pb.jpg', { metadata: {} });                                     // size not on record: drawn to learn it
    await pic('pc.jpg', { size: 5 * MB, metadata: { width: 2400, height: 1600 } }); // within the preview, but heavy
    await pic('pd.PNG', { mime: '', size: 5 * MB });                           // known by its name
    await pic('pe.jpg', { kind: 'other' });                                    // an image, as effectiveKind reads it
    await pic('pf.png', { mime: 'image/png', size: 1 * MB, metadata: { width: 3000, height: 2000 } }); // light, but too many pixels to be its own
    await pic('pg.jpg', { size: 1 * MB, metadata: { width: '3000', height: 2000 } }); // a size written as text
    await pic('ph.jpg', { size: 1 * MB, metadata: { width: 0, height: 0 } });  // a size that is none
    await pic('qa.jpg', { size: 400_000, metadata: { width: 1600, height: 1200 } }); // light enough to be its own
    await pic('ql.png', { mime: 'image/png', size: 1 * MB, metadata: { width: 2400, height: 1600 } }); // and within the preview's size
    await pic('qb.jpg', { metadata: { width: 900, height: 600 } });            // barely bigger than its thumbnail
    await pic('qc.gif', { mime: 'image/gif' });                                // animates
    await pic('qd.gif', { mime: '' });                                         // animates, known by its name
    await pic('qe.jpg', { poster: `_thumbs/${crypto.randomUUID()}.poster.webp` }); // has one
    await pic('qf.jpg', { thumb: false });                                     // the other queue's
    await pic('qg.heic', { mime: 'image/heic' });                              // not sharp's
    await pic('qh.jpg', { size: 10_000_000_000 });                             // too big
    await pic('qi.jpg', { metadata: { width: 20000, height: 20000 } });        // too many pixels on record
    await pic('qj.mov', { mime: 'video/quicktime', kind: 'video' });           // a video's poster is its frame: a browser's
    const young = await pic('qk.jpg', { age: 30_000 });                        // its browser may be drawing it now
    // This test's own rows: the others' have a size, and a claim, of their own.
    const these = async (q) => mine(await db.claimServerPosters(q)).filter((n) => /^[pq][a-z]\./.test(n));
    const args = { limit: 100, maxBytes: 450 * MB, maxPixels: 16384 * 16384 };
    const claimed = await these(args);
    assert.deepEqual(claimed, ['pa.jpg', 'pb.jpg', 'pc.jpg', 'pd.PNG', 'pe.jpg', 'pf.png', 'pg.jpg', 'ph.jpg']);
    await db.sql`DELETE FROM files WHERE id = ${young.id}`;
    // Claimed: not again until it is due, and never past the tries.
    assert.deepEqual(await these(args), []);
    const later = Date.now() + 60 * 60_000;
    assert.deepEqual(await these({ ...args, now: later }), claimed);
    await these({ ...args, now: later + 60 * 60_000 });
    assert.deepEqual(await these({ ...args, now: later + 2 * 60 * 60_000 }), [], 'three tries, then left');
  });

  test('a large preview is recorded beside the thumbnail, which keeps everything it has', async () => {
    const thumb = `_thumbs/${crypto.randomUUID()}.webp`;
    const f = await file('ra.jpg', { thumb });
    await db.sql`
      UPDATE files SET metadata = '{"width":6000,"placeholder":"data:image/webp;base64,AAAA"}'::jsonb, thumb_sizes = 'sm,xs'
      WHERE id = ${f.id}`;
    const cols = async () => (await db.sql`
      SELECT thumbnail_key, thumb_sizes, poster_key, metadata, seq, updated_at, version FROM files WHERE id = ${f.id}`)[0];
    const before = await cols();
    const key = `_thumbs/${crypto.randomUUID()}.poster.webp`;
    assert.equal(await db.setServerPoster(f.id, key, { width: 6001, height: 4000 }, { thumbnailKey: thumb }), true);
    const after = await cols();
    assert.equal(after.poster_key, key);
    assert.deepEqual(
      { thumb: after.thumbnail_key, sizes: after.thumb_sizes, placeholder: after.metadata.placeholder, seq: String(after.seq), at: String(after.updated_at), version: after.version },
      { thumb, sizes: 'sm,xs', placeholder: before.metadata.placeholder, seq: String(before.seq), at: String(before.updated_at), version: before.version },
    );
    assert.deepEqual([after.metadata.width, after.metadata.height], [6000, 4000], 'a size on record stays; one missing is filled in');
  });

  test('one recorded meanwhile wins, and a thumbnail since replaced takes none', async () => {
    const thumb = `_thumbs/${crypto.randomUUID()}.webp`;
    const theirs = `_thumbs/${crypto.randomUUID()}.poster.webp`;
    const ours = () => `_thumbs/${crypto.randomUUID()}.poster.webp`;
    const a = await file('sa.jpg', { thumb });
    await db.sql`UPDATE files SET poster_key = ${theirs} WHERE id = ${a.id}`;
    assert.equal(await db.setServerPoster(a.id, ours(), { width: 6000, height: 4000 }, { thumbnailKey: thumb }), false);
    assert.equal((await db.sql`SELECT poster_key FROM files WHERE id = ${a.id}`)[0].poster_key, theirs);
    const b = await file('sb.jpg', { thumb: `_thumbs/${crypto.randomUUID()}.webp` });
    assert.equal(await db.setServerPoster(b.id, ours(), {}, { thumbnailKey: thumb }), false);
    const c = await file('sc.jpg', { thumb });
    await db.sql`UPDATE files SET deleted_at = 1 WHERE id = ${c.id}`;
    assert.equal(await db.setServerPoster(c.id, ours(), {}, { thumbnailKey: thumb }), false, 'nor a trashed one');
    assert.deepEqual((await db.sql`SELECT poster_key FROM files WHERE id IN (${b.id}, ${c.id})`).map((r) => r.poster_key), [null, null]);
  });

  test('a picture that needs none: its size learned, and not claimed again', async () => {
    const thumb = `_thumbs/${crypto.randomUUID()}.webp`;
    const f = await file('ta.jpg', { thumb, size: 300_000 });
    await db.sql`UPDATE files SET metadata = '{"placeholder":"data:image/webp;base64,AAAA"}'::jsonb WHERE id = ${f.id}`;
    const args = { limit: 100, maxBytes: 450 * 1024 * 1024 };
    assert.ok(mine(await db.claimServerPosters(args)).includes('ta.jpg'), 'its size not on record');
    assert.equal(await db.setServerPoster(f.id, null, { width: 900, height: 600 }, { thumbnailKey: thumb }), true);
    const [row] = await db.sql`SELECT poster_key, metadata FROM files WHERE id = ${f.id}`;
    assert.deepEqual([row.poster_key, row.metadata.width, row.metadata.height], [null, 900, 600]);
    assert.ok(!mine(await db.claimServerPosters({ ...args, now: Date.now() + 60 * 60_000 })).includes('ta.jpg'));
  });

  test('the size a draw read replaces one on record that judged otherwise, so the claim stops taking it', async () => {
    // Recorded on its side: 1300x800 wants a preview, 800x1300 upright does
    // not (lib/poster.js imagePreviewFor's 1.25x, against a grid poster cut
    // to the other shape).
    const thumb = `_thumbs/${crypto.randomUUID()}.webp`;
    const f = await file('ua.jpg', { thumb, size: 5 * 1024 * 1024 });
    await db.sql`
      UPDATE files SET metadata = '{"width":1300,"height":800,"placeholder":"data:image/webp;base64,AAAA"}'::jsonb, thumb_sizes = 'sm,xs'
      WHERE id = ${f.id}`;
    const args = { limit: 100, maxBytes: 450 * 1024 * 1024 };
    assert.ok(mine(await db.claimServerPosters(args)).includes('ua.jpg'));
    assert.equal(await db.setServerPoster(f.id, null, { width: 800, height: 1300 }, { thumbnailKey: thumb }), true);
    const [row] = await db.sql`SELECT metadata FROM files WHERE id = ${f.id}`;
    assert.deepEqual([row.metadata.width, row.metadata.height, !!row.metadata.placeholder], [800, 1300, true]);
    assert.ok(!mine(await db.claimServerPosters({ ...args, now: Date.now() + 60 * 60_000 })).includes('ua.jpg'));
  });

  test('a draw recorded hands the file back its tries; so do new contents', async () => {
    const f = await file('va.jpg');
    await db.claimServerPreviews({ limit: 50, maxBytes: 450 * 1024 * 1024 });
    await db.setServerPreviewError(f.id, 'Could not draw it.');
    const tries = async () => (await db.sql`SELECT preview_tries, preview_tried_at, preview_error FROM files WHERE id = ${f.id}`)[0];
    const claimed = await tries();
    assert.equal(claimed.preview_tries, 1);
    assert.ok(claimed.preview_tried_at && claimed.preview_error);
    await db.setServerPreviewDrawn(f.id);
    assert.deepEqual({ ...(await tries()) }, { preview_tries: 0, preview_tried_at: null, preview_error: null });

    await db.sql`UPDATE files SET preview_tries = 3, preview_tried_at = ${Date.now()}, preview_error = 'Too many pixels' WHERE id = ${f.id}`;
    const replaced = await db.replaceFileContent(f.id, { fromKey: f.storageKey, toKey: `${T}/va-2.jpg`, url: `http://s3.test/b/${T}/va-2.jpg`, size: 2000 });
    assert.ok(replaced);
    assert.deepEqual({ ...(await tries()) }, { preview_tries: 0, preview_tried_at: null, preview_error: null });
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
