// Change cover…: a video's thumbnail set from a frame someone picked. The
// frame goes through the same draw → upload → thumbnail PUT as every other
// thumbnail (lib/thumbnail-client.js setVideoCover), so what is checked here
// is the part that is new: who is offered it, that a refusal costs no
// upload, and that the PUT replaces a good thumbnail for an editor and for
// nobody else. The route half runs against a real database, with only the
// session stubbed, and skips without TEST_DATABASE_URL.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { coverChangeable } from '../lib/media.js';

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@cover.test';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__coverSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__coverSession = email ? { user: { email } } : null; };

const db = await import('../lib/db.js');
const thumbRoute = await import('../app/api/files/[id]/thumbnail/route.js');
const { setVideoCover } = await import('../lib/thumbnail-client.js');

// ── Without a database ─────────────────────────────────────────────────────

test('a new cover is offered for a video in the bucket, and nothing else', () => {
  assert.equal(coverChangeable({ storage: 's3', kind: 'video', mime: 'video/mp4', name: 'a.mp4' }), true);
  assert.equal(coverChangeable({ storage: 's3', mime: '', name: 'b.mov' }), true, 'by extension');
  assert.equal(coverChangeable({ storage: 'blob', kind: 'video', mime: 'video/mp4', name: 'a.mp4' }), false, 'previews go to the bucket');
  assert.equal(coverChangeable({ storage: 's3', kind: 'image', mime: 'image/jpeg', name: 'a.jpg' }), false);
  assert.equal(coverChangeable({ storage: 's3', kind: 'audio', mime: 'audio/mpeg', name: 'a.mp3' }), false);
  assert.equal(coverChangeable(null), false);
});

test('setVideoCover asks first, and a refusal decodes and uploads nothing', async () => {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push([String(url), init.method || 'GET']); return new Response(null, { status: 403 }); };
  try {
    await assert.rejects(
      setVideoCover({ id: 'f1', url: 'https://s3.test/v.mp4', name: 'v.mp4', mime: 'video/mp4', storage: 's3' }, 3),
      /not change its cover/,
    );
  } finally {
    globalThis.fetch = prev;
  }
  assert.deepEqual(calls, [['/api/files/f1/thumbnail', 'GET']]);
});

// ── With a database ────────────────────────────────────────────────────────

const tag = Math.random().toString(36).slice(2, 8);
const EDITOR = `editor-${tag}@cover.test`;
const VIEWER = `viewer-${tag}@cover.test`;
const PREFIX = `cover-${tag}`;
const thumb = () => `_thumbs/${randomUUID()}.webp`;
const poster = () => `_thumbs/${randomUUID()}.poster.webp`;
const made = [];
let drive;

async function call(handler, params, method, body) {
  const res = await handler(new Request('http://app.test/x', {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }), { params });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  if (!live) return;
  drive = await db.createFilespace({ name: `Cover ${tag}`, bucket: 'b', prefix: PREFIX, createdBy: 'boss@cover.test' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: EDITOR, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
  for (const email of [EDITOR, VIEWER]) await db.adminAddApprovedInvite({ email, name: email, reviewedBy: 'test' });
});

after(async () => {
  as(null);
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@cover.test`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('changing the cover of a drive video', { skip }, () => {
  let video;
  const OLD = { thumbnailKey: thumb(), posterKey: poster() };
  before(async () => {
    video = await db.createFile({
      url: 'http://s3.test/b/clip.mp4', name: `clip-${tag}.mp4`, mime: 'video/mp4', kind: 'video', size: 1,
      storage: 's3', storageKey: `${PREFIX}/clip.mp4`, createdBy: 'boss@cover.test',
      ...OLD, thumbSizes: ['sm', 'xs'], metadata: { width: 1920, height: 1080, duration: 42 },
    });
    made.push(video.id);
  });

  test('a viewer is refused, before anything is written', async () => {
    as(VIEWER);
    assert.equal((await call(thumbRoute.GET, { id: video.id }, 'GET')).status, 403);
    const put = await call(thumbRoute.PUT, { id: video.id }, 'PUT', { thumbnailKey: thumb(), posterKey: poster(), thumbSizes: ['sm', 'xs'] });
    assert.equal(put.status, 403, JSON.stringify(put.body));
    const row = await db.getFileById(video.id);
    assert.equal(row.thumbnailKey, OLD.thumbnailKey);
    assert.equal(row.posterKey, OLD.posterKey);
  });

  test('an editor replaces a good thumbnail with the chosen frame, under new keys', async () => {
    as(EDITOR);
    assert.equal((await call(thumbRoute.GET, { id: video.id }, 'GET')).status, 204);
    const before = await db.getFileById(video.id);
    const NEW = { thumbnailKey: thumb(), posterKey: poster() };
    const put = await call(thumbRoute.PUT, { id: video.id }, 'PUT', {
      ...NEW, thumbSizes: ['sm', 'xs'], media: { width: 1920, height: 1080, duration: 42 },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.file.thumbnailKey, NEW.thumbnailKey);
    const row = await db.getFileById(video.id);
    assert.equal(row.thumbnailKey, NEW.thumbnailKey);
    assert.equal(row.posterKey, NEW.posterKey, 'the player shows the same frame');
    assert.deepEqual(row.thumbSizes, ['sm', 'xs']);
    assert.ok(row.seq > before.seq, 'devices pick up the new cover');
    assert.equal(row.version, before.version, 'a cover is not an edit');
    assert.deepEqual(
      (await db.unreferencedPreviewKeys({ thumbKeys: [OLD.thumbnailKey], posterKeys: [OLD.posterKey] })).sort(),
      [OLD.thumbnailKey, OLD.posterKey].sort(),
      'the old picture is free to be deleted',
    );
  });
});
