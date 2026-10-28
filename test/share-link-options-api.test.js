// A link's options past who it is for: downloads, an expiry chosen or
// changed later, how its page looks, and the templates a sharer starts
// from — the real route handlers and queries against a real database. Runs
// with TEST_DATABASE_URL pointing at a throwaway database, and skips without
// one.
//
// Stubbed as in test/folder-shares-api.test.js: '@/auth' returns whoever the
// test says is signed in, 'next/headers' reads the jar of whichever browser
// the test says is asking, and the flags every principal is made with are
// laid over the table's.

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
process.env.ADMIN_EMAILS = 'boss@linkoptions.test';
process.env.AUTH_SECRET = 'link-options-test-secret';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const AUTH = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__session || null; }')}`;
const HEADERS = `data:text/javascript,${encodeURIComponent(`
  export function cookies() {
    const jar = globalThis.__jar || new Map();
    return {
      get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name, value) => { jar.set(name, value); },
      delete: (name) => { jar.delete(name); },
    };
  }
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
const access = await import('../lib/share-access.js');
const fileShares = await import('../app/api/files/[id]/shares/route.js');
const fileShare = await import('../app/api/files/[id]/shares/[token]/route.js');
const folderShares = await import('../app/api/files/folders/shares/route.js');
const folderShare = await import('../app/api/files/folders/shares/[token]/route.js');
const fileDownload = await import('../app/s/[token]/download/route.js');
const folderFileDownload = await import('../app/s/[token]/files/[id]/download/route.js');
const templates = await import('../app/api/share-templates/route.js');
const template = await import('../app/api/share-templates/[id]/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const DOMAIN = 'linkoptions.test';
const BOSS = `boss@${DOMAIN}`;
const OWNER = `owner-${tag}@${DOMAIN}`;     // editor of the drive; makes the links
const VIEWER = `viewer-${tag}@${DOMAIN}`;   // a viewer of it
const CONTRIB = `contrib-${tag}@${DOMAIN}`; // an editor in the Contributor role: private links only, 30 days at most
const GONER = `goner-${tag}@${DOMAIN}`;     // removed at the end, with their templates
const P = `slo-${tag}`;
const DAY = 86400000;

const as = (email) => { globalThis.__session = email ? { user: { email } } : null; globalThis.__jar = new Map(); };
const req = (url, init = {}) => new Request(`http://app.test${url}`, {
  ...init,
  headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
});
async function call(handler, url, params, init) {
  const res = await handler(req(url, init), { params });
  const location = res.headers.get('location');
  const body = location ? null : await res.json().catch(() => null);
  return { status: res.status, body, location };
}

const file = {
  make: (f, body) => call(fileShares.POST, `/api/files/${f.id}/shares`, { id: f.id }, { method: 'POST', body }),
  list: (f) => call(fileShares.GET, `/api/files/${f.id}/shares`, { id: f.id }),
  change: (f, token, body) => call(fileShare.PATCH, `/api/files/${f.id}/shares/${token}`, { id: f.id, token }, { method: 'PATCH', body }),
};
const folder = {
  make: (body) => call(folderShares.POST, '/api/files/folders/shares', {}, { method: 'POST', body }),
  change: (token, body) => call(folderShare.PATCH, `/api/files/folders/shares/${token}`, { token }, { method: 'PATCH', body }),
};
const guest = {
  download: (token) => { as(null); return call(fileDownload.GET, `/s/${token}/download`, { token }); },
  folderDownload: (token, id) => { as(null); return call(folderFileDownload.GET, `/s/${token}/files/${id}/download`, { token, id }); },
};
const tpl = {
  list: () => call(templates.GET, '/api/share-templates', {}),
  save: (body) => call(templates.POST, '/api/share-templates', {}, { method: 'POST', body }),
  remove: (id) => call(template.DELETE, `/api/share-templates/${id}`, { id }, { method: 'DELETE' }),
};

let drive;
const f = {};
const made = [];

before(async () => {
  if (!live) return;
  await db.ensureSchema();
  drive = await db.createFilespace({ name: `Options ${tag}`, bucket: 'b', prefix: P, createdBy: BOSS });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: CONTRIB, role: 'editor' });
  for (const email of [OWNER, VIEWER, CONTRIB, GONER]) {
    await db.adminAddApprovedInvite({ email, name: email.split('@')[0], reviewedBy: 'test' });
  }
  await db.upsertPerson(CONTRIB, { roleId: 'contributor' });
  const put = async (key, name, dir) => {
    const row = await db.createFile({
      name, folder: dir, url: `http://s3.test/b/${key}`, mime: 'image/jpeg', kind: 'image', size: 10,
      storage: 's3', storageKey: key, createdBy: OWNER,
    });
    made.push(row.id);
    return row;
  };
  f.pic = await put(`${P}/Shoot/a.jpg`, 'a.jpg', 'Shoot');
  f.other = await put(`${P}/Shoot/b.jpg`, 'b.jpg', 'Shoot');
});

