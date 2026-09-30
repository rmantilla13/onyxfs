// A multipart upload against a REAL S3 API — moto on localhost — through the
// real route (app/api/files/upload/multipart) and, end to end, the browser's
// own uploader (lib/multipart-client.js): the part size a client asks for,
// signed parts that land, an assembled object with the bytes that were sent,
// and a resume that cuts the file by the part size the upload was created
// with rather than by what the browser would ask for now. A mock would agree
// with whatever part arithmetic we wrote; this checks what the bucket holds.
//
// The database is test/fixtures/mac-writes-stubs.mjs's in-memory store, as in
// test/mac-writes-api.test.js, and '@/auth' is whoever the test says has a
// browser session. Start moto with:
//   pip install 'moto[server]' && python -m moto.server -p 5111
// Skipped, not failed, when nothing is listening.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

process.env.ADMIN_EMAILS = 'boss@mp.test';
process.env.SUPER_ADMIN_EMAILS = '';
process.env.AUTH_SECRET = 'multipart-moto-test-secret-0123456789abcdef';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const DB_STUB = new URL('./fixtures/mac-writes-stubs.mjs', import.meta.url).href;
const AUTH_STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__mw?.session || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH_STUB, shortCircuit: true };
    const r = next(specifier, context);
    if (r.url.endsWith('/lib/db.js') && context.parentURL !== DB_STUB) return { url: DB_STUB, shortCircuit: true };
    return r;
  },
});

const ENDPOINT = process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:5111';
const BUCKET = 'onyx-multipart-test';
const MiB = 1024 * 1024;
const STORAGE = { provider: 's3', bucket: BUCKET, accessKeyId: 'test', secretAccessKey: 'test', region: 'us-east-1', endpoint: ENDPOINT, prefix: 'files' };
const D1 = { id: 'd1', name: 'Team', bucket: BUCKET, prefix: 'team', region: 'us-east-1' };
const ED = 'ed@mp.test';

const S3 = await import('@aws-sdk/client-s3');
const bucket = new S3.S3Client({
  region: 'us-east-1', endpoint: ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  requestHandler: { requestTimeout: 3000, connectionTimeout: 1500 },
  maxAttempts: 1,
});
let live = false;
try {
  await bucket.send(new S3.CreateBucketCommand({ Bucket: BUCKET }));
  live = true;
} catch (e) {
  live = /BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(`${e?.name} ${e?.Code} ${e?.message}`);
}
const skip = !live && `no S3 API at ${ENDPOINT} (moto)`;

const multipartRoute = await import('../app/api/files/upload/multipart/route.js');
const { uploadFileMultipart, partSizeHint } = await import('../lib/multipart-client.js');

function reset() {
  globalThis.__mw = {
    now: Date.now(), seq: 100, session: { user: { email: ED } },
    settings: new Map([['storage.config', STORAGE], ['roles.config', { version: 2, defaultRole: 'member', roles: [], assignments: {} }]]),
    people: new Map([[ED, { id: randomUUID(), email: ED, roleId: 'member', status: 'active', quotaBytes: null, maxUploadBytes: null }]]),
    invites: new Set([ED]), tokens: new Map(), drives: [D1], grants: new Map([[`d1|${ED}`, 'editor']]), acl: new Map(),
    files: new Map(), folders: new Map(), uploads: new Map(), uploadKeys: new Map(), transcripts: new Map(),
    audit: [], tombstones: [], s3: { objects: new Map(), multipart: new Map(), calls: [] },
  };
}

