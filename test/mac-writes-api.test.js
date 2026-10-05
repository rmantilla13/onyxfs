// Onyx for Mac writing through the web's own routes with its bearer token,
// run for real with no database and no bucket. lib/db.js resolves to the
// in-memory store in test/fixtures/mac-writes-stubs.mjs (whose access
// answers are the real rules); the bucket is the S3 client's send(),
// replaced below, so lib/storage.js — key naming, presigning, moves, HEADs,
// multipart — is the code that runs in production, and where an object
// lands is checked, not assumed. '@/auth' is whoever the test says has a
// browser session. Everything between — middleware.js, requirePrincipal and
// the desktop guard, getPrincipal and can(), uploadCheck, the routes,
// lib/replace-content.js, lib/preview-gc.js — is the real code.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

process.env.ADMIN_EMAILS = 'boss@mw.test';
process.env.SUPER_ADMIN_EMAILS = '';
process.env.AUTH_SECRET = 'mac-writes-test-secret-0123456789abcdef';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const DB_STUB = new URL('./fixtures/mac-writes-stubs.mjs', import.meta.url).href;
const AUTH_STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__mw?.session || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH_STUB, shortCircuit: true };
    const r = next(specifier, context);
    // lib/db.js however it is named ('@/lib/db', './db.js') — except to the
    // store itself, which borrows the real module's pure rules.
    if (r.url.endsWith('/lib/db.js') && context.parentURL !== DB_STUB) return { url: DB_STUB, shortCircuit: true };
    return r;
  },
});

