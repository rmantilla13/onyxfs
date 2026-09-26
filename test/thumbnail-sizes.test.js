// The thumbnail's smaller siblings end to end: the real route handlers,
// against a real database, with only the session stubbed. Runs with
// TEST_DATABASE_URL pointing at a throwaway database, and skips without one.
//
// What matters: only someone who may write the file is handed a PUT URL
// (a drive's viewer and an outsider are refused before anything is signed),
// the keys are derived from the row's own thumbnail, and sizes are recorded
// only against the thumbnail they were drawn from.

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
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@sizes.test';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__sizesSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__sizesSession = email ? { user: { email } } : null; };

const db = await import('../lib/db.js');
const storage = await import('../lib/storage.js');
const sizesRoute = await import('../app/api/files/[id]/thumbnail/sizes/route.js');
const thumbRoute = await import('../app/api/files/[id]/thumbnail/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const OWNER = `owner-${tag}@sizes.test`;
const VIEWER = `viewer-${tag}@sizes.test`;
const OUTSIDER = `out-${tag}@sizes.test`;
const PREFIX = `sz-${tag}`;
// Fresh keys per run: a key another row holds is refused (lib/db.js
// previewKeysInUse), and other test files run beside this one.
const UUID = crypto.randomUUID();
const KEY = `_thumbs/${UUID}.webp`;
const KEY2 = `_thumbs/${crypto.randomUUID()}.webp`;

const req = (url, init = {}) => new Request(`http://app.test${url}`, {
  ...init,
  headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
});
async function call(handler, url, params, init) {
  const res = await handler(req(url, init), { params });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

let drive;
let photo;
let bare;
const made = [];

before(async () => {
  if (!live) return;
  drive = await db.createFilespace({ name: `Sizes ${tag}`, bucket: 'b', prefix: PREFIX, createdBy: 'boss@sizes.test' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
  for (const email of [OWNER, VIEWER, OUTSIDER]) await db.adminAddApprovedInvite({ email, name: email, reviewedBy: 'test' });
  photo = await db.createFile({
    name: 'photo.jpg', url: `http://s3.test/b/${PREFIX}/photo.jpg`, mime: 'image/jpeg', kind: 'image', size: 1000,
    storage: 's3', storageKey: `${PREFIX}/photo.jpg`, createdBy: OWNER, thumbnailKey: KEY,
  });
  bare = await db.createFile({
    name: 'bare.jpg', url: `http://s3.test/b/${PREFIX}/bare.jpg`, mime: 'image/jpeg', kind: 'image', size: 1000,
    storage: 's3', storageKey: `${PREFIX}/bare.jpg`, createdBy: OWNER,
  });
  made.push(photo.id, bare.id);
});

after(async () => {
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@sizes.test`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('POST /api/files/[id]/thumbnail/sizes', { skip }, () => {
  test('refused to anyone who may not write the file, before anything is signed', async () => {
    as(null);
    assert.equal((await call(sizesRoute.POST, '/x', { id: photo.id }, { method: 'POST' })).status, 401);
    as(VIEWER);
    assert.equal((await call(sizesRoute.POST, '/x', { id: photo.id }, { method: 'POST' })).status, 403, 'a drive viewer reads, but does not write');
    as(OUTSIDER);
    assert.equal((await call(sizesRoute.POST, '/x', { id: photo.id }, { method: 'POST' })).status, 403);
    as(OWNER);
    assert.equal((await call(sizesRoute.POST, '/x', { id: 'no-such-file' }, { method: 'POST' })).status, 404);
  });

  test('a file with no thumbnail has nothing to size', async () => {
    as(OWNER);
    assert.equal((await call(sizesRoute.POST, '/x', { id: bare.id }, { method: 'POST' })).status, 409);
  });

  test('an editor gets PUTs for the siblings of the row’s own thumbnail', async () => {
    as(OWNER);
    const r = await call(sizesRoute.POST, '/x', { id: photo.id }, { method: 'POST', body: { key: 'drives/other/secret.pdf' } });
    const cfg = await storage.getStorageConfig();
    if (storage.storageMode(cfg) !== 's3') {
      assert.equal(r.status, 400);
      return;
    }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.thumbnailKey, KEY);
    assert.equal(r.body.siblings.sm.key, `_thumbs/${UUID}.sm.webp`);
    assert.equal(r.body.siblings.xs.key, `_thumbs/${UUID}.xs.webp`);
    assert.ok(new URL(r.body.siblings.sm.putUrl).pathname.endsWith(`/_thumbs/${UUID}.sm.webp`));
  });
});

describe('PUT /api/files/[id]/thumbnail/sizes', { skip }, () => {
  test('refused to a viewer and an outsider', async () => {
    for (const who of [VIEWER, OUTSIDER]) {
      as(who);
      const r = await call(sizesRoute.PUT, '/x', { id: photo.id }, { method: 'PUT', body: { thumbnailKey: KEY, sizes: ['sm'] } });
      assert.equal(r.status, 403, who);
    }
    const [row] = await db.sql`SELECT thumb_sizes FROM files WHERE id = ${photo.id}`;
    assert.equal(row.thumb_sizes, null);
  });

  test('bad input is refused before the database is asked', async () => {
    as(OWNER);
    assert.equal((await call(sizesRoute.PUT, '/x', { id: photo.id }, { method: 'PUT', body: { thumbnailKey: 'files/x.jpg', sizes: ['sm'] } })).status, 400);
    assert.equal((await call(sizesRoute.PUT, '/x', { id: photo.id }, { method: 'PUT', body: { thumbnailKey: KEY, sizes: ['lg'] } })).status, 400);
  });

  test('sizes for a thumbnail the row no longer has are not recorded', async () => {
    as(OWNER);
    const r = await call(sizesRoute.PUT, '/x', { id: photo.id }, { method: 'PUT', body: { thumbnailKey: KEY2, sizes: ['sm', 'xs'] } });
    assert.equal(r.status, 409);
    assert.equal((await db.getFileById(photo.id)).thumbSizes.length, 0);
  });

  test('an editor records them, and the row lists them — without a sync bump', async () => {
    as(OWNER);
    const before = await db.getFileById(photo.id);
    const r = await call(sizesRoute.PUT, '/x', { id: photo.id }, { method: 'PUT', body: { thumbnailKey: KEY, sizes: ['xs', 'sm', 'zz'] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await db.getFileById(photo.id);
    assert.deepEqual(after.thumbSizes, ['sm', 'xs']);
    assert.equal(after.seq, before.seq, 'web-only renditions are not a change devices sync');
  });
});

describe('the thumbnail PUT and siblings', { skip }, () => {
  test('a new thumbnail carries its own siblings, or clears the old ones', async () => {
    as(OWNER);
    const r = await call(thumbRoute.PUT, '/x', { id: photo.id }, { method: 'PUT', body: { thumbnailKey: KEY2, thumbSizes: ['sm'], media: { width: 6000, height: 4000 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await db.getFileById(photo.id)).thumbSizes, ['sm']);
    const again = await call(thumbRoute.PUT, '/x', { id: photo.id }, { method: 'PUT', body: { thumbnailKey: KEY } });
    assert.equal(again.status, 200);
    assert.deepEqual((await db.getFileById(photo.id)).thumbSizes, [], 'drawn from the old picture, so gone with it');
  });

  test('a viewer cannot record a thumbnail or its sizes', async () => {
    as(VIEWER);
    const r = await call(thumbRoute.PUT, '/x', { id: photo.id }, { method: 'PUT', body: { thumbnailKey: KEY2, thumbSizes: ['sm', 'xs'] } });
    assert.equal(r.status, 403);
  });

  test('recordThumbSizes keeps only known sizes and checks the thumbnail', async () => {
    assert.equal(await db.recordThumbSizes(photo.id, ['xs'], { thumbnailKey: KEY2 }), null);
    assert.equal(await db.recordThumbSizes(photo.id, ['xs', 'nope'], { thumbnailKey: KEY }), 'xs');
    assert.equal(await db.recordThumbSizes(photo.id, [], { thumbnailKey: KEY }), null);
  });
});

test('an upload records its siblings with its thumbnail, and none without one', { skip }, async (t) => {
  const { uploadFields } = await import('../lib/media.js');
  const body = {
    name: 'up.jpg', url: `http://s3.test/b/${PREFIX}/up.jpg`, mime: 'image/jpeg', size: 1, storage: 's3',
    storageKey: `${PREFIX}/up.jpg`, thumbnailKey: KEY, thumbSizes: ['sm', 'xs', 'evil'],
  };
  const file = await db.createFile({ ...body, ...uploadFields(body), createdBy: OWNER });
  t.after(() => db.deleteFile(file.id).catch(() => {}));
  assert.deepEqual(file.thumbSizes, ['sm', 'xs']);
  const none = { ...body, name: 'none.jpg', storageKey: `${PREFIX}/none.jpg`, thumbnailKey: undefined };
  const f2 = await db.createFile({ ...none, ...uploadFields(none), createdBy: OWNER });
  t.after(() => db.deleteFile(f2.id).catch(() => {}));
  assert.deepEqual(f2.thumbSizes, []);
});

// A row written before keys were checked may hold another file's thumbnail.
// Editing that row is not editing the other file: its siblings — named after
// the shared thumbnail — are never signed or recorded through it.
describe('a thumbnail another row also holds', { skip }, () => {
  test('gets no sibling PUTs and records no sizes', async (t) => {
    const SHARED = `_thumbs/${crypto.randomUUID()}.webp`;
    const theirs = await db.createFile({
      name: 'theirs.jpg', url: `http://s3.test/b/${PREFIX}/theirs.jpg`, mime: 'image/jpeg', kind: 'image', size: 1,
      storage: 's3', storageKey: `${PREFIX}/theirs.jpg`, createdBy: OWNER, thumbnailKey: SHARED,
    });
    const mine = await db.createFile({
      name: 'mine.jpg', url: `http://s3.test/b/library/${VIEWER}/mine.jpg`, mime: 'image/jpeg', kind: 'image', size: 1,
      storage: 's3', storageKey: `library/${VIEWER}/mine.jpg`, createdBy: VIEWER,
    });
    made.push(theirs.id, mine.id);
    // As an old write could have left it.
    await db.sql`UPDATE files SET thumbnail_key = ${SHARED} WHERE id = ${mine.id}`;
    as(VIEWER);
    const post = await call(sizesRoute.POST, '/x', { id: mine.id }, { method: 'POST' });
    assert.equal(post.status, 409, JSON.stringify(post.body));
    assert.equal(post.body?.siblings, undefined, 'nothing signed');
    const put = await call(sizesRoute.PUT, '/x', { id: mine.id }, { method: 'PUT', body: { thumbnailKey: SHARED, sizes: ['sm', 'xs'] } });
    assert.equal(put.status, 409);
    assert.deepEqual((await db.getFileById(mine.id)).thumbSizes, []);
    // The file that has it alone is unaffected once the other row lets go.
    await db.sql`UPDATE files SET thumbnail_key = NULL WHERE id = ${mine.id}`;
    as(OWNER);
    const own = await call(sizesRoute.POST, '/x', { id: theirs.id }, { method: 'POST' });
    assert.notEqual(own.status, 409, JSON.stringify(own.body));
    t.after(() => as(null));
  });
});
