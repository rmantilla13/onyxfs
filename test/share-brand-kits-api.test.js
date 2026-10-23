// Brand kits: an admin's other looks for a share link's page, kept in the
// settings table (share.brands), offered to sharers, named by a link's look
// and found again by its page — and the workspace brand form beside them.
// The real route handlers and queries against a real database. Runs with
// TEST_DATABASE_URL pointing at a throwaway database, and skips without one.
//
// Stubbed as in test/share-link-options-api.test.js: '@/auth' returns
// whoever the test says is signed in, 'next/headers' reads the jar of
// whichever browser the test says is asking, and the flags every principal
// is made with are laid over the table's. The two settings rows changed here
// are global, so each is put back as it was afterwards.

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
process.env.ADMIN_EMAILS = 'boss@brandkits.test';
process.env.AUTH_SECRET = 'brand-kits-test-secret';
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
const { loadShareKit, loadBrand } = await import('../lib/brand-config.js');
const kitsRoute = await import('../app/api/admin/brand/kits/route.js');
const kitRoute = await import('../app/api/admin/brand/kits/[id]/route.js');
const brandRoute = await import('../app/api/admin/brand/route.js');
const shareBrands = await import('../app/api/share-brands/route.js');
const fileShares = await import('../app/api/files/[id]/shares/route.js');
const fileShare = await import('../app/api/files/[id]/shares/[token]/route.js');
const folderShares = await import('../app/api/files/folders/shares/route.js');
const folderShare = await import('../app/api/files/folders/shares/[token]/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const DOMAIN = 'brandkits.test';
const BOSS = `boss@${DOMAIN}`;
const OWNER = `owner-${tag}@${DOMAIN}`; // editor of the drive; makes the links
const P = `sbk-${tag}`;

const as = (email) => { globalThis.__session = email ? { user: { email } } : null; globalThis.__jar = new Map(); };
const req = (url, init = {}) => new Request(`http://app.test${url}`, {
  ...init,
  headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
});
async function call(handler, url, params, init) {
  const res = await handler(req(url, init), { params });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const kits = {
  list: () => call(kitsRoute.GET, '/api/admin/brand/kits', {}),
  add: (body) => call(kitsRoute.POST, '/api/admin/brand/kits', {}, { method: 'POST', body }),
  change: (id, body) => call(kitRoute.PATCH, `/api/admin/brand/kits/${id}`, { id }, { method: 'PATCH', body }),
  remove: (id) => call(kitRoute.DELETE, `/api/admin/brand/kits/${id}`, { id }, { method: 'DELETE' }),
  offered: () => call(shareBrands.GET, '/api/share-brands', {}),
};
const brand = {
  read: () => call(brandRoute.GET, '/api/admin/brand', {}),
  save: (config) => call(brandRoute.PUT, '/api/admin/brand', {}, { method: 'PUT', body: { config } }),
};
const file = {
  make: (f, body) => call(fileShares.POST, `/api/files/${f.id}/shares`, { id: f.id }, { method: 'POST', body }),
  change: (f, token, body) => call(fileShare.PATCH, `/api/files/${f.id}/shares/${token}`, { id: f.id, token }, { method: 'PATCH', body }),
};
const folder = {
  make: (body) => call(folderShares.POST, '/api/files/folders/shares', {}, { method: 'POST', body }),
  change: (token, body) => call(folderShare.PATCH, `/api/files/folders/shares/${token}`, { token }, { method: 'PATCH', body }),
};

const ACME = { name: `Acme ${tag}`, logoUrl: '/onyx-lockup.svg', logoDarkUrl: '/onyx-lockup-dark.svg', accent: '#be185d' };
const NORTH = { name: `North ${tag}`, logoUrl: 'https://cdn.north.test/logo.svg', accent: '#147538', displayFontFamily: 'Fraunces, Georgia, serif' };

let drive;
let pic;
const made = [];
const saved = {};

before(async () => {
  if (!live) return;
  await db.ensureSchema();
  // Both rows are the whole workspace's: kept, and put back in after().
  saved.kits = await db.getSetting('share.brands', { fresh: true, strict: true });
  saved.brand = await db.getSetting('brand.config', { fresh: true, strict: true });
  await db.deleteSetting('share.brands');
  drive = await db.createFilespace({ name: `Kits ${tag}`, bucket: 'b', prefix: P, createdBy: BOSS });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.adminAddApprovedInvite({ email: OWNER, name: 'owner', reviewedBy: 'test' });
  pic = await db.createFile({
    name: 'a.jpg', folder: 'Shoot', url: `http://s3.test/b/${P}/Shoot/a.jpg`, mime: 'image/jpeg', kind: 'image', size: 10,
    storage: 's3', storageKey: `${P}/Shoot/a.jpg`, createdBy: OWNER,
  });
  made.push(pic.id);
});

after(async () => {
  if (live) {
    const restore = async (key, value) => (value == null ? db.deleteSetting(key) : db.setSetting(key, value));
    await restore('share.brands', saved.kits).catch(() => {});
    await restore('brand.config', saved.brand).catch(() => {});
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    await db.sql`DELETE FROM file_shares WHERE created_by LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM folders WHERE filespace LIKE ${`%${tag}%`}`.catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM people WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM audit_events WHERE actor = ${BOSS} OR actor LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('brand kits', { skip }, () => {
  const t = {};

  test('only an admin manages them; anyone signed in is offered them', async () => {
    as(null);
    assert.equal((await kits.list()).status, 401);
    assert.equal((await kits.offered()).status, 401);
    as(OWNER);
    assert.equal((await kits.list()).status, 403);
    assert.equal((await kits.add(ACME)).status, 403);
    assert.equal((await kits.change('kAnything1', ACME)).status, 403);
    assert.equal((await kits.remove('kAnything1')).status, 403);
    assert.deepEqual((await kits.offered()).body, { kits: [] });
    as(BOSS);
    assert.deepEqual((await kits.list()).body, { kits: [] });
  });

  test('an admin adds a kit, checked whole; a sharer never types its images', async () => {
    as(BOSS);
    const added = await kits.add(ACME);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.match(added.body.kit.id, /^[A-Za-z0-9_-]{6,40}$/);
    assert.equal(added.body.kit.accent, '#BE185D');
    assert.equal(added.body.kit.links, 0);
    t.acme = added.body.kit.id;
    const north = await kits.add(NORTH);
    assert.equal(north.status, 200, JSON.stringify(north.body));
    t.north = north.body.kit.id;

    assert.equal((await kits.add({ ...ACME, name: ACME.name.toUpperCase() })).status, 409, 'names are kept apart, in any case');
    assert.match((await kits.add({ ...ACME, name: 'Evil', logoUrl: 'javascript:alert(1)' })).body.error, /https:\/\/ or \//);
    assert.match((await kits.add({ ...ACME, name: 'Insecure', logoUrl: 'http://cdn.test/a.svg' })).body.error, /https:\/\/ or \//);
    assert.match((await kits.add({ ...ACME, name: 'Pale', accent: 'pink' })).body.error, /#RRGGBB/);
    assert.match((await kits.add({ ...ACME, name: 'Hostile', displayFontFamily: 'x;}</style>' })).body.error, /CSS names it/);
    assert.equal((await kits.add('not json at all')).status, 400);

    as(OWNER);
    const offered = (await kits.offered()).body.kits;
    assert.deepEqual(offered.map((k) => k.name), [ACME.name, NORTH.name]);
    assert.deepEqual(Object.keys(offered[0]).sort(), ['accent', 'id', 'logoDarkUrl', 'logoUrl', 'name']);
  });

  test('a link wears a kit by id; one there is none of is refused', async () => {
    as(OWNER);
    const made1 = await file.make(pic, { kind: 'public', look: { brand: t.acme, theme: 'dark' } });
    assert.equal(made1.status, 200, JSON.stringify(made1.body));
    assert.deepEqual(made1.body.share.look, { brand: t.acme, theme: 'dark' });
    t.link = made1.body.share.token;

    const ghost = await file.make(pic, { kind: 'public', look: { brand: 'kNoSuchKit1' } });
    assert.equal(ghost.status, 400);
    assert.match(ghost.body.error, /no longer available/);
    assert.match((await file.make(pic, { kind: 'public', look: { brand: '/onyx-mark.svg' } })).body.error, /brand kits/);

    const restyled = await file.change(pic, t.link, { look: { brand: t.north } });
    assert.equal(restyled.status, 200, JSON.stringify(restyled.body));
    assert.deepEqual(restyled.body.share.look, { brand: t.north });
    assert.equal((await file.change(pic, t.link, { look: { brand: 'kNoSuchKit1' } })).status, 400);
    assert.equal((await file.change(pic, t.link, { look: { brand: t.acme, accent: '#1d4ed8' } })).status, 200);

    const fl = await folder.make({ folder: 'Shoot', filespaceId: drive.id, kind: 'public', look: { view: 'gallery', brand: t.north } });
    assert.equal(fl.status, 200, JSON.stringify(fl.body));
    t.folderLink = fl.body.share.token;
    assert.equal((await folder.make({ folder: 'Shoot', filespaceId: drive.id, kind: 'public', look: { brand: 'kNoSuchKit1' } })).status, 400);
    assert.equal((await folder.change(t.folderLink, { look: { brand: 'kNoSuchKit1' } })).status, 400);

    as(BOSS);
    const listed = (await kits.list()).body.kits;
    assert.equal(listed.find((k) => k.id === t.acme).links, 1);
    assert.equal(listed.find((k) => k.id === t.north).links, 1);
  });

  test('the page finds the link’s kit once it is in', async () => {
    const opened = await access.resolveShareAccess(t.link);
    assert.equal(opened.state, 'ok');
    assert.equal(opened.look.brand, t.acme);
    assert.equal(opened.look.accent, '#1D4ED8', 'the link’s own accent, over the kit’s');
    const kit = await loadShareKit(opened.look.brand);
    assert.equal(kit.name, ACME.name);
    assert.equal(kit.logoDarkUrl, ACME.logoDarkUrl);
    const folderOpen = await access.resolveFolderShareAccess(t.folderLink);
    assert.equal(folderOpen.look.brand, t.north);
    assert.equal((await loadShareKit(folderOpen.look.brand)).displayFontFamily, NORTH.displayFontFamily);
    assert.equal(await loadShareKit('kNoSuchKit1'), null);
    assert.equal(await loadShareKit(null), null);
  });

  test('a kit changed in place reaches every link that wears it', async () => {
    as(BOSS);
    const changed = await kits.change(t.acme, { ...ACME, accent: '#0E6F8A', logoDarkUrl: '' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.kit.id, t.acme);
    assert.equal(changed.body.kit.logoDarkUrl, undefined);
    assert.equal(changed.body.kit.links, 1);
    // loadShareKit is per request under React; here every call reads again.
    const kit = await loadShareKit(t.acme);
    assert.equal(kit.accent, '#0E6F8A');
    assert.equal((await kits.change(t.acme, { ...ACME, name: NORTH.name })).status, 409);
    assert.equal((await kits.change('kNoSuchKit1', ACME)).status, 404);
    assert.equal((await kits.change(t.acme, { ...ACME, logoUrl: '' })).status, 400);
  });

  test('a kit removed leaves its links on the workspace’s look, and a sharer able to save them', async () => {
    as(BOSS);
    const gone = await kits.remove(t.acme);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.links, 1);
    assert.equal((await kits.remove(t.acme)).status, 404);

    const opened = await access.resolveShareAccess(t.link);
    assert.equal(opened.state, 'ok', 'the link still opens');
    assert.equal(opened.look.brand, t.acme, 'and still names it');
    assert.equal(await loadShareKit(opened.look.brand), null, 'which is no kit: the workspace brand');

    as(OWNER);
    // A change that leaves the gone kit as it was is not refused for it...
    const kept = await file.change(pic, t.link, { look: { brand: t.acme, accent: '#1d4ed8', theme: 'light' }, downloads: false });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    // ...but it cannot be put on another link, or back on this one once taken off.
    assert.equal((await file.make(pic, { kind: 'public', look: { brand: t.acme } })).status, 400);
    assert.equal((await file.change(pic, t.link, { look: null })).status, 200);
    assert.equal((await file.change(pic, t.link, { look: { brand: t.acme } })).status, 400);
    assert.deepEqual((await kits.offered()).body.kits.map((k) => k.id), [t.north]);
  });
});

describe('the workspace brand form', { skip }, () => {
  test('an admin reads the brand with its defaults, and saves it whole', async () => {
    as(OWNER);
    assert.equal((await brand.read()).status, 403);
    assert.equal((await brand.save({ name: 'Nope' })).status, 403);

    as(BOSS);
    const read = await brand.read();
    assert.equal(read.status, 200);
    assert.equal(typeof read.body.defaults.name, 'string');
    assert.ok(read.body.defaults.markUrl);

    const ok = await brand.save({ name: `Studio ${tag}`, colorAccent: '#7638E2', lockupUrl: '/onyx-lockup.svg', desktopScheme: 'evil', bogus: 'x', tagline: '' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.config, { name: `Studio ${tag}`, colorAccent: '#7638E2', lockupUrl: '/onyx-lockup.svg' }, 'never the scheme, nothing unknown, blanks are defaults');
    assert.deepEqual((await brand.read()).body.config, ok.body.config);
    const shown = await loadBrand();
    assert.equal(shown.name, `Studio ${tag}`);
    assert.equal(shown.desktop.scheme, read.body.defaults.desktopScheme);

    const badColour = await brand.save({ colorInk: 'black' });
    assert.equal(badColour.status, 400);
    assert.equal(badColour.body.field, 'colorInk');
    const badImage = await brand.save({ markUrl: 'javascript:alert(1)' });
    assert.equal(badImage.status, 400);
    assert.equal(badImage.body.field, 'markUrl');
    assert.equal((await brand.read()).body.config.name, `Studio ${tag}`, 'a refused save changes nothing');
    assert.equal((await brand.save(null)).status, 400);
  });
});
