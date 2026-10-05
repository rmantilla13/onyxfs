// Admin → Usage's "Move into a drive…" (GET/POST /api/admin/library/move),
// run for real with no database and no bucket, as test/mac-writes-api.test.js
// runs the Mac's writes: lib/db.js resolves to the in-memory store in
// test/fixtures/mac-writes-stubs.mjs, and the bucket is the S3 client's
// send(), replaced below, so lib/storage.js — key naming, s3UniqueKey,
// copies, HEADs, folder markers — is the code that runs in production, and
// where each object lands is checked, not assumed. requireAdmin, the session,
// readGlobalFlags and the route are the real code.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

process.env.ADMIN_EMAILS = 'boss@lm.test';
process.env.SUPER_ADMIN_EMAILS = '';
process.env.AUTH_SECRET = 'library-move-test-secret-0123456789abcdef';
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

// ── the bucket: objects by `<bucket>/<key>` ──
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
      // A test failing HEADs (b.failHead) sees what a throttled or broken bucket leaves;
      // one watching them (b.onHead) can act between a look and what follows it; one
      // holding them (b.holdHead) lets other work run after the bucket has answered
      // and before the caller hears it.
      if (b.failHead?.(i.Key)) throw Object.assign(new Error('SlowDown'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });
      b.onHead?.(i.Key);
      const o = b.objects.get(at(i.Key));
      await b.holdHead?.(i.Key);
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
      if (b.failCopy?.(i.Key)) throw Object.assign(new Error('InternalError'), { name: 'InternalError' });
      const o = b.objects.get(decodeURIComponent(String(i.CopySource).replace(/^\//, '')));
      if (!o) throw missing('NoSuchKey');
      b.objects.set(at(i.Key), { ...o });
      b.copies.push(at(i.Key));
      // One watching them (b.onCopy) can act once a copy has landed.
      b.onCopy?.(i.Key);
      return {};
    }
    case 'ListObjectsV2Command': {
      const pre = at(i.Prefix || '');
      b.lists.push(i.Prefix || '');
      const keys = [...b.objects.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(i.Bucket.length + 1));
      if (!i.Delimiter) return { Contents: keys.map((k) => ({ Key: k, Size: b.objects.get(`${i.Bucket}/${k}`).size })), IsTruncated: false };
      // With a delimiter, one level: what is at it, and the folders below it once each.
      const p = i.Prefix || '';
      const here = keys.filter((k) => !k.slice(p.length).includes('/') || k === p);
      const below = [...new Set(keys.map((k) => k.slice(p.length)).filter((r) => r.includes('/')).map((r) => `${p}${r.slice(0, r.indexOf('/') + 1)}`))];
      return { Contents: here.map((k) => ({ Key: k })), CommonPrefixes: below.filter((c) => c !== p).map((Prefix) => ({ Prefix })), IsTruncated: false };
    }
    // A copy in parts: b.multipart is UploadId → `<bucket>/<key>`, b.parted what each copies,
    // b.begun when each began (none for one a test put there), b.parts its parts.
    case 'CreateMultipartUploadCommand': {
      const id = randomUUID();
      (b.multipart ||= new Map()).set(id, at(i.Key));
      (b.begun ||= new Map()).set(id, Date.now());
      return { UploadId: id };
    }
    case 'UploadPartCopyCommand': {
      (b.parted ||= new Map()).set(i.UploadId, decodeURIComponent(String(i.CopySource).replace(/^\//, '')));
      const [first, last] = String(i.CopySourceRange).replace('bytes=', '').split('-').map(Number);
      const parts = (b.parts ||= new Map()).get(i.UploadId) || new Map();
      parts.set(i.PartNumber, { ETag: `"${md5(String(i.PartNumber))}"`, Size: last - first + 1 });
      b.parts.set(i.UploadId, parts);
      return { CopyPartResult: { ETag: `"${md5(String(i.PartNumber))}"` } };
    }
    case 'ListPartsCommand': {
      const parts = [...(b.parts?.get(i.UploadId) || new Map())].sort(([x], [y]) => x - y);
      return { Parts: parts.map(([PartNumber, p]) => ({ PartNumber, ...p })), IsTruncated: false };
    }
    case 'CompleteMultipartUploadCommand': {
      const o = b.objects.get(b.parted?.get(i.UploadId));
      if (!o || b.multipart?.get(i.UploadId) !== at(i.Key)) throw missing('NoSuchUpload');
      b.objects.set(at(i.Key), { ...o });
      b.copies.push(at(i.Key));
      b.multipart.delete(i.UploadId);
      return {};
    }
    case 'ListMultipartUploadsCommand': {
      const Uploads = [...(b.multipart || new Map())].filter(([, k]) => k.startsWith(at(i.Prefix || ''))).map(([UploadId, k]) => ({
        UploadId, Key: k.slice(i.Bucket.length + 1), ...(b.begun?.has(UploadId) && { Initiated: new Date(b.begun.get(UploadId)) }),
      }));
      return { Uploads, IsTruncated: false };
    }
    case 'AbortMultipartUploadCommand': b.multipart?.delete(i.UploadId); return {};
    default: throw new Error(`unexpected ${cmd.constructor.name}`);
  }
};

const store = await import(DB_STUB);
const moveRoute = await import('../app/api/admin/library/move/route.js');
const presignRoute = await import('../app/api/files/presign/route.js');
const foldersRoute = await import('../app/api/files/folders/route.js');
const { _setFolderMoveBudgetMs } = await import('../lib/folder-ops.js');
const { MOVE_HOLDER } = await import('../lib/library-move.js');

// ── the world ──
const STORAGE = { provider: 's3', bucket: 'onyx', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', endpoint: 'http://s3.test', prefix: 'files' };
const D1 = { id: 'd1', name: 'Team', bucket: 'onyx', prefix: 'team', region: 'us-east-1' };
const D2 = { id: 'd2', name: 'Studio', bucket: 'onyx', prefix: 'studio', region: 'us-east-1' };
// A bucket of its own, reached by the Storage keys.
const D3 = { id: 'd3', name: 'Vault', bucket: 'vault', prefix: 'archive', region: 'us-east-1' };
// A bucket of its own with keys of its own, on another service.
const D4 = { id: 'd4', name: 'Client', bucket: 'client', prefix: 'client', region: 'auto', endpoint: 'https://r2.example', accessKeyId: 'ck', secretAccessKey: 'cs' };
const BOSS = 'boss@lm.test'; // ADMIN_EMAILS
const ED = 'ed@lm.test'; // a Member, editor of Team

function reset() {
  globalThis.__mw = {
    now: Date.now(), seq: 100, session: null,
    settings: new Map([['storage.config', STORAGE]]),
    people: new Map(), invites: new Set(), tokens: new Map(), drives: [D1, D2, D3, D4], grants: new Map([['d1|' + ED, 'editor']]), acl: new Map(),
    files: new Map(), folders: new Map(), uploads: new Map(), uploadKeys: new Map(), transcripts: new Map(),
    audit: [], tombstones: [], stars: [], shares: new Map(), collections: [],
    s3: { objects: new Map(), calls: [], copies: [], lists: [] },
  };
  for (const email of [BOSS, ED]) {
    globalThis.__mw.people.set(email, { id: randomUUID(), email, roleId: 'member', status: 'active', quotaBytes: null, maxUploadBytes: null });
    globalThis.__mw.invites.add(email);
  }
}
beforeEach(reset);
afterEach(() => _setFolderMoveBudgetMs());

async function call(handler, method, { body, cookie } = {}) {
  globalThis.__mw.session = cookie ? { user: { email: cookie } } : null;
  const res = await handler(new Request('http://app.test/api/admin/library/move', {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
}
const look = (who = BOSS) => call(moveRoute.GET, 'GET', { cookie: who });
const move = (body, who = BOSS) => call(moveRoute.POST, 'POST', { body, cookie: who });
/** Another route, as `who` signed in on the web. */
async function as(who, handler, path, method, body) {
  globalThis.__mw.session = { user: { email: who } };
  const res = await handler(new Request(`http://app.test${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** Until the bucket has been asked to copy (b.copyGate holding it there). */
async function copying() {
  while (!globalThis.__mw.s3.calls.includes('CopyObjectCommand')) await new Promise((r) => setTimeout(r, 1));
}
/** Hold every copy until the returned function is called. */
function holdCopies() {
  let open;
  globalThis.__mw.s3.copyGate = new Promise((r) => { open = r; });
  return () => { globalThis.__mw.s3.copyGate = null; open(); };
}
/** Calls until the move answers anything but 202 `more`, carrying `after` along. → { last, calls, moved } */
async function moveAll(body) {
  let after = '';
  let moved = 0;
  for (let calls = 1; calls < 100; calls++) {
    const r = await move({ ...body, after });
    if (r.status !== 202) return { last: r, calls, moved: moved + (r.body?.moved || 0) };
    assert.equal(r.body.more, true);
    moved += r.body.moved;
    after = r.body.after;
  }
  throw new Error('the move never finished');
}

const obj = (bucket, key) => globalThis.__mw.s3.objects.get(`${bucket}/${key}`) || null;
const stored = (key) => obj('onyx', key);
/** A file stored at `key` in the Storage bucket, and its row: outside every drive unless the key is in one. */
async function file(key, { name = key.slice(key.lastIndexOf('/') + 1), folder = '', bytes = `bytes of ${key}`, ...more } = {}) {
  const body = Buffer.from(bytes);
  globalThis.__mw.s3.objects.set(`onyx/${key}`, { size: body.length, etag: md5(body) });
  return store.createFile({ name, folder, size: body.length, storage: 's3', storageKey: key, url: `http://s3.test/onyx/${key}`, createdBy: ED, ...more });
}
const row = (id) => globalThis.__mw.files.get(id);
const underPrefix = (bucket, prefix) => [...globalThis.__mw.s3.objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}/`)).map((k) => k.slice(bucket.length + 1)).sort();
const rowsIn = (tag) => [...globalThis.__mw.folders.values()].filter((r) => r.tag === tag).sort((a, b) => (a.name < b.name ? -1 : 1));

describe('who may move them', () => {
  test('only an admin: a member is refused, and someone signed out', async () => {
    await file('files/a.jpg');
    for (const who of [ED, null]) {
      const got = await look(who);
      const sent = await move({ driveId: 'd1' }, who);
      assert.equal(got.status, who ? 403 : 401);
      assert.equal(sent.status, who ? 403 : 401);
    }
    assert.equal(row([...globalThis.__mw.files.keys()][0]).storageKey, 'files/a.jpg', 'nothing moved');
    assert.deepEqual(globalThis.__mw.s3.copies, []);
  });
});

describe('what is outside every drive', () => {
  test('GET counts it as Usage does, says how much the move takes, and which drives can take it', async () => {
    await file('files/a.jpg', { bytes: 'aaaa' });
    await file('files/Shoot/b.jpg', { folder: 'Shoot', bytes: 'bbbbbb' });
    await file('team/in-a-drive.jpg', { bytes: 'not counted' });
    // Outside every drive, and not the move's: a Blob file, a preview, the OS's junk.
    await store.createFile({ name: 'old.jpg', size: 3, storage: 'blob', url: 'https://blob.test/old.jpg' });
    await file('_thumbs/abc.webp', { bytes: 't' });
    await file('files/.DS_Store', { bytes: 'j' });

    const r = await look();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual({ files: r.body.files, bytes: r.body.bytes }, { files: 5, bytes: 4 + 6 + 3 + 1 + 1 });
    assert.deepEqual(r.body.movable, { files: 2, bytes: 10 });
    assert.equal(r.body.problem, null);
    assert.deepEqual(r.body.drives.map((d) => [d.name, !!d.problem]), [['Client', true], ['Studio', false], ['Team', false], ['Vault', false]]);
    assert.deepEqual(r.body.drives.map((d) => d.warning), [null, null, null, null]);
    assert.equal(r.body.run, null);
    assert.ok(!JSON.stringify(r.body).includes('cs'), 'no drive’s secret');
  });
});

describe('a run', () => {
  test('moves every file under the drive’s prefix, keeping its folders, and leaves nothing at the old keys', async () => {
    const a = await file('files/a.jpg');
    const b = await file('files/Shoot/Day 1/b.mov', { folder: 'Shoot/Day 1' });
    // A file from a drive since deleted: outside every drive, under no prefix of the library's.
    const c = await file('gone-drive/Shoot/c.jpg', { folder: 'Shoot' });
    const seq = { a: row(a.id).seq, b: row(b.id).seq, c: row(c.id).seq };

    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.moved, 3);
    assert.equal(out.body.left, 0);
    assert.equal(row(a.id).storageKey, 'team/a.jpg');
    assert.deepEqual([row(b.id).storageKey, row(b.id).folder], ['team/Shoot/Day 1/b.mov', 'Shoot/Day 1']);
    assert.deepEqual([row(c.id).storageKey, row(c.id).folder], ['team/Shoot/c.jpg', 'Shoot']);
    for (const f of [a, b, c]) {
      assert.ok(row(f.id).seq > seq[f.id === a.id ? 'a' : f.id === b.id ? 'b' : 'c'], 'seq moved, so devices see it go');
      assert.equal(row(f.id).version, 2);
      assert.equal(row(f.id).url, `http://s3.test/onyx/${row(f.id).storageKey}`);
      assert.equal(stored(row(f.id).storageKey).etag, md5(Buffer.from(`bytes of ${f.storageKey}`)), 'the same bytes');
    }
    assert.deepEqual(underPrefix('onyx', 'files'), [], 'nothing at the old keys');
    assert.equal(stored('gone-drive/Shoot/c.jpg'), null);
    assert.deepEqual([...(globalThis.__mw.moveCopies || new Map()).keys()], [], 'and no notes left');
    assert.equal((await look()).body.files, 0);
    assert.equal(globalThis.__mw.audit.at(-1).action, 'library.move');
  });

  test('into a folder of the drive: each file keeps its own folders inside it', async () => {
    const b = await file('files/Shoot/b.jpg', { folder: 'Shoot' });
    const top = await file('files/top.jpg');
    const out = await move({ driveId: 'd1', folder: 'From the library/' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([row(b.id).storageKey, row(b.id).folder], ['team/From the library/Shoot/b.jpg', 'From the library/Shoot']);
    assert.deepEqual([row(top.id).storageKey, row(top.id).folder], ['team/From the library/top.jpg', 'From the library']);
    assert.deepEqual(rowsIn('team').map((r) => r.name), ['From the library'], 'the folder it went into is there');
  });

  test('a name already taken in the drive gets the next free name, and what was there is left alone', async () => {
    const theirs = await file('team/Shoot/b.jpg', { folder: 'Shoot', bytes: 'the drive’s own' });
    const mine = await file('files/Shoot/b.jpg', { folder: 'Shoot', bytes: 'the library’s' });
    // A key handed to an upload still in flight is taken too.
    await store.issueUploadKey('team/Shoot/b (2).jpg', ED, { bucket: 'onyx' });
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([row(mine.id).storageKey, row(mine.id).name], ['team/Shoot/b (3).jpg', 'b (3).jpg']);
    assert.equal(stored('team/Shoot/b (3).jpg').etag, md5(Buffer.from('the library’s')));
    assert.equal(stored('team/Shoot/b.jpg').etag, md5(Buffer.from('the drive’s own')));
    assert.equal(row(theirs.id).storageKey, 'team/Shoot/b.jpg');
    assert.ok(globalThis.__mw.uploadKeys.has(`team/Shoot/b (2).jpg|${ED}`), 'the upload keeps its key');
    assert.ok(![...globalThis.__mw.uploadKeys.keys()].some((k) => k.startsWith('team/Shoot/b (3).jpg')), 'and the move gives its own back');
  });

  test('a file whose name the bucket would not take as it is keeps it, with the suffix where the key has one', async () => {
    await file('team/Caf_.jpg');
    const f = await file('files/Café.jpg', { name: 'Café.jpg' });
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.deepEqual([row(f.id).storageKey, row(f.id).name], ['team/Caf_ (2).jpg', 'Café (2).jpg']);
  });

  test('files already in drives, and what is not a file, are not touched', async () => {
    const inTeam = await file('team/x.jpg');
    const inStudio = await file('studio/Cuts/y.mov', { folder: 'Cuts' });
    const thumb = await file('_thumbs/abc.webp');
    const junk = await file('files/.DS_Store');
    const trashed = await file('files/old.jpg');
    Object.assign(row(trashed.id), { deletedAt: Date.now(), trashKey: '_trash/x/files/old.jpg' });
    const blob = await store.createFile({ name: 'b.jpg', storage: 'blob', url: 'https://blob.test/b.jpg' });
    const before = new Map([inTeam, inStudio, thumb, junk, trashed, blob].map((f) => [f.id, { ...row(f.id) }]));
    const loose = await file('files/a.jpg');

    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.moved, 1);
    assert.equal(row(loose.id).storageKey, 'team/a.jpg');
    for (const [id, was] of before) assert.deepEqual(row(id), was, `${was.storageKey || was.url} as it was`);
    assert.ok(stored('_thumbs/abc.webp') && stored('files/.DS_Store') && stored('files/old.jpg'));
  });

  test('a file two rows share is copied for each, and the original goes only once neither holds it', async () => {
    const one = await file('files/shared.jpg', { name: 'one.jpg', bytes: 'shared' });
    const two = await store.createFile({ name: 'two.jpg', size: 6, storage: 's3', storageKey: 'files/shared.jpg' });
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([row(one.id).storageKey, row(two.id).storageKey].sort(), ['team/one.jpg', 'team/two.jpg']);
    for (const k of ['team/one.jpg', 'team/two.jpg']) assert.equal(stored(k).etag, md5(Buffer.from('shared')));
    assert.equal(stored('files/shared.jpg'), null);
  });

  test('a file trashed while its copy is made stays as it is, and the copy goes', async () => {
    const f = await file('files/a.jpg');
    let open;
    globalThis.__mw.s3.copyGate = new Promise((r) => { open = r; });
    const running = move({ driveId: 'd1' });
    while (!globalThis.__mw.s3.calls.includes('CopyObjectCommand')) await new Promise((r) => setTimeout(r, 1));
    Object.assign(row(f.id), { deletedAt: Date.now() });
    globalThis.__mw.s3.copyGate = null;
    open();
    const out = await running;
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([out.body.moved, out.body.skipped], [0, 1]);
    assert.equal(row(f.id).storageKey, 'files/a.jpg');
    assert.ok(stored('files/a.jpg'), 'its object is where the trash will look for it');
    assert.deepEqual(underPrefix('onyx', 'team'), [], 'the copy is gone');
  });

  test('a copy that fails is counted, the rest go on, and the next run moves it', async () => {
    const a = await file('files/a.jpg');
    const b = await file('files/b.jpg');
    globalThis.__mw.s3.failCopy = (key) => key === 'team/a.jpg';
    const first = await move({ driveId: 'd1' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.moved, first.body.failed, first.body.left], [1, 1, 1]);
    assert.match(first.body.error, /InternalError/);
    assert.equal(row(a.id).storageKey, 'files/a.jpg');
    assert.equal(row(b.id).storageKey, 'team/b.jpg');
    globalThis.__mw.s3.failCopy = null;
    const again = await move({ driveId: 'd1' });
    assert.deepEqual([again.status, again.body.moved, again.body.left], [200, 1, 0]);
    assert.equal(row(a.id).storageKey, 'team/a.jpg');
  });
});

describe('stopping and carrying on', () => {
  const copies = () => globalThis.__mw.s3.calls.filter((c) => c === 'CopyObjectCommand').length;

  test('cut off by the time limit, each call answers 202 and the next carries on: every file moved exactly once', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await file(`files/Shoot/${i}.jpg`, { folder: 'Shoot' }));
    _setFolderMoveBudgetMs(0); // one file a call
    const first = await move({ driveId: 'd1' });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.deepEqual([first.body.more, first.body.moved, first.body.left], [true, 1, 4]);
    assert.ok(first.body.after);

    const rest = await moveAll({ driveId: 'd1' });
    assert.equal(rest.last.status, 200, JSON.stringify(rest.last.body));
    assert.equal(1 + rest.moved, 5);
    assert.equal(copies(), 5, 'one copy each, none made twice');
    assert.deepEqual(underPrefix('onyx', 'team'), made.map((_, i) => `team/Shoot/${i}.jpg`).sort());
    assert.deepEqual(underPrefix('onyx', 'files'), []);
    for (const f of made) assert.equal(row(f.id).storageKey, `team/${f.storageKey.slice('files/'.length)}`);
  });

  test('stopped after the copy and before the row, the next call uses the copy rather than making another', async () => {
    const f = await file('files/Shoot/a.jpg', { folder: 'Shoot' });
    // What the call left: its note, and its copy.
    globalThis.__mw.moveCopies = new Map([['team/Shoot/a.jpg', 'files/Shoot/a.jpg']]);
    globalThis.__mw.s3.objects.set('onyx/team/Shoot/a.jpg', { ...stored('files/Shoot/a.jpg') });
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).storageKey, 'team/Shoot/a.jpg', 'not “a (2).jpg”');
    assert.equal(copies(), 0);
    assert.deepEqual(underPrefix('onyx', 'team'), ['team/Shoot/a.jpg']);
    assert.equal(stored('files/Shoot/a.jpg'), null);
  });

  test('stopped after its key was spoken for and before the copy, the next call keeps the name', async () => {
    const f = await file('files/a.jpg');
    globalThis.__mw.moveCopies = new Map([['team/a.jpg', 'files/a.jpg']]);
    await store.issueUploadKey('team/a.jpg', MOVE_HOLDER, { bucket: 'onyx' });
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.equal(row(f.id).storageKey, 'team/a.jpg', 'not “a (2).jpg”');
    assert.deepEqual([...globalThis.__mw.uploadKeys.keys()], [], 'and the key is given back');
  });

  test('what is at a noted key and is not a copy of the original is never written over: the file takes the next name', async () => {
    const f = await file('files/a.jpg', { bytes: 'new bytes' });
    globalThis.__mw.moveCopies = new Map([['team/a.jpg', 'files/a.jpg']]);
    // A copy of bytes the original has since been rewritten from, or a
    // mounted drive's file of that name written since: it cannot be told which.
    globalThis.__mw.s3.objects.set('onyx/team/a.jpg', { size: 3, etag: md5(Buffer.from('old')) });
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.equal(row(f.id).storageKey, 'team/a (2).jpg');
    assert.equal(stored('team/a (2).jpg').etag, md5(Buffer.from('new bytes')));
    assert.equal(stored('team/a.jpg').etag, md5(Buffer.from('old')), 'left as it is');
    assert.deepEqual([...globalThis.__mw.moveCopies.keys()], [], 'and the note forgotten');
  });

  test('a noted copy of a file renamed since is not carried on from, which would undo the rename', async () => {
    const f = await file('files/new.jpg', { bytes: 'same bytes' });
    // An earlier call copied it as "old.jpg", then the row was renamed without its object moving.
    globalThis.__mw.moveCopies = new Map([['team/old.jpg', 'files/new.jpg']]);
    globalThis.__mw.s3.objects.set('onyx/team/old.jpg', { ...stored('files/new.jpg') });
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.deepEqual([row(f.id).storageKey, row(f.id).name], ['team/new.jpg', 'new.jpg']);
    assert.equal(stored('team/old.jpg'), null, 'the copy at the old name is gone');
  });

  test('stopped after the row and before the original went, the next call deletes the original', async () => {
    const f = await file('files/a.jpg');
    // What the call left: the row moved, the original and the note still there.
    globalThis.__mw.s3.objects.set('onyx/team/a.jpg', { ...stored('files/a.jpg') });
    Object.assign(row(f.id), { storageKey: 'team/a.jpg' });
    globalThis.__mw.moveCopies = new Map([['team/a.jpg', 'files/a.jpg']]);
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(stored('files/a.jpg'), null);
    assert.ok(stored('team/a.jpg'));
    assert.deepEqual([...globalThis.__mw.moveCopies.keys()], []);
  });

  test('a noted key whose file has gone is tidied only while it holds the move’s copy: a file written there since stays', async () => {
    const g = globalThis.__mw;
    // Neither original is any file's now; both objects are still in the bucket.
    g.s3.objects.set('onyx/files/x.jpg', { size: 4, etag: md5(Buffer.from('orig')) });
    g.s3.objects.set('onyx/files/y.jpg', { size: 4, etag: md5(Buffer.from('ours')) });
    g.s3.objects.set('onyx/team/x.jpg', { size: 5, etag: md5(Buffer.from('mount')) }); // a mounted drive's, written since
    g.s3.objects.set('onyx/team/y.jpg', { size: 4, etag: md5(Buffer.from('ours')) }); // the move's copy
    g.moveCopies = new Map([['team/x.jpg', 'files/x.jpg'], ['team/y.jpg', 'files/y.jpg']]);
    await file('files/a.jpg');
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.equal(stored('team/x.jpg').etag, md5(Buffer.from('mount')), 'never the move’s to delete');
    assert.equal(stored('team/y.jpg'), null);
    assert.deepEqual([...g.moveCopies.keys()], [], 'both notes forgotten');
  });

  test('a noted copy whose file has gone since is deleted; one of a file still held elsewhere is left be', async () => {
    globalThis.__mw.s3.objects.set('onyx/team/orphan.jpg', { size: 1, etag: md5(Buffer.from('o')) });
    const kept = await file('files/kept.jpg');
    Object.assign(row(kept.id), { deletedAt: Date.now(), trashKey: null }); // trashed, its object not yet moved aside
    globalThis.__mw.s3.objects.set('onyx/team/kept.jpg', { ...stored('files/kept.jpg') });
    globalThis.__mw.moveCopies = new Map([['team/orphan.jpg', 'files/orphan.jpg'], ['team/kept.jpg', 'files/kept.jpg']]);
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.equal(stored('team/orphan.jpg'), null);
    assert.ok(stored('files/kept.jpg'), 'the trashed file’s object waits at its key');
  });

  test('two rows sharing an original carry on from their own copies: neither tidies away the other’s', async () => {
    const g = globalThis.__mw;
    const a = await file('files/shared.jpg', { name: 'a.jpg', bytes: 'shared' });
    const b = await store.createFile({ name: 'b.jpg', size: 6, storage: 's3', storageKey: 'files/shared.jpg' });
    // An earlier call, cut off, left a noted copy for each.
    g.moveCopies = new Map([['team/a.jpg', 'files/shared.jpg'], ['team/b.jpg', 'files/shared.jpg']]);
    for (const k of ['team/a.jpg', 'team/b.jpg']) g.s3.objects.set(`onyx/${k}`, { ...stored('files/shared.jpg') });
    // b has been told its copy is there; before it hears so, a moves and tidies what it may.
    let held = false;
    g.s3.holdHead = async (key) => {
      if (key !== 'team/b.jpg' || held) return;
      held = true;
      while (row(a.id).storageKey !== 'team/a.jpg') await new Promise((r) => setTimeout(r, 1));
      for (let i = 0; i < 50 && stored('team/b.jpg'); i++) await new Promise((r) => setTimeout(r, 1));
    };
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([out.body.moved, out.body.error], [2, null]);
    assert.ok(held, 'b carried on from its copy');
    assert.deepEqual([row(a.id).storageKey, row(b.id).storageKey], ['team/a.jpg', 'team/b.jpg']);
    for (const k of ['team/a.jpg', 'team/b.jpg']) assert.equal(stored(k)?.etag, md5(Buffer.from('shared')), `${k} is there`);
    assert.equal(stored('files/shared.jpg'), null, 'the original goes once neither holds it');
    assert.equal(g.s3.copies.length, 0, 'no copy made again');
    assert.deepEqual([...g.moveCopies.keys()], []);
  });

  test('a copy made for a row still at a shared original stays until that row has moved, and goes then', async () => {
    const g = globalThis.__mw;
    const a = await file('files/shared.jpg', { name: 'a.jpg', bytes: 'shared' });
    const b = await store.createFile({ name: 'b.jpg', size: 6, storage: 's3', storageKey: 'files/shared.jpg', visibility: 'owner' });
    // An earlier run into Studio copied b there and was cut off; a call of it
    // that lost its lease could still point b at that copy.
    g.moveCopies = new Map([['studio/b.jpg', 'files/shared.jpg']]);
    g.s3.objects.set('onyx/studio/b.jpg', { ...stored('files/shared.jpg') });
    const first = await move({ driveId: 'd1' });
    assert.deepEqual([first.status, first.body.moved, first.body.stays], [200, 1, 1], JSON.stringify(first.body));
    assert.equal(row(a.id).storageKey, 'team/a.jpg');
    assert.ok(stored('studio/b.jpg'), 'b’s copy stays while b is at the original');
    assert.ok(stored('files/shared.jpg'));
    assert.equal(g.moveCopies.get('studio/b.jpg'), 'files/shared.jpg');

    const second = await move({ driveId: 'd1', private: true });
    assert.deepEqual([second.status, second.body.moved], [200, 1], JSON.stringify(second.body));
    assert.equal(row(b.id).storageKey, 'team/b.jpg');
    assert.deepEqual(underPrefix('onyx', 'studio'), [], 'and goes once b has moved');
    assert.equal(stored('files/shared.jpg'), null);
    assert.deepEqual([...g.moveCopies.keys()], []);
  });
});

describe('what follows the files', () => {
  test('the library’s folders, with their tags and metadata; where the drive has one already, its own win', async () => {
    const g = globalThis.__mw;
    const lib = (name, extra = {}) => g.folders.set(`\u0000${name}`, { tag: '', name, ...extra });
    lib('Shoot', { tags: ['spring'], metadata: { client: 'Acme', season: 'Spring' } });
    lib('Shoot/Day 1');
    lib('Empty', { tags: ['keep'] });
    g.folders.set('team\u0000Shoot', { tag: 'team', name: 'Shoot', tags: ['team'], metadata: { client: 'Ours' } });
    g.folders.set('studio\u0000Empty', { tag: 'studio', name: 'Empty' });
    await file('files/Shoot/Day 1/a.jpg', { folder: 'Shoot/Day 1' });

    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.folders, 3);
    assert.deepEqual(rowsIn(''), [], 'none left in the library');
    assert.deepEqual(rowsIn('team'), [
      { tag: 'team', name: 'Empty', tags: ['keep'] },
      { tag: 'team', name: 'Shoot', tags: ['spring', 'team'], metadata: { client: 'Ours', season: 'Spring' } },
      { tag: 'team', name: 'Shoot/Day 1' },
    ]);
    assert.deepEqual(rowsIn('studio'), [{ tag: 'studio', name: 'Empty' }], 'another drive’s folder of that name is its own');
  });

  test('under a folder, with its parents; links, stars and collections come along', async () => {
    const g = globalThis.__mw;
    g.folders.set('\u0000Shoot', { tag: '', name: 'Shoot' });
    g.shares.set('lib-link', { token: 'lib-link', kind: 'folder', folder: 'Shoot', storage_prefix: null, mode: 'public' });
    g.shares.set('drive-link', { token: 'drive-link', kind: 'folder', folder: 'Selects', storage_prefix: 'studio', mode: 'public' });
    g.stars.push({ owner: ED, driveId: '', folder: 'Shoot' }, { owner: BOSS, driveId: '', folder: 'Shoot' });
    g.stars.push({ owner: BOSS, driveId: 'd1', folder: '2025/Shoot' }); // already starred there
    g.collections.push(
      { id: 'c1', driveId: '', name: 'Selects' },
      { id: 'c2', driveId: 'd1', name: 'selects' },
      { id: 'c3', driveId: 'd2', name: 'Other' },
    );
    await file('files/Shoot/a.jpg', { folder: 'Shoot' });

    const out = await move({ driveId: 'd1', folder: '2025' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(rowsIn('team').map((r) => r.name), ['2025', '2025/Shoot']);
    assert.deepEqual([g.shares.get('lib-link').storage_prefix, g.shares.get('lib-link').folder], ['team', '2025/Shoot']);
    assert.deepEqual([g.shares.get('drive-link').storage_prefix, g.shares.get('drive-link').folder], ['studio', 'Selects']);
    assert.deepEqual(g.stars.map((s) => [s.owner, s.driveId, s.folder]).sort(), [
      [BOSS, 'd1', '2025/Shoot'],
      [ED, 'd1', '2025/Shoot'],
    ]);
    assert.deepEqual(g.collections.map((c) => [c.id, c.driveId, c.name]), [['c1', 'd1', 'Selects (2)'], ['c2', 'd1', 'selects'], ['c3', 'd2', 'Other']]);
    assert.equal(out.body.collections, 1);
  });

  test('a collection moved out of All files meanwhile (from the sidebar) stays where it went', async () => {
    const g = globalThis.__mw;
    g.collections.push({ id: 'c1', driveId: '', name: 'Selects' }, { id: 'c2', driveId: '', name: 'Picks' });
    // c1 is moved into the other drive as the run gets to the collections.
    g.beforeMove = () => { g.collections[0].driveId = 'd2'; delete g.beforeMove; };
    await file('files/a.jpg');
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(g.collections.map((c) => [c.id, c.driveId]), [['c1', 'd2'], ['c2', 'd1']]);
    assert.equal(out.body.collections, 1, 'only the one it moved is counted');
  });

  test('empty folders’ markers move with them', async () => {
    globalThis.__mw.s3.objects.set('onyx/files/Empty/', { size: 0, etag: md5(Buffer.alloc(0)) });
    globalThis.__mw.s3.objects.set('onyx/team/Kept/', { size: 0, etag: md5(Buffer.alloc(0)) });
    await file('files/a.jpg');
    assert.equal((await move({ driveId: 'd1', folder: 'Old' })).status, 200);
    assert.equal(stored('files/Empty/'), null);
    assert.ok(stored('team/Old/Empty/'));
    assert.ok(stored('team/Kept/'), 'the drive’s own stay');
  });
});

describe('where the bytes can go', () => {
  test('a drive in a bucket of its own, reached by the same keys, is copied into bucket to bucket', async () => {
    const f = await file('files/Shoot/a.jpg', { folder: 'Shoot' });
    const out = await move({ driveId: 'd3' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).storageKey, 'archive/Shoot/a.jpg');
    assert.equal(obj('vault', 'archive/Shoot/a.jpg').etag, md5(Buffer.from('bytes of files/Shoot/a.jpg')));
    assert.equal(stored('files/Shoot/a.jpg'), null);
    assert.equal(stored('archive/Shoot/a.jpg'), null, 'not in the Storage bucket');
  });

  test('one in another region says so before anything moves, and is still copied into', async () => {
    globalThis.__mw.drives.push({ id: 'd7', name: 'Europe', bucket: 'eu-files', prefix: 'eu', region: 'eu-west-1' });
    const f = await file('files/a.jpg');
    const got = await look();
    assert.match(got.body.drives.find((d) => d.id === 'd7').warning, /“Europe” keeps its files in a bucket in eu-west-1, and these are in us-east-1/);
    assert.equal((await move({ driveId: 'd7' })).status, 200);
    assert.equal(row(f.id).storageKey, 'eu/a.jpg');
    assert.ok(obj('eu-files', 'eu/a.jpg'));
  });

  test('a drive with keys of its own elsewhere is refused, with why, and nothing moves', async () => {
    const f = await file('files/a.jpg');
    const out = await move({ driveId: 'd4' });
    assert.equal(out.status, 409);
    assert.match(out.body.error, /“Client” keeps its files in a bucket of its own, with keys of its own/);
    assert.equal(row(f.id).storageKey, 'files/a.jpg');
    assert.deepEqual(globalThis.__mw.s3.copies, []);
  });

  test('no drive, a drive that is not there, a bad folder, or drives turned off: refused', async () => {
    await file('files/a.jpg');
    assert.equal((await move({})).status, 400);
    assert.equal((await move({ driveId: 'nope' })).status, 404);
    assert.equal((await move({ driveId: 'd1', folder: 'a/_thumbs' })).status, 400);
    globalThis.__mw.settings.set('features.flags', { filespaces: false });
    const off = await move({ driveId: 'd1' });
    assert.deepEqual([off.status, off.body.error], [409, 'Drives are turned off, so there is no drive to move files into.']);
    assert.equal((await look()).body.problem, 'Drives are turned off, so there is no drive to move files into.');
    assert.deepEqual(globalThis.__mw.s3.copies, []);
  });
});

describe('one call at a time', () => {
  test('a second call while one is copying is refused; two names that make one key each land, with their own bytes', async () => {
    // "Café" and "Cafè" are both "Caf_" to the bucket (safeObjectName).
    const one = await file('files/Café.jpg', { name: 'Café.jpg', bytes: 'eleven byte' });
    const two = await file('files/Cafè.jpg', { name: 'Cafè.jpg', bytes: 'seven b' });
    const release = holdCopies();
    const first = move({ driveId: 'd1' });
    await copying();
    const second = await move({ driveId: 'd1', folder: 'Imports' });
    assert.deepEqual([second.status, second.body.code], [409, 'busy']);
    release();
    const out = await first;
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.moved, 2);
    assert.deepEqual([row(one.id).storageKey, row(two.id).storageKey].sort(), ['team/Caf_ (2).jpg', 'team/Caf_.jpg']);
    assert.equal(stored(row(one.id).storageKey).etag, md5(Buffer.from('eleven byte')));
    assert.equal(stored(row(two.id).storageKey).etag, md5(Buffer.from('seven b')));
    assert.deepEqual(underPrefix('onyx', 'files'), []);
    const again = await move({ driveId: 'd1', folder: 'Imports' });
    assert.deepEqual([again.status, again.body.moved], [200, 0], 'once the first has answered, the next may run');
  });

  test('a lease a cut-off call left is taken once it has run out, and not before; each call gives its own back', async () => {
    await file('files/a.jpg');
    const g = globalThis.__mw;
    g.settings.set('library.move', { call: 'gone', by: BOSS, until: g.now + 60_000 });
    const held = await move({ driveId: 'd1' });
    assert.deepEqual([held.status, held.body.code], [409, 'busy']);
    assert.deepEqual(g.s3.copies, []);
    g.settings.set('library.move', { call: 'gone', by: BOSS, until: g.now - 1 });
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(g.settings.get('library.move').until, 0);
  });

  test('an upload by the admin running the move, to the same name in the same folder, is given the next name', async () => {
    const f = await file('files/a.jpg');
    const release = holdCopies();
    const running = move({ driveId: 'd1' });
    await copying();
    const p = await as(BOSS, presignRoute.POST, '/api/files/presign', 'POST', { filename: 'a.jpg', contentType: 'image/jpeg', size: 5, folder: '', filespaceId: 'd1' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.key, 'team/a (2).jpg');
    release();
    const out = await running;
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).storageKey, 'team/a.jpg');
    assert.ok(globalThis.__mw.uploadKeys.has(`team/a (2).jpg|${BOSS}`), 'the upload keeps its key');
  });

  test('a noted key someone has been handed since is given up for the next name', async () => {
    const f = await file('files/a.jpg');
    globalThis.__mw.moveCopies = new Map([['team/a.jpg', 'files/a.jpg']]);
    await store.issueUploadKey('team/a.jpg', BOSS, { bucket: 'onyx' });
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.equal(row(f.id).storageKey, 'team/a (2).jpg');
    assert.ok(globalThis.__mw.uploadKeys.has(`team/a.jpg|${BOSS}`));
  });

  test('a move that notes a key while a rename onto it is looking is not written over', async () => {
    const g = globalThis.__mw;
    await file('team/A/x.jpg', { folder: 'A' });
    // Between the rename's first look at its notes and its own: the move notes the key.
    g.s3.onHead = (key) => { if (key === 'team/B/x.jpg') (g.moveCopies ||= new Map()).set(key, 'files/B/x.jpg'); };
    const r = await as(ED, foldersRoute.PATCH, '/api/files/folders', 'PATCH', { from: 'A', to: 'B', filespaceId: 'd1', resumable: true });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /stopped part-way/);
    assert.equal(g.moveCopies.get('team/B/x.jpg'), 'files/B/x.jpg', 'the move’s note is its own still');
    assert.equal(stored('team/B/x.jpg'), null, 'nothing copied there');
  });

  test('a folder rename in the drive onto keys the move has noted waits for it', async () => {
    await file('team/A/x.jpg', { folder: 'A' });
    globalThis.__mw.moveCopies = new Map([['team/B/x.jpg', 'files/B/x.jpg']]);
    const r = await as(ED, foldersRoute.PATCH, '/api/files/folders', 'PATCH', { from: 'A', to: 'B', filespaceId: 'd1', resumable: true });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /being moved into “B”/);
    assert.ok(stored('team/A/x.jpg'));
    assert.equal(stored('team/B/x.jpg'), null);
  });

  test('a move that finishes a file at a key while a rename onto it is looking is not written over', async () => {
    const g = globalThis.__mw;
    const mine = await file('team/A/x.jpg', { folder: 'A', bytes: 'drive bytes' });
    const loose = await file('files/B/x.jpg', { folder: 'B', bytes: 'library bytes' });
    // The rename has asked the bucket and been told nothing is there; before it
    // hears so, a whole move runs: noted, copied, re-keyed, original gone, note forgotten.
    let moving = null;
    g.s3.holdHead = async (key) => {
      if (key !== 'team/B/x.jpg' || moving) return;
      moving = move({ driveId: 'd1' });
      await moving;
    };
    const r = await as(ED, foldersRoute.PATCH, '/api/files/folders', 'PATCH', { from: 'A', to: 'B', filespaceId: 'd1', resumable: true });
    const moved = await moving;
    assert.deepEqual([moved.status, moved.body.moved], [200, 1], JSON.stringify(moved.body));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /already stored at team\/B\/x\.jpg/);
    assert.equal(row(loose.id).storageKey, 'team/B/x.jpg');
    assert.equal(stored('team/B/x.jpg').etag, md5(Buffer.from('library bytes')), 'the moved file keeps its bytes');
    assert.deepEqual([row(mine.id).storageKey, row(mine.id).folder], ['team/A/x.jpg', 'A']);
    assert.equal(stored('team/A/x.jpg').etag, md5(Buffer.from('drive bytes')));
    assert.equal(g.moveCopies.has('team/B/x.jpg'), false, 'the rename’s note on it is forgotten');
  });

  test('a file that comes to a new key while a rename copies is never pointed at twice: nothing is renamed', async () => {
    const g = globalThis.__mw;
    const mine = await file('team/A/x.jpg', { folder: 'A', bytes: 'drive bytes' });
    let other = null;
    // Once the rename's copy has landed, something else records a file at that key
    // (an upload, a file moved there) before the catalog moves.
    g.s3.onCopy = (key) => {
      if (key !== 'team/B/x.jpg' || other) return;
      g.s3.objects.set('onyx/team/B/x.jpg', { size: 12, etag: md5(Buffer.from('upload bytes')) });
      other = store.createFile({ name: 'x.jpg', folder: 'Elsewhere', size: 12, storage: 's3', storageKey: 'team/B/x.jpg' });
    };
    const r = await as(ED, foldersRoute.PATCH, '/api/files/folders', 'PATCH', { from: 'A', to: 'B', filespaceId: 'd1' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /already stored at team\/B\/x\.jpg.*Nothing was renamed/);
    assert.deepEqual([row(mine.id).storageKey, row(mine.id).folder], ['team/A/x.jpg', 'A']);
    assert.equal(stored('team/A/x.jpg').etag, md5(Buffer.from('drive bytes')));
    assert.equal(row((await other).id).storageKey, 'team/B/x.jpg');
    assert.equal(stored('team/B/x.jpg').etag, md5(Buffer.from('upload bytes')), 'what that file holds is not undone');
    assert.deepEqual([...g.moveCopies.keys()], []);
  });
});