// ── the bucket ──
const md5 = (b) => createHash('md5').update(b).digest('hex');
const sdk = await import('@aws-sdk/client-s3');
sdk.S3Client.prototype.send = async function send(cmd) {
  const b = globalThis.__mw.s3;
  const i = cmd.input || {};
  const at = (key) => `${i.Bucket}/${key}`;
  const missing = (name) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  b.calls.push(cmd.constructor.name);
  switch (cmd.constructor.name) {
    case 'HeadObjectCommand': {
      const o = b.objects.get(at(i.Key));
      if (!o) throw missing('NotFound');
      return { ContentLength: o.size, ETag: `"${o.etag}"`, ...(o.modified != null && { LastModified: new Date(o.modified) }) };
    }
    case 'PutObjectCommand': {
      const body = Buffer.from(i.Body ?? '');
      b.objects.set(at(i.Key), { size: body.length, etag: md5(body) });
      return {};
    }
    case 'DeleteObjectCommand': b.objects.delete(at(i.Key)); return {};
    case 'CopyObjectCommand': {
      // A test holding copies (b.copyGate) sees what a slow copy leaves meanwhile.
      if (b.copyGate) await b.copyGate;
      const o = b.objects.get(decodeURIComponent(String(i.CopySource).replace(/^\//, '')));
      if (!o) throw missing('NoSuchKey');
      b.objects.set(at(i.Key), { ...o });
      return {};
    }
    case 'CreateMultipartUploadCommand': {
      const id = randomUUID();
      b.multipart.set(id, { key: at(i.Key), parts: new Map() });
      return { UploadId: id };
    }
    case 'ListPartsCommand': {
      const u = b.multipart.get(i.UploadId);
      if (!u || u.key !== at(i.Key)) throw missing('NoSuchUpload');
      return { Parts: [...u.parts].map(([n, p]) => ({ PartNumber: n, ETag: `"${p.etag}"`, Size: p.size })), IsTruncated: false };
    }
    case 'CompleteMultipartUploadCommand': {
      const u = b.multipart.get(i.UploadId);
      if (!u || u.key !== at(i.Key)) throw missing('NoSuchUpload');
      const parts = i.MultipartUpload.Parts.map((p) => u.parts.get(p.PartNumber));
      const etag = `${md5(Buffer.concat(parts.map((p) => Buffer.from(p.etag, 'hex'))))}-${parts.length}`;
      b.objects.set(u.key, { size: parts.reduce((n, p) => n + p.size, 0), etag });
      b.multipart.delete(i.UploadId);
      return {};
    }
    case 'AbortMultipartUploadCommand': b.multipart.delete(i.UploadId); return {};
    case 'ListObjectsV2Command': {
      const pre = at(i.Prefix || '');
      const Contents = [...b.objects.keys()].filter((k) => k.startsWith(pre)).map((k) => ({ Key: k.slice(i.Bucket.length + 1), Size: b.objects.get(k).size }));
      return { Contents, IsTruncated: false };
    }
    default: throw new Error(`unexpected ${cmd.constructor.name}`);
  }
};

/** What the Mac does with a presigned URL: PUT the bytes (a whole file, or one part). */
function put(url, bytes) {
  const u = new URL(url);
  const body = Buffer.from(bytes);
  const path = decodeURIComponent(u.pathname.slice(1));
  const b = globalThis.__mw.s3;
  if (u.searchParams.get('x-id') === 'UploadPart') {
    const up = b.multipart.get(u.searchParams.get('uploadId'));
    assert.ok(up && up.key === path, 'the part URL names the upload');
    up.parts.set(Number(u.searchParams.get('partNumber')), { size: body.length, etag: md5(body) });
  } else {
    assert.equal(u.searchParams.get('x-id'), 'PutObject');
    b.objects.set(path, { size: body.length, etag: md5(body) });
  }
}
const stored = (key) => globalThis.__mw.s3.objects.get(`onyx/${key}`) || null;

const { NextRequest } = await import('next/server');
const { middleware, config: mwConfig } = await import('../middleware.js');
const { bearerMayPass, bearerToken } = await import('../lib/bearer-gate.js');
const { encodeWaveform } = await import('../lib/waveform.js');
const filesRoute = await import('../app/api/files/route.js');
const presignRoute = await import('../app/api/files/presign/route.js');
const multipartRoute = await import('../app/api/files/upload/multipart/route.js');
const fileRoute = await import('../app/api/files/[id]/route.js');
const contentRoute = await import('../app/api/files/[id]/content/route.js');
const thumbnailRoute = await import('../app/api/files/[id]/thumbnail/route.js');
const waveformRoute = await import('../app/api/files/[id]/waveform/route.js');
const placeholderRoute = await import('../app/api/files/[id]/placeholder/route.js');
const filmstripRoute = await import('../app/api/files/[id]/filmstrip/route.js');
const foldersRoute = await import('../app/api/files/folders/route.js');
const { _setFolderMoveBudgetMs, _setFolderRenameLimits } = await import('../lib/folder-ops.js');
const restoreRoute = await import('../app/api/admin/trash/restore/route.js');
// What a route finishes after it answers: a trashed file's object moving to the trash.
const { afterResponseSettled } = await import('../lib/after-response.js');

// ── the world ──
const STORAGE = { provider: 's3', bucket: 'onyx', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', endpoint: 'http://s3.test', prefix: 'files' };
const D1 = { id: 'd1', name: 'Team', bucket: 'onyx', prefix: 'team', region: 'us-east-1' };
const D2 = { id: 'd2', name: 'Studio', bucket: 'onyx', prefix: 'studio', region: 'us-east-1' };
const ROLES = { version: 2, defaultRole: 'member', roles: [{ id: 'no-desktop', name: 'No desktop', caps: { 'desktop.mount': false } }], assignments: {} };
const BOSS = 'boss@mw.test'; // ADMIN_EMAILS
const ED = 'ed@mw.test'; // a Member, editor of the drive: the Mac's owner
const ED2 = 'ed2@mw.test'; // another editor of the drive
const DV = 'dv@mw.test'; // a Member who is a viewer of the drive
const VR = 'vr@mw.test'; // the Viewer role, granted editor (capped to viewer)
const ND = 'nd@mw.test'; // a role without desktop.mount, editor of the drive
const PEOPLE = [[ED, 'member', 'editor'], [ED2, 'member', 'editor'], [DV, 'member', 'viewer'], [VR, 'viewer', 'editor'], [ND, 'no-desktop', 'editor']];

function reset() {
  globalThis.__mw = {
    now: Date.now(), seq: 100, session: null,
    settings: new Map([['storage.config', STORAGE], ['roles.config', ROLES]]),
    people: new Map(), invites: new Set(), tokens: new Map(), drives: [D1, D2], grants: new Map(), acl: new Map(),
    files: new Map(), folders: new Map(), uploads: new Map(), uploadKeys: new Map(), transcripts: new Map(),
    audit: [], tombstones: [],
    s3: { objects: new Map(), multipart: new Map(), calls: [] },
  };
  for (const [email, roleId, driveRole] of PEOPLE) {
    globalThis.__mw.people.set(email, { id: randomUUID(), email, roleId, status: 'active', quotaBytes: null, maxUploadBytes: null });
    globalThis.__mw.invites.add(email);
    globalThis.__mw.grants.set(`d1|${email}`, driveRole);
    // The second drive: ED and ED2 edit it too; nobody else is in it.
    if (email === ED || email === ED2) globalThis.__mw.grants.set(`d2|${email}`, 'editor');
  }
}
beforeEach(reset);
// Nothing one test started in the background lands in the next one's bucket.
afterEach(afterResponseSettled);

/** A device token, as /api/desktop/token hands one out. The store's clock is globalThis.__mw.now. */
function tokenFor(email, { expiresAt = globalThis.__mw.now + 86400_000 } = {}) {
  const raw = `dt_live_${randomUUID()}`;
  globalThis.__mw.tokens.set(raw, { id: randomUUID(), email, expiresAt });
  return raw;
}
const mac = (email) => ({ token: tokenFor(email) });
const web = (email) => ({ cookie: email });

async function call(handler, path, { method = 'GET', body, token, cookie, params = {}, headers = {} } = {}) {
  globalThis.__mw.session = cookie ? { user: { email: cookie } } : null;
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await handler(new Request(`http://app.test${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), { params });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const presign = (who, body) => call(presignRoute.POST, '/api/files/presign', { method: 'POST', body, ...who });
const record = (who, body) => call(filesRoute.POST, '/api/files', { method: 'POST', body, ...who });
const multipart = (who, body) => call(multipartRoute.POST, '/api/files/upload/multipart', { method: 'POST', body, ...who });
const getFile = (who, id) => call(fileRoute.GET, `/api/files/${id}`, { params: { id }, ...who });
const patchFile = (who, id, body, headers) => call(fileRoute.PATCH, `/api/files/${id}`, { method: 'PATCH', body, params: { id }, headers, ...who });
const trashFile = (who, id) => call(fileRoute.DELETE, `/api/files/${id}`, { method: 'DELETE', params: { id }, ...who });
const swap = (who, id, body, headers) => call(contentRoute.POST, `/api/files/${id}/content`, { method: 'POST', body, params: { id }, headers, ...who });
const restore = (who, ids) => call(restoreRoute.POST, '/api/admin/trash/restore', { method: 'POST', body: { ids }, ...who });
/** PATCH with `progress`: the HTTP status, and the NDJSON lines read to the end — progress, then the answer. */
async function moveStreamed({ token, cookie } = {}, body) {
  globalThis.__mw.session = cookie ? { user: { email: cookie } } : null;
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await foldersRoute.PATCH(new Request('http://app.test/api/files/folders', {
    method: 'PATCH', headers: h, body: JSON.stringify({ ...body, progress: true }),
  }), { params: {} });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('ndjson')) return { status: res.status, type, lines: [], answer: null, body: await res.json().catch(() => null) };
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, type, lines: lines.slice(0, -1), answer: lines.at(-1) };
}
const folders = {
  create: (who, body) => call(foldersRoute.POST, '/api/files/folders', { method: 'POST', body, ...who }),
  move: (who, body) => call(foldersRoute.PATCH, '/api/files/folders', { method: 'PATCH', body, ...who }),
  remove: (who, name, filespace = 'd1') => call(foldersRoute.DELETE, `/api/files/folders?name=${encodeURIComponent(name)}&filespace=${filespace}`, { method: 'DELETE', ...who }),
  list: (who, filespace = 'd1') => call(foldersRoute.GET, `/api/files/folders?filespace=${filespace}`, who),
};

/** The Mac's small-file upload: presign, PUT, record. Resolves the new row. */
async function upload(who, { name = 'Take 1.mov', folder = 'Cuts', filespaceId = 'd1', bytes = Buffer.alloc(1000, 1), mime = 'video/quicktime', media } = {}) {
  const p = await presign(who, { filename: name, contentType: mime, size: bytes.length, folder, filespaceId: filespaceId || undefined });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  put(p.body.putUrl, bytes);
  const r = await record(who, {
    name: p.body.name, url: p.body.publicUrl, mime, size: bytes.length, folder, storage: 's3', storageKey: p.body.key, filespace: filespaceId || undefined,
    ...(media ? { media } : {}),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.file;
}
const row = (id) => globalThis.__mw.files.get(id);

describe('the sign-in gate (middleware.js)', () => {
  const run = (path, { method = 'POST', authorization } = {}) => middleware(
    new NextRequest(`http://app.test${path}`, { method, headers: authorization ? { authorization } : {} }),
    { waitUntil() {} },
  );
  const redirected = (res) => res.status === 307 && /\/signin\?callbackUrl=/.test(res.headers.get('location') || '');
  const passed = (res) => res.headers.get('x-middleware-next') === '1' && !res.headers.get('location');
  const PATHS = [
    '/api/files', '/api/files/presign', '/api/files/upload/multipart', '/api/files/folders',
    '/api/files/3f0c7e1a-1111-4222-8333-944455556666', '/api/files/3f0c7e1a-1111-4222-8333-944455556666/content',
    '/api/files/3f0c7e1a-1111-4222-8333-944455556666/thumbnail',
    '/api/files/3f0c7e1a-1111-4222-8333-944455556666/waveform',
    '/api/admin/trash/restore', '/api/stars', '/api/collections', '/api/collections/3f0c7e1a-1111', '/api/files/folders/meta',
    // The iPhone's links: a file's, and one of them; a folder's, and one of them.
    '/api/files/3f0c7e1a-1111-4222-8333-944455556666/shares',
    '/api/files/3f0c7e1a-1111-4222-8333-944455556666/shares/Zk3_q9Lx0aB7cD2eF4gH6i',
    '/api/files/folders/shares', '/api/files/folders/shares/Zk3_q9Lx0aB7cD2eF4gH6i',
  ];

  test('with no session and no token, the Mac’s paths are redirected to sign in exactly as before', async () => {
    for (const p of PATHS) assert.ok(redirected(await run(p)), p);
  });

  test('a bearer token takes those paths, and only those, past the gate', async () => {
    for (const p of PATHS) assert.ok(passed(await run(p, { authorization: 'Bearer dt_live_x' })), p);
    for (const p of [
      '/api/files/abc/comments', '/api/files/abc/thumbnail/sizes', '/api/files/abc/filmstrip', '/api/files/abc/download', '/api/files/upload',
      '/api/files/config', '/api/admin/people', '/api/admin/trash', '/api/filespaces', '/files/abc', '/admin',
      '/api/files/abc/shares/t/x', '/api/files/folders/shares/t/x', '/api/files/config/shares', '/api/files/presign/shares',
      '/api/files/upload/shares/t', '/api/admin/shares',
    ]) {
      assert.ok(redirected(await run(p, { authorization: 'Bearer dt_live_x' })), p);
    }
  });

  test('it has to be a bearer: another scheme or an empty one is the gate as before', async () => {
    for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer ', 'Bearer', 'dt_live_x']) {
      assert.ok(redirected(await run('/api/files/presign', { authorization })), authorization);
    }
    assert.equal(bearerToken('bearer  dt_live_y '), 'dt_live_y', 'the scheme in any case, as the guard reads it');
    assert.equal(bearerMayPass('/api/files/presign', 'BEARER t'), true);
    assert.equal(bearerMayPass('/api/files/presign/', 'Bearer t'), false, 'exact paths');
    assert.equal(bearerMayPass('/api/files/a/b', 'Bearer t'), false);
  });

  test('the matcher is unchanged: these paths still run through the middleware', async () => {
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp/index.js');
    const gated = (p) => pathToRegexp(mwConfig.matcher[0]).test(p);
    for (const p of PATHS) assert.equal(gated(p), true, p);
  });
});

describe('who a token is', () => {
  test('the Mac records an upload as the token’s person, with the web’s own routes', async () => {
    const who = mac(ED);
    const p = await presign(who, { filename: 'Take 1.mov', contentType: 'video/quicktime', size: 1000, folder: 'Cuts', filespaceId: 'd1' });
    assert.equal(p.status, 200);
    assert.deepEqual(Object.keys(p.body).sort(), ['key', 'name', 'publicUrl', 'putUrl']);
    assert.equal(p.body.key, 'team/Cuts/Take 1.mov', 'in the drive, in its folder');
    put(p.body.putUrl, Buffer.alloc(1000, 7));
    const r = await record(who, {
      name: p.body.name, url: p.body.publicUrl, mime: 'video/quicktime', size: 1000, folder: 'Cuts', storage: 's3', storageKey: p.body.key, filespace: 'd1',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.file.createdBy, ED);
    assert.equal(r.body.file.size, 1000, 'the size the bucket reported');
    assert.equal(r.body.file.contentHash, md5(Buffer.alloc(1000, 7)));
    assert.match(r.body.file.url, /^http:\/\/s3\.test\/onyx\/team\/Cuts\/Take%201\.mov\?X-Amz-/, 'presigned for reading');
    const got = await getFile(who, r.body.file.id);
    assert.equal(got.status, 200);
    assert.equal(got.body.canWrite, true);
  });

  test('no session and no token is a 401, as it always was', async () => {
    for (const out of [
      await presign({}, { filename: 'a.mov', size: 1 }), await record({}, {}), await getFile({}, 'x'),
      await folders.create({}, { name: 'X' }), await swap({}, 'x', { key: 'k' }),
      await call(multipartRoute.GET, '/api/files/upload/multipart'),
    ]) {
      assert.equal(out.status, 401);
      assert.equal(out.body.error, 'Not authenticated');
    }
    const basic = await presign({ headers: { authorization: 'Basic eDp5' } }, { filename: 'a.mov', size: 1 });
    assert.equal(basic.status, 401);
    assert.equal(basic.body.error, 'Not authenticated');
  });

  test('a revoked or expired token is refused everywhere, before anything is signed', async () => {
    const f = await upload(mac(ED));
    const revoked = tokenFor(ED);
    globalThis.__mw.tokens.delete(revoked);
    const expired = tokenFor(ED, { expiresAt: globalThis.__mw.now - 1 });
    const calls = globalThis.__mw.s3.calls.length;
    for (const token of [revoked, expired]) {
      for (const out of [
        await presign({ token }, { filename: 'b.mov', size: 1, filespaceId: 'd1' }),
        await multipart({ token }, { action: 'create', filename: 'b.mov', size: 1, filespaceId: 'd1' }),
        await record({ token }, { url: 'u', storage: 's3', storageKey: 'team/b.mov' }),
        await getFile({ token }, f.id), await patchFile({ token }, f.id, { name: 'x.mov' }), await trashFile({ token }, f.id),
        await folders.create({ token }, { name: 'X', filespaceId: 'd1' }), await swap({ token }, f.id, { key: 'team/Cuts/x.mov' }),
        await restore({ token }, [f.id]),
      ]) {
        assert.equal(out.status, 401);
        assert.equal(out.body.error, 'Invalid or expired token');
      }
    }
    assert.equal(globalThis.__mw.s3.calls.length, calls, 'the bucket was never asked');
    assert.equal(row(f.id).name, 'Take 1.mov');
    assert.equal(row(f.id).deletedAt, null);
  });

  test('a suspended person’s token stops at once', async () => {
    const who = mac(ED);
    globalThis.__mw.people.get(ED).status = 'suspended';
    const out = await presign(who, { filename: 'a.mov', size: 1, filespaceId: 'd1' });
    assert.equal(out.status, 403);
    assert.equal(out.body.error, 'Access revoked');
  });

  test('a role without the desktop app cannot write through it — and still can on the web', async () => {
    const f = await upload(mac(ED));
    const who = mac(ND);
    for (const out of [
      await presign(who, { filename: 'a.mov', size: 1, filespaceId: 'd1' }),
      await multipart(who, { action: 'create', filename: 'a.mov', size: 1, filespaceId: 'd1' }),
      await patchFile(who, f.id, { name: 'y.mov', filespaceId: 'd1' }), await trashFile(who, f.id),
      await folders.create(who, { name: 'X', filespaceId: 'd1' }), await getFile(who, f.id),
    ]) {
      assert.equal(out.status, 403);
      assert.equal(out.body.error, 'Your role cannot use the desktop app.');
    }
    const onWeb = await presign(web(ND), { filename: 'a.mov', size: 1, filespaceId: 'd1' });
    assert.equal(onWeb.status, 200, 'the web does not need the desktop app');
  });

  test('with drives and desktop mounts turned off, no token writes — an admin’s neither', async () => {
    globalThis.__mw.settings.set('features.flags', { filespaces: false });
    for (const email of [ED, BOSS]) {
      const out = await presign(mac(email), { filename: 'a.mov', size: 1, filespaceId: 'd1' });
      assert.equal(out.status, 403);
      assert.equal(out.body.error, 'Drives and desktop mounts are turned off.');
    }
  });

  test('a session wins over a token: a browser that sends both is its session', async () => {
    const f = await upload({ cookie: ED2, token: tokenFor(ED) }, { name: 'Both.mov' });
    assert.equal(f.createdBy, ED2);
  });
});

describe('a viewer’s token changes nothing', () => {
  for (const [label, email, why] of [
    ['the Viewer role (granted editor, capped to viewer)', VR, /role|view this drive/],
    ['a Member who views the drive', DV, /view this drive|No access|not add/],
  ]) {
    test(label, async () => {
      const f = await upload(mac(ED));
      const who = mac(email);
      assert.equal((await getFile(who, f.id)).status, 200, 'reading is theirs');
      const refused = [
        await presign(who, { filename: 'a.mov', size: 10, folder: 'Cuts', filespaceId: 'd1' }),
        await presign(who, { replaceOf: f.id, size: 10 }),
        await multipart(who, { action: 'create', filename: 'a.mov', size: 10, filespaceId: 'd1' }),
        await multipart(who, { action: 'create', replaceOf: f.id, size: 10 }),
        await record(who, { name: 'a.mov', url: 'u', storage: 's3', storageKey: 'team/Cuts/a.mov', size: 1 }),
        await patchFile(who, f.id, { name: 'Renamed.mov', filespaceId: 'd1' }),
        await patchFile(who, f.id, { folder: 'Elsewhere', filespaceId: 'd1' }),
        await trashFile(who, f.id),
        await folders.create(who, { name: 'New', filespaceId: 'd1' }),
        await folders.move(who, { from: 'Cuts', to: 'Cuts 2', filespaceId: 'd1' }),
        await folders.remove(who, 'Cuts'),
        await swap(who, f.id, { key: 'team/Cuts/Take 1 (2).mov' }),
        await restore(who, [f.id]),
      ];
      for (const out of refused) {
        assert.equal(out.status, 403, JSON.stringify(out.body));
        assert.ok(why.test(out.body.error) || out.body.error === 'Admin access required', out.body.error);
      }
      const r = row(f.id);
      assert.deepEqual([r.name, r.folder, r.storageKey, r.deletedAt, r.version], ['Take 1.mov', 'Cuts', 'team/Cuts/Take 1.mov', null, 1]);
      assert.deepEqual([...globalThis.__mw.s3.objects.keys()], ['onyx/team/Cuts/Take 1.mov'], 'nothing new in the bucket');
      assert.equal(globalThis.__mw.uploadKeys.size, 0, 'no key issued');
    });
  }
});

describe('the Mac’s writes', () => {
  test('a large file by multipart: create, sign, parts, status, complete, record', async () => {
    const who = mac(ED);
    const size = 20_000_000;
    const bytes = Buffer.alloc(size, 3);
    const c = await multipart(who, { action: 'create', filename: 'Master.mov', size, mime: 'video/quicktime', folder: 'Cuts', filespaceId: 'd1' });
    assert.equal(c.status, 200);
    assert.equal(c.body.key, 'team/Cuts/Master.mov');
    assert.equal(c.body.partSize, 8 * 1024 * 1024, 'the server picks the part size');
    assert.equal(c.body.partCount, 3);
    assert.equal('replaceOf' in c.body, false);
    const listed = await call(multipartRoute.GET, '/api/files/upload/multipart', who);
    assert.deepEqual(listed.body.uploads.map((u) => u.id), [c.body.id], 'resumable, and listed for the token’s person');
    const signed = await multipart(who, { action: 'sign', id: c.body.id, partNumbers: [1, 2, 3] });
    assert.equal(signed.body.parts.length, 3);
    for (const { partNumber, url } of signed.body.parts) {
      put(url, bytes.subarray((partNumber - 1) * c.body.partSize, partNumber * c.body.partSize));
    }
    const status = await multipart(who, { action: 'status', id: c.body.id });
    assert.equal(status.body.uploaded, size);
    const done = await multipart(who, { action: 'complete', id: c.body.id });
    assert.equal(done.status, 200);
    assert.deepEqual(Object.keys(done.body).sort(), ['key', 'mime', 'name', 'publicUrl', 'size']);
    const r = await record(who, {
      name: done.body.name, url: done.body.publicUrl, mime: done.body.mime, size, folder: 'Cuts', storage: 's3', storageKey: done.body.key, filespace: 'd1',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.file.size, size);
    assert.match(r.body.file.contentHash, /^[0-9a-f]{32}-3$/);
  });

  test('a heavy video is queued for a proxy; a light one some browser will not play is left for the queue to offer', async () => {
    const { PROXY_MIN_BYTES, shouldProxy } = await import('../lib/proxies.js');
    const who = mac(ED);
    const queued = () => [...(globalThis.__mw.proxies || new Map()).keys()];

    // A 300 MB master. The bytes are not written — 300 MB through the mock
    // bucket would make this test cost seconds — so the object is planted at
    // the presigned key with the size the route will HEAD for. Everything else
    // is the real path: presign, uploadCheck, createFile, and the queue.
    const size = PROXY_MIN_BYTES + 1;
    const p = await presign(who, { filename: 'Master.mov', contentType: 'video/quicktime', size, folder: 'Cuts', filespaceId: 'd1' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    globalThis.__mw.s3.objects.set(`onyx/${p.body.key}`, { size, etag: 'f'.repeat(32) });
    const heavy = await record(who, {
      name: p.body.name, url: p.body.publicUrl, mime: 'video/quicktime', size, folder: 'Cuts', storage: 's3', storageKey: p.body.key, filespace: 'd1',
    });
    assert.equal(heavy.status, 200, JSON.stringify(heavy.body));
    assert.deepEqual(queued(), [heavy.body.file.id], 'the master is waiting for a Mac to transcode');

    // Under the threshold nothing is queued: streaming the original is fine,
    // and a proxy would cost storage for nothing.
    const light = await upload(who, { name: 'Take 1.mov' });
    assert.deepEqual(queued(), [heavy.body.file.id], `a small file queued a proxy: ${light.id}`);

    // And a purge takes the job with it — a queue holding work for a file that
    // no longer exists would have a Mac claiming it for ever.
    const admin = mac('boss@mw.test');
    await trashFile(admin, heavy.body.file.id);
    const { deleteFile } = await import('@/lib/db');
    await deleteFile(heavy.body.file.id);
    assert.deepEqual(queued(), []);

    // A light video some browser will not play keeps the codec the Mac read
    // from its bytes and sent as it recorded it (OnyxKit VideoCodec), which
    // makes it one the queue offers the Macs once what people asked for is
    // taken (lib/db.js listProxyJobs) — but asks for no job now: one per
    // phone clip would put every request a person makes behind them
    // (lib/proxies.js asksAtUpload). A light one every browser plays is
    // neither.
    const hevc = { fourcc: 'hvc1', bitDepth: 10, chroma: '4:2:0', hdr: true };
    const phone = await upload(who, { name: 'IMG_0042.MOV', media: { videoCodec: hevc } });
    assert.deepEqual(row(phone.id).metadata.videoCodec, hevc);
    assert.equal(shouldProxy(row(phone.id)), true, 'offered by the queue');
    assert.deepEqual(queued(), [], 'but not asked for at upload');
    const cut = await upload(who, { name: 'Export.mp4', mime: 'video/mp4', media: { videoCodec: { fourcc: 'avc1', bitDepth: 8, chroma: '4:2:0' } } });
    assert.equal(shouldProxy(row(cut.id)), false, `an H.264 file would be offered: ${cut.id}`);
    assert.deepEqual(queued(), []);
    for (const id of [phone.id, cut.id]) {
      await trashFile(admin, id);
      await deleteFile(id);
    }
    assert.deepEqual(queued(), []);
  });

  test('rename, move, trash and — for an admin — restore, all with a token', async () => {
    const f = await upload(mac(ED));
    const who = mac(ED);
    const seq0 = row(f.id).seq;

    const renamed = await patchFile(who, f.id, { name: 'Take 2.mov', filespaceId: 'd1' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.objectMoved, true);
    assert.equal(renamed.body.file.name, 'Take 2.mov');
    assert.ok(stored('team/Cuts/Take 2.mov') && !stored('team/Cuts/Take 1.mov'), 'the object follows the name');

    const moved = await patchFile(who, f.id, { folder: 'Selects', filespaceId: 'd1' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.objectMoved, true);
    assert.equal(row(f.id).storageKey, 'team/Selects/Take 2.mov');
    assert.ok(stored('team/Selects/Take 2.mov'));
    assert.ok(row(f.id).seq > seq0, 'each change reaches devices');

    const stale = await patchFile(who, f.id, { name: 'Take 3.mov', filespaceId: 'd1' }, { 'if-match': '"1"' });
    assert.equal(stale.status, 409, 'If-Match holds for a token too');
    assert.equal(stale.body.code, 'version_mismatch');

    const trashed = await trashFile(who, f.id);
    assert.deepEqual(trashed.body, { ok: true, trashed: true }, 'the trash flag is read on the server');
    assert.equal((await getFile(who, f.id)).status, 404, 'gone at once, whether or not its object has moved yet');
    await afterResponseSettled();
    assert.ok(stored(`_trash/${f.id}/team/Selects/Take 2.mov`), 'moved out of the drive once the delete has answered');
    assert.ok(!stored('team/Selects/Take 2.mov'));
    const retried = await trashFile(who, f.id);
    await afterResponseSettled();
    assert.deepEqual([retried.status, retried.body], [200, { ok: true, trashed: true }], 'asked again, the same answer');
    assert.ok(stored(`_trash/${f.id}/team/Selects/Take 2.mov`), 'and the trashed object stays where it is');
    assert.equal((await trashFile(mac(DV), f.id)).status, 403, 'still only for someone who could delete it');
    assert.equal((await getFile(who, f.id)).status, 404);

    const notAdmin = await restore(who, [f.id]);
    assert.equal(notAdmin.status, 403, 'restoring is an admin’s call, from the Mac as on the web');
    assert.equal(notAdmin.body.error, 'Admin access required');
    const back = await restore(mac(BOSS), [f.id]);
    assert.equal(back.status, 200);
    assert.deepEqual(back.body, { restored: [{ id: f.id, name: 'Take 2.mov', movedTo: null, restored: true }], failed: [], notInTrash: [] });
    assert.ok(stored('team/Selects/Take 2.mov'));
    assert.equal(row(f.id).deletedAt, null);
    assert.equal(globalThis.__mw.audit.at(-1).actor, BOSS);
  });

  test('with the trash off, a token’s delete is permanent, as the web’s is', async () => {
    globalThis.__mw.settings.set('features.flags', { trash: false });
    const f = await upload(mac(ED));
    const out = await trashFile(mac(ED), f.id);
    assert.deepEqual(out.body, { ok: true, trashed: false });
    assert.equal(row(f.id), undefined);
    assert.equal(stored('team/Cuts/Take 1.mov'), null);
    assert.deepEqual((await trashFile(mac(ED), f.id)).body, { ok: true }, 'asked again: already gone');
  });

  test('with the trash off, a file already in the trash is left to the purge, not stranded', async () => {
    const f = await upload(mac(ED));
    await trashFile(mac(ED), f.id);
    await afterResponseSettled();
    globalThis.__mw.settings.set('features.flags', { trash: false });
    const out = await trashFile(mac(ED), f.id);
    assert.deepEqual(out.body, { ok: true, trashed: true });
    assert.ok(row(f.id), 'the row stays for the purge, which deletes the object at its trash key');
    assert.ok(stored(`_trash/${f.id}/team/Cuts/Take 1.mov`));
  });

  test('folders: create (and ensure), list, rename with the files in it, delete', async () => {
    const who = mac(ED);
    const made = await folders.create(who, { name: 'Day 1/Cam A', filespaceId: 'd1' });
    assert.equal(made.status, 201);
    assert.deepEqual(made.body, { folder: { name: 'Day 1/Cam A' } });
    assert.ok(stored('team/Day 1/Cam A/'), 'a marker, so the empty folder shows on a mount');
    assert.equal((await folders.create(who, { name: 'Day 1/Cam A', filespaceId: 'd1', ensure: true })).status, 200, 'already there is fine when asked to ensure');
    assert.equal((await folders.create(who, { name: 'Day 1/Cam A', filespaceId: 'd1' })).status, 409);

    const f = await upload(who, { name: 'A001.mov', folder: 'Day 1/Cam A' });
    const tree = await folders.list(who);
    assert.deepEqual(tree.body.folders.map((x) => x.folder), ['Day 1', 'Day 1/Cam A']);

    const renamed = await folders.move(who, { from: 'Day 1', to: 'Day One', filespaceId: 'd1' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.files, 1);
    assert.equal(renamed.body.leftovers, 0);
    assert.equal(row(f.id).folder, 'Day One/Cam A');
    assert.equal(row(f.id).storageKey, 'team/Day One/Cam A/A001.mov');
    assert.ok(stored('team/Day One/Cam A/A001.mov') && !stored('team/Day 1/Cam A/A001.mov'));

    const gone = await folders.remove(who, 'Day One');
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body, { deleted: 1, failed: 0, error: null, outside: 0, more: false, trashed: true });
    assert.ok(row(f.id).deletedAt);
    assert.equal([...globalThis.__mw.folders.keys()].length, 0);
    assert.ok(!stored('team/Day One/Cam A/'), 'markers go too');
  });
});

describe('new contents for a file', () => {
  // A file with everything a replacement must drop: previews (and their
  // objects), media facts, a transcript of the old bytes.
  async function seeded(who = mac(ED)) {
    const f = await upload(who, { name: 'Interview.mov', bytes: Buffer.alloc(1000, 1) });
    const r = row(f.id);
    const uuid = randomUUID();
    Object.assign(r, {
      thumbnailKey: `_thumbs/${uuid}.webp`, posterKey: `_thumbs/${uuid}.poster.webp`, filmstripKey: `_thumbs/${uuid}.strip.webp`,
      thumbSizes: ['sm', 'xs'],
      metadata: { client: 'Acme', width: 1920, height: 1080, duration: 12.5, fps: { num: 24, den: 1 }, filmstrip: { frames: 40 } },
    });
    for (const k of [`${uuid}.webp`, `${uuid}.sm.webp`, `${uuid}.xs.webp`, `${uuid}.poster.webp`, `${uuid}.strip.webp`]) {
      globalThis.__mw.s3.objects.set(`onyx/_thumbs/${k}`, { size: 10, etag: md5(k) });
    }
    globalThis.__mw.transcripts.set(f.id, { sourceKey: r.storageKey });
    return { f: structuredClone(r), uuid };
  }

  test('presign with replaceOf, PUT, swap: the same file with new bytes, everything about the old ones gone', async () => {
    const who = mac(ED);
    const { f, uuid } = await seeded(who);
    const p = await presign(who, { replaceOf: f.id, contentType: 'video/quicktime', size: 1500, filename: 'ignored.mov', folder: 'Nope', filespaceId: 'nope' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.key, 'team/Cuts/Interview (2).mov', 'beside the old object, never over it');
    assert.equal(p.body.name, 'Interview.mov', 'a replacement keeps the file’s name');
    assert.equal(p.body.replaceOf, f.id);
    assert.deepEqual(globalThis.__mw.uploadKeys.get(`${p.body.key}|${ED}`).replaceOf, f.id, 'the key is bound to this file');

    const newBytes = Buffer.alloc(1500, 2);
    put(p.body.putUrl, newBytes);
    assert.equal(row(f.id).storageKey, f.storageKey, 'nothing changes until the swap');

    const out = await swap(who, f.id, { key: p.body.key, mime: 'video/quicktime' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const r = row(f.id);
    assert.equal(out.body.file.id, f.id);
    assert.equal(r.storageKey, 'team/Cuts/Interview (2).mov');
    assert.equal(r.name, 'Interview.mov');
    assert.equal(r.folder, 'Cuts');
    assert.equal(r.size, 1500, 'the bucket’s size');
    assert.equal(r.contentHash, md5(newBytes));
    assert.equal(r.version, f.version + 1);
    assert.ok(r.seq > f.seq, 'seq moves, so the delta carries it');
    assert.deepEqual([r.thumbnailKey, r.posterKey, r.filmstripKey, r.thumbSizes], [null, null, null, []], 'previews are made again');
    assert.deepEqual(r.metadata, { client: 'Acme' }, 'the library’s own fields stay; the old bytes’ facts go');
    assert.equal(stored('team/Cuts/Interview.mov'), null, 'no versions yet: the old object is deleted');
    assert.equal(stored('team/Cuts/Interview (2).mov').size, 1500);
    for (const k of [`${uuid}.webp`, `${uuid}.sm.webp`, `${uuid}.xs.webp`, `${uuid}.poster.webp`, `${uuid}.strip.webp`]) {
      assert.equal(stored(`_thumbs/${k}`), null, k);
    }
    assert.equal(globalThis.__mw.transcripts.get(f.id).sourceKey, 'team/Cuts/Interview.mov', 'the transcript does not follow: it is stale');
    assert.equal(globalThis.__mw.uploadKeys.size, 0, 'the key was taken');
    // Asked again — the answer lost on the way back — it answers as before,
    // If-Match on the version it replaced or not, and changes nothing.
    const seq1 = r.seq;
    for (const headers of [undefined, { 'if-match': `"${f.version}"` }]) {
      const again = await swap(who, f.id, { key: p.body.key }, headers);
      assert.equal(again.status, 200);
      assert.equal(again.body.file.storageKey, p.body.key);
    }
    assert.equal(row(f.id).seq, seq1);
    assert.equal(row(f.id).version, f.version + 1);

    // Again: the name is free now, so the bytes go back under it.
    const again = await presign(who, { replaceOf: f.id, size: 900 });
    assert.equal(again.body.key, 'team/Cuts/Interview.mov');
    put(again.body.putUrl, Buffer.alloc(900, 3));
    assert.equal((await swap(who, f.id, { key: again.body.key })).status, 200);
    assert.equal(row(f.id).storageKey, 'team/Cuts/Interview.mov');
    assert.equal(stored('team/Cuts/Interview (2).mov'), null);
    assert.deepEqual([...globalThis.__mw.s3.objects.keys()], ['onyx/team/Cuts/Interview.mov'], 'nothing left behind');
  });

  test('by multipart: the binding survives complete, and the swap takes the assembled object', async () => {
    const who = mac(ED);
    const { f } = await seeded(who);
    const size = 20_000_000;
    const c = await multipart(who, { action: 'create', replaceOf: f.id, size, mime: 'video/quicktime', filename: 'x', folder: 'y' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.key, 'team/Cuts/Interview (2).mov');
    assert.equal(c.body.name, 'Interview.mov');
    assert.equal(c.body.replaceOf, f.id);
    assert.equal(c.body.partCount, 3);
    assert.equal((await call(multipartRoute.GET, '/api/files/upload/multipart', who)).body.uploads[0].replaceOf, f.id);
    const signed = await multipart(who, { action: 'sign', id: c.body.id, partNumbers: [1, 2, 3] });
    const bytes = Buffer.alloc(size, 9);
    for (const { partNumber, url } of signed.body.parts) put(url, bytes.subarray((partNumber - 1) * c.body.partSize, partNumber * c.body.partSize));
    const done = await multipart(who, { action: 'complete', id: c.body.id });
    assert.equal(done.status, 200);
    assert.equal(done.body.replaceOf, f.id);
    assert.equal(globalThis.__mw.uploadKeys.get(`${done.body.key}|${ED}`).replaceOf, f.id, 'issued again, for the same file');
    const out = await swap(who, f.id, { key: done.body.key });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).size, size);
    assert.match(row(f.id).contentHash, /-3$/);
    assert.equal(stored('team/Cuts/Interview.mov'), null);
  });

  test('a key is taken only for what it was issued for, by whom it was issued to', async () => {
    const who = mac(ED);
    const { f } = await seeded(who);
    const p = await presign(who, { replaceOf: f.id, size: 1200 });
    put(p.body.putUrl, Buffer.alloc(1200, 4));

    const asNewFile = await record(who, { name: 'Sneaky.mov', url: p.body.publicUrl, storage: 's3', storageKey: p.body.key, folder: 'Cuts', filespace: 'd1' });
    assert.equal(asNewFile.status, 403, 'new contents are never a file of their own');
    assert.equal(asNewFile.body.code, 'not_issued');

    const byAnother = await swap(mac(ED2), f.id, { key: p.body.key });
    assert.equal(byAnother.status, 403, 'another editor of the drive, but not the one it was issued to');
    assert.equal(byAnother.body.code, 'not_issued');

    const other = await upload(who, { name: 'Other.mov' });
    const intoOther = await swap(who, other.id, { key: p.body.key });
    assert.equal(intoOther.status, 403, 'nor into another file');

    const plain = await presign(who, { filename: 'Plain.mov', size: 5, folder: 'Cuts', filespaceId: 'd1' });
    put(plain.body.putUrl, Buffer.alloc(5));
    const plainSwap = await swap(who, f.id, { key: plain.body.key });
    assert.equal(plainSwap.status, 403, 'nor is an upload for a new file swapped into one');
    assert.equal(plainSwap.body.code, 'not_issued');

    assert.equal((await swap(who, f.id, { key: p.body.key })).status, 200, 'still good for what it was for');
    assert.equal((await record(who, { name: 'Plain.mov', url: plain.body.publicUrl, storage: 's3', storageKey: plain.body.key, folder: 'Cuts', filespace: 'd1' })).status, 200);
  });

  test('uploads in flight are never handed the same key', async () => {
    const who = mac(ED);
    const other = mac(ED2);
    const { f } = await seeded(who);
    // Two Macs saving over one file before either lands.
    const a = await presign(who, { replaceOf: f.id, size: 10 });
    const b = await presign(other, { replaceOf: f.id, size: 12 });
    assert.equal(a.body.key, 'team/Cuts/Interview (2).mov');
    assert.equal(b.body.key, 'team/Cuts/Interview (3).mov', 'not the key the first one is still uploading to');
    // A new file of the same name, meanwhile, by presign or by multipart —
    // and the same person starting it again gets the key they already hold.
    const n = await presign(other, { filename: 'Interview.mov', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    assert.equal(n.body.key, 'team/Cuts/Interview (4).mov');
    const m = await multipart(mac(BOSS), { action: 'create', filename: 'Interview.mov', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    assert.equal(m.body.key, 'team/Cuts/Interview (5).mov');
    const again = await multipart(other, { action: 'create', filename: 'Interview.mov', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    assert.equal(again.body.key, 'team/Cuts/Interview (4).mov');
    // Retrying your own new upload keeps its name; your own replacement is still passed over.
    const r1 = await presign(who, { filename: 'Retry.mov', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    const r2 = await presign(who, { filename: 'Retry.mov', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    assert.equal(r2.body.key, r1.body.key);
    assert.equal(r1.body.key, 'team/Cuts/Retry.mov');
    // Both replacements land and swap in, each over the last: the catalog
    // always names the bytes that are there.
    put(a.body.putUrl, Buffer.alloc(10, 1));
    put(b.body.putUrl, Buffer.alloc(12, 2));
    assert.equal((await swap(who, f.id, { key: a.body.key })).status, 200);
    assert.equal((await swap(other, f.id, { key: b.body.key })).status, 200);
    assert.equal(row(f.id).storageKey, 'team/Cuts/Interview (3).mov');
    assert.equal(row(f.id).size, 12);
    assert.equal(stored('team/Cuts/Interview (3).mov').size, 12);
    assert.equal(stored('team/Cuts/Interview (2).mov'), null, 'the first one’s bytes went with the second swap');
    assert.equal(stored('team/Cuts/Interview.mov'), null);
  });

  test('If-Match is asked before the key is taken', async () => {
    const who = mac(ED);
    const { f } = await seeded(who);
    const p = await presign(who, { replaceOf: f.id, size: 1100 });
    put(p.body.putUrl, Buffer.alloc(1100, 5));
    const stale = await swap(who, f.id, { key: p.body.key }, { 'if-match': '"99"' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'version_mismatch');
    assert.equal(stale.body.currentVersion, 1);
    assert.ok(stored(p.body.key), 'the upload is kept');
    const ok = await swap(who, f.id, { key: p.body.key }, { 'if-match': 'W/"1"' });
    assert.equal(ok.status, 200);
  });

  test('before the bytes arrive: 409, and the key is handed back for when they have', async () => {
    const who = mac(ED);
    const { f } = await seeded(who);
    const p = await presign(who, { replaceOf: f.id, size: 1000 });
    const early = await swap(who, f.id, { key: p.body.key });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'not_uploaded');
    assert.equal(row(f.id).storageKey, f.storageKey);
    assert.ok(stored(f.storageKey), 'the old bytes are untouched');
    put(p.body.putUrl, Buffer.alloc(1000, 6));
    assert.equal((await swap(who, f.id, { key: p.body.key })).status, 200);
  });

  test('the quota counts what the file grows by, measured by the bucket', async () => {
    const who = mac(ED);
    const { f } = await seeded(who);
    globalThis.__mw.people.get(ED).quotaBytes = 1100; // holds 1000: 100 bytes of room
    const tooBig = await presign(who, { replaceOf: f.id, size: 1200 });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.code, 'quota');
    assert.equal(globalThis.__mw.uploadKeys.size, 0);

    // Declared small, uploaded large: the swap measures, refuses, and removes
    // the object — the caller's, issued for this, named by no row.
    const lying = await presign(who, { replaceOf: f.id, size: 1000 });
    assert.equal(lying.status, 200);
    put(lying.body.putUrl, Buffer.alloc(1200, 1));
    const refused = await swap(who, f.id, { key: lying.body.key });
    assert.equal(refused.status, 413);
    assert.equal(refused.body.code, 'quota');
    assert.equal(stored(lying.body.key), null);
    assert.equal(row(f.id).storageKey, f.storageKey);

    // At the quota exactly, a file that shrinks is fine: it adds nothing.
    globalThis.__mw.people.get(ED).quotaBytes = 1000;
    const smaller = await presign(who, { replaceOf: f.id, size: 400 });
    assert.equal(smaller.status, 200);
    put(smaller.body.putUrl, Buffer.alloc(400, 1));
    assert.equal((await swap(who, f.id, { key: smaller.body.key })).status, 200);
    assert.equal(row(f.id).size, 400);
  });

  test('a file moved while its new contents uploaded is left as it is, and the upload removed', async () => {
    const who = mac(ED);
    const { f } = await seeded(who);
    const p = await presign(who, { replaceOf: f.id, size: 1000 });
    put(p.body.putUrl, Buffer.alloc(1000, 8));
    assert.equal((await patchFile(who, f.id, { folder: 'Selects', filespaceId: 'd1' })).status, 200);
    const out = await swap(who, f.id, { key: p.body.key });
    assert.equal(out.status, 409);
    assert.equal(out.body.code, 'moved');
    assert.equal(stored(p.body.key), null);
    assert.equal(row(f.id).storageKey, 'team/Selects/Interview.mov');
    assert.equal(row(f.id).size, 1000);
    assert.ok(stored('team/Selects/Interview.mov'));
  });

  test('old bytes another row still names are not deleted', async () => {
    const who = mac(ED);
    const { f } = await seeded(who);
    // A row recorded at the same key before POST /api/files refused one in use.
    globalThis.__mw.files.set('twin', { ...structuredClone(row(f.id)), id: 'twin', thumbnailKey: null, posterKey: null, filmstripKey: null });
    const p = await presign(who, { replaceOf: f.id, size: 10 });
    put(p.body.putUrl, Buffer.alloc(10));
    assert.equal((await swap(who, f.id, { key: p.body.key })).status, 200);
    assert.ok(stored('team/Cuts/Interview.mov'), 'still the twin’s');
    assert.equal(row('twin').storageKey, 'team/Cuts/Interview.mov');
  });

  test('a grant on the file is no way to write into a drive one may only view', async () => {
    const { f } = await seeded(mac(ED));
    globalThis.__mw.acl.set(`${f.id}|${DV}`, 'editor');
    const dv = mac(DV);
    assert.equal((await getFile(dv, f.id)).body.canWrite, true, 'the grant does let them change the file');
    for (const out of [
      await presign(dv, { replaceOf: f.id, size: 10 }),
      await multipart(dv, { action: 'create', replaceOf: f.id, size: 10 }),
      await swap(dv, f.id, { key: 'team/Cuts/Interview (2).mov' }),
    ]) {
      assert.equal(out.status, 403);
      assert.equal(out.body.error, 'You can view this drive but not change it. Ask one of its owners for editor access.');
    }
    assert.equal(globalThis.__mw.uploadKeys.size, 0);
  });

  test('a trashed file has no contents to replace; a file in no drive does', async () => {
    globalThis.__mw.settings.set('features.flags', { library: true }); // a workspace with an All files
    const who = mac(ED);
    const { f } = await seeded(who);
    await trashFile(who, f.id);
    assert.equal((await presign(who, { replaceOf: f.id, size: 1 })).status, 404);
    assert.equal((await swap(who, f.id, { key: 'team/Cuts/Interview (2).mov' })).status, 404);

    const lib = await upload(who, { name: 'Logo.png', folder: 'Brand', filespaceId: null, mime: 'image/png', bytes: Buffer.alloc(50, 1) });
    assert.equal(lib.storageKey, 'files/Brand/Logo.png');
    const p = await presign(who, { replaceOf: lib.id, size: 60, contentType: 'image/png' });
    assert.equal(p.body.key, 'files/Brand/Logo (2).png');
    put(p.body.putUrl, Buffer.alloc(60, 2));
    const out = await swap(who, lib.id, { key: p.body.key });
    assert.equal(out.status, 200);
    assert.equal(row(lib.id).size, 60);
  });

  test('the web can use it too: the same routes with a session', async () => {
    const { f } = await seeded(mac(ED));
    const p = await presign(web(ED2), { replaceOf: f.id, size: 1000 });
    assert.equal(p.status, 200);
    put(p.body.putUrl, Buffer.alloc(1000, 4));
    const out = await swap(web(ED2), f.id, { key: p.body.key });
    assert.equal(out.status, 200);
    assert.equal(row(f.id).createdBy, ED, 'still its uploader’s file');
  });
});

describe('folder names are per drive', () => {
  // `globalNames` stands for the old primary key on folder names alone, still
  // in place until the guard that drops it has run.
  const rowsIn = (tag) => [...globalThis.__mw.folders.values()].filter((r) => r.tag === tag).map((r) => r.name).sort();

  test('two drives each make "Selects" — and "untitled folder", as Finder does — and the library its own', async () => {
    globalThis.__mw.settings.set('features.flags', { library: true }); // a workspace with an All files
    const who = mac(ED);
    for (const name of ['Selects', 'untitled folder']) {
      const one = await folders.create(who, { name, filespaceId: 'd1' });
      const two = await folders.create(who, { name, filespaceId: 'd2' });
      assert.deepEqual([one.status, two.status], [201, 201], name);
      assert.deepEqual(two.body, { folder: { name } });
    }
    { const r = await folders.create(web(BOSS), { name: 'Selects' }); assert.equal(r.status, 201, 'and the library ' + JSON.stringify(r.body)); }
    assert.deepEqual(rowsIn('team'), ['Selects', 'untitled folder']);
    assert.deepEqual(rowsIn('studio'), ['Selects', 'untitled folder']);
    assert.deepEqual(rowsIn(''), ['Selects']);
    assert.ok(stored('team/Selects/') && stored('studio/Selects/'), 'each drive’s marker, in its own prefix');
  });

  test('the same name twice in one drive: 409, or 200 with ensure', async () => {
    const who = mac(ED);
    await folders.create(who, { name: 'Selects', filespaceId: 'd1' });
    const again = await folders.create(who, { name: 'Selects', filespaceId: 'd1' });
    assert.deepEqual([again.status, again.body], [409, { error: 'A folder named “Selects” already exists here.' }]);
    const nested = await folders.create(who, { name: 'Day 1/Cam A', filespaceId: 'd1' });
    assert.equal(nested.status, 201);
    const nestedAgain = await folders.create(who, { name: 'Day 1/Cam A', filespaceId: 'd1' });
    assert.deepEqual([nestedAgain.status, nestedAgain.body], [409, { error: 'A folder named “Cam A” already exists here.' }]);
    assert.deepEqual((await folders.create(who, { name: 'Selects', filespaceId: 'd1', ensure: true })).body, { folder: { name: 'Selects' } });
  });

  test('while the old key on names stands, another drive’s name is still refused, as before', async () => {
    globalThis.__mw.globalNames = true;
    const who = mac(ED);
    assert.equal((await folders.create(who, { name: 'Selects', filespaceId: 'd1' })).status, 201);
    for (const ensure of [false, true]) {
      const two = await folders.create(who, { name: 'Selects', filespaceId: 'd2', ensure });
      assert.deepEqual([two.status, two.body], [409, {
        error: 'A folder at “Selects” already exists in another filespace, and folder names are not yet per-filespace. Choose another name.',
      }], 'not a 200 for a folder that would not show up');
    }
    assert.deepEqual(rowsIn('studio'), []);
    // A rename onto another drive's name gets as far as the one statement,
    // which the old key refuses: the copies are undone, nothing moves.
    await folders.create(who, { name: 'Picks', filespaceId: 'd2' });
    const f = await upload(who, { name: 'A.mov', folder: 'Selects', filespaceId: 'd1' });
    const out = await folders.move(who, { from: 'Selects', to: 'Picks', filespaceId: 'd1' });
    assert.deepEqual([out.status, out.body], [409, {
      error: 'A folder at “Picks” already exists in another filespace, and folder names are not yet per-filespace. Nothing was renamed.',
    }]);
    assert.equal(row(f.id).storageKey, 'team/Selects/A.mov');
    assert.ok(stored('team/Selects/A.mov') && !stored('team/Picks/A.mov'), 'the copy was undone');
  });

  test('rename and move in one drive leave the other drive’s folder of that name as it is', async () => {
    const who = mac(ED);
    for (const d of ['d1', 'd2']) await folders.create(who, { name: 'Selects/Empty', filespaceId: d });
    const mine = await upload(who, { name: 'A.mov', folder: 'Selects', filespaceId: 'd1' });
    const theirs = await upload(who, { name: 'B.mov', folder: 'Selects', filespaceId: 'd2' });

    const renamed = await folders.move(who, { from: 'Selects', to: 'Picks', filespaceId: 'd1' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.deepEqual([renamed.body.files, renamed.body.folders, renamed.body.outside], [1, 2, 1], 'the other drive’s file is outside, and stays');
    assert.deepEqual(rowsIn('team'), ['Picks', 'Picks/Empty']);
    assert.deepEqual(rowsIn('studio'), ['Selects', 'Selects/Empty']);
    assert.equal(row(mine.id).storageKey, 'team/Picks/A.mov');
    assert.equal(row(theirs.id).folder, 'Selects');
    assert.equal(row(theirs.id).storageKey, 'studio/Selects/B.mov');
    assert.ok(stored('studio/Selects/B.mov') && stored('team/Picks/A.mov') && !stored('team/Selects/A.mov'));

    // Onto a name the other drive has: this drive's own "Selects" is free again.
    const moved = await folders.move(who, { from: 'Picks', to: 'Archive/Selects', filespaceId: 'd1' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(rowsIn('team'), ['Archive', 'Archive/Selects', 'Archive/Selects/Empty']);
    assert.deepEqual(rowsIn('studio'), ['Selects', 'Selects/Empty']);
    // The other drive's "Selects" is no obstacle; this drive's own is.
    await folders.create(who, { name: 'Selects', filespaceId: 'd1' });
    const clash = await folders.move(who, { from: 'Archive/Selects', to: 'Selects', filespaceId: 'd1' });
    assert.deepEqual([clash.status, clash.body], [409, { error: '“Selects” already exists. Choose another name, or move the files into it instead.' }]);
  });

  // A move cut off by the time limit mid-copy never undid its copies: they
  // sat at the new keys, and every try after was refused ("Something is
  // already stored at …") with the folder still where it was. Each copy is
  // noted before it is made (folder_move_copies), so the next call knows
  // its own.
  const copies = () => globalThis.__mw.s3.calls.filter((c) => c === 'CopyObjectCommand').length;
  const budget = async (ms, run) => {
    _setFolderMoveBudgetMs(ms);
    try { return await run(); } finally { _setFolderMoveBudgetMs(); }
  };
  const bytes = (s) => Buffer.from(s.repeat(50));

  test('a move that stopped part-way carries on from its copies, even from the Mac', async () => {
    const who = mac(ED);
    const a = await upload(who, { name: 'A.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('a') });
    const b = await upload(who, { name: 'B.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('b') });
    const first = await budget(0, () => folders.move(web(ED), { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1', resumable: true }));
    assert.deepEqual([first.status, first.body], [202, { more: true, from: 'Shoot', to: '2026/Shoot', copied: 1, total: 2 }]);
    assert.equal(row(a.id).folder, 'Shoot', 'nothing has moved yet');

    // Onyx for Mac doesn't come back on a 202, so it moves in one call — past the copy already made.
    const before = copies();
    const moved = await folders.move(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(copies() - before, 1, 'only the file not yet copied');
    assert.equal(row(a.id).storageKey, 'team/2026/Shoot/A.arw');
    assert.equal(row(b.id).storageKey, 'team/2026/Shoot/B.arw');
    assert.equal(stored('team/2026/Shoot/A.arw').etag, md5(bytes('a')));
    assert.equal(stored('team/2026/Shoot/B.arw').etag, md5(bytes('b')));
    assert.ok(!stored('team/Shoot/A.arw') && !stored('team/Shoot/B.arw'), 'the originals are gone');
    assert.deepEqual([...(globalThis.__mw.moveCopies || new Map()).keys()], [], 'and the notes with them');
  });

  test('a noted copy is used as long as it is still one, and made again when it isn’t', async () => {
    const who = mac(ED);
    const a = await upload(who, { name: 'A.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('a') });
    const b = await upload(who, { name: 'B.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('b') });
    const objects = globalThis.__mw.s3.objects;
    const t = Date.now();
    // A was uploaded in parts: its copy has another ETag, and was written after it.
    objects.set('onyx/team/Shoot/A.arw', { size: 100, etag: `${'1'.repeat(32)}-2`, modified: t - 60_000 });
    objects.set('onyx/team/2026/Shoot/A.arw', { size: 100, etag: '2'.repeat(32), modified: t - 30_000 });
    // B was written again after its copy was made, at the same length.
    objects.set('onyx/team/Shoot/B.arw', { size: 100, etag: '3'.repeat(32), modified: t - 10_000 });
    objects.set('onyx/team/2026/Shoot/B.arw', { size: 100, etag: '4'.repeat(32), modified: t - 30_000 });
    globalThis.__mw.moveCopies = new Map([
      ['team/2026/Shoot/A.arw', 'team/Shoot/A.arw'],
      ['team/2026/Shoot/B.arw', 'team/Shoot/B.arw'],
    ]);

    const before = copies();
    const moved = await folders.move(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(copies() - before, 1, 'B again, not A');
    assert.equal(stored('team/2026/Shoot/A.arw').etag, '2'.repeat(32));
    assert.equal(stored('team/2026/Shoot/B.arw').etag, '3'.repeat(32), 'B as it is now');
    assert.equal(row(a.id).folder, '2026/Shoot');
    assert.equal(row(b.id).folder, '2026/Shoot');
  });

  test('a noted copy of another file, from a move of another folder that stopped, is made again', async () => {
    const who = mac(ED);
    const a = await upload(who, { name: 'A.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('a') });
    await upload(who, { name: 'A.arw', folder: 'Old/Shoot', filespaceId: 'd1', bytes: bytes('z') });
    globalThis.__mw.s3.objects.set('onyx/team/2026/Shoot/A.arw', { ...stored('team/Old/Shoot/A.arw') });
    globalThis.__mw.moveCopies = new Map([['team/2026/Shoot/A.arw', 'team/Old/Shoot/A.arw']]);

    const moved = await folders.move(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(row(a.id).storageKey, 'team/2026/Shoot/A.arw');
    assert.equal(stored('team/2026/Shoot/A.arw').etag, md5(bytes('a')), 'this A, not the other');
  });

  test('something the rename didn’t put there is refused — unless the caller says to replace it', async () => {
    const who = mac(ED);
    const a = await upload(who, { name: 'A.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('a') });
    const other = { size: 7, etag: 'e'.repeat(32) };
    globalThis.__mw.s3.objects.set('onyx/team/2026/Shoot/A.arw', other);
    // Even the very same bytes: nothing says who put them there.
    globalThis.__mw.s3.objects.set('onyx/team/2026/Shoot/B.arw', { ...stored('team/Shoot/A.arw') });
    await upload(who, { name: 'B.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('a') });

    const out = await folders.move(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1' });
    assert.deepEqual([out.status, out.body], [409, {
      error: '2 files are already stored at “2026/Shoot” but not in the library (team/2026/Shoot/A.arw, …), perhaps left by a move that didn\'t finish. Nothing was renamed.',
      code: 'occupied', occupied: 2, from: 'Shoot', to: '2026/Shoot',
    }]);
    assert.equal(row(a.id).storageKey, 'team/Shoot/A.arw');
    assert.deepEqual(stored('team/2026/Shoot/A.arw'), other, 'what was there is left alone');

    const replaced = await folders.move(web(ED), { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1', resumable: true, replace: true });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(row(a.id).storageKey, 'team/2026/Shoot/A.arw');
    assert.equal(stored('team/2026/Shoot/A.arw').etag, md5(bytes('a')));
  });

  test('an object the library keeps at a new key is never replaced', async () => {
    const who = mac(ED);
    const a = await upload(who, { name: 'A.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('a') });
    // A file in the trash whose object never moved aside still holds its key.
    const gone = await upload(who, { name: 'A.arw', folder: 'Elsewhere', filespaceId: 'd1', bytes: bytes('g') });
    Object.assign(row(gone.id), { storageKey: 'team/2026/Shoot/A.arw', deletedAt: Date.now(), trashKey: null });
    globalThis.__mw.s3.objects.set('onyx/team/2026/Shoot/A.arw', { ...stored('team/Elsewhere/A.arw') });

    for (const replace of [false, true]) {
      const out = await folders.move(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1', replace });
      assert.deepEqual([out.status, out.body], [409, { error: 'A file the library keeps is already stored at team/2026/Shoot/A.arw. Nothing was renamed.' }]);
    }
    assert.equal(row(a.id).folder, 'Shoot');
    assert.equal(stored('team/2026/Shoot/A.arw').etag, md5(bytes('g')));
  });

  test('undoing never takes a copy the library has come to point at', async () => {
    globalThis.__mw.globalNames = true;
    const who = mac(ED);
    await folders.create(who, { name: 'Selects', filespaceId: 'd1' });
    await folders.create(who, { name: 'Picks', filespaceId: 'd2' });
    await upload(who, { name: 'A.mov', folder: 'Selects', filespaceId: 'd1' });
    const other = await upload(who, { name: 'Z.mov', folder: 'Other', filespaceId: 'd1' });
    let release;
    globalThis.__mw.s3.copyGate = new Promise((r) => { release = r; });
    const going = folders.move(who, { from: 'Selects', to: 'Picks', filespaceId: 'd1' });
    for (let i = 0; i < 200 && !copies(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(copies(), 1, 'the copy is under way');
    // Meanwhile a row has come to point at the new key (the same rename,
    // run twice at once, got there first).
    row(other.id).storageKey = 'team/Picks/A.mov';
    globalThis.__mw.s3.copyGate = null;
    release();
    const out = await going;
    assert.equal(out.status, 409, 'the one statement still refuses the name, as before');
    assert.ok(stored('team/Picks/A.mov'), 'the copy the row points at stays');
  });

  // What the web's move shows while it runs: each step as it goes, then the
  // answer the plain response would have been.
  test('with progress, a move streams its steps and then its answer', async () => {
    const who = web(ED);
    for (const n of ['1', '2', '3']) await upload(mac(ED), { name: `${n}.arw`, folder: 'Shoot', filespaceId: 'd1', bytes: bytes(n) });
    const out = await moveStreamed(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1', resumable: true });
    assert.equal(out.status, 200);
    assert.match(out.type, /application\/x-ndjson/);
    const phases = [...new Set(out.lines.map((l) => l.phase))];
    assert.deepEqual(phases, ['check', 'copy', 'catalog', 'tidy']);
    for (const phase of ['check', 'copy', 'tidy']) {
      const last = out.lines.filter((l) => l.phase === phase).at(-1);
      assert.deepEqual([last.done, last.total], [3, 3], `${phase} reaches the end`);
    }
    assert.equal(out.answer.status, 200);
    assert.equal(out.answer.body.files, 3);
    assert.equal(out.answer.body.to, '2026/Shoot');
  });

  test('with progress, a round that runs out of time answers 202 last, and nothing moves', async () => {
    const who = web(ED);
    for (const n of ['1', '2']) await upload(mac(ED), { name: `${n}.arw`, folder: 'Shoot', filespaceId: 'd1', bytes: bytes(n) });
    const out = await budget(0, () => moveStreamed(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1', resumable: true }));
    assert.deepEqual([...new Set(out.lines.map((l) => l.phase))], ['check', 'copy']);
    assert.deepEqual(out.answer, { status: 202, body: { more: true, from: 'Shoot', to: '2026/Shoot', copied: 1, total: 2 } });
  });

  test('with progress, a refusal found while checking is the answer; one found before is a plain response', async () => {
    const who = web(ED);
    await upload(mac(ED), { name: 'A.arw', folder: 'Shoot', filespaceId: 'd1', bytes: bytes('a') });
    globalThis.__mw.s3.objects.set('onyx/team/2026/Shoot/A.arw', { size: 7, etag: 'e'.repeat(32) });
    const occupied = await moveStreamed(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1', resumable: true });
    assert.equal(occupied.answer.status, 409);
    assert.equal(occupied.answer.body.code, 'occupied');

    const missing = await moveStreamed(who, { from: 'Nowhere', to: 'Elsewhere', filespaceId: 'd1', resumable: true });
    assert.deepEqual([missing.status, missing.type.includes('json'), missing.body], [404, true, { error: 'There is no folder “Nowhere” here.' }]);
  });

  test('a resumable move copies over several calls, then moves; one that is not does it in one', async () => {
    const who = mac(ED);
    const ids = [];
    for (const n of ['1', '2', '3']) ids.push((await upload(who, { name: `${n}.arw`, folder: 'Shoot', filespaceId: 'd1', bytes: bytes(n) })).id);
    await budget(0, async () => {
      const seen = [];
      for (let round = 0; round < 10; round++) {
        const r = await folders.move(who, { from: 'Shoot', to: '2026/Shoot', filespaceId: 'd1', resumable: true });
        seen.push(r.status);
        if (r.status !== 202) { assert.equal(r.status, 200, JSON.stringify(r.body)); break; }
        assert.deepEqual(r.body, { more: true, from: 'Shoot', to: '2026/Shoot', copied: round + 1, total: 3 });
        assert.equal(row(ids[0]).folder, 'Shoot', 'nothing has moved yet');
      }
      assert.deepEqual(seen, [202, 202, 200]);
      for (const id of ids) assert.equal(row(id).folder, '2026/Shoot');

      // Without `resumable` (Onyx for Mac), the budget doesn't apply.
      const back = await folders.move(who, { from: '2026/Shoot', to: 'Shoot', filespaceId: 'd1' });
      assert.equal(back.status, 200, JSON.stringify(back.body));
      for (const id of ids) assert.equal(row(id).folder, 'Shoot');
    });
  });

  // A rename of 2,885 photos from the web was refused at a flat 1,000, though
  // the web moves a big folder in steps and could have carried on.
  test('the web renames a folder bigger than one call can copy; a caller that cannot come back is held to one call', async () => {
    const who = mac(ED);
    const ids = [];
    for (const n of ['1', '2', '3']) ids.push((await upload(who, { name: `${n}.arw`, folder: 'Big', filespaceId: 'd1', bytes: bytes(n) })).id);
    _setFolderRenameLimits({ resumable: 3, once: 2 });
    try {
      const once = await folders.move(who, { from: 'Big', to: 'Bigger', filespaceId: 'd1' });
      assert.equal(once.status, 413);
      assert.match(once.body.error, /Rename it on the web/);
      assert.equal(row(ids[0]).folder, 'Big', 'refused before anything moved');

      const web = await folders.move(who, { from: 'Big', to: 'Bigger', filespaceId: 'd1', resumable: true });
      assert.equal(web.status, 200, JSON.stringify(web.body));
      for (const id of ids) assert.equal(row(id).folder, 'Bigger');

      _setFolderRenameLimits({ resumable: 2 });
      const tooMany = await folders.move(who, { from: 'Bigger', to: 'Big', filespaceId: 'd1', resumable: true });
      assert.equal(tooMany.status, 413);
      assert.match(tooMany.body.error, /more than 2 at once/);
    } finally {
      _setFolderRenameLimits();
    }
  });

  test('delete in one drive leaves the other drive’s folder of that name, and its file', async () => {
    const who = mac(ED);
    for (const d of ['d1', 'd2']) await folders.create(who, { name: 'Selects/Empty', filespaceId: d });
    const mine = await upload(who, { name: 'A.mov', folder: 'Selects', filespaceId: 'd1' });
    const theirs = await upload(who, { name: 'B.mov', folder: 'Selects', filespaceId: 'd2' });
    const gone = await folders.remove(who, 'Selects', 'd1');
    assert.deepEqual(gone.body, { deleted: 1, failed: 0, error: null, outside: 1, more: false, trashed: true });
    assert.ok(row(mine.id).deletedAt);
    assert.equal(row(theirs.id).deletedAt, null);
    assert.deepEqual(rowsIn('team'), []);
    assert.deepEqual(rowsIn('studio'), ['Selects', 'Selects/Empty']);
    assert.ok(stored('studio/Selects/Empty/') && !stored('team/Selects/Empty/'), 'only this drive’s markers go');
  });

  test('the delete confirmation counts this drive’s folder alone', async () => {
    const who = mac(ED);
    for (const d of ['d1', 'd2']) await folders.create(who, { name: 'Selects/Empty', filespaceId: d });
    await upload(who, { name: 'A.mov', folder: 'Selects', filespaceId: 'd1' });
    await upload(who, { name: 'B.mov', folder: 'Selects', filespaceId: 'd2' });
    await upload(who, { name: 'C.mov', folder: 'Selects/Sub', filespaceId: 'd2' });
    const one = await call(foldersRoute.GET, '/api/files/folders?summary=Selects&filespace=d1', who);
    assert.deepEqual(one.body, { files: 1, folders: 1, outside: 2 });
    const two = await call(foldersRoute.GET, '/api/files/folders?summary=Selects&filespace=d2', who);
    assert.deepEqual(two.body, { files: 2, folders: 2, outside: 1 });
  });

  test('each drive’s listing shows its own folders', async () => {
    const who = mac(ED);
    await folders.create(who, { name: 'Selects', filespaceId: 'd1' });
    await folders.create(who, { name: 'Only One', filespaceId: 'd1' });
    await folders.create(who, { name: 'Selects', filespaceId: 'd2' });
    await folders.create(who, { name: 'Only Two', filespaceId: 'd2' });
    assert.deepEqual((await folders.list(who, 'd1')).body.folders.map((f) => f.folder), ['Only One', 'Selects']);
    assert.deepEqual((await folders.list(who, 'd2')).body.folders.map((f) => f.folder), ['Only Two', 'Selects']);
  });

  test('a drive editor restructures its own folder, whatever the library has of that name', async () => {
    globalThis.__mw.settings.set('features.flags', { library: true }); // a workspace with an All files
    const who = mac(ED);
    await folders.create(web(BOSS), { name: 'Board' });
    await folders.create(who, { name: 'Board', filespaceId: 'd1' });
    assert.equal((await folders.move(who, { from: 'Board', to: 'Board 2', filespaceId: 'd1' })).status, 200);
    assert.equal((await folders.remove(who, 'Board 2', 'd1')).status, 200);
    assert.deepEqual(rowsIn(''), ['Board'], 'the library’s is untouched');
  });

  test('folder access cannot follow a folder to a name another drive uses', async () => {
    const who = mac(ED);
    await folders.create(who, { name: 'Selects', filespaceId: 'd1' });
    await folders.create(who, { name: 'Picks', filespaceId: 'd2' });
    globalThis.__mw.folderGrants = ['Selects']; // someone was given access to "Selects"
    const out = await folders.move(who, { from: 'Selects', to: 'Picks', filespaceId: 'd1' });
    assert.deepEqual([out.status, out.body], [409, {
      error: '“Picks” is also a folder in another drive or in the library, and the access given on “Selects” would reach it there as well. Choose another name, or remove that access first.',
    }]);
    assert.deepEqual(rowsIn('team'), ['Selects']);
    assert.equal((await folders.move(who, { from: 'Selects', to: 'Keepers', filespaceId: 'd1' })).status, 200, 'a name no one else uses is fine');
  });
});

describe('the file’s own dates', () => {
  const SHOT = Date.parse('2026-09-05T12:30:00Z');
  const SAVED = Date.parse('2026-09-05T13:02:10Z');

  async function recordWith(who, dates) {
    const p = await presign(who, { filename: 'Take 9.mov', contentType: 'video/quicktime', size: 100, folder: 'Cuts', filespaceId: 'd1' });
    put(p.body.putUrl, Buffer.alloc(100, 1));
    return record(who, {
      name: p.body.name, url: p.body.publicUrl, storage: 's3', storageKey: p.body.key, size: 100, folder: 'Cuts', filespace: 'd1', ...dates,
    });
  }

  test('recorded with the upload, and read back wherever the file is', async () => {
    const who = mac(ED);
    const r = await recordWith(who, { fileCreatedAt: SHOT, fileModifiedAt: SAVED });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.file.fileCreatedAt, r.body.file.fileModifiedAt], [SHOT, SAVED]);
    assert.notEqual(r.body.file.createdAt, SHOT, 'the row’s own time is when it was added');
    const one = await getFile(who, r.body.file.id);
    assert.deepEqual([one.body.file.fileCreatedAt, one.body.file.fileModifiedAt], [SHOT, SAVED]);
    const list = await call(filesRoute.GET, '/api/files?filespace=d1&folder=Cuts&folders=0', who);
    const listed = list.body.files.find((f) => f.id === r.body.file.id);
    assert.deepEqual([listed.fileCreatedAt, listed.fileModifiedAt], [SHOT, SAVED]);
  });

  test('a date that could not be real is dropped, and the upload recorded all the same', async () => {
    const r = await recordWith(mac(ED), { fileCreatedAt: 'last week', fileModifiedAt: Date.now() + 3 * 86400_000 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.file.fileCreatedAt, r.body.file.fileModifiedAt], [null, null]);
  });

  test('new contents move the modified date — to the one sent, else to now — and keep the created one', async () => {
    const who = mac(ED);
    const { body: { file } } = await recordWith(who, { fileCreatedAt: SHOT, fileModifiedAt: SAVED });
    const p = await presign(who, { replaceOf: file.id, size: 120 });
    put(p.body.putUrl, Buffer.alloc(120, 2));
    const later = Date.parse('2026-09-06T08:00:00Z');
    const sent = await swap(who, file.id, { key: p.body.key, fileModifiedAt: later });
    assert.deepEqual([sent.body.file.fileCreatedAt, sent.body.file.fileModifiedAt], [SHOT, later]);

    globalThis.__mw.now = Date.parse('2026-09-26T09:00:00Z');
    const q = await presign(who, { replaceOf: file.id, size: 130 });
    put(q.body.putUrl, Buffer.alloc(130, 3));
    const unsaid = await swap(who, file.id, { key: q.body.key, fileModifiedAt: 'soon' });
    assert.equal(unsaid.status, 200);
    assert.equal(unsaid.body.file.fileModifiedAt, globalThis.__mw.now, 'a swap never leaves it where the old bytes had it');
    assert.equal(unsaid.body.file.fileCreatedAt, SHOT);
  });
});

describe('the session path, unchanged', () => {
  test('a browser uploads, renames, moves and trashes exactly as before', async () => {
    const who = web(ED);
    const f = await upload(who, { name: 'Web.mov' });
    assert.equal(f.createdBy, ED);
    const renamed = await patchFile(who, f.id, { name: 'Web 2.mov', filespaceId: 'd1' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.objectMoved, true);
    assert.equal((await patchFile(who, f.id, { folder: 'Selects', filespaceId: 'd1' })).status, 200);
    assert.deepEqual((await trashFile(who, f.id)).body, { ok: true, trashed: true });
    assert.equal((await restore(web(ED), [f.id])).status, 403);
    assert.equal((await restore(web(BOSS), [f.id])).status, 200);
  });

  test('a signed-out browser is refused by the handler as before', async () => {
    const out = await presign({}, { filename: 'a.mov', size: 1 });
    assert.deepEqual([out.status, out.body], [401, { error: 'Not authenticated' }]);
  });
});

describe('what a mounted disk relies on the server for', () => {
  const NFD = 'Cafe\u0301';
  const NFC = 'Caf\u00e9';

  test('a folder stored decomposed is the one a Mac names composed: uploads join it, a rename moves it all', async () => {
    const first = await upload(web(ED), { name: 'a.txt', folder: `${NFD}/Sub`, mime: 'text/plain' });
    assert.equal(row(first.id).folder, `${NFC}/Sub`, 'a new folder is stored composed');
    // One made before names were composed: its folder and its key decomposed.
    const objects = globalThis.__mw.s3.objects;
    objects.set(`onyx/team/${NFD}/Sub/a.txt`, objects.get(`onyx/team/${NFC}/Sub/a.txt`));
    objects.delete(`onyx/team/${NFC}/Sub/a.txt`);
    Object.assign(row(first.id), { folder: `${NFD}/Sub`, storageKey: `team/${NFD}/Sub/a.txt` });
    const second = await upload(mac(ED), { name: 'b.txt', folder: `${NFC}/Sub`, mime: 'text/plain' });
    assert.equal(row(second.id).folder, `${NFD}/Sub`, 'the Mac’s composed name reaches the folder already there');
    assert.equal(row(second.id).storageKey, `team/${NFD}/Sub/b.txt`, 'and so does its key, from the presign');
    const moved = await folders.move(mac(ED), { from: NFC, to: 'Coffee', filespaceId: 'd1' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual([row(first.id).folder, row(second.id).folder], ['Coffee/Sub', 'Coffee/Sub'], 'both, not only the composed one');
  });

  test('a new name is stored composed, file or folder', async () => {
    // (An upload's name is the object's, which is ASCII; a rename keeps the name given.)
    const f = await upload(mac(ED), { name: 'plain.txt', folder: 'Notes', mime: 'text/plain' });
    const r = await patchFile(mac(ED), f.id, { name: `Re${NFD}.txt`, filespaceId: 'd1' });
    assert.equal(r.status, 200);
    assert.equal(row(f.id).name, `Re${NFC}.txt`);
    const made = await folders.create(mac(ED), { name: `New ${NFD}`, filespaceId: 'd1', ensure: true });
    assert.equal(made.status, 201);
    assert.equal(made.body.folder.name, `New ${NFC}`);
  });

  test('a folder that is not there: deleting or renaming it is a 404, not a quiet success', async () => {
    await upload(mac(ED), { name: 'p.txt', folder: 'Photos', mime: 'text/plain' });
    const gone = await folders.remove(mac(ED), 'photos (2)');
    assert.equal(gone.status, 404, JSON.stringify(gone.body));
    const moved = await folders.move(mac(ED), { from: 'photos (2)', to: 'Old', filespaceId: 'd1' });
    assert.equal(moved.status, 404);
    assert.equal((await folders.list(mac(ED))).body.folders.some((f) => f.folder === 'Old'), false, 'and nothing was made');
  });

  test('a folder holding a file its deleter cannot see is refused whole, saying why', async () => {
    const theirs = await upload(web(ED2), { name: 'private.txt', folder: 'Shared', mime: 'text/plain' });
    row(theirs.id).visibility = 'owner';
    const mine = await upload(mac(ED), { name: 'mine.txt', folder: 'Shared', mime: 'text/plain' });
    const r = await folders.remove(mac(ED), 'Shared');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'hidden_files');
    assert.equal(r.body.hidden, 1);
    assert.ok(!row(theirs.id).deletedAt && !row(mine.id).deletedAt, 'nothing was deleted');
    // Its owner, who sees both, deletes it.
    assert.equal((await folders.remove(web(ED2), 'Shared')).status, 200);
    assert.ok(row(theirs.id).deletedAt && row(mine.id).deletedAt);
  });

  test('a file whose key does not spell its folder still goes with the folder', async () => {
    const f = await upload(mac(ED), { name: 'stray.txt', folder: 'Old', mime: 'text/plain' });
    row(f.id).folder = 'Elsewhere';
    const r = await folders.remove(mac(ED), 'Elsewhere');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, 1);
    assert.ok(row(f.id).deletedAt, 'deleted, where it used to be left behind and bring the folder back');
  });

  test('moving or renaming a drive’s file without naming the drive moves its object too', async () => {
    const f = await upload(mac(ED), { name: 'mv.txt', folder: 'From', mime: 'text/plain' });
    const moved = await patchFile(web(ED), f.id, { folder: 'To' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.objectMoved, true);
    assert.equal(row(f.id).storageKey, 'team/To/mv.txt');
    assert.ok(stored('team/To/mv.txt') && !stored('team/From/mv.txt'));
    const renamed = await patchFile(web(ED), f.id, { name: 'renamed.txt' });
    assert.equal(renamed.body.objectMoved, true);
    assert.equal(row(f.id).storageKey, 'team/To/renamed.txt');
  });
});

describe('a thumbnail made on the Mac', () => {
  const mayRecord = (who, id) => call(thumbnailRoute.GET, `/api/files/${id}/thumbnail`, { params: { id }, ...who });
  const recordThumb = (who, id, body) => call(thumbnailRoute.PUT, `/api/files/${id}/thumbnail`, { method: 'PUT', body, params: { id }, ...who });

  test('the Mac asks whether it may, puts the pictures where the server names, and records them as a browser does', async () => {
    const who = mac(ED);
    const f = await upload(who, { name: 'GX010042.MP4', mime: 'video/mp4' });
    const before = structuredClone(row(f.id));
    assert.equal((await mayRecord(who, f.id)).status, 204);

    const grid = await presign(who, { thumb: true, sizes: ['sm', 'xs'], contentType: 'image/jpeg' });
    assert.equal(grid.status, 200, JSON.stringify(grid.body));
    assert.match(grid.body.key, /^_thumbs\/[0-9a-f-]{36}\.jpg$/);
    assert.equal(grid.body.cacheControl, 'private, max-age=31536000, immutable');
    assert.deepEqual(Object.keys(grid.body.siblings).sort(), ['sm', 'xs']);
    assert.equal(grid.body.siblings.sm.key, grid.body.key.replace(/\.jpg$/, '.sm.jpg'));
    const poster = await presign(who, { poster: true, contentType: 'image/jpeg' });
    assert.match(poster.body.key, /^_thumbs\/[0-9a-f-]{36}\.poster\.jpg$/);
    for (const url of [grid.body.putUrl, grid.body.siblings.sm.putUrl, grid.body.siblings.xs.putUrl, poster.body.putUrl]) {
      put(url, Buffer.alloc(100, 5));
    }
    assert.ok(stored(grid.body.siblings.xs.key), 'the siblings land under the thumbnail’s own name');

    const out = await recordThumb(who, f.id, {
      thumbnailKey: grid.body.key, posterKey: poster.body.key, thumbSizes: ['sm', 'xs'],
      media: { width: 3840, height: 2160, duration: 42.52 },
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const r = row(f.id);
    assert.deepEqual([r.thumbnailKey, r.posterKey, r.thumbSizes], [grid.body.key, poster.body.key, ['sm', 'xs']]);
    assert.deepEqual([r.metadata.width, r.metadata.height, r.metadata.duration], [3840, 2160, 42.5]);
    assert.ok(r.seq > before.seq, 'seq moves: every device picks the thumbnail up');
    assert.equal(r.version, before.version, 'a picture is not an edit');
    assert.match(out.body.file.thumbnailUrl, /^http:\/\/s3\.test\/onyx\/_thumbs\/.*X-Amz-/, 'signed for the answer');
  });

  test('a viewer’s Mac is told no before it draws anything, and cannot record one either', async () => {
    const f = await upload(mac(ED), { name: 'Take 2.mov' });
    const viewer = mac(DV);
    assert.equal((await mayRecord(viewer, f.id)).status, 403);
    const uuid = randomUUID();
    const out = await recordThumb(viewer, f.id, { thumbnailKey: `_thumbs/${uuid}.jpg`, thumbSizes: ['sm'] });
    assert.equal(out.status, 403);
    assert.equal(row(f.id).thumbnailKey, null);
    // Capped to the Viewer role by the platform, whatever the drive says.
    assert.equal((await mayRecord(mac(VR), f.id)).status, 403);
    assert.equal((await mayRecord(mac(ED2), f.id)).status, 204, 'another editor of the drive may');
  });

  test('a token that does not count is refused, and a role without the desktop app too', async () => {
    const f = await upload(mac(ED));
    const revoked = tokenFor(ED);
    globalThis.__mw.tokens.delete(revoked);
    for (const out of [await mayRecord({ token: revoked }, f.id), await recordThumb({ token: revoked }, f.id, {})]) {
      assert.equal(out.status, 401);
    }
    const noDesktop = await mayRecord(mac(ND), f.id);
    assert.equal(noDesktop.status, 403);
    assert.equal(noDesktop.body.error, 'Your role cannot use the desktop app.');
    assert.equal((await mayRecord({}, f.id)).status, 401, 'nor with nothing at all');
  });

  test('the browser’s session still works as it did', async () => {
    const f = await upload(web(ED));
    assert.equal((await mayRecord(web(ED), f.id)).status, 204);
    assert.equal((await mayRecord(web(DV), f.id)).status, 403);
  });
});

describe('a thumbnail’s placeholder', () => {
  // A real 24×18 WebP (test/placeholder.test.js has the rest of what one may be).
  const PH = 'data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA==';
  const recordThumb = (who, id, body) => call(thumbnailRoute.PUT, `/api/files/${id}/thumbnail`, { method: 'PUT', body, params: { id }, ...who });
  const recordPh = (who, id, body) => call(placeholderRoute.PUT, `/api/files/${id}/placeholder`, { method: 'PUT', body, params: { id }, ...who });
  const thumbKey = async (who) => {
    const grid = await presign(who, { thumb: true, sizes: [], contentType: 'image/webp' });
    assert.equal(grid.status, 200, JSON.stringify(grid.body));
    put(grid.body.putUrl, Buffer.alloc(50, 3));
    return grid.body.key;
  };

  test('comes with its thumbnail, and goes when the thumbnail is replaced without one', async () => {
    const who = mac(ED);
    const f = await upload(who, { name: 'A001.mov' });
    const first = await recordThumb(who, f.id, { thumbnailKey: await thumbKey(who), placeholder: PH });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(row(f.id).metadata.placeholder, PH);
    const junk = await recordThumb(who, f.id, { thumbnailKey: await thumbKey(who), placeholder: 'data:image/svg+xml;base64,PHN2Zz4=' });
    assert.equal(junk.status, 200, 'a bad placeholder never costs the thumbnail');
    assert.equal(row(f.id).metadata.placeholder, undefined, 'and the old picture’s does not stay on the new one');
  });

  test('is recorded later for the thumbnail it was drawn from, and only that one', async () => {
    const who = web(ED);
    const f = await upload(who, { name: 'A002.mov' });
    const key = await thumbKey(who);
    assert.equal((await recordThumb(who, f.id, { thumbnailKey: key })).status, 200);
    const before = structuredClone(row(f.id));
    const out = await recordPh(who, f.id, { placeholder: PH, thumbnailKey: key });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).metadata.placeholder, PH);
    assert.ok(row(f.id).seq > before.seq, 'listings and devices pick it up');
    assert.equal(row(f.id).version, before.version, 'not an edit');
    assert.equal((await recordPh(who, f.id, { placeholder: PH, thumbnailKey: await thumbKey(who) })).status, 409, 'another thumbnail’s');
  });

  test('refused: a viewer, nobody, something that is not one, a key that is not a thumbnail’s', async () => {
    const f = await upload(web(ED), { name: 'A003.mov' });
    const key = await thumbKey(web(ED));
    await recordThumb(web(ED), f.id, { thumbnailKey: key });
    assert.equal((await recordPh(web(DV), f.id, { placeholder: PH, thumbnailKey: key })).status, 403);
    assert.equal((await recordPh({}, f.id, { placeholder: 'junk', thumbnailKey: key })).status, 401, 'asked who before what');
    assert.equal((await recordPh(web(ED), f.id, { placeholder: 'junk', thumbnailKey: key })).status, 400);
    assert.equal((await recordPh(web(ED), f.id, { placeholder: PH, thumbnailKey: 'files/A003.mov' })).status, 400);
    assert.equal((await recordPh(web(ED), 'nope', { placeholder: PH, thumbnailKey: key })).status, 404);
    assert.equal(row(f.id).metadata.placeholder, undefined);
  });
});

describe('a sound’s waveform', () => {
  const WAVE = encodeWaveform(Uint8Array.from({ length: 256 }, (_, i) => (i * 7) % 256));
  const mayRecord = (who, id) => call(waveformRoute.GET, `/api/files/${id}/waveform`, { params: { id }, ...who });
  const recordWave = (who, id, body) => call(waveformRoute.PUT, `/api/files/${id}/waveform`, { method: 'PUT', body, params: { id }, ...who });
  const sound = (who, extra = {}) => upload(who, { name: 'Interview take 3.m4a', mime: 'audio/mp4', ...extra });

  test('drawn at upload, it is recorded with the file — for a sound, and only as a waveform', async () => {
    const who = web(ED);
    const p = await presign(who, { filename: 'Take.m4a', contentType: 'audio/mp4', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    put(p.body.putUrl, Buffer.alloc(10, 1));
    const base = { name: p.body.name, url: p.body.publicUrl, size: 10, folder: 'Cuts', storage: 's3', storageKey: p.body.key, filespace: 'd1' };
    const out = await record(who, { ...base, mime: 'audio/mp4', waveform: WAVE, metadata: { waveform: 'x' } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(out.body.file.id).metadata.waveform, WAVE, 'the checked one, not the metadata’s');

    const v = await presign(who, { filename: 'Take.mov', contentType: 'video/quicktime', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    put(v.body.putUrl, Buffer.alloc(10, 1));
    const video = await record(who, { ...base, name: v.body.name, url: v.body.publicUrl, storageKey: v.body.key, mime: 'video/quicktime', waveform: WAVE });
    assert.equal(row(video.body.file.id).metadata.waveform, undefined, 'a video keeps no waveform');

    const w = await presign(who, { filename: 'Bad.m4a', contentType: 'audio/mp4', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    put(w.body.putUrl, Buffer.alloc(10, 1));
    const bad = await record(who, { ...base, name: w.body.name, url: w.body.publicUrl, storageKey: w.body.key, mime: 'audio/mp4', waveform: '1:AAAA' });
    assert.equal(bad.status, 200, 'a bad waveform never fails the upload');
    assert.equal(row(bad.body.file.id).metadata.waveform, undefined);
  });

  test('the Mac asks whether it may, then records one: seq moves, version does not', async () => {
    const who = mac(ED);
    const f = await sound(who);
    const before = structuredClone(row(f.id));
    assert.equal((await mayRecord(who, f.id)).status, 204);
    const out = await recordWave(who, f.id, { waveform: WAVE, contentHash: before.contentHash });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).metadata.waveform, WAVE);
    assert.equal(out.body.file.metadata.waveform, WAVE);
    assert.ok(row(f.id).seq > before.seq, 'every device picks it up');
    assert.equal(row(f.id).version, before.version, 'a waveform is not an edit');
    assert.match(out.body.file.url, /X-Amz-/, 'signed for the answer');
  });

  test('refused: a viewer, a video, something that is not a waveform, contents that changed', async () => {
    const f = await sound(mac(ED));
    assert.equal((await mayRecord(mac(DV), f.id)).status, 403);
    assert.equal((await recordWave(mac(DV), f.id, { waveform: WAVE })).status, 403);
    assert.equal(row(f.id).metadata.waveform, undefined);

    const video = await upload(mac(ED), { name: 'Take 9.mov' });
    assert.equal((await mayRecord(mac(ED), video.id)).status, 400);
    assert.equal((await recordWave(mac(ED), video.id, { waveform: WAVE })).status, 400);

    for (const waveform of [undefined, '', 'nope', '1:AAAA', `2:${WAVE.slice(2)}`, { bars: [1, 2] }]) {
      assert.equal((await recordWave(mac(ED), f.id, { waveform })).status, 400, String(waveform));
    }
    const moved = await recordWave(mac(ED), f.id, { waveform: WAVE, contentHash: 'not-its-hash' });
    assert.equal(moved.status, 409);
    assert.equal(row(f.id).metadata.waveform, undefined);
    assert.equal((await recordWave(mac(ED), 'nope', { waveform: WAVE })).status, 404);
    assert.equal((await recordWave({}, f.id, { waveform: WAVE })).status, 401);
    assert.equal((await recordWave({}, f.id, { waveform: 'junk' })).status, 401, 'asked who it is before what it sent');
  });

  test('new contents take the old shape with them', async () => {
    const f = await sound(mac(ED));
    assert.equal((await recordWave(mac(ED), f.id, { waveform: WAVE })).status, 200);
    const { MEDIA_KEYS } = await import('../lib/media.js');
    assert.ok(MEDIA_KEYS.includes('waveform'), 'cleared with the media facts when contents are replaced');
    const edit = await patchFile(mac(ED), f.id, { metadata: { waveform: '1:zzzz', client: 'Acme' } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(row(f.id).metadata.waveform, WAVE, 'nor can a metadata edit write one');
  });
});

// A browser records an upload without waiting long for its hover-scrub
// sheet (lib/upload-client.js), and attaches the sheet once it is in the
// bucket: PUT /api/files/[id]/filmstrip, with the thumbnail PUT's checks.
describe('a filmstrip attached after its file was recorded', () => {
  const attach = (who, id, body) => call(filmstripRoute.PUT, `/api/files/${id}/filmstrip`, { method: 'PUT', body, params: { id }, ...who });
  const LAYOUT = { frames: 40, columns: 8, tileWidth: 160, tileHeight: 90 };
  /** A sheet in the bucket, at the key the presign route names. */
  const sheet = async (who) => {
    const p = await presign(who, { strip: true, contentType: 'image/webp' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.match(p.body.key, /^_thumbs\/[0-9a-f-]{36}\.strip\.webp$/);
    put(p.body.putUrl, Buffer.alloc(300, 7));
    return p.body.key;
  };

  test('recorded on the file: the key, its layout, seq moved, and nothing else', async () => {
    const who = web(ED);
    const f = await upload(who, { name: 'A001.mov' });
    const before = structuredClone(row(f.id));
    const key = await sheet(who);
    const out = await attach(who, f.id, { filmstripKey: key, filmstrip: LAYOUT });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const r = row(f.id);
    assert.equal(r.filmstripKey, key);
    assert.deepEqual(r.metadata.filmstrip, LAYOUT);
    assert.ok(r.seq > before.seq, 'seq moves: every device picks it up');
    assert.equal(r.version, before.version, 'a preview is not an edit');
    assert.equal(r.updatedAt, before.updatedAt);
    assert.match(out.body.file.filmstripUrl, /^http:\/\/s3\.test\/onyx\/_thumbs\/[0-9a-f-]{36}\.strip\.webp\?.*X-Amz-/, 'signed for the answer');
  });

  test('a new sheet replaces the old, which leaves the bucket once nothing points at it', async () => {
    const who = web(ED);
    const f = await upload(who, { name: 'A002.mov' });
    const first = await sheet(who);
    assert.equal((await attach(who, f.id, { filmstripKey: first, filmstrip: LAYOUT })).status, 200);
    const second = await sheet(who);
    assert.equal((await attach(who, f.id, { filmstripKey: second, filmstrip: LAYOUT })).status, 200);
    assert.equal(row(f.id).filmstripKey, second);
    assert.equal(stored(first), null, 'the replaced sheet is deleted');
    assert.ok(stored(second));
  });

  test('only a filmstrip key, with a layout that places every tile, and never another file’s', async () => {
    const f = await upload(web(ED), { name: 'A003.mov' });
    const theirs = await upload(web(ED2), { name: 'B001.mov' });
    const taken = await sheet(web(ED2));
    assert.equal((await attach(web(ED2), theirs.id, { filmstripKey: taken, filmstrip: LAYOUT })).status, 200);
    const uuid = randomUUID();
    for (const [body, status, why] of [
      [{ filmstripKey: `_thumbs/${uuid}.webp`, filmstrip: LAYOUT }, 400, 'a thumbnail’s key'],
      [{ filmstripKey: f.storageKey, filmstrip: LAYOUT }, 400, 'the file itself'],
      [{ filmstripKey: `_thumbs/${uuid}.strip.webp` }, 400, 'no layout'],
      [{ filmstripKey: `_thumbs/${uuid}.strip.webp`, filmstrip: { ...LAYOUT, columns: 0 } }, 400, 'a layout that places nothing'],
      [{ filmstripKey: `_thumbs/${uuid}.strip.webp`, filmstrip: { ...LAYOUT, tileWidth: 1000 } }, 400, 'a sheet past 4096px'],
      [{ filmstripKey: taken, filmstrip: LAYOUT }, 409, 'another file’s sheet'],
    ]) {
      const out = await attach(web(ED), f.id, body);
      assert.equal(out.status, status, why);
    }
    assert.equal(row(f.id).filmstripKey, null, 'nothing recorded');
    assert.equal(row(theirs.id).filmstripKey, taken, 'theirs as it was');
    const deck = await upload(web(ED), { name: 'Deck.pdf', mime: 'application/pdf' });
    const onDeck = await attach(web(ED), deck.id, { filmstripKey: await sheet(web(ED)), filmstrip: LAYOUT });
    assert.equal(onDeck.status, 400, 'only a video is scrubbed');
    assert.equal(onDeck.body.error, 'Only a video has a filmstrip.');
    assert.equal(row(deck.id).filmstripKey, null);
  });

  test('who may: an editor of the file — not a viewer, the Viewer role, nobody, or anyone for a trashed file', async () => {
    const f = await upload(web(ED), { name: 'A004.mov' });
    const key = await sheet(web(ED));
    const body = { filmstripKey: key, filmstrip: LAYOUT };
    assert.equal((await attach(web(DV), f.id, body)).status, 403, 'a viewer of the drive');
    assert.equal((await attach(web(VR), f.id, body)).status, 403, 'the Viewer role, granted editor');
    assert.equal((await attach({}, f.id, body)).status, 401);
    assert.equal((await attach(web(ED), 'no-such-file', body)).status, 404);
    await trashFile(web(ED), f.id);
    assert.equal((await attach(web(ED), f.id, body)).status, 404, 'in the trash');
    assert.equal(row(f.id).filmstripKey, null);
    assert.equal((await attach(web(ED2), (await upload(web(ED2), { name: 'B002.mov' })).id, body)).status, 200, 'another editor of the drive, on a file of theirs');
  });
});

// A delete answers once the row is trashed; the object follows to the trash
// after it (lib/trash-move.js). What that leaves meanwhile, and after.
describe('a delete answers at once, and its object follows', () => {
  /** Hold every copy until the returned function is called. */
  const holdCopies = () => {
    let release;
    globalThis.__mw.s3.copyGate = new Promise((r) => { release = r; });
    return () => { globalThis.__mw.s3.copyGate = null; release(); };
  };

  test('gone at once, with its object still where it was until the move lands', async () => {
    const who = mac(ED);
    const f = await upload(who);
    const release = holdCopies();
    const out = await trashFile(who, f.id);
    assert.deepEqual(out.body, { ok: true, trashed: true });
    assert.ok(row(f.id).deletedAt, 'trashed before the copy');
    assert.equal(row(f.id).trashKey, null);
    assert.equal((await getFile(who, f.id)).status, 404);
    assert.ok(stored('team/Cuts/Take 1.mov'), 'the object waits at its key meanwhile');
    release();
    await afterResponseSettled();
    assert.equal(row(f.id).trashKey, `_trash/${f.id}/team/Cuts/Take 1.mov`);
    assert.ok(stored(`_trash/${f.id}/team/Cuts/Take 1.mov`) && !stored('team/Cuts/Take 1.mov'));
  });

  test('restored before its object moved: it stays where it was, and the copy made meanwhile goes', async () => {
    const who = mac(ED);
    const f = await upload(who);
    const release = holdCopies();
    await trashFile(who, f.id);
    const back = await restore(mac(BOSS), [f.id]);
    assert.equal(back.status, 200);
    assert.deepEqual(back.body.restored, [{ id: f.id, name: 'Take 1.mov', movedTo: null, restored: true }]);
    release();
    await afterResponseSettled();
    assert.equal(row(f.id).deletedAt, null);
    assert.equal(row(f.id).trashKey, null);
    assert.ok(stored('team/Cuts/Take 1.mov'), 'the live file keeps its object');
    assert.equal(stored(`_trash/${f.id}/team/Cuts/Take 1.mov`), null, 'no copy left in the trash');
  });

  test('a file put back under the name of one deleted keeps it — it used to be refused', async () => {
    const who = mac(ED);
    const f = await upload(who);
    await trashFile(who, f.id);
    await afterResponseSettled();
    const again = await upload(who, { bytes: Buffer.alloc(1000, 2) });
    assert.equal(again.name, 'Take 1.mov');
    assert.equal(again.storageKey, 'team/Cuts/Take 1.mov');
    assert.ok(stored(`_trash/${f.id}/team/Cuts/Take 1.mov`), 'the deleted one waits in the trash');
  });

  test('…even before the deleted one’s object has moved: it moves first (Finder’s Replace)', async () => {
    const who = mac(ED);
    const f = await upload(who);
    // Trashed, its object not moved: as a delete leaves it until its move
    // lands, or for good if that move was cut short.
    Object.assign(row(f.id), { deletedAt: globalThis.__mw.now, trashKey: null });
    const again = await upload(who, { bytes: Buffer.alloc(1000, 2) });
    assert.equal(again.name, 'Take 1.mov', 'not “Take 1 (2).mov”');
    assert.equal(again.storageKey, 'team/Cuts/Take 1.mov');
    assert.equal(row(f.id).trashKey, `_trash/${f.id}/team/Cuts/Take 1.mov`, 'the old one went to the trash first');
    assert.ok(stored(`_trash/${f.id}/team/Cuts/Take 1.mov`));
  });

  test('a restore after that finds its name taken, and comes back beside the new one', async () => {
    const who = mac(ED);
    const f = await upload(who);
    await trashFile(who, f.id);
    await afterResponseSettled();
    const again = await upload(who, { bytes: Buffer.alloc(1000, 2) });
    const back = await restore(mac(BOSS), [f.id]);
    assert.equal(back.status, 200);
    assert.equal(back.body.restored[0].movedTo, 'team/Cuts/Take 1 (2).mov');
    assert.equal(row(again.id).storageKey, 'team/Cuts/Take 1.mov', 'the new file keeps its object');
    assert.ok(stored('team/Cuts/Take 1.mov') && stored('team/Cuts/Take 1 (2).mov'));
  });

  test('a folder’s files are trashed at once, and their objects follow', async () => {
    const who = mac(ED);
    const a = await upload(who, { name: 'A.mov', folder: 'Wrap' });
    const b = await upload(who, { name: 'B.mov', folder: 'Wrap' });
    const release = holdCopies();
    const gone = await folders.remove(who, 'Wrap');
    assert.equal(gone.status, 200);
    assert.equal(gone.body.deleted, 2);
    assert.ok(row(a.id).deletedAt && row(b.id).deletedAt, 'trashed before any copy');
    release();
    await afterResponseSettled();
    assert.ok(stored(`_trash/${a.id}/team/Wrap/A.mov`) && stored(`_trash/${b.id}/team/Wrap/B.mov`));
    assert.ok(!stored('team/Wrap/A.mov') && !stored('team/Wrap/B.mov'));
  });
});

describe('with no All files (the `library` flag, off by default)', () => {
  const listing = (who, query = '') => call(filesRoute.GET, `/api/files${query}`, who);

  test('nothing is uploaded, by anyone, to a place outside every drive', async () => {
    for (const who of [mac(ED), web(ED), web(BOSS)]) {
      const p = await presign(who, { filename: 'a.jpg', contentType: 'image/jpeg', size: 10, folder: 'Cuts' });
      assert.equal(p.status, 400, JSON.stringify(p.body));
      assert.equal(p.body.code, 'drive_required');
      const m = await multipart(who, { action: 'create', filename: 'a.mov', size: 10 });
      assert.equal(m.status, 400);
    }
    const inDrive = await presign(mac(ED), { filename: 'a.jpg', contentType: 'image/jpeg', size: 10, folder: 'Cuts', filespaceId: 'd1' });
    assert.equal(inDrive.status, 200, 'a drive takes it as before');
  });

  test('a listing or a folder tree names a drive', async () => {
    for (const who of [web(ED), web(BOSS)]) {
      const all = await listing(who);
      assert.equal(all.status, 400);
      assert.equal(all.body.code, 'drive_required');
      assert.equal((await folders.list(who, '')).status, 400);
    }
    assert.equal((await listing(web(ED), '?filespace=d1')).status, 200);
    assert.equal((await folders.list(web(ED), 'd1')).status, 200);
  });

  test('no folder is made, moved or removed outside a drive', async () => {
    const who = web(BOSS);
    assert.equal((await folders.create(who, { name: 'Loose' })).status, 400);
    assert.equal((await folders.move(who, { from: 'Archive', to: 'Archive 2' })).status, 400);
    assert.equal((await folders.remove(who, 'Archive', '')).status, 400);
    assert.equal((await folders.create(who, { name: 'Loose', filespaceId: 'd1' })).status, 201);
  });

  test('turned on, All files is back', async () => {
    globalThis.__mw.settings.set('features.flags', { library: true });
    assert.equal((await listing(web(ED))).status, 200);
    assert.equal((await folders.create(web(BOSS), { name: 'Loose' })).status, 201);
  });

  test('with drives off, the library is the only place there is, so it stays', async () => {
    globalThis.__mw.settings.set('features.flags', { filespaces: false });
    assert.equal((await listing(web(ED))).status, 200);
  });
});
