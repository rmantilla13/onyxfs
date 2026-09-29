// What a browser is handed to play or to save a file, run for real with no
// database and no bucket: the listing's streamable copy of a heavy video
// (asked for only when a row could have one), a share link's, and download
// links signed for as long as a player's, so a large download can resume.
//
// lib/db.js resolves to the in-memory store in test/fixtures/mac-writes-stubs.mjs
// and '@/auth' to whoever the test says is signed in. Everything between —
// requirePrincipal and getPrincipal, lib/file-listing.js, lib/share-access.js,
// the routes, and lib/storage.js's presigning — is the code that runs in
// production. Presigning is local arithmetic, so each URL is read for what it
// says without a bucket anywhere. The lookup's SQL is test/proxies-db.test.js's.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_EMAILS = 'boss@pl.test';
process.env.SUPER_ADMIN_EMAILS = '';
process.env.AUTH_SECRET = 'playback-links-test-secret-0123456789abcdef';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const DB_STUB = new URL('./fixtures/mac-writes-stubs.mjs', import.meta.url).href;
const AUTH_STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__mw?.session || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH_STUB, shortCircuit: true };
    const r = next(specifier, context);
    // lib/db.js however it is named — except to the store itself, which
    // borrows the real module's pure rules.
    if (r.url.endsWith('/lib/db.js') && context.parentURL !== DB_STUB) return { url: DB_STUB, shortCircuit: true };
    return r;
  },
});

const store = await import('../lib/db.js');
const filesRoute = await import('../app/api/files/route.js');
const downloadRoute = await import('../app/api/files/[id]/download/route.js');
const shareDownloadRoute = await import('../app/s/[token]/download/route.js');
const { resolveShareAccess } = await import('../lib/share-access.js');
const { playableProxies, withProxyKeys } = await import('../lib/file-listing.js');
const { presignFileUrls, ORIGINAL_URL_TTL } = await import('../lib/storage.js');
const { sharedFile, proxyKeyFor } = await import('../lib/media.js');
const { PROXY_MIN_BYTES } = await import('../lib/proxies.js');

