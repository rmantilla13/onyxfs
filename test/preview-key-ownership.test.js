// A preview key (thumbnail, player poster, filmstrip) is a random name, not a
// secret: it rides in every signed thumbnail URL and on the rows a listing or
// a share page sends. Recording one another file uses let someone who could
// edit a file of their own
//   - keep that other file's 2400px preview signed on their row after losing
//     access to it (the poster adopt), and
//   - have the sizes route sign PUTs over that file's sm/xs renditions, which
//     every member of its drive is then shown (the sibling overwrite).
// Writes now take only a key no other row holds (lib/db.js
// previewKeysInUse). The real route handlers, against a real database, with
// only the session stubbed; the database half skips without
// TEST_DATABASE_URL.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';

// lib/db.js reads DATABASE_URL when it is first imported, so everything that
// reaches it is imported below, once that is set.
const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@keys.test';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__keysSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__keysSession = email ? { user: { email } } : null; };

const db = await import('../lib/db.js');
const gc = await import('../lib/preview-gc.js');
const { previewKeysOf, previewObjects, withoutTakenPreviews } = gc;
const thumbRoute = await import('../app/api/files/[id]/thumbnail/route.js');
const sizesRoute = await import('../app/api/files/[id]/thumbnail/sizes/route.js');
const filesRoute = await import('../app/api/files/route.js');

const src = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

// ── Without a database ─────────────────────────────────────────────────────

test('withoutTakenPreviews drops a taken thumbnail with its poster and siblings, a strip with its geometry', () => {
  const T = `_thumbs/${randomUUID()}.webp`;
  const P = `_thumbs/${randomUUID()}.poster.webp`;
  const S = `_thumbs/${randomUUID()}.strip.webp`;
  const fields = {
    kind: 'video', thumbnailKey: T, posterKey: P, thumbSizes: ['sm', 'xs'], filmstripKey: S,
    metadata: { width: 10, height: 10, filmstrip: { frames: 40, columns: 8, tileWidth: 160, tileHeight: 90 } },
  };
  assert.equal(withoutTakenPreviews(fields, new Set()), fields, 'nothing taken, nothing changed');
  const a = withoutTakenPreviews(fields, new Set([T]));
  assert.equal(a.thumbnailKey, null);
  assert.equal(a.posterKey, null, 'the same picture, larger');
  assert.equal(a.thumbSizes, null, 'their keys are the thumbnail’s');
  assert.equal(a.filmstripKey, S);
  assert.deepEqual(a.metadata.filmstrip, fields.metadata.filmstrip);
  const b = withoutTakenPreviews(fields, new Set([P]));
  assert.equal(b.thumbnailKey, null, 'a stolen poster takes the thumbnail with it');
  const c = withoutTakenPreviews(fields, new Set([S]));
  assert.equal(c.filmstripKey, null);
  assert.equal(c.metadata.filmstrip, undefined);
  assert.equal(c.metadata.width, 10, 'the upload keeps its facts');
  assert.equal(c.thumbnailKey, T);
});

test('the thumbnail PUT refuses a key another file uses, before it writes, and fails closed', async () => {
  const route = await src('app/api/files/[id]/thumbnail/route.js');
  const put = route.slice(route.indexOf('export async function PUT'));
  const check = put.indexOf('previewKeysInUse(');
  assert.ok(check > 0, 'PUT checks the keys');
  assert.ok(check < put.indexOf('setFileThumbnail('), 'checked before the write');
  assert.match(put, /previewKeysInUse\(\[body\.thumbnailKey, body\.posterKey\], \{ exceptId: existing\.id \}\)/);
  assert.match(put, /status: 409/);
  assert.match(put, /status: 503/, 'a check that cannot be made fails closed');
});

test('POST /api/files drops preview keys another file uses, and all of them when it cannot tell', async () => {
  const route = await src('app/api/files/route.js');
  // The whitelisted record (lib/file-record.js), not the raw body.
  assert.match(route, /const previews = await ownPreviews\(uploadFields\(record\)\)/);
  assert.match(route, /\.\.\.previews,/);
  assert.match(route, /try \{ taken = await previewKeysInUse\(keys\); \} catch \{ taken = new Set\(keys\); \}/);
});

test('the sizes route signs and records nothing for a thumbnail another row holds', async () => {
  const route = await src('app/api/files/[id]/thumbnail/sizes/route.js');
  const post = route.slice(route.indexOf('export async function POST'), route.indexOf('export async function PUT'));
  assert.ok(post.indexOf('sharedThumbnail(') > 0 && post.indexOf('sharedThumbnail(') < post.indexOf('s3PresignSiblingPut('));
  const put = route.slice(route.indexOf('export async function PUT'));
  assert.ok(put.indexOf('sharedThumbnail(') > 0 && put.indexOf('sharedThumbnail(') < put.indexOf('recordThumbSizes('));
});

