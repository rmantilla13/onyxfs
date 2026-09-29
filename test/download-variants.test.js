// "Download as…" on the server: a video's proxy and cover, saved through the
// routes the original comes from — GET /api/files/[id]/download?variant= for
// people signed in, GET /s/<token>/download?variant= for a share link's
// guests — run for real with no database and no bucket.
//
// lib/db.js resolves to the in-memory store in test/fixtures/mac-writes-stubs.mjs
// (whose finishedProxyKeys keeps a log of what it was asked, so a refusal can
// be seen to come before any lookup), '@/auth' to whoever the test says is
// signed in, and 'next/headers' to a cookie jar for a password link's unlock.
// Everything between — requirePrincipal, lib/share-access.js, the routes,
// lib/download-variants.js and lib/storage.js's presigning — is the code that
// runs in production. Presigning is local arithmetic, so each URL is read for
// what it says without a bucket anywhere.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.ADMIN_EMAILS = 'boss@dv.test';
process.env.SUPER_ADMIN_EMAILS = '';
process.env.AUTH_SECRET = 'download-variants-test-secret-0123456789';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const DB_STUB = new URL('./fixtures/mac-writes-stubs.mjs', import.meta.url).href;
const AUTH_STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__mw?.session || null; }')}`;
const HEADERS_STUB = `data:text/javascript,${encodeURIComponent(`
  export function cookies() {
    const jar = globalThis.__mw?.jar || new Map();
    return { get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined), set() {}, delete() {} };
  }
  export function headers() { return new Headers(); }
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH_STUB, shortCircuit: true };
    if (specifier === 'next/headers') return { url: HEADERS_STUB, shortCircuit: true };
    const r = next(specifier, context);
    if (r.url.endsWith('/lib/db.js') && context.parentURL !== DB_STUB) return { url: DB_STUB, shortCircuit: true };
    return r;
  },
});

const store = await import('../lib/db.js');
const downloadRoute = await import('../app/api/files/[id]/download/route.js');
const shareDownloadRoute = await import('../app/s/[token]/download/route.js');
const { ORIGINAL_URL_TTL } = await import('../lib/storage.js');
const { proxyKeyFor } = await import('../lib/media.js');
const { shareCookieName, shareCookieValue } = await import('../lib/shares.js');