describe('what is left part-way, and what the bucket says', () => {
  test('a copy an earlier run made into another drive goes once the file has moved', async () => {
    const f = await file('files/a.jpg');
    globalThis.__mw.moveCopies = new Map([['studio/a.jpg', 'files/a.jpg']]);
    globalThis.__mw.s3.objects.set('onyx/studio/a.jpg', { ...stored('files/a.jpg') });
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).storageKey, 'team/a.jpg');
    assert.deepEqual(underPrefix('onyx', 'studio'), []);
    assert.deepEqual([...globalThis.__mw.moveCopies.keys()], []);
  });

  test('a key the bucket could not be asked about is not taken for free: the file waits for the next run', async () => {
    // A mounted drive's object the catalog does not know of yet.
    globalThis.__mw.s3.objects.set('onyx/team/a.jpg', { size: 5, etag: md5(Buffer.from('mount')) });
    const f = await file('files/a.jpg');
    globalThis.__mw.s3.failHead = (key) => key === 'team/a.jpg';
    const first = await move({ driveId: 'd1' });
    assert.deepEqual([first.status, first.body.failed, first.body.moved], [200, 1, 0]);
    assert.equal(stored('team/a.jpg').etag, md5(Buffer.from('mount')), 'not written over');
    assert.equal(row(f.id).storageKey, 'files/a.jpg');
    globalThis.__mw.s3.failHead = null;
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.equal(row(f.id).storageKey, 'team/a (2).jpg');
  });

  test('a copy in parts cut off part-way: its open parts are aborted, and it is made again', async () => {
    const f = await file('files/big.mov', { size: 6 * 1024 ** 3 });
    globalThis.__mw.moveCopies = new Map([['team/big.mov', 'files/big.mov']]);
    globalThis.__mw.s3.multipart = new Map([['cut-off', 'onyx/team/big.mov']]);
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).storageKey, 'team/big.mov');
    assert.ok(globalThis.__mw.s3.calls.includes('AbortMultipartUploadCommand'));
    assert.deepEqual([...globalThis.__mw.s3.multipart.keys()], [], 'none left open');
    assert.equal(stored('team/big.mov').etag, md5(Buffer.from('bytes of files/big.mov')));
    assert.equal(stored('files/big.mov'), null);
  });
});