async function multipart(body) {
  const res = await multipartRoute.POST(new Request('http://app.test/api/files/upload/multipart', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** A browser's PUT of one part to its presigned URL. */
async function putPart(url, bytes) {
  const res = await realFetch(url, { method: 'PUT', body: bytes });
  assert.equal(res.status, 200, await res.text());
  return res.headers.get('etag');
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function stored(key) {
  const head = await bucket.send(new S3.HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  const got = await bucket.send(new S3.GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { size: Number(head.ContentLength), etag: String(head.ETag).replace(/"/g, ''), sha: sha(Buffer.from(await got.Body.transformToByteArray())) };
}

// The browser, for lib/multipart-client.js: fetch() of the route in-process,
// and an XMLHttpRequest whose PUT goes to the bucket for real.
const realFetch = globalThis.fetch;
const sent = [];
class BucketXHR {
  constructor() { this.upload = {}; this.headers = {}; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  getResponseHeader(k) { return this.res?.headers.get(k) ?? null; }
  abort() { this.stop?.abort(); }
  send(body) {
    this.stop = new AbortController();
    (async () => {
      const bytes = Buffer.from(await body.arrayBuffer());
      sent.push({ url: this.url, size: bytes.length });
      this.res = await realFetch(this.url, { method: this.method, headers: this.headers, body: bytes, signal: this.stop.signal });
      this.status = this.res.status;
      this.responseText = await this.res.text();
      if (this.res.ok) this.upload.onprogress?.({ lengthComputable: true, loaded: bytes.length, total: bytes.length });
      this.onload?.();
    })().catch((e) => (e?.name === 'AbortError' ? this.onabort?.() : this.onerror?.()));
  }
}
const routeCalls = [];
async function browserFetch(url, init = {}) {
  if (typeof url === 'string' && url.startsWith('/api/files/upload/multipart')) {
    routeCalls.push(JSON.parse(init.body || '{}'));
    return multipartRoute.POST(new Request(`http://app.test${url}`, init));
  }
  return realFetch(url, init);
}

const made = [];
describe('multipart upload against a real S3 API', { skip }, () => {
  before(() => {
    globalThis.fetch = browserFetch;
    globalThis.XMLHttpRequest = BucketXHR;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    delete globalThis.XMLHttpRequest;
    for (const Key of made) await bucket.send(new S3.DeleteObjectCommand({ Bucket: BUCKET, Key })).catch(() => {});
    bucket.destroy();
  });
  beforeEach(() => {
    reset();
    sent.length = 0;
    routeCalls.length = 0;
  });

  test('the part size asked for is used, kept with the upload, and the parts assemble', async () => {
    const name = `Master-${randomUUID().slice(0, 8)}.mov`;
    const size = 20 * MiB + 123;
    const bytes = randomBytes(size);
    const c = await multipart({ action: 'create', filename: name, size, mime: 'video/quicktime', folder: 'Cuts', filespaceId: 'd1', partSize: 12 * MiB });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.key, `team/Cuts/${name}`);
    assert.deepEqual([c.body.partSize, c.body.partCount], [12 * MiB, 2]);
    made.push(c.body.key);
    const signed = await multipart({ action: 'sign', id: c.body.id, partNumbers: [1, 2] });
    assert.equal(signed.body.parts.length, 2, 'both in one call');
    for (const { partNumber, url } of signed.body.parts) {
      await putPart(url, bytes.subarray((partNumber - 1) * 12 * MiB, partNumber * 12 * MiB));
    }
    const status = await multipart({ action: 'status', id: c.body.id });
    assert.equal(status.body.upload.partSize, 12 * MiB, 'stored with the upload');
    assert.deepEqual(status.body.parts.map((p) => p.size), [12 * MiB, 8 * MiB + 123]);
    assert.equal(status.body.uploaded, size);
    const done = await multipart({ action: 'complete', id: c.body.id });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const obj = await stored(c.body.key);
    assert.equal(obj.size, size);
    assert.match(obj.etag, /-2$/, 'assembled from two parts');
    assert.equal(obj.sha, sha(bytes), 'the bytes that were sent');
  });

  test('a size outside the limits is moved inside them, not refused', async () => {
    const size = 20 * MiB;
    for (const [asked, want] of [[MiB, 8 * MiB], ['abc', 8 * MiB], [undefined, 8 * MiB], [6 * 1024 * MiB, 5 * 1024 * MiB]]) {
      const c = await multipart({ action: 'create', filename: `odd-${randomUUID().slice(0, 8)}.bin`, size, folder: 'Cuts', filespaceId: 'd1', partSize: asked });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.equal(c.body.partSize, want, String(asked));
      assert.equal((await multipart({ action: 'status', id: c.body.id })).body.upload.partSize, want);
      assert.equal((await multipart({ action: 'abort', id: c.body.id })).status, 200);
    }
  });

  test('the browser’s uploader, end to end: the parts it asks for land and assemble', async () => {
    const size = 20 * MiB + 5;
    const bytes = randomBytes(size);
    const file = Object.assign(new Blob([bytes]), { name: `Take-${randomUUID().slice(0, 8)}.mov` });
    const progress = [];
    const out = await uploadFileMultipart(file, { folder: 'Cuts', filespaceId: 'd1', onProgress: (p) => progress.push(p.uploaded) });
    made.push(out.key);
    const create = routeCalls.find((c) => c.action === 'create');
    assert.equal(create.partSize, partSizeHint(size));
    assert.equal(routeCalls.filter((c) => c.action === 'sign').length, 1, 'three parts, one sign call');
    assert.deepEqual(sent.map((s) => s.size).sort((a, b) => a - b), [4 * MiB + 5, 8 * MiB, 8 * MiB]);
    assert.equal(progress.at(-1), size);
    const obj = await stored(out.key);
    assert.equal(obj.size, size);
    assert.match(obj.etag, /-3$/);
    assert.equal(obj.sha, sha(bytes));
  });

  test('a resume cuts the file as it was cut at create, and sends only what is missing', async () => {
    const size = 20 * MiB + 77;
    const bytes = randomBytes(size);
    const name = `Resumed-${randomUUID().slice(0, 8)}.mov`;
    // Started with 12 MiB parts — not what the browser asks for a file this
    // size (8 MiB) — and one part landed before the page went away.
    const c = await multipart({ action: 'create', filename: name, size, folder: 'Cuts', filespaceId: 'd1', partSize: 12 * MiB });
    made.push(c.body.key);
    const [first] = (await multipart({ action: 'sign', id: c.body.id, partNumbers: [1] })).body.parts;
    await putPart(first.url, bytes.subarray(0, 12 * MiB));

    const file = Object.assign(new Blob([bytes]), { name });
    const out = await uploadFileMultipart(file, { resumeId: c.body.id });
    assert.equal(routeCalls.some((call) => call.action === 'create'), false);
    assert.deepEqual(sent.map((s) => s.size), [8 * MiB + 77], 'only part 2, cut at 12 MiB');
    assert.equal(out.key, c.body.key);
    const obj = await stored(out.key);
    assert.equal(obj.size, size);
    assert.match(obj.etag, /-2$/);
    assert.equal(obj.sha, sha(bytes));
  });
});