// ── the world ──
const STORAGE = { provider: 's3', bucket: 'onyx', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', endpoint: 'http://s3.test', prefix: 'files' };
const TEAM = { id: 'd1', name: 'Team', bucket: 'onyx', prefix: 'team', region: 'us-east-1' };
const ED = 'ed@dv.test'; // a Member, editor of the drive
const OUT = 'out@dv.test'; // a Member of the workspace, not of the drive
const person = (email) => ({ id: randomUUID(), email, roleId: 'member', status: 'active', quotaBytes: null, maxUploadBytes: null });

beforeEach(() => {
  globalThis.__mw = {
    now: Date.now(), seq: 100, session: null, jar: new Map(),
    settings: new Map([['storage.config', STORAGE]]),
    people: new Map([[ED, person(ED)], [OUT, person(OUT)]]),
    invites: new Set([ED, OUT]), tokens: new Map(), drives: [TEAM], grants: new Map([[`d1|${ED}`, 'editor']]), acl: new Map(),
    files: new Map(), folders: new Map(), uploads: new Map(), uploadKeys: new Map(), transcripts: new Map(),
    proxies: new Map(), proxyLookups: [], shares: new Map(),
    audit: [], tombstones: [],
  };
});

const uuid = () => randomUUID();
const video = (name, extra = {}) => store.createFile({
  name, kind: 'video', mime: 'video/quicktime', size: 4_000_000_000, folder: 'Cuts', storage: 's3',
  storageKey: `team/Cuts/${name}`, url: `http://s3.test/onyx/team/Cuts/${name}`, createdBy: ED,
  metadata: { width: 3840, height: 2160 }, ...extra,
});
/** A job for `f`, finished unless said otherwise; its key. */
function proxyOf(f, { status = 'done', sourceKey = f.storageKey } = {}) {
  const proxyKey = status === 'done' ? proxyKeyFor(uuid()) : null;
  globalThis.__mw.proxies.set(f.id, { fileId: f.id, status, proxyKey, sourceKey });
  return proxyKey;
}
/** A link to `f`, as file_shares stores one; its token. */
function linkTo(f, extra = {}) {
  const token = uuid().replace(/-/g, '');
  globalThis.__mw.shares.set(token, {
    token, file_id: f.id, kind: 'file', mode: 'public', created_by: ED, created_at: Date.now(),
    expires_at: null, password_hash: null, review: null, ...extra,
  });
  return token;
}

async function mine(f, variant, { as = ED, id = f.id } = {}) {
  globalThis.__mw.session = as ? { user: { email: as } } : null;
  const q = variant == null ? '' : `?variant=${encodeURIComponent(variant)}`;
  return downloadRoute.GET(new Request(`http://app.test/api/files/${id}/download${q}`), { params: { id } });
}
async function guest(token, variant) {
  globalThis.__mw.session = null;
  const q = variant == null ? '' : `?variant=${encodeURIComponent(variant)}`;
  return shareDownloadRoute.GET(new Request(`http://app.test/s/${token}/download${q}`), { params: { token } });
}
/** The signed URL a download route redirected to. */
function redirectOf(res) {
  assert.equal(res.status, 307);
  return new URL(res.headers.get('location'));
}
const pathOf = (url) => decodeURIComponent(url.pathname);
const disposition = (url) => url.searchParams.get('response-content-disposition');
const lookups = () => globalThis.__mw.proxyLookups;

describe('a signed-in download of a video’s proxy', () => {
  test('the finished proxy, as an attachment named for it, signed as long as the original’s', async () => {
    const f = await video('Master.mov');
    const key = proxyOf(f);
    const url = redirectOf(await mine(f, 'proxy'));
    assert.equal(pathOf(url), `/onyx/${key}`);
    assert.equal(disposition(url), 'attachment; filename="Master (1080p).mp4"');
    assert.equal(url.searchParams.get('X-Amz-Expires'), String(ORIGINAL_URL_TTL));
    assert.match(url.search, /X-Amz-Signature=/);
    assert.deepEqual(lookups(), [[f.id]], 'one lookup, of this file');
  });

  test('named for the lines it has: a 720p master’s proxy is 720p', async () => {
    const f = await video('Small.mov', { metadata: { width: 1280, height: 720 } });
    proxyOf(f);
    assert.equal(disposition(redirectOf(await mine(f, 'proxy'))), 'attachment; filename="Small (720p).mp4"');
  });

  test('refused when there is none to serve: none made, one still queued, or one of replaced contents', async () => {
    const none = await video('None.mov');
    const queued = await video('Queued.mov');
    proxyOf(queued, { status: 'queued' });
    const stale = await video('Stale.mov');
    proxyOf(stale, { sourceKey: 'team/Cuts/Stale-before.mov' });
    for (const f of [none, queued, stale]) {
      const res = await mine(f, 'proxy');
      assert.equal(res.status, 404, f.name);
      assert.match((await res.json()).error, /no streamable copy/, f.name);
      assert.equal(res.headers.get('location'), null, `${f.name}: nothing signed`);
    }
  });

  test('with the proxies flag off, an existing proxy is not served — and not looked up', async () => {
    globalThis.__mw.settings.set('features.flags', { proxies: false });
    const f = await video('Master.mov');
    proxyOf(f);
    assert.equal((await mine(f, 'proxy')).status, 404);
    assert.deepEqual(lookups(), []);
  });

  test('only a video has one: a photo’s proxy is refused before any lookup', async () => {
    const still = await store.createFile({
      name: 'Still.jpg', kind: 'image', mime: 'image/jpeg', size: 4e9, folder: 'Cuts', storage: 's3',
      storageKey: 'team/Cuts/Still.jpg', url: 'http://s3.test/onyx/team/Cuts/Still.jpg', createdBy: ED,
    });
    assert.equal((await mine(still, 'proxy')).status, 404);
    assert.deepEqual(lookups(), []);
  });

  test('a trashed file’s proxy is gone with it', async () => {
    const f = await video('Master.mov');
    proxyOf(f);
    await store.softDeleteFile(f.id, { trashKey: '_trash/Master.mov', deletedBy: ED });
    assert.equal((await mine(f, 'proxy')).status, 404);
    assert.deepEqual(lookups(), []);
  });
});

describe('who may ask, decided before anything is looked up or signed', () => {
  test('401 signed out, 404 for no such file, 403 for a drive they are not in', async () => {
    const f = await video('Master.mov');
    proxyOf(f);
    for (const variant of ['proxy', 'poster']) {
      const out = await mine(f, variant, { as: null });
      assert.equal(out.status, 401, variant);
      assert.equal((await mine(f, variant, { id: uuid() })).status, 404, variant);
      const outsider = await mine(f, variant, { as: OUT });
      assert.equal(outsider.status, 403, variant);
      assert.equal(outsider.headers.get('location'), null);
    }
    assert.deepEqual(lookups(), [], 'no proxy was looked up for any of them');
  });

  test('a variant that does not exist is refused — once the caller is known', async () => {
    const f = await video('Master.mov');
    assert.equal((await mine(f, 'thumbs', { as: null })).status, 401);
    const res = await mine(f, 'thumbs');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no such download/);
    assert.equal((await mine(f, '../../team/Cuts/Other.mov')).status, 400);
  });

  test('the original is as it always was, asked for plainly or by name', async () => {
    const f = await video('Master.mov');
    for (const variant of [null, 'original', '']) {
      const url = redirectOf(await mine(f, variant));
      assert.equal(pathOf(url), `/onyx/${f.storageKey}`, String(variant));
      assert.equal(disposition(url), 'attachment; filename="Master.mov"');
      assert.equal(url.searchParams.get('X-Amz-Expires'), String(ORIGINAL_URL_TTL));
    }
    assert.deepEqual(lookups(), []);
  });
});