describe('private files', () => {
  test('stay outside unless the admin says to move them, counted apart, and keep their folder meanwhile', async () => {
    const g = globalThis.__mw;
    g.folders.set('\u0000Shoot', { tag: '', name: 'Shoot', tags: ['spring'] });
    const open = await file('files/Shoot/open.jpg', { folder: 'Shoot' });
    const mine = await file('files/mine.jpg', { visibility: 'owner' });
    const theirs = await file('files/Shoot/theirs.jpg', { folder: 'Shoot', visibility: 'custom' });
    const got = await look();
    assert.deepEqual([got.body.movable.files, got.body.private.files], [1, 2]);

    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([out.body.moved, out.body.left, out.body.stays], [1, 0, 2]);
    assert.equal(row(open.id).storageKey, 'team/Shoot/open.jpg');
    assert.deepEqual([row(mine.id).storageKey, row(theirs.id).storageKey], ['files/mine.jpg', 'files/Shoot/theirs.jpg']);
    assert.deepEqual(rowsIn('').map((r) => [r.name, r.tags]), [['Shoot', ['spring']]], 'the private file keeps its folder');
    assert.deepEqual(rowsIn('team').map((r) => [r.name, r.tags]), [['Shoot', ['spring']]], 'and so does the file that moved');
    assert.equal(g.audit.at(-1).detail.private, false);
    assert.equal(g.audit.at(-1).detail.stays, 2);

    const all = await move({ driveId: 'd1', private: true });
    assert.deepEqual([all.status, all.body.moved, all.body.stays], [200, 2, 0]);
    assert.deepEqual([row(mine.id).storageKey, row(theirs.id).storageKey], ['team/mine.jpg', 'team/Shoot/theirs.jpg']);
    assert.deepEqual(rowsIn(''), [], 'once nothing is left in it, the folder follows');
    assert.deepEqual(rowsIn('team').map((r) => [r.name, r.tags]), [['Shoot', ['spring']]]);
    assert.equal(g.audit.at(-1).detail.private, true, 'the choice that opened them to the drive is on record');
  });
});