// ── the world ──
const STORAGE = { provider: 's3', bucket: 'onyx', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', endpoint: 'http://s3.test', prefix: 'files' };
const TEAM = { id: 'd1', name: 'Team', bucket: 'onyx', prefix: 'team', region: 'us-east-1' };
const ED = 'ed@pl.test'; // a Member, editor of the drive
const HEAVY = 4_000_000_000;
const LIGHT = 50_000_000;

beforeEach(() => {
  globalThis.__mw = {
    now: Date.now(), seq: 100, session: null,
    settings: new Map([['storage.config', STORAGE]]),
    people: new Map([[ED, { id: randomUUID(), email: ED, roleId: 'member', status: 'active', quotaBytes: null, maxUploadBytes: null }]]),
    invites: new Set([ED]), tokens: new Map(), drives: [TEAM], grants: new Map([[`d1|${ED}`, 'editor']]), acl: new Map(),
    files: new Map(), folders: new Map(), uploads: new Map(), uploadKeys: new Map(), transcripts: new Map(),
    proxies: new Map(), proxyLookups: [], shares: new Map(),
    audit: [], tombstones: [],
  };
});

async function call(handler, path, { params = {}, as = ED } = {}) {
  globalThis.__mw.session = as ? { user: { email: as } } : null;
  return handler(new Request(`http://app.test${path}`), { params });
}
/** The drive's Cuts folder, as the library asks for it. */
async function listing() {
  const res = await call(filesRoute.GET, '/api/files?filespace=d1&folder=Cuts&folders=0');
  assert.equal(res.status, 200);
  return new Map((await res.json()).files.map((f) => [f.name, f]));
}
const file = (name, size, extra = {}) => store.createFile({
  name, kind: 'video', mime: 'video/quicktime', size, folder: 'Cuts', storage: 's3',
  storageKey: `team/Cuts/${name}`, url: `http://s3.test/onyx/team/Cuts/${name}`, createdBy: ED, ...extra,
});
/** A job for `f`, finished unless said otherwise; its key. */
function proxyOf(f, { status = 'done', sourceKey = f.storageKey } = {}) {
  const proxyKey = status === 'done' ? proxyKeyFor(randomUUID()) : null;
  globalThis.__mw.proxies.set(f.id, { fileId: f.id, status, proxyKey, sourceKey });
  return proxyKey;
}
/** A public link to `f`, as file_shares stores one; its token. */
function linkTo(f) {
  const token = randomUUID().replace(/-/g, '');
  globalThis.__mw.shares.set(token, {
    token, file_id: f.id, kind: 'file', mode: 'public', created_by: ED, created_at: Date.now(),
    expires_at: null, password_hash: null, review: null,
  });
  return token;
}
/** Where a signed URL points, path unescaped. */
const pathOf = (url) => decodeURIComponent(new URL(url).pathname);

describe('the listing plays a heavy video’s streamable copy', () => {
  test('signed with the page, for the video that has a finished one — and only rows that could were asked about', async () => {
    const master = await file('Master.mov', HEAVY);
    const key = proxyOf(master);
    const waiting = await file('Waiting.mov', HEAVY);
    proxyOf(waiting, { status: 'queued' });
    const clip = await file('Clip.mov', LIGHT);
    proxyOf(clip); // made anyway; a clip this small streams as it is
    const still = await file('Still.jpg', HEAVY, { kind: 'image', mime: 'image/jpeg' });

    const rows = await listing();
    const played = rows.get('Master.mov');
    assert.ok(played.proxyUrl, 'the rendition is signed with the page');
    assert.equal(pathOf(played.proxyUrl), `/onyx/${key}`);
    assert.match(played.proxyUrl, /X-Amz-Signature=/);
    assert.equal(pathOf(played.url), `/onyx/${master.storageKey}`, 'and the master is still the master');
    for (const name of ['Waiting.mov', 'Clip.mov', 'Still.jpg']) assert.equal(rows.get(name).proxyUrl, undefined, name);
    assert.ok(rows.get('Master.mov').can, 'the per-file answers ride along as before');

    // One lookup for the page, of the videos big enough to have a proxy.
    assert.equal(globalThis.__mw.proxyLookups.length, 1);
    assert.deepEqual(globalThis.__mw.proxyLookups[0].sort(), [master.id, waiting.id].sort());
    assert.ok(HEAVY >= PROXY_MIN_BYTES && LIGHT < PROXY_MIN_BYTES);
    assert.ok(![clip.id, still.id].some((id) => globalThis.__mw.proxyLookups[0].includes(id)));
  });

  test('a page with nothing worth a proxy asks nothing', async () => {
    await file('Clip.mov', LIGHT);
    await file('Still.jpg', HEAVY, { kind: 'image', mime: 'image/jpeg' });
    await file('Notes.pdf', HEAVY, { kind: 'doc', mime: 'application/pdf' });
    const rows = await listing();
    assert.equal(rows.size, 3);
    assert.deepEqual(globalThis.__mw.proxyLookups, []);
  });

  test('with the flag off, nothing is looked up and nothing served', async () => {
    globalThis.__mw.settings.set('features.flags', { proxies: false });
    const master = await file('Master.mov', HEAVY);
    proxyOf(master);
    const rows = await listing();
    assert.equal(rows.get('Master.mov').proxyUrl, undefined);
    assert.deepEqual(globalThis.__mw.proxyLookups, []);
  });
});

describe('a share link plays it too', () => {
  test('what the page hands the visitor: the rendition, under the flags the link was let in by, and no keys', async () => {
    const master = await file('Master.mov', HEAVY);
    const key = proxyOf(master);
    const access = await resolveShareAccess(linkTo(master));
    assert.equal(access.state, 'ok');
    assert.equal(access.flags?.proxies, true, 'the flags the decision was made under');

    // app/s/[token]/page.js's steps, in its order.
    const proxies = await playableProxies([access.file], access.flags);
    const [signed] = await presignFileUrls(withProxyKeys([access.file], proxies), { expiresIn: 21600 });
    const shared = sharedFile(signed);
    assert.equal(pathOf(shared.proxyUrl), `/onyx/${key}`);
    assert.equal(shared.proxyKey, undefined, 'the key stays on the server, as the storage key does');
    assert.equal(shared.storageKey, undefined);
  });

  test('off, the visitor streams the master', async () => {
    globalThis.__mw.settings.set('features.flags', { proxies: false });
    const master = await file('Master.mov', HEAVY);
    proxyOf(master);
    const access = await resolveShareAccess(linkTo(master));
    assert.equal(access.state, 'ok');
    assert.equal((await playableProxies([access.file], access.flags)).size, 0);
    assert.deepEqual(globalThis.__mw.proxyLookups, []);
  });
});

describe('a download link outlives a paused download', () => {
  /** The signed URL a download route redirected to. */
  async function redirectOf(res) {
    assert.equal(res.status, 307);
    return new URL(res.headers.get('location'));
  }

  test('the file’s: an attachment, signed for as long as a player’s URL', async () => {
    const f = await file('Master.mov', HEAVY);
    const url = await redirectOf(await call(downloadRoute.GET, `/api/files/${f.id}/download`, { params: { id: f.id } }));
    assert.equal(ORIGINAL_URL_TTL, 21600, 'six hours');
    assert.equal(url.searchParams.get('X-Amz-Expires'), String(ORIGINAL_URL_TTL));
    assert.equal(url.searchParams.get('response-content-disposition'), 'attachment; filename="Master.mov"');
    assert.equal(pathOf(url.href), `/onyx/${f.storageKey}`);
  });

  test('a share link’s: the same — and once the link is gone, nothing new is signed', async () => {
    const f = await file('Master.mov', HEAVY);
    const token = linkTo(f);
    const url = await redirectOf(await call(shareDownloadRoute.GET, `/s/${token}/download`, { params: { token }, as: null }));
    assert.equal(url.searchParams.get('X-Amz-Expires'), String(ORIGINAL_URL_TTL));
    assert.equal(url.searchParams.get('response-content-disposition'), 'attachment; filename="Master.mov"');

    globalThis.__mw.shares.delete(token);
    const gone = await redirectOf(await call(shareDownloadRoute.GET, `/s/${token}/download`, { params: { token }, as: null }));
    assert.equal(gone.pathname, `/s/${token}`, 'sent to the page, which says why');
  });
});