describe('a video’s cover', () => {
  test('its player poster, as stored, named for what it is', async () => {
    const posterKey = `_thumbs/${uuid()}.poster.webp`;
    const f = await video('Master.mov', { thumbnailKey: `_thumbs/${uuid()}.webp`, posterKey });
    const url = redirectOf(await mine(f, 'poster'));
    assert.equal(pathOf(url), `/onyx/${posterKey}`);
    assert.equal(disposition(url), 'attachment; filename="Master (cover).webp"');
    assert.equal(url.searchParams.get('X-Amz-Expires'), String(ORIGINAL_URL_TTL));
  });

  test('a small clip’s cover is its thumbnail; a JPEG one is saved as .jpg', async () => {
    const thumbnailKey = `_thumbs/${uuid()}.jpg`;
    const f = await video('Clip.mp4', { thumbnailKey });
    const url = redirectOf(await mine(f, 'poster'));
    assert.equal(pathOf(url), `/onyx/${thumbnailKey}`);
    assert.equal(disposition(url), 'attachment; filename="Clip (cover).jpg"');
  });

  test('none, or one the server did not name, is refused', async () => {
    const bare = await video('Bare.mov');
    assert.equal((await mine(bare, 'poster')).status, 404);
    const odd = await video('Odd.mov', { thumbnailKey: 'team/Cuts/Other.mov', posterKey: 'team/Cuts/Other.mov' });
    const res = await mine(odd, 'poster');
    assert.equal(res.status, 404, 'a key that is not one of ours is never signed');
    assert.equal(res.headers.get('location'), null);
  });

  test('only a video’s: a photo’s large preview is not served this way', async () => {
    const photo = await store.createFile({
      name: 'Still.jpg', kind: 'image', mime: 'image/jpeg', size: 5e6, folder: 'Cuts', storage: 's3',
      storageKey: 'team/Cuts/Still.jpg', url: 'http://s3.test/onyx/team/Cuts/Still.jpg', createdBy: ED,
      thumbnailKey: `_thumbs/${uuid()}.webp`, posterKey: `_thumbs/${uuid()}.poster.webp`,
    });
    assert.equal((await mine(photo, 'poster')).status, 404);
  });
});