describe('one destination a run', () => {
  test('a run stopped part-way carries on only where it was going, until it has finished', async () => {
    _setFolderMoveBudgetMs(0); // a file a call
    const a = await file('files/Shoot/a.jpg', { folder: 'Shoot' });
    const b = await file('files/Shoot/b.jpg', { folder: 'Shoot' });
    const first = await move({ driveId: 'd1' });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    // The dialog closed and opened again, and another folder chosen.
    assert.deepEqual((await look()).body.run, { driveId: 'd1', folder: '' });
    for (const elsewhere of [{ driveId: 'd1', folder: 'Archive' }, { driveId: 'd2' }]) {
      const r = await move(elsewhere);
      assert.deepEqual([r.status, r.body.code, r.body.run], [409, 'elsewhere', { driveId: 'd1', folder: '' }], JSON.stringify(r.body));
      assert.match(r.body.error, /A move into “Team” stopped part-way/);
    }
    const rest = await moveAll({ driveId: 'd1' });
    assert.equal(rest.last.status, 200, JSON.stringify(rest.last.body));
    assert.deepEqual([row(a.id).storageKey, row(b.id).storageKey], ['team/Shoot/a.jpg', 'team/Shoot/b.jpg']);
    assert.equal((await look()).body.run, null);
    await file('files/c.jpg');
    const next = await move({ driveId: 'd1', folder: 'Archive' });
    assert.equal(next.status, 200, 'once it has finished, the next goes anywhere');
  });

  test('a run whose drive has gone since leaves the next free to go elsewhere', async () => {
    _setFolderMoveBudgetMs(0);
    await file('files/a.jpg');
    await file('files/b.jpg');
    globalThis.__mw.drives.push({ id: 'd9', name: 'Temp', bucket: 'onyx', prefix: 'temp', region: 'us-east-1' });
    assert.equal((await move({ driveId: 'd9' })).status, 202);
    globalThis.__mw.drives.pop();
    const r = await moveAll({ driveId: 'd1' });
    assert.equal(r.last.status, 200, JSON.stringify(r.last.body));
  });

  test('the run keeps a fingerprint of each link it will carry, never the link’s token', async () => {
    _setFolderMoveBudgetMs(0);
    const g = globalThis.__mw;
    g.shares.set('the-secret-token', { token: 'the-secret-token', kind: 'folder', folder: 'Fresh', storage_prefix: null, mode: 'public' });
    await file('files/Fresh/a.jpg', { folder: 'Fresh' });
    await file('files/Fresh/b.jpg', { folder: 'Fresh' });
    assert.equal((await move({ driveId: 'd1' })).status, 202);
    const kept = JSON.stringify(g.settings.get('library.move'));
    assert.ok(!kept.includes('the-secret-token'), kept);
    assert.equal(g.settings.get('library.move').run.carry.length, 1);
    const done = await moveAll({ driveId: 'd1' });
    assert.equal(done.last.body.links, 1);
    assert.equal(g.shares.get('the-secret-token').storage_prefix, 'team');
    assert.equal(g.settings.get('library.move').run, undefined, 'and forgets it when the run ends');
  });
});

