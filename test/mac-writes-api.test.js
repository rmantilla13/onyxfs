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

import { test, describe, beforeEach } from 'node:test';
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
      return { ContentLength: o.size, ETag: `"${o.etag}"` };
    }
    case 'PutObjectCommand': {
      const body = Buffer.from(i.Body ?? '');
      b.objects.set(at(i.Key), { size: body.length, etag: md5(body) });
      return {};
    }
    case 'DeleteObjectCommand': b.objects.delete(at(i.Key)); return {};
    case 'CopyObjectCommand': {
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
const filesRoute = await import('../app/api/files/route.js');
const presignRoute = await import('../app/api/files/presign/route.js');
const multipartRoute = await import('../app/api/files/upload/multipart/route.js');
const fileRoute = await import('../app/api/files/[id]/route.js');
const contentRoute = await import('../app/api/files/[id]/content/route.js');
const foldersRoute = await import('../app/api/files/folders/route.js');
const restoreRoute = await import('../app/api/admin/trash/restore/route.js');

// ── the world ──
const STORAGE = { provider: 's3', bucket: 'onyx', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', endpoint: 'http://s3.test', prefix: 'files' };
const D1 = { id: 'd1', name: 'Team', bucket: 'onyx', prefix: 'team', region: 'us-east-1' };
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
    people: new Map(), invites: new Set(), tokens: new Map(), drives: [D1], grants: new Map(), acl: new Map(),
    files: new Map(), folders: new Map(), uploads: new Map(), uploadKeys: new Map(), transcripts: new Map(),
    audit: [], tombstones: [],
    s3: { objects: new Map(), multipart: new Map(), calls: [] },
  };
  for (const [email, roleId, driveRole] of PEOPLE) {
    globalThis.__mw.people.set(email, { id: randomUUID(), email, roleId, status: 'active', quotaBytes: null, maxUploadBytes: null });
    globalThis.__mw.invites.add(email);
    globalThis.__mw.grants.set(`d1|${email}`, driveRole);
  }
}
beforeEach(reset);

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
const folders = {
  create: (who, body) => call(foldersRoute.POST, '/api/files/folders', { method: 'POST', body, ...who }),
  move: (who, body) => call(foldersRoute.PATCH, '/api/files/folders', { method: 'PATCH', body, ...who }),
  remove: (who, name, filespace = 'd1') => call(foldersRoute.DELETE, `/api/files/folders?name=${encodeURIComponent(name)}&filespace=${filespace}`, { method: 'DELETE', ...who }),
  list: (who, filespace = 'd1') => call(foldersRoute.GET, `/api/files/folders?filespace=${filespace}`, who),
};

/** The Mac's small-file upload: presign, PUT, record. Resolves the new row. */
async function upload(who, { name = 'Take 1.mov', folder = 'Cuts', filespaceId = 'd1', bytes = Buffer.alloc(1000, 1), mime = 'video/quicktime' } = {}) {
  const p = await presign(who, { filename: name, contentType: mime, size: bytes.length, folder, filespaceId: filespaceId || undefined });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  put(p.body.putUrl, bytes);
  const r = await record(who, {
    name: p.body.name, url: p.body.publicUrl, mime, size: bytes.length, folder, storage: 's3', storageKey: p.body.key, filespace: filespaceId || undefined,
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
    '/api/admin/trash/restore',
  ];

  test('with no session and no token, the Mac’s paths are redirected to sign in exactly as before', async () => {
    for (const p of PATHS) assert.ok(redirected(await run(p)), p);
  });

  test('a bearer token takes those paths, and only those, past the gate', async () => {
    for (const p of PATHS) assert.ok(passed(await run(p, { authorization: 'Bearer dt_live_x' })), p);
    for (const p of [
      '/api/files/abc/comments', '/api/files/abc/thumbnail', '/api/files/abc/download', '/api/files/upload',
      '/api/files/config', '/api/admin/people', '/api/admin/trash', '/api/filespaces', '/files/abc', '/admin',
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
    assert.ok(stored(`_trash/${f.id}/team/Selects/Take 2.mov`), 'moved out of the drive');
    assert.ok(!stored('team/Selects/Take 2.mov'));
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
    assert.equal((await swap(who, f.id, { key: p.body.key })).status, 400, 'once');

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