describe('a share link’s guests', () => {
  test('get the proxy and the cover through the link’s own route', async () => {
    const posterKey = `_thumbs/${uuid()}.poster.jpg`;
    const f = await video('Master.mov', { thumbnailKey: `_thumbs/${uuid()}.jpg`, posterKey });
    const key = proxyOf(f);
    const token = linkTo(f);
    const proxied = redirectOf(await guest(token, 'proxy'));
    assert.equal(pathOf(proxied), `/onyx/${key}`);
    assert.equal(disposition(proxied), 'attachment; filename="Master (1080p).mp4"');
    assert.equal(proxied.searchParams.get('X-Amz-Expires'), String(ORIGINAL_URL_TTL));
    const cover = redirectOf(await guest(token, 'poster'));
    assert.equal(pathOf(cover), `/onyx/${posterKey}`);
    assert.equal(disposition(cover), 'attachment; filename="Master (cover).jpg"');
    const original = redirectOf(await guest(token));
    assert.equal(disposition(original), 'attachment; filename="Master.mov"');
  });

  test('a link that is gone, expired, locked or switched off sends them to the page, and nothing is looked up', async () => {
    const f = await video('Master.mov');
    proxyOf(f);
    const missing = 'nosuchtoken12345';
    const expired = linkTo(f, { expires_at: Date.now() - 1000 });
    const locked = linkTo(f, { password_hash: 'scrypt$whatever' });
    for (const token of [missing, expired, locked]) {
      const res = await guest(token, 'proxy');
      assert.equal(res.status, 307, token);
      assert.equal(new URL(res.headers.get('location')).pathname, `/s/${token}`, 'the page, which says why');
    }
    globalThis.__mw.settings.set('features.flags', { shares: false });
    const off = linkTo(f);
    assert.equal(new URL((await guest(off, 'proxy')).headers.get('location')).pathname, `/s/${off}`);
    assert.deepEqual(lookups(), []);
  });

  test('a password link, once unlocked, serves them like any other', async () => {
    const f = await video('Master.mov');
    const key = proxyOf(f);
    const hash = 'scrypt$salt$hash';
    const token = linkTo(f, { password_hash: hash });
    globalThis.__mw.jar.set(shareCookieName(token), shareCookieValue(token, hash, process.env.AUTH_SECRET));
    assert.equal(pathOf(redirectOf(await guest(token, 'proxy'))), `/onyx/${key}`);
    // Another link's unlock does not open this one.
    const other = linkTo(f, { password_hash: hash });
    assert.equal(new URL((await guest(other, 'proxy')).headers.get('location')).pathname, `/s/${other}`);
  });

  test('under the flags the link was let in by: proxies off, no proxy', async () => {
    globalThis.__mw.settings.set('features.flags', { proxies: false });
    const f = await video('Master.mov');
    proxyOf(f);
    const res = await guest(linkTo(f), 'proxy');
    assert.equal(res.status, 404);
    assert.deepEqual(lookups(), []);
  });

  test('refused when the video has none, and for a variant that does not exist', async () => {
    const f = await video('Master.mov');
    const token = linkTo(f);
    assert.equal((await guest(token, 'proxy')).status, 404);
    assert.equal((await guest(token, 'poster')).status, 404);
    assert.equal((await guest(token, 'strip')).status, 400);
  });

  test('a link whose file was trashed is gone', async () => {
    const f = await video('Master.mov');
    proxyOf(f);
    const token = linkTo(f);
    await store.softDeleteFile(f.id, { trashKey: '_trash/Master.mov', deletedBy: ED });
    const res = await guest(token, 'proxy');
    assert.equal(new URL(res.headers.get('location')).pathname, `/s/${token}`);
  });
});

test('Onyx for Mac takes every one of these as a download from the first request', () => {
  // WebController.swift recognises the download routes by path and hands them
  // to WKDownload before the redirect to the bucket — so a variant is a query
  // on those paths, never a path of its own.
  const swift = readFileSync(new URL('../apple/OnyxMac/WebController.swift', import.meta.url), 'utf8');
  const m = swift.match(/url\.path\.range\(of: #"(.+?)"#, options: \.regularExpression\)/);
  assert.ok(m, 'the download pattern is where it was');
  const pattern = new RegExp(m[1]);
  for (const href of [
    '/api/files/1f0c/download', '/api/files/1f0c/download?variant=proxy', '/api/files/1f0c/download?variant=poster',
    '/s/AbC123_-xyz/download?variant=proxy', '/s/AbC123_-xyz/download?variant=poster',
  ]) {
    assert.match(new URL(href, 'https://onyx.test').pathname, pattern, href);
  }
});