describe('a video past what one copy takes', () => {
  const GiB = 1024 ** 3;
  const calls = (name) => globalThis.__mw.s3.calls.filter((c) => c === name).length;

  /** The row of `f` under the id `id`: files are taken in id order, and the store's ids are random. */
  function withId(f, id) {
    const g = globalThis.__mw;
    const r = g.files.get(f.id);
    g.files.delete(f.id);
    g.files.set(id, Object.assign(r, { id }));
    return r;
  }

  test('is copied in parts over as many calls as it takes, none made twice, and lands once', async () => {
    const f = withId(await file('files/big.mov', { size: 6 * GiB }), '00000000-big');
    // 6 GiB in the bucket: twelve parts of 512 MiB, written a minute ago.
    Object.assign(stored('files/big.mov'), { size: 6 * GiB, modified: Date.now() - 60_000 });
    const after = withId(await file('files/zz.jpg'), 'ffffffff-after');
    _setFolderMoveBudgetMs(0); // the parts at once, then the time is up
    const first = await move({ driveId: 'd1' });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(row(f.id).storageKey, 'files/big.mov', 'not yet');
    assert.equal(calls('UploadPartCopyCommand'), 8);
    assert.ok(globalThis.__mw.uploadKeys.has(`team/big.mov|${MOVE_HOLDER}`), 'its key held between calls');
    assert.equal(row(after.id).storageKey, 'files/zz.jpg', 'what follows it waits for it');

    const rest = await moveAll({ driveId: 'd1' });
    assert.equal(rest.last.status, 200, JSON.stringify(rest.last.body));
    assert.equal(calls('CreateMultipartUploadCommand'), 1, 'carried on, not begun again');
    assert.equal(calls('UploadPartCopyCommand'), 12, 'each part once');
    assert.equal(row(f.id).storageKey, 'team/big.mov');
    assert.equal(stored('team/big.mov').size, 6 * GiB);
    assert.equal(stored('files/big.mov'), null);
    assert.equal(row(after.id).storageKey, 'team/zz.jpg');
    assert.deepEqual([...globalThis.__mw.s3.multipart.keys()], [], 'none left open');
    assert.deepEqual([...globalThis.__mw.uploadKeys.keys()], []);
  });

  test('parts of an original written since they began are not carried on from', async () => {
    const f = await file('files/big.mov', { size: 6 * GiB });
    Object.assign(stored('files/big.mov'), { size: 6 * GiB, modified: Date.now() + 60_000 });
    globalThis.__mw.moveCopies = new Map([['team/big.mov', 'files/big.mov']]);
    globalThis.__mw.s3.multipart = new Map([['stale', 'onyx/team/big.mov']]);
    globalThis.__mw.s3.begun = new Map([['stale', Date.now()]]);
    const out = await moveAll({ driveId: 'd1' });
    assert.equal(out.last.status, 200, JSON.stringify(out.last.body));
    assert.ok(!globalThis.__mw.s3.multipart.has('stale'), 'aborted');
    assert.equal(calls('UploadPartCopyCommand'), 12);
    assert.equal(row(f.id).storageKey, 'team/big.mov');
  });
});

