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
      if (b.failCopy?.(i.Key)) throw Object.assign(new Error('InternalError'), { name: 'InternalError' });
      const o = b.objects.get(decodeURIComponent(String(i.CopySource).replace(/^\//, '')));
      if (!o) throw missing('NoSuchKey');
      b.objects.set(at(i.Key), { ...o });
      b.copies.push(at(i.Key));
      return {};
    }
    case 'ListObjectsV2Command': {
      const pre = at(i.Prefix || '');
      const Contents = [...b.objects.keys()].filter((k) => k.startsWith(pre)).map((k) => ({ Key: k.slice(i.Bucket.length + 1), Size: b.objects.get(k).size }));
      return { Contents, IsTruncated: false };
    }
    default: throw new Error(`unexpected ${cmd.constructor.name}`);
  }
};

const store = await import(DB_STUB);
const moveRoute = await import('../app/api/admin/library/move/route.js');
const { _setFolderMoveBudgetMs } = await import('../lib/folder-ops.js');

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
    s3: { objects: new Map(), calls: [], copies: [] },
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
    await store.issueUploadKey('team/a.jpg', BOSS, { bucket: 'onyx' });
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.equal(row(f.id).storageKey, 'team/a.jpg', 'not “a (2).jpg”');
    assert.deepEqual([...globalThis.__mw.uploadKeys.keys()], [], 'and the key is given back');
  });

  test('a noted copy of an original written since is made again over itself', async () => {
    const f = await file('files/a.jpg', { bytes: 'new bytes' });
    globalThis.__mw.moveCopies = new Map([['team/a.jpg', 'files/a.jpg']]);
    globalThis.__mw.s3.objects.set('onyx/team/a.jpg', { size: 3, etag: md5(Buffer.from('old')) });
    assert.equal((await move({ driveId: 'd1' })).status, 200);
    assert.equal(row(f.id).storageKey, 'team/a.jpg');
    assert.equal(stored('team/a.jpg').etag, md5(Buffer.from('new bytes')));
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