after(async () => {
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    await db.sql`DELETE FROM file_shares WHERE created_by LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM share_templates WHERE owner LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM folders WHERE filespace LIKE ${`%${tag}%`}`.catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM people WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM audit_events WHERE actor LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('a file link’s options', { skip }, () => {
  const t = {};

  test('made with downloads off and a look, and never handed back for a plain link', async () => {
    as(OWNER);
    const look = { view: 'presentation', theme: 'dark', accent: '#1d4ed8', logo: 'none', title: 'Selects', message: 'For Friday.', sender: true };
    const shown = await file.make(f.pic, { kind: 'public', downloads: false, look });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(shown.body.share.downloads, false);
    assert.deepEqual(shown.body.share.look, { ...look, accent: '#1D4ED8' });
    t.shown = shown.body.share.token;

    // The reuse bug the password comment in createShare describes, for the
    // new columns: a plain request must not get the downloads-off link, and
    // a downloads-off one must not get the plain link.
    const plain = await file.make(f.pic, { kind: 'public' });
    assert.notEqual(plain.body.share.token, t.shown);
    assert.equal(plain.body.share.downloads, true);
    assert.equal(plain.body.share.look, null);
    t.plain = plain.body.share.token;
    assert.equal((await file.make(f.pic, { kind: 'public' })).body.share.token, t.plain, 'plain is reused');
    const again = await file.make(f.pic, { kind: 'public', downloads: false });
    assert.notEqual(again.body.share.token, t.plain);
    assert.notEqual(again.body.share.token, t.shown, 'an option set is never reused');
    const styled = await file.make(f.pic, { kind: 'public', look: { theme: 'light' } });
    assert.notEqual(styled.body.share.token, t.plain);
  });

  test('refused rather than dropped: a view that is not a file’s, a bad accent, a private link without downloads', async () => {
    as(OWNER);
    assert.match((await file.make(f.pic, { kind: 'public', look: { view: 'gallery' } })).body.error, /lays out/);
    assert.match((await file.make(f.pic, { kind: 'public', look: { accent: 'tomato' } })).body.error, /#RRGGBB/);
    const priv = await file.make(f.pic, { kind: 'private', downloads: false });
    assert.equal(priv.status, 400);
    assert.match(priv.body.error, /members/);
  });

  test('a guest gets the look once in, and no download from a link that allows none', async () => {
    const shown = await access.resolveShareAccess(t.shown);
    assert.equal(shown.state, 'ok');
    assert.equal(shown.downloads, false);
    assert.equal(shown.look.view, 'presentation');
    assert.equal(shown.look.theme, 'dark');
    const refused = await guest.download(t.shown);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /turned off/);
    for (const variant of ['proxy', 'poster']) {
      as(null);
      const r = await call(fileDownload.GET, `/s/${t.shown}/download?variant=${variant}`, { token: t.shown });
      assert.equal(r.status, 403, variant);
    }
    const plain = await guest.download(t.plain);
    assert.ok([302, 307].includes(plain.status), `a plain link downloads: ${plain.status}`);
    assert.ok(plain.location);
  });

  test('the look and downloads change in place; opening up is held to what making would be', async () => {
    as(OWNER);
    const restyled = await file.change(f.pic, t.shown, { look: { view: 'standard', theme: 'light' } });
    assert.equal(restyled.status, 200, JSON.stringify(restyled.body));
    assert.deepEqual(restyled.body.share.look, { theme: 'light' }, 'the whole look is replaced');
    assert.equal((await file.change(f.pic, t.shown, { look: null })).body.share.look, null);

    // A Contributor may change the file, so may narrow its links — but may
    // not make public links, so may not open one up.
    as(CONTRIB);
    const on = await file.change(f.pic, t.shown, { downloads: true });
    assert.equal(on.status, 403);
    assert.match(on.body.error, /private links only/);
    const off = await file.change(f.pic, t.plain, { downloads: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.share.downloads, false);
    assert.equal((await guest.download(t.plain)).status, 403, 'refused from the next request');

    as(OWNER);
    assert.equal((await file.change(f.pic, t.plain, { downloads: true })).body.share.downloads, true);
    assert.ok([302, 307].includes((await guest.download(t.plain)).status));

    // Someone who can only view the file manages none of its links.
    as(VIEWER);
    assert.equal((await file.change(f.pic, t.plain, { look: { theme: 'dark' } })).status, 403);
    as(OWNER);
    assert.match((await file.change(f.pic, t.plain, { look: { view: 'gallery' } })).body.error, /lays out/);
    assert.equal((await file.change(f.pic, t.plain, { downloads: 'yes' })).status, 400);
  });

  test('an expiry can be chosen as a date, and changed later within the role’s longest', async () => {
    as(CONTRIB);
    const week = await file.make(f.pic, { kind: 'private', expires: '7' });
    assert.equal(week.status, 200);
    const tok = week.body.share.token;
    // Contributor: links last at most 30 days.
    const never = await file.change(f.pic, tok, { expires: 'never' });
    assert.equal(never.status, 403);
    assert.match(never.body.error, /within 30 days/);
    assert.equal((await file.change(f.pic, tok, { expires: '90' })).status, 403);
    const month = await file.change(f.pic, tok, { expires: '30' });
    assert.equal(month.status, 200, JSON.stringify(month.body));
    assert.ok(Math.abs(month.body.share.expiresAt - (Date.now() + 30 * DAY)) < 60000);
    const date = Date.now() + 20 * DAY;
    const dated = await file.change(f.pic, tok, { expires: 'date', expiresAt: date });
    assert.equal(dated.status, 200);
    assert.equal(dated.body.share.expiresAt, date);
    assert.equal((await file.change(f.pic, tok, { expires: 'date', expiresAt: Date.now() + 31 * DAY })).status, 403);
    assert.equal((await file.change(f.pic, tok, { expires: 'date', expiresAt: Date.now() - DAY })).status, 400);
    // A link made on a date is held to the same limit.
    assert.equal((await file.make(f.pic, { kind: 'private', expires: 'date', expiresAt: Date.now() + 45 * DAY })).status, 403);
    assert.equal((await file.make(f.pic, { kind: 'private', expires: 'date', expiresAt: Date.now() + 10 * DAY })).status, 200);
  });

  test('an expired link comes back when it is given a later expiry', async () => {
    as(OWNER);
    const made1 = await file.make(f.pic, { kind: 'public', expires: '1' });
    const tok = made1.body.share.token;
    await db.sql`UPDATE file_shares SET expires_at = ${Date.now() - 1000} WHERE token = ${tok}`;
    assert.equal((await access.resolveShareAccess(tok)).state, 'expired');
    // Turning downloads on is opening up, and an expired link has no time left to open.
    await db.sql`UPDATE file_shares SET downloads = false WHERE token = ${tok}`;
    const stuck = await file.change(f.pic, tok, { downloads: true });
    assert.equal(stuck.status, 400);
    assert.match(stuck.body.error, /expired/);
    const back = await file.change(f.pic, tok, { expires: '7', downloads: true });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal((await access.resolveShareAccess(tok)).state, 'ok');
  });

  test('the list shows each link’s downloads and look; a password never', async () => {
    as(OWNER);
    const pw = await file.make(f.pic, { kind: 'password', password: 'hunter22', downloads: false });
    assert.equal(pw.status, 200);
    const listed = await file.list(f.pic);
    const one = listed.body.shares.find((s) => s.token === pw.body.share.token);
    assert.equal(one.downloads, false);
    assert.equal(JSON.stringify(listed.body).includes('hunter22'), false);
    assert.equal(JSON.stringify(listed.body).includes('scrypt'), false);
  });
});

describe('a folder link’s options', { skip }, () => {
  let tok;

  test('made in a view of its own with downloads off; a file of it does not download', async () => {
    as(OWNER);
    const r = await folder.make({ folder: 'Shoot', filespaceId: drive.id, kind: 'public', downloads: false, look: { view: 'gallery', theme: 'dark' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.share.downloads, false);
    assert.deepEqual(r.body.share.look, { view: 'gallery', theme: 'dark' });
    tok = r.body.share.token;
    assert.notEqual((await folder.make({ folder: 'Shoot', filespaceId: drive.id, kind: 'public' })).body.share.token, tok);
    assert.match((await folder.make({ folder: 'Shoot', filespaceId: drive.id, kind: 'public', look: { view: 'presentation' } })).body.error, /lays out/);

    const open = await access.resolveFolderShareAccess(tok);
    assert.equal(open.state, 'ok');
    assert.equal(open.look.view, 'gallery');
    assert.equal(open.downloads, false);
    const refused = await guest.folderDownload(tok, f.pic.id);
    assert.equal(refused.status, 403);
  });

  test('changed in place by whoever may manage the folder’s links', async () => {
    as(VIEWER);
    assert.equal((await folder.change(tok, { downloads: true })).status, 403);
    as(CONTRIB);
    // May manage the folder (an editor), may not open a public link up.
    assert.equal((await folder.change(tok, { downloads: true })).status, 403);
    assert.equal((await folder.change(tok, { look: { view: 'list' } })).status, 200);
    as(OWNER);
    const on = await folder.change(tok, { downloads: true, expires: '30' });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.share.downloads, true);
    assert.deepEqual(on.body.share.look, { view: 'list' });
    assert.ok(on.body.share.expiresAt > Date.now());
    const dl = await guest.folderDownload(tok, f.pic.id);
    assert.ok([302, 307].includes(dl.status), `downloads now: ${dl.status}`);
    as(OWNER);
    assert.match((await folder.change(tok, { review: 'comment' })).body.error, /cannot take comments/);
    assert.equal((await folder.change('nope-not-a-token-at-all', { downloads: false })).status, 404);
  });
});

describe('share templates', { skip }, () => {
  test('saved for oneself, replaced by name, never with a password, and removed', async () => {
    as(null);
    assert.equal((await tpl.list()).status, 401);
    as(OWNER);
    assert.deepEqual((await tpl.list()).body.templates, []);
    const saved = await tpl.save({ name: 'Client cut', settings: { kind: 'password', password: 'hunter22', expires: '7', review: 'approve', downloads: false, views: { file: 'presentation' }, look: { theme: 'dark' } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(JSON.stringify(saved.body).includes('hunter22'), false);
    assert.deepEqual(saved.body.template.settings, { kind: 'password', expires: '7', review: 'approve', downloads: false, views: { file: 'presentation' }, look: { theme: 'dark' } });

    const replaced = await tpl.save({ name: 'client CUT', settings: { kind: 'public' } });
    assert.equal(replaced.body.template.id, saved.body.template.id, 'the same name, any case, is the same template');
    assert.equal((await tpl.list()).body.templates.length, 1);

    assert.equal((await tpl.save({ name: '', settings: {} })).status, 400);
    assert.equal((await tpl.save({ name: 'Dated', settings: { expires: 'date' } })).status, 400);
    assert.equal((await tpl.save({ name: 'Bad view', settings: { views: { file: 'gallery' } } })).status, 400);

    // Someone else's is not theirs to see or remove.
    as(VIEWER);
    assert.deepEqual((await tpl.list()).body.templates, []);
    assert.equal((await tpl.remove(saved.body.template.id)).status, 404);
    as(OWNER);
    assert.equal((await tpl.remove(saved.body.template.id)).status, 200);
    assert.deepEqual((await tpl.list()).body.templates, []);
  });

  test('a person removed takes their templates with them', async () => {
    as(GONER);
    assert.equal((await tpl.save({ name: 'Mine', settings: { kind: 'public' } })).status, 200);
    await db.removePerson(GONER, { apply: true, by: BOSS });
    const left = await db.sql`SELECT count(*)::int AS n FROM share_templates WHERE owner = ${GONER}`;
    assert.equal(left[0].n, 0);
  });
});