describe('a drive inside the one chosen', () => {
  const ACME = { id: 'd5', name: 'Acme', bucket: 'onyx', prefix: 'team/Clients/Acme', region: 'us-east-1' };

  test('a file that would land inside it stays outside, saying where; the rest move, and the folders wait', async () => {
    globalThis.__mw.drives.push(ACME);
    globalThis.__mw.folders.set('\u0000Clients/Acme', { tag: '', name: 'Clients/Acme', tags: ['acme'] });
    globalThis.__mw.s3.objects.set('onyx/files/Clients/Acme/Empty/', { size: 0, etag: md5(Buffer.alloc(0)) });
    const plan = await file('files/Clients/Acme/plan.pdf', { folder: 'Clients/Acme' });
    const other = await file('files/Clients/other.pdf', { folder: 'Clients' });
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([out.body.moved, out.body.blocked, out.body.folders], [1, 1, 0]);
    assert.match(out.body.error, /inside “Acme”/);
    assert.equal(row(plan.id).storageKey, 'files/Clients/Acme/plan.pdf');
    assert.equal(row(other.id).storageKey, 'team/Clients/other.pdf');
    assert.deepEqual(underPrefix('onyx', 'team/Clients/Acme'), []);
    assert.deepEqual(rowsIn('').map((r) => r.name), ['Clients/Acme']);
  });

  test('a folder inside it is refused before anything moves', async () => {
    globalThis.__mw.drives.push(ACME);
    await file('files/a.jpg');
    const out = await move({ driveId: 'd1', folder: 'Clients/Acme/In' });
    assert.equal(out.status, 409);
    assert.match(out.body.error, /inside the drive “Acme”/);
    assert.deepEqual(globalThis.__mw.s3.copies, []);
  });
});