test('previewKeysOf and previewObjects name only server previews, and a thumbnail’s siblings with it', () => {
  const U = randomUUID();
  const rows = [
    { thumbnailKey: `_thumbs/${U}.webp`, posterKey: `_thumbs/${U}.poster.webp`, filmstripKey: `_thumbs/${U}.strip.webp` },
    { thumbnailKey: 'files/legacy-thumb-a.jpg', posterKey: 'files/a.jpg', filmstripKey: null },
  ];
  const keys = previewKeysOf(rows);
  assert.deepEqual(keys, { thumbKeys: [`_thumbs/${U}.webp`], posterKeys: [`_thumbs/${U}.poster.webp`], stripKeys: [`_thumbs/${U}.strip.webp`] });
  assert.deepEqual(previewObjects([`_thumbs/${U}.webp`, 'files/a.jpg']).sort(), [`_thumbs/${U}.webp`, `_thumbs/${U}.sm.webp`, `_thumbs/${U}.xs.webp`].sort());
});

test('a delete takes its previews with it: with the trash off, and when the trash is purged', async () => {
  const del = await src('app/api/files/[id]/route.js');
  const off = del.slice(del.indexOf('if (flags.trash === false)'));
  assert.ok(off.indexOf('dropUnusedPreviews(') > off.indexOf('await deleteFile(id)'), 'after the row is gone');
  // The purge is lib/maintenance.js's, shared by the cron and Admin → Trash.
  const purge = await src('lib/maintenance.js');
  assert.ok(purge.indexOf('dropUnusedPreviews(') > purge.indexOf('await deleteFile(row.id)'), 'after the row is gone');
  const folders = await src('app/api/files/folders/route.js');
  assert.match(folders, /if \(flags\.trash === false\) \{\n\s+const gone = /);
});

// ── With a database ────────────────────────────────────────────────────────

const tag = Math.random().toString(36).slice(2, 8);
const OWNER = `owner-${tag}@keys.test`;
const MEMBER = `member-${tag}@keys.test`;
const PREFIX = `pk-${tag}`;
const thumb = () => `_thumbs/${randomUUID()}.webp`;
const poster = () => `_thumbs/${randomUUID()}.poster.webp`;
const strip = () => `_thumbs/${randomUUID()}.strip.webp`;

const made = [];
let drive;

async function call(handler, params, method, body, url = 'http://app.test/x') {
  const res = await handler(new Request(url, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }), { params });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function file(fields) {
  const f = await db.createFile({
    url: 'http://s3.test/b/x', name: `pk-${randomUUID()}.jpg`, mime: 'image/jpeg', kind: 'image', size: 1,
    storage: 's3', storageKey: `files/pk/${randomUUID()}.jpg`, createdBy: OWNER, ...fields,
  });
  made.push(f.id);
  return f;
}

before(async () => {
  if (!live) return;
  drive = await db.createFilespace({ name: `Keys ${tag}`, bucket: 'b', prefix: PREFIX, createdBy: 'boss@keys.test' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: MEMBER, role: 'viewer' });
  for (const email of [OWNER, MEMBER]) await db.adminAddApprovedInvite({ email, name: email, reviewedBy: 'test' });
});

after(async () => {
  as(null);
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@keys.test`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('previewKeysInUse', { skip }, () => {
  test("another file's thumbnail, poster and filmstrip keys are in use; a file's own are not", async () => {
    const t = thumb(); const p = poster(); const s = strip();
    const victim = await file({ thumbnailKey: t, posterKey: p, filmstripKey: s });
    const mine = await file({});
    assert.deepEqual([...await db.previewKeysInUse([t, p, s], { exceptId: mine.id })].sort(), [p, s, t].sort());
    assert.equal((await db.previewKeysInUse([t, p, s], { exceptId: victim.id })).size, 0);
    assert.equal((await db.previewKeysInUse([thumb()])).size, 0, 'a fresh key is free');
    assert.equal((await db.previewKeysInUse([])).size, 0);
  });
});

describe('the sibling overwrite (a drive viewer, a file of their own)', { skip }, () => {
  test('cannot take the drive file’s thumbnail, so is never handed PUTs for its siblings', async () => {
    const VICTIM = thumb();
    const victim = await file({ storageKey: `${PREFIX}/v.jpg`, thumbnailKey: VICTIM, thumbSizes: ['sm', 'xs'] });
    const mine = await file({ storageKey: `library/${MEMBER}/m.jpg`, createdBy: MEMBER });
    as(MEMBER);
    assert.equal((await call(sizesRoute.POST, { id: victim.id }, 'POST')).status, 403, 'a viewer writes nothing of the drive’s');
    const adopt = await call(thumbRoute.PUT, { id: mine.id }, 'PUT', { thumbnailKey: VICTIM });
    assert.equal(adopt.status, 409, JSON.stringify(adopt.body));
    assert.match(adopt.body.error, /belongs to another file/);
    assert.equal((await db.getFileById(mine.id)).thumbnailKey, null, 'nothing recorded');
    const sizes = await call(sizesRoute.POST, { id: mine.id }, 'POST');
    assert.equal(sizes.status, 409, 'no thumbnail of its own to size');
    assert.equal(sizes.body?.siblings, undefined);
    assert.deepEqual((await db.getFileById(victim.id)).thumbSizes, ['sm', 'xs']);
  });
});

describe('the poster adopt (keeping a preview after losing access)', { skip }, () => {
  test('neither the pair nor the poster alone can be recorded on another row', async () => {
    const TK = thumb(); const PK = poster();
    const victim = await file({ storageKey: `${PREFIX}/secret.jpg`, size: 9e6, thumbnailKey: TK, posterKey: PK });
    const mine = await file({ storageKey: `library/${MEMBER}/m2.jpg`, createdBy: MEMBER });
    // A member saw the keys in the listing; then was removed from the drive.
    await db.revokeFilespaceAccess({ filespaceId: drive.id, email: MEMBER });
    assert.equal(await db.canAccessFile(await db.getFileById(victim.id), await db.buildPrincipal(MEMBER)), false, "no longer a member");
    try {
      as(MEMBER);
      const pair = await call(thumbRoute.PUT, { id: mine.id }, 'PUT', { thumbnailKey: TK, posterKey: PK });
      assert.equal(pair.status, 409, JSON.stringify(pair.body));
      assert.equal(pair.body.file, undefined, 'no signed poster handed back');
      const alone = await call(thumbRoute.PUT, { id: mine.id }, 'PUT', { thumbnailKey: thumb(), posterKey: PK });
      assert.equal(alone.status, 409, 'a fresh thumbnail does not carry another file’s poster in');
      const row = await db.getFileById(mine.id);
      assert.equal(row.posterKey, null);
      assert.equal(row.thumbnailKey, null);
      // So when the owner replaces the victim's preview, nothing keeps it alive.
      await db.sql`UPDATE files SET poster_key = NULL WHERE id = ${victim.id}`;
      assert.deepEqual(await db.unreferencedPreviewKeys({ posterKeys: [PK] }), [PK]);
    } finally {
      await db.grantFilespaceAccess({ filespaceId: drive.id, email: MEMBER, role: 'viewer' });
    }
  });

  test('a file’s own keys, and fresh ones, are still recorded', async () => {
    const mine = await file({ createdBy: MEMBER, storageKey: `library/${MEMBER}/m3.jpg` });
    as(MEMBER);
    const T = thumb(); const P = poster();
    const r = await call(thumbRoute.PUT, { id: mine.id }, 'PUT', { thumbnailKey: T, posterKey: P });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const again = await call(thumbRoute.PUT, { id: mine.id }, 'PUT', { thumbnailKey: T, posterKey: P });
    assert.equal(again.status, 200, 'its own keys are not another file’s');
  });
});

// The fill-in's preview-only form: an image with a thumbnail gets its large
// preview from the original a viewer fetched, and nothing else moves.
describe('the thumbnail PUT with a preview alone', { skip }, () => {
  test('records the preview, keeps the thumbnail, its siblings and seq, and fills only missing sizes', async () => {
    const T = thumb();
    const f = await file({ createdBy: MEMBER, storageKey: `library/${MEMBER}/p-${randomUUID()}.jpg`, thumbnailKey: T, thumbSizes: ['sm', 'xs'], metadata: { width: 6000 } });
    const before = await db.getFileById(f.id);
    as(MEMBER);
    const P = poster();
    const r = await call(thumbRoute.PUT, { id: f.id }, 'PUT', { posterKey: P, media: { width: 10, height: 4000 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await db.getFileById(f.id);
    assert.equal(after.posterKey, P);
    assert.equal(after.thumbnailKey, T);
    assert.deepEqual(after.thumbSizes, ['sm', 'xs']);
    assert.equal(after.seq, before.seq, 'devices have nothing to pull');
    assert.deepEqual([after.metadata.width, after.metadata.height], [6000, 4000], 'the row’s own width stands');
  });

  test('refuses another file’s poster, and anything that is not a poster key', async () => {
    const PK = poster();
    await file({ thumbnailKey: thumb(), posterKey: PK });
    const mine = await file({ createdBy: MEMBER, storageKey: `library/${MEMBER}/q-${randomUUID()}.jpg`, thumbnailKey: thumb() });
    as(MEMBER);
    assert.equal((await call(thumbRoute.PUT, { id: mine.id }, 'PUT', { posterKey: PK })).status, 409);
    assert.equal((await call(thumbRoute.PUT, { id: mine.id }, 'PUT', { posterKey: thumb() })).status, 400);
    assert.equal((await db.getFileById(mine.id)).posterKey, null);
  });
});

describe('POST /api/files', { skip }, () => {
  test('records the upload, without preview keys another row holds', async () => {
    const TK = thumb(); const PK = poster(); const SK = strip();
    await file({ thumbnailKey: TK, posterKey: PK, filmstripKey: SK });
    as(MEMBER);
    const body = {
      name: 'up.mp4', url: 'http://s3.test/b/up.mp4', mime: 'video/mp4', size: 1, storage: 's3',
      storageKey: `library/${MEMBER}/up-${randomUUID()}.mp4`, thumbnailKey: TK, posterKey: PK, thumbSizes: ['sm', 'xs'],
      filmstripKey: SK, filmstrip: { frames: 40, columns: 8, tileWidth: 160, tileHeight: 90 }, media: { width: 1920, height: 1080 },
    };
    // POST /api/files records only a key presign issued to this person
    // (lib/db.js claimUploadKey), as a real upload's would be.
    await db.issueUploadKey(body.storageKey, MEMBER);
    const r = await call(filesRoute.POST, {}, 'POST', body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    made.push(r.body.file.id);
    const row = await db.getFileById(r.body.file.id);
    assert.equal(row.thumbnailKey, null);
    assert.equal(row.posterKey, null);
    assert.deepEqual(row.thumbSizes, []);
    assert.equal(row.filmstripKey, null);
    assert.equal(row.metadata.filmstrip, undefined);
    assert.equal(row.metadata.width, 1920, 'still recorded, with its facts');

    const fresh = { ...body, storageKey: `library/${MEMBER}/up-${randomUUID()}.mp4`, thumbnailKey: thumb(), posterKey: poster(), filmstripKey: strip() };
    await db.issueUploadKey(fresh.storageKey, MEMBER);
    const ok = await call(filesRoute.POST, {}, 'POST', fresh);
    assert.equal(ok.status, 200);
    made.push(ok.body.file.id);
    const kept = await db.getFileById(ok.body.file.id);
    assert.equal(kept.thumbnailKey, fresh.thumbnailKey);
    assert.equal(kept.posterKey, fresh.posterKey);
    assert.deepEqual(kept.thumbSizes, ['sm', 'xs']);
    assert.equal(kept.filmstripKey, fresh.filmstripKey);
  });
});

describe('dropUnusedPreviews', { skip }, () => {
  test('deletes what no row points at, with a thumbnail’s siblings — never what another row still holds', async () => {
    const SHARED = thumb(); const OWN = thumb(); const P = poster(); const S = strip();
    const a = await file({ thumbnailKey: SHARED });
    const b = await file({ thumbnailKey: OWN, posterKey: P, filmstripKey: S });
    await db.sql`UPDATE files SET thumbnail_key = ${SHARED} WHERE id = ${a.id}`;
    const other = await file({});
    await db.sql`UPDATE files SET thumbnail_key = ${SHARED} WHERE id = ${other.id}`;
    const before = await db.getFileById(b.id);
    await db.deleteFile(b.id);
    await db.deleteFile(a.id);
    const removed = [];
    const n = await gc.dropUnusedPreviews(gc.previewKeysOf([before, { thumbnailKey: SHARED }]), { remove: async (k) => { removed.push(k); return true; } });
    const base = (k) => k.replace(/\.(webp|jpg)$/, '');
    assert.deepEqual(removed.sort(), [OWN, `${base(OWN)}.sm.webp`, `${base(OWN)}.xs.webp`, P, S].sort());
    assert.equal(n, 5);
    assert.ok(!removed.includes(SHARED), 'another row still shows it');
  });
});
