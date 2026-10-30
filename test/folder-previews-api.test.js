// What a folder's preview shows (POST /api/files/previews, lib/file-listing.js
// folderPreviews): its newest pictures, the folder and everything beneath it,
// held to the listing's own rules — the drive boundary, a file shown only to
// its owner, the trash — and nothing but thumbnails in the answer. The real
// route and queries against a real database: runs with TEST_DATABASE_URL
// pointing at a throwaway database, and skips without one.
//
// Stubbed as in test/folder-shares-api.test.js: '@/auth' returns whoever the
// test says is signed in, and the flags every principal is made with are laid
// over the table's (All files on, so its case can be asked).

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
process.env.ADMIN_EMAILS = 'boss@folderpreviews.test';
process.env.AUTH_SECRET = 'folder-previews-test-secret';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const AUTH = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__session || null; }')}`;
const HEADERS = `data:text/javascript,${encodeURIComponent(`
  export function cookies() { return { get: () => undefined, set() {}, delete() {} }; }
  export function headers() { return new Headers(); }
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH, shortCircuit: true };
    if (specifier === 'next/headers') return { url: HEADERS, shortCircuit: true };
    if (specifier === './db.js' && context.parentURL?.endsWith('/lib/authz.js')) {
      const real = next(specifier, context).url;
      const src = `export * from ${JSON.stringify(real)};
        import { getSetting as read } from ${JSON.stringify(real)};
        export async function getSetting(key, opts) {
          const value = await read(key, opts);
          if (key !== 'features.flags') return value;
          return { ...(value || {}), ...(globalThis.__flagsOver || {}) };
        }`;
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

globalThis.__flagsOver = { library: true };

const db = await import('../lib/db.js');
const listing = await import('../lib/file-listing.js');
const { getPrincipal } = await import('../lib/authz.js');
const route = await import('../app/api/files/previews/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const DOMAIN = 'folderpreviews.test';
const BOSS = `boss@${DOMAIN}`;
const OWNER = `owner-${tag}@${DOMAIN}`;     // editor of the drive; made the files
const VIEWER = `viewer-${tag}@${DOMAIN}`;   // views the drive
const OUTSIDER = `outsider-${tag}@${DOMAIN}`; // in no drive
const P = `fpv-${tag}`;                     // the drive
const Q = `fpq-${tag}`;                     // another drive, the owner not in it

const as = (email) => { globalThis.__session = email ? { user: { email } } : null; };
async function ask(items) {
  const res = await route.POST(new Request('http://app.test/api/files/previews', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
}
const names = (tiles) => (tiles || []).map((t) => t.name);

let drive; let other;
const f = {};
const made = [];

before(async () => {
  if (!live) return;
  await db.ensureSchema();
  drive = await db.createFilespace({ name: `Previews ${tag}`, bucket: 'b', prefix: P, createdBy: BOSS });
  other = await db.createFilespace({ name: `Other ${tag}`, bucket: 'b', prefix: Q, createdBy: BOSS });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
  for (const email of [OWNER, VIEWER, OUTSIDER]) {
    await db.adminAddApprovedInvite({ email, name: email.split('@')[0], reviewedBy: 'test' });
  }
  let n = 0;
  const put = async (key, name, folder, over = {}) => {
    const row = await db.createFile({
      name, folder, url: `http://s3.test/b/${key}`, mime: 'image/jpeg', kind: 'image', size: 10,
      storage: 's3', storageKey: key, createdBy: OWNER, thumbnailUrl: `http://s3.test/b/thumbs/${key}.jpg`,
      metadata: { width: 400, height: 300 }, ...over,
    });
    // One millisecond apart at least, so "newest first" has an order to keep.
    await db.sql`UPDATE files SET created_at = ${Date.now() + n++} WHERE id = ${row.id}`;
    made.push(row.id);
    return row;
  };
  f.a = await put(`${P}/Shoot/a.jpg`, 'a.jpg', 'Shoot');
  f.deep = await put(`${P}/Shoot/sub/deep.jpg`, 'deep.jpg', 'Shoot/sub');
  f.mine = await put(`${P}/Shoot/mine.jpg`, 'mine.jpg', 'Shoot', { visibility: 'owner' });
  f.bare = await put(`${P}/Shoot/bare.jpg`, 'bare.jpg', 'Shoot', { thumbnailUrl: null });
  f.trashed = await put(`${P}/Shoot/trashed.jpg`, 'trashed.jpg', 'Shoot');
  await db.softDeleteFile(f.trashed.id, { deletedBy: OWNER });
  f.sibling = await put(`${P}/Shoots/sibling.jpg`, 'sibling.jpg', 'Shoots');
  f.elsewhere = await put(`${Q}/Shoot/elsewhere.jpg`, 'elsewhere.jpg', 'Shoot');
  for (let i = 0; i < 5; i++) await put(`${P}/Many/m${i}.jpg`, `m${i}.jpg`, 'Many');
});

after(async () => {
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    for (const d of [drive, other]) if (d) await db.deleteFilespace(d.id).catch(() => {});
    await db.sql`DELETE FROM folders WHERE filespace LIKE ${`%${tag}%`}`.catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM people WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('a folder’s preview', { skip }, () => {
  test('its newest pictures, from it and beneath it, held to who may see them', async () => {
    as(OWNER);
    const { status, body } = await ask([{ filespace: drive.id, folder: 'Shoot' }]);
    assert.equal(status, 200);
    // Newest first; their own owner-only file is theirs to see.
    assert.deepEqual(names(body.previews[0]), ['mine.jpg', 'deep.jpg', 'a.jpg']);

    as(VIEWER);
    const viewer = await ask([{ filespace: drive.id, folder: 'Shoot' }]);
    assert.deepEqual(names(viewer.body.previews[0]), ['deep.jpg', 'a.jpg'], 'someone else’s owner-only file is not in it');
  });

  test('never a picture from the trash, a sibling folder or another drive, nor a file without a thumbnail', async () => {
    as(OWNER);
    const { body } = await ask([{ filespace: drive.id, folder: 'Shoot' }]);
    const shown = names(body.previews[0]);
    for (const no of ['trashed.jpg', 'sibling.jpg', 'elsewhere.jpg', 'bare.jpg']) assert.ok(!shown.includes(no), no);
  });

  test('at most four, the newest; a drive’s top holds its whole drive', async () => {
    as(OWNER);
    const { body } = await ask([{ filespace: drive.id, folder: 'Many' }, { filespace: drive.id, folder: '' }]);
    assert.deepEqual(names(body.previews[0]), ['m4.jpg', 'm3.jpg', 'm2.jpg', 'm1.jpg']);
    assert.equal(body.previews[1].length, 4);
    assert.ok(names(body.previews[1]).every((n) => /^m\d\.jpg$/.test(n)), 'the newest in the whole drive');
  });

  test('a drive they may not open, and a malformed item, are empty — the others are still answered', async () => {
    as(OUTSIDER);
    const out = await ask([{ filespace: drive.id, folder: 'Shoot' }]);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.previews, [[]]);
    as(OWNER);
    const mixed = await ask([{ filespace: other.id, folder: 'Shoot' }, { filespace: drive.id, folder: 'Shoot' }, null, { filespace: drive.id, folder: 'x'.repeat(2000) }]);
    assert.deepEqual(mixed.body.previews[0], [], 'not their drive');
    assert.ok(mixed.body.previews[1].length > 0);
    assert.deepEqual(mixed.body.previews[3], []);
  });

  test('All files previews only what its own listing of the folder would show', async () => {
    as(OWNER);
    const { body } = await ask([{ filespace: '', folder: 'Shoot' }]);
    const principal = await getPrincipal(OWNER);
    const { files } = await db.listFilesForUser({ folderPrefix: 'Shoot', storagePrefix: undefined, limit: 500 }, principal);
    const listed = new Set(files.map((x) => x.id));
    assert.ok(body.previews[0].every((t) => listed.has(t.id)));
    assert.ok(!names(body.previews[0]).includes('elsewhere.jpg'), 'not from a drive they are not in');
    // Without All files, nothing.
    globalThis.__flagsOver = {};
    try {
      const off = await ask([{ filespace: '', folder: 'Shoot' }]);
      assert.deepEqual(off.body.previews, [[]]);
    } finally {
      globalThis.__flagsOver = { library: true };
    }
  });

  test('the answer is thumbnails only: never the original or anything else of the row', async () => {
    as(OWNER);
    const { body } = await ask([{ filespace: drive.id, folder: 'Shoot' }]);
    const text = JSON.stringify(body);
    assert.ok(!text.includes('http://s3.test/b/fpv'), 'no original address');
    for (const t of body.previews[0]) {
      assert.deepEqual(Object.keys(t).sort(), ['grid', 'height', 'id', 'name', 'placeholder', 'sm', 'width', 'xs']);
      assert.match(t.grid, /\/thumbs\//);
    }
  });

  test('refused: no one signed in, no list, too many at once', async () => {
    as(null);
    assert.equal((await ask([{ folder: '' }])).status, 401);
    as(OWNER);
    const none = await route.POST(new Request('http://app.test/api/files/previews', { method: 'POST', body: '{}' }));
    assert.equal(none.status, 400);
    assert.equal((await ask(Array.from({ length: listing.PREVIEW_MAX_FOLDERS + 1 }, () => ({ folder: '' })))).status, 400);
  });
});