describe('the folders, once every file is in', () => {
  test('a folder still holding a file that could not be moved is copied: both keep its tags, and it moves with the last of them', async () => {
    globalThis.__mw.folders.set('\u0000Shoot', { tag: '', name: 'Shoot', tags: ['spring'] });
    await file('files/Shoot/a.jpg', { folder: 'Shoot' });
    const b = await file('files/Shoot/b.jpg', { folder: 'Shoot' });
    globalThis.__mw.s3.failCopy = (key) => key === 'team/Shoot/a.jpg';
    const first = await move({ driveId: 'd1' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.moved, first.body.failed, first.body.left, first.body.copied], [1, 1, 1, 1]);
    assert.match(first.body.error, /“a\.jpg” \(InternalError\)/, 'the file named');
    assert.equal(row(b.id).storageKey, 'team/Shoot/b.jpg');
    assert.deepEqual(rowsIn('').map((r) => [r.name, r.tags]), [['Shoot', ['spring']]], 'the library keeps it');
    assert.deepEqual(rowsIn('team').map((r) => [r.name, r.tags]), [['Shoot', ['spring']]], 'and the drive has it');
    assert.equal((await look()).body.run, null, 'the run has ended');
    globalThis.__mw.s3.failCopy = null;
    const again = await move({ driveId: 'd1' });
    assert.deepEqual([again.status, again.body.moved, again.body.folders, again.body.copied], [200, 1, 1, 0]);
    assert.deepEqual(rowsIn(''), []);
    assert.deepEqual(rowsIn('team').map((r) => [r.name, r.tags]), [['Shoot', ['spring']]]);
  });

  test('a file with nothing stored to move is named, stays, and holds nothing up', async () => {
    const g = globalThis.__mw;
    g.folders.set('\u0000Shoot', { tag: '', name: 'Shoot', tags: ['spring'] });
    const a = await file('files/Shoot/a.jpg', { folder: 'Shoot' });
    // Gone from the bucket outside the app, and one of a drive since deleted
    // whose own bucket kept it: neither is in the Storage bucket.
    const gone = await file('files/Shoot/gone.jpg', { folder: 'Shoot' });
    g.s3.objects.delete('onyx/files/Shoot/gone.jpg');
    const vaulted = await file('old-drive/Shoot/v.jpg', { folder: 'Shoot' });
    g.s3.objects.set('vault/old-drive/Shoot/v.jpg', g.s3.objects.get('onyx/old-drive/Shoot/v.jpg'));
    g.s3.objects.delete('onyx/old-drive/Shoot/v.jpg');
    for (let n = 0; n < 2; n++) {
      const out = await move({ driveId: 'd1' });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual([out.body.moved, out.body.missing, out.body.failed, out.body.left], [n ? 0 : 1, 2, 0, 2]);
      assert.deepEqual(out.body.missingNames.sort(), ['gone.jpg', 'v.jpg']);
      assert.equal(out.body.error, null);
    }
    assert.equal(row(a.id).storageKey, 'team/Shoot/a.jpg');
    assert.deepEqual([row(gone.id).storageKey, row(vaulted.id).storageKey], ['files/Shoot/gone.jpg', 'old-drive/Shoot/v.jpg']);
    assert.deepEqual(underPrefix('onyx', 'team'), ['team/Shoot/a.jpg'], 'nothing half-made for them');
    assert.deepEqual(rowsIn('').map((r) => r.name), ['Shoot'], 'their folder stays with them');
    assert.deepEqual(rowsIn('team').map((r) => [r.name, r.tags]), [['Shoot', ['spring']]], 'and the moved file has its tags');
    assert.deepEqual([...(g.moveCopies || new Map()).keys()], []);
    assert.deepEqual([...g.uploadKeys.keys()], []);
  });

  test('a folder the library stored decomposed lands where its files did, composed, with its tags and its twin’s', async () => {
    const NFD = 'Café';
    const NFC = 'Café';
    const g = globalThis.__mw;
    g.folders.set(`\u0000${NFD}`, { tag: '', name: NFD, tags: ['paris'] });
    g.folders.set(`\u0000${NFC}`, { tag: '', name: NFC, tags: ['lyon'], metadata: { city: 'Lyon' } });
    const f = await file(`files/${NFD}/a.jpg`, { folder: NFD });
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(row(f.id).folder, NFC);
    assert.deepEqual(rowsIn(''), []);
    assert.deepEqual(rowsIn('team'), [{ tag: 'team', name: NFC, tags: ['paris', 'lyon'], metadata: { city: 'Lyon' } }]);
  });

  test('a link follows its folder only where the drive had no folder of that name: it never opens the drive’s own files', async () => {
    const g = globalThis.__mw;
    _setFolderMoveBudgetMs(0); // a file a call: what the first decided holds for the rest
    await file('team/Shoot/secret.jpg', { folder: 'Shoot', bytes: 'the drive’s own' });
    await file('files/Shoot/a.jpg', { folder: 'Shoot' });
    await file('files/Fresh/b.jpg', { folder: 'Fresh' });
    g.shares.set('shoot', { token: 'shoot', kind: 'folder', folder: 'Shoot', storage_prefix: null, mode: 'public' });
    g.shares.set('fresh', { token: 'fresh', kind: 'folder', folder: 'Fresh', storage_prefix: null, mode: 'public' });
    const done = await moveAll({ driveId: 'd1' });
    assert.equal(done.last.status, 200, JSON.stringify(done.last.body));
    assert.equal(done.moved, 2);
    assert.deepEqual([done.last.body.links, done.last.body.linksLeft], [1, 1]);
    assert.deepEqual([g.shares.get('fresh').storage_prefix, g.shares.get('fresh').folder], ['team', 'Fresh']);
    assert.deepEqual([g.shares.get('shoot').storage_prefix, g.shares.get('shoot').folder], [null, 'Shoot'], 'left with the library');
  });

  test('empty folders’ markers are found a level at a time, never reading inside a drive', async () => {
    const g = globalThis.__mw;
    // A drive under the library's own prefix: its objects are its own, and not listed.
    g.drives.push({ id: 'd6', name: 'Marketing', bucket: 'onyx', prefix: 'files/Marketing', region: 'us-east-1' });
    for (let i = 0; i < 3; i++) g.s3.objects.set(`onyx/files/Marketing/deep/${i}.jpg`, { size: 1, etag: md5(Buffer.from(String(i))) });
    g.s3.objects.set('onyx/files/Marketing/Kept/', { size: 0, etag: md5(Buffer.alloc(0)) });
    g.s3.objects.set('onyx/files/Empty/Inner/', { size: 0, etag: md5(Buffer.alloc(0)) });
    await file('files/a.jpg');
    const out = await move({ driveId: 'd1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.ok(stored('team/Empty/Inner/'));
    assert.equal(stored('files/Empty/Inner/'), null);
    assert.ok(stored('files/Marketing/Kept/'), 'the drive’s own stay');
    assert.ok(!g.s3.lists.some((p) => p.startsWith('files/Marketing/')), 'and are never listed');
  });
});
