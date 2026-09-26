// A preview key (thumbnail, player poster, filmstrip) is a random name, not a
// secret: it rides in every signed thumbnail URL and on the rows a listing or
// a share page sends. Recording one another file uses let someone who can
// edit a file of their own keep that other file's preview signed on their
// row after losing access to it. Writes now take only a key no other row
// holds.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const src = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('the thumbnail PUT refuses a key another file uses, before it writes', async () => {
  const route = await src('app/api/files/[id]/thumbnail/route.js');
  const put = route.slice(route.indexOf('export async function PUT'));
  const check = put.indexOf('previewKeysInUse(');
  assert.ok(check > 0, 'PUT checks the keys');
  assert.ok(check < put.indexOf('setFileThumbnail('), 'checked before the write');
  assert.match(put, /status: 409/);
  assert.match(put, /status: 503/, 'a check that cannot be made fails closed');
});

test('POST /api/files drops preview keys another file uses', async () => {
  const route = await src('app/api/files/route.js');
  assert.match(route, /const previews = await ownPreviews\(uploadFields\(record\)\)/);
  assert.match(route, /previewKeysInUse\(keys\)/);
  assert.match(route, /catch \{ taken = new Set\(keys\); \}/, 'unknown means dropped, not trusted');
});

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
const describeDb = live ? describe : describe.skip;

describeDb('previewKeysInUse (database)', () => {
  let db;
  const made = [];
  const thumb = () => `_thumbs/${randomUUID()}.webp`;
  const poster = () => `_thumbs/${randomUUID()}.poster.webp`;

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    await db.ensureSchema();
  });
  after(async () => {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql.end({ timeout: 2 }).catch(() => {});
  });

  const file = async (fields) => {
    const f = await db.createFile({ url: 'https://example.com/x', name: `pk-${randomUUID()}.jpg`, storage: 's3', storageKey: `files/pk/${randomUUID()}.jpg`, createdBy: 'pk@example.com', ...fields });
    made.push(f.id);
    return f;
  };

  test("another file's thumbnail, poster and filmstrip keys are in use", async () => {
    const t = thumb(); const p = poster(); const s = `_thumbs/${randomUUID()}.strip.webp`;
    const victim = await file({ thumbnailKey: t, posterKey: p, filmstripKey: s });
    const mine = await file({});
    assert.deepEqual([...await db.previewKeysInUse([t, p, s], { exceptId: mine.id })].sort(), [p, s, t].sort());
    assert.equal((await db.previewKeysInUse([t], { exceptId: victim.id })).size, 0, "a file's own keys are not taken");
    assert.equal((await db.previewKeysInUse([thumb()])).size, 0, 'a fresh key is free');
  });
});
