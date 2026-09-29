// Folder links end to end: the routes that make, list and revoke them, and
// what a link to a folder hands out — the real route handlers and queries
// against a real database. Runs with TEST_DATABASE_URL pointing at a
// throwaway database, and skips without one.
//
// Three things are replaced. '@/auth' resolves to a stub whose auth()
// returns whoever the test says is signed in, and 'next/headers' to one whose
// cookies() reads the jar of whichever browser the test says is asking — as
// in test/share-review-api.test.js. And lib/share-access.js's readGlobalFlags
// can be told the flags ("sharing off") without writing the settings table,
// which other test files read at the same time.

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
process.env.ADMIN_EMAILS = 'boss@foldershares.test';
process.env.AUTH_SECRET = 'folder-shares-test-secret';
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
    if (specifier === '@/lib/authz' && context.parentURL?.endsWith('/lib/share-access.js')) {
      const real = next(specifier, context).url;
      const src = `export * from ${JSON.stringify(real)};
        import { readGlobalFlags as real } from ${JSON.stringify(real)};
        export async function readGlobalFlags() { return globalThis.__flags !== undefined ? globalThis.__flags : real(); }`;
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const db = await import('../lib/db.js');
const { mergeFlags } = await import('../lib/features.js');
const { shareCookieName, shareCookieValue, MAX_PASSWORD_FAILURES } = await import('../lib/shares.js');
const { encodeCursor } = await import('../lib/file-query.js');
const access = await import('../lib/share-access.js');
const sharesRoute = await import('../app/api/files/folders/shares/route.js');
const shareRoute = await import('../app/api/files/folders/shares/[token]/route.js');
const listRoute = await import('../app/s/[token]/list/route.js');
const downloadRoute = await import('../app/s/[token]/files/[id]/download/route.js');
const fileDownloadRoute = await import('../app/s/[token]/download/route.js');
const { unlockShare } = await import('../app/s/[token]/actions.js');

const tag = Math.random().toString(36).slice(2, 8);
const DOMAIN = 'foldershares.test';
const BOSS = `boss@${DOMAIN}`;
const OWNER = `owner-${tag}@${DOMAIN}`;       // editor of the team drive; makes the links
const VIEWER = `viewer-${tag}@${DOMAIN}`;     // a viewer of it
const CONTRIB = `contrib-${tag}@${DOMAIN}`;   // an editor whose role is Contributor: no public links
const OUTSIDER = `outsider-${tag}@${DOMAIN}`; // signed in, in no drive, no grants
const LIBED = `libed-${tag}@${DOMAIN}`;       // an editor grant on one library folder
const GONER = `goner-${tag}@${DOMAIN}`;       // removed at the end, with their links
const P = `fsl-${tag}`;                       // the team drive
const NESTED = `${P}/Q1/client`;              // a client's drive inside it: private links only
const OTHER = `fso-${tag}`;                   // another drive with a Q1 of its own
const LIB = `Lib-${tag}`;                     // a library folder

// Who is signed in, and which browser is asking.
const as = (email) => { globalThis.__session = email ? { user: { email } } : null; };
const browser = () => new Map();
const use = (jar) => { globalThis.__jar = jar; };

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

const api = {
  make: (body) => call(sharesRoute.POST, '/api/files/folders/shares', {}, { method: 'POST', body }),
  list: (folder, filespace) => call(sharesRoute.GET, `/api/files/folders/shares?${new URLSearchParams({ folder, ...(filespace ? { filespace } : {}) })}`, {}),
  revoke: (token) => call(shareRoute.DELETE, `/api/files/folders/shares/${token}`, { token }, { method: 'DELETE' }),
};
// A guest's requests, with no one signed in.
const guest = {
  list: (token, qs = '') => { as(null); return call(listRoute.GET, `/s/${token}/list${qs}`, { token }); },
  download: (token, id) => { as(null); return call(downloadRoute.GET, `/s/${token}/files/${id}/download`, { token, id }); },
};
const names = (r) => (r.body?.files || []).map((f) => f.name).sort();

let team; let nested; let other;
const f = {};
const made = { files: [], tokens: [] };
const links = {};

before(async () => {
  if (!live) return;
  await db.ensureSchema();
  team = await db.createFilespace({ name: `Team ${tag}`, bucket: 'b', prefix: P, createdBy: BOSS });
  nested = await db.createFilespace({ name: `Client ${tag}`, bucket: 'b', prefix: NESTED, createdBy: BOSS });
  await db.updateFilespace(nested.id, { shareKinds: ['private'] });
  other = await db.createFilespace({ name: `Other ${tag}`, bucket: 'b', prefix: OTHER, createdBy: BOSS });
  await db.grantFilespaceAccess({ filespaceId: team.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: team.id, email: VIEWER, role: 'viewer' });
  await db.grantFilespaceAccess({ filespaceId: team.id, email: CONTRIB, role: 'editor' });
  for (const email of [OWNER, VIEWER, CONTRIB, OUTSIDER, LIBED, GONER]) {
    await db.adminAddApprovedInvite({ email, name: email.split('@')[0], reviewedBy: 'test' });
  }
  await db.upsertPerson(CONTRIB, { roleId: 'contributor' });
  await db.grantFolderAccess({ folder: LIB, subjectType: 'user', subject: LIBED, role: 'editor', grantedBy: BOSS });

  const put = async (key, name, folder, over = {}) => {
    const row = await db.createFile({
      name, folder, url: `http://s3.test/b/${key}`, mime: name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
      kind: name.endsWith('.mp4') ? 'video' : 'image', size: 10, storage: 's3', storageKey: key, createdBy: OWNER, ...over,
    });
    made.files.push(row.id);
    return row;
  };
  f.a = await put(`${P}/Q1/a.jpg`, 'a.jpg', 'Q1');
  f.b = await put(`${P}/Q1/sub/b.mp4`, 'b.mp4', 'Q1/sub');
  f.q10 = await put(`${P}/Q10/c.jpg`, 'c.jpg', 'Q10');
  f.priv = await put(`${P}/Q1/priv.jpg`, 'priv.jpg', 'Q1', { visibility: 'owner' });
  f.moved = await put(`${P}/Q1/moved.jpg`, 'moved.jpg', 'Q2');
  f.mislaid = await put(`${P}/elsewhere/mislaid.jpg`, 'mislaid.jpg', 'Q1');
  f.thumb = await put(`${P}/Q1/_thumbs/t.jpg`, 't.jpg', 'Q1/_thumbs');
  f.nested = await put(`${NESTED}/n.jpg`, 'n.jpg', 'Q1/client');
  f.trashed = await put(`${P}/Q1/trashed.jpg`, 'trashed.jpg', 'Q1');
  await db.softDeleteFile(f.trashed.id, { deletedBy: OWNER });
  f.other = await put(`${OTHER}/Q1/o.jpg`, 'o.jpg', 'Q1');
  f.libQ1 = await put(`files/Q1/lib-${tag}.jpg`, `lib-${tag}.jpg`, 'Q1');
  f.pages = [];
  for (const n of ['p1', 'p2', 'p3', 'p4', 'p5']) f.pages.push(await put(`${P}/Q1/page/${n}.jpg`, `${n}.jpg`, 'Q1/page'));
  f.lib = await put(`files/${LIB}/l.jpg`, 'l.jpg', LIB);
  f.teamLib = await put(`${P}/${LIB}/t.jpg`, 't.jpg', LIB);
  f.r = await put(`${P}/R1/r.jpg`, 'r.jpg', 'R1');
});

after(async () => {
  if (live) {
    globalThis.__flags = undefined;
    for (const id of made.files) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made.files})`.catch(() => {});
    await db.sql`DELETE FROM file_shares WHERE created_by LIKE ${`%-${tag}@${DOMAIN}`} OR token = ANY(${made.tokens})`.catch(() => {});
    await db.sql`DELETE FROM file_shares WHERE kind = 'folder' AND (storage_prefix LIKE ${`fs%-${tag}%`} OR folder LIKE ${`%${tag}%`})`.catch(() => {});
    for (const d of [team, nested, other]) if (d) await db.deleteFilespace(d.id).catch(() => {});
    await db.sql`DELETE FROM folder_access WHERE subject LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM folders WHERE filespace LIKE ${`fs%-${tag}%`} OR name LIKE ${`%${tag}%`}`.catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM people WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM audit_events WHERE actor LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('making, listing and revoking a folder’s links', { skip }, () => {
  test('401 with no one signed in, before anything is read', async () => {
    as(null);
    assert.equal((await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public' })).status, 401);
    assert.equal((await api.list('Q1', team.id)).status, 401);
    assert.equal((await api.revoke('abcdefghijklmnop')).status, 401);
  });

  test('403 for anyone who may not change the folder: outside the drive, a viewer of it', async () => {
    as(OUTSIDER);
    const out = await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public' });
    assert.equal(out.status, 403);
    assert.match(out.body.error, /No access to that drive/);
    assert.equal((await api.list('Q1', team.id)).status, 403);
    as(VIEWER);
    const viewer = await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public' });
    assert.equal(viewer.status, 403);
    assert.match(viewer.body.error, /view this drive/);
    assert.equal((await api.list('Q1', team.id)).status, 403);
    // The library's folders: a folder grant, or nothing.
    as(OUTSIDER);
    assert.equal((await api.make({ folder: LIB, kind: 'public' })).status, 403);
    assert.equal((await api.list(LIB)).status, 403);
  });

  test('the same capability a file’s public link needs, and the drive’s link kinds', async () => {
    as(CONTRIB);
    const r = await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public' });
    assert.equal(r.status, 403, 'a Contributor makes no public or password links');
    assert.match(r.body.error, /private links only/);
    assert.equal((await api.list('Q1', team.id)).status, 200, 'but sees and may revoke the folder’s links');

    as(OWNER);
    // Inside the client's drive, which allows private links only.
    const client = await api.make({ folder: 'Q1/client', filespaceId: team.id, kind: 'public' });
    assert.equal(client.status, 403);
    assert.match(client.body.error, /does not allow public links/);
    await db.updateFilespace(team.id, { shareKinds: ['private'] });
    try {
      const pw = await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'password', password: 'hunter22' });
      assert.equal(pw.status, 403);
      assert.match(pw.body.error, /does not allow password links/);
    } finally {
      await db.updateFilespace(team.id, { shareKinds: null });
    }
  });

  test('400 for what a folder link cannot be, 404 for a folder that is not there', async () => {
    as(OWNER);
    const make = (over) => api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public', ...over });
    assert.equal((await make({ kind: 'private' })).status, 400);
    assert.match((await make({ review: 'comment' })).body.error, /cannot take comments/);
    for (const folder of ['', '/', '../Q1', 'Q1/../Q10', '_thumbs', 'Q1/_trash', 42]) {
      assert.equal((await make({ folder })).status, 400, JSON.stringify(folder));
    }
    assert.equal((await make({ kind: 'password', password: 'abc' })).status, 400);
    assert.equal((await make({ expires: '365' })).status, 400);
    const none = await make({ folder: `Nope-${tag}` });
    assert.equal(none.status, 404);
    assert.match(none.body.error, /no folder/);
  });

  test('made: public, reused only when it is exactly that link; password and expiring ones are their own', async () => {
    as(OWNER);
    const pub = await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public' });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.share.kind, 'public');
    assert.equal(pub.body.share.review, null);
    assert.match(pub.body.share.token, /^[A-Za-z0-9_-]{22}$/, '128 bits, like a file link');
    links.pub = pub.body.share.token;
    assert.equal((await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public' })).body.share.token, links.pub);

    const pw = await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'password', password: 'hunter22' });
    assert.equal(pw.status, 200);
    assert.equal(pw.body.share.kind, 'password');
    assert.notEqual(pw.body.share.token, links.pub, 'a password is never dropped for an open link that exists');
    links.pw = pw.body.share.token;

    const week = await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public', expires: '7' });
    assert.notEqual(week.body.share.token, links.pub);
    assert.ok(week.body.share.expiresAt > Date.now());
    links.week = week.body.share.token;

    const listed = await api.list('Q1', team.id);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.shares.map((s) => s.token), [links.week, links.pw, links.pub], 'newest first');
    for (const s of listed.body.shares) {
      assert.deepEqual(Object.keys(s).sort(), ['createdAt', 'createdBy', 'expiresAt', 'kind', 'review', 'token', 'viewCount']);
    }
    // Someone else asking for the same open link is given one of their own:
    // a folder link speaks for whoever made it.
    as(BOSS);
    const theirs = await api.make({ folder: 'Q1', filespaceId: team.id, kind: 'public' });
    assert.equal(theirs.status, 200);
    assert.notEqual(theirs.body.share.token, links.pub);
    assert.equal(theirs.body.share.createdBy, BOSS);
    assert.equal((await api.revoke(theirs.body.share.token)).status, 200);
    // The drive's Q1 is not the library's.
    assert.deepEqual((await api.list('Q1')).body.shares, []);
    const row = await db.getShareRow(links.pw);
    assert.equal(row.kind, 'folder');
    assert.equal(row.storage_prefix, P);
    assert.match(row.password_hash, /^scrypt\$/);
    assert.equal(row.file_id, null);
  });

  test('the library: a folder grant makes its links, and they reach no drive', async () => {
    as(LIBED);
    const r = await api.make({ folder: LIB, kind: 'public' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    links.lib = r.body.share.token;
    assert.equal((await db.getShareRow(links.lib)).storage_prefix, null);
    const shown = await guest.list(links.lib);
    assert.equal(shown.status, 200);
    assert.deepEqual(names(shown), ['l.jpg'], 'not the team drive’s file in a folder of the same name');
  });
});

describe('what a folder link hands out', { skip }, () => {
  test('the folder’s own files, and nothing that only looks as if it were there', async () => {
    const shown = await guest.list(links.pub);
    assert.equal(shown.status, 200);
    assert.deepEqual(names(shown), ['a.jpg']);
    assert.equal(shown.body.cursor, null);
    const [a] = shown.body.files;
    assert.equal(a.id, f.a.id);
    for (const k of ['createdBy', 'folder', 'storageKey', 'tags', 'visibility', 'can', 'storage']) assert.ok(!(k in a), k);
  });

  test('subfolders: those that hold something the link reaches, with how much', async () => {
    const got = await access.resolveFolderShareAccess(links.pub);
    assert.equal(got.state, 'ok');
    assert.equal(got.scope.root, 'Q1');
    assert.equal(got.scope.prefix, P);
    const listing = await access.folderLinkListing(got, { sub: '' });
    assert.deepEqual(listing.folders, [{ name: 'page', count: 5 }, { name: 'sub', count: 1 }], 'not the client drive’s, not _thumbs');
    assert.equal(listing.count, 1);
    assert.deepEqual(names(await guest.list(links.pub, '?path=sub')), ['b.mp4']);
    assert.deepEqual(names(await guest.list(links.pub, '?path=client')), [], 'a drive inside that allows no public link');
  });

  test('a crafted path never leaves the folder: 404', async () => {
    for (const qs of ['?path=..', '?path=../Q10', '?path=%2e%2e', '?path=%2e%2e%2fQ10', '?path=sub%2F..%2F..%2FQ10',
      '?path=/Q1', '?path=sub/', '?path=sub//x', '?path=_thumbs', '?path=%00']) {
      const r = await guest.list(links.pub, qs);
      assert.equal(r.status, 404, qs);
      assert.equal(r.body.files, undefined);
    }
    // Encoded twice: a name with "%2F" in it, which is no folder in the link.
    assert.deepEqual(names(await guest.list(links.pub, '?path=sub%252F..%252F..%252FQ10')), []);
  });

  test('pages: keyset, by name, to the end', async () => {
    const got = await access.resolveFolderShareAccess(links.pub);
    const one = await access.folderLinkListing(got, { sub: 'page', limit: 2 });
    assert.deepEqual(names({ body: one }), ['p1.jpg', 'p2.jpg']);
    assert.ok(one.cursor);
    const two = await guest.list(links.pub, `?${new URLSearchParams({ path: 'page', cursor: one.cursor })}`);
    assert.equal(two.status, 200);
    assert.deepEqual(names(two), ['p3.jpg', 'p4.jpg', 'p5.jpg']);
    assert.equal(two.body.cursor, null);
    // A cursor from nowhere is the first page, not an error.
    assert.deepEqual(names(await guest.list(links.pub, '?path=page&cursor=nonsense')), ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg', 'p5.jpg']);
    const past = encodeCursor({ value: 'zzz', id: 'z' });
    assert.deepEqual(names(await guest.list(links.pub, `?path=page&cursor=${past}`)), []);
  });

  test('a download: only a file in the link, decided again; anything else is told it is not', async () => {
    const ok = await guest.download(links.pub, f.a.id);
    assert.ok([302, 307].includes(ok.status), String(ok.status));
    assert.ok(ok.location.includes(`${P}/Q1/a.jpg`), ok.location);
    assert.ok(!ok.location.includes('/s/'), ok.location);
    const deep = await guest.download(links.pub, f.b.id);
    assert.ok(deep.location.includes(`${P}/Q1/sub/b.mp4`));
    for (const [what, id] of Object.entries({
      q10: f.q10.id, priv: f.priv.id, moved: f.moved.id, mislaid: f.mislaid.id, thumb: f.thumb.id, nested: f.nested.id,
      trashed: f.trashed.id, other: f.other.id, library: f.libQ1.id, teamLib: f.teamLib.id, random: 'no-such-file',
    })) {
      const r = await guest.download(links.pub, id);
      assert.equal(r.location, `http://app.test/s/${links.pub}/files/${id}`, what);
    }
    const up = await guest.download(links.pub, '../../x');
    assert.equal(up.location, `http://app.test/s/${links.pub}/files/..%2F..%2Fx`);
    const got = await access.resolveFolderShareAccess(links.pub);
    assert.equal(await access.folderLinkFile(got, f.q10.id), null, 'the preview page asks the same');
    assert.equal((await access.folderLinkFile(got, f.a.id)).id, f.a.id);
  });

  test('live: a file moved out, trashed or restricted drops out at once, and comes back', async () => {
    const shown = async () => names(await guest.list(links.pub));
    await db.updateFile(f.a.id, { folder: 'Q3' });
    assert.deepEqual(await shown(), [], 'moved out in the catalog');
    assert.equal((await guest.download(links.pub, f.a.id)).location, `http://app.test/s/${links.pub}/files/${f.a.id}`);
    await db.updateFile(f.a.id, { folder: 'Q1' });
    assert.deepEqual(await shown(), ['a.jpg']);

    await db.setFileStorageKey(f.a.id, `${P}/Q3/a.jpg`);
    await db.updateFile(f.a.id, { folder: 'Q3' });
    assert.deepEqual(await shown(), [], 'moved out, object and all');
    await db.setFileStorageKey(f.a.id, `${P}/Q1/a.jpg`);
    await db.updateFile(f.a.id, { folder: 'Q1' });

    await db.setFileVisibility(f.a.id, 'owner');
    assert.deepEqual(await shown(), [], 'restricted to certain people');
    await db.setFileVisibility(f.a.id, 'org');

    await db.softDeleteFile(f.b.id, { deletedBy: OWNER });
    assert.deepEqual(names(await guest.list(links.pub, '?path=sub')), []);
    assert.equal((await guest.download(links.pub, f.b.id)).location, `http://app.test/s/${links.pub}/files/${f.b.id}`);
    await db.restoreFile(f.b.id);
    assert.deepEqual(names(await guest.list(links.pub, '?path=sub')), ['b.mp4']);
    assert.deepEqual(await shown(), ['a.jpg']);
  });

  test('a password link: the password first, through the same form and lockout as a file link', async () => {
    const jar = browser();
    use(jar);
    assert.equal((await access.resolveFolderShareAccess(links.pw)).state, 'password');
    const shut = await guest.list(links.pw);
    assert.equal(shut.status, 401);
    assert.equal((await guest.download(links.pw, f.a.id)).location, `http://app.test/s/${links.pw}`);

    const form = (password) => { const d = new FormData(); d.set('token', links.pw); d.set('password', password); return d; };
    assert.deepEqual(await unlockShare({}, form('wrong one')), { error: 'That password is not right.' });
    await assert.rejects(unlockShare({}, form('hunter22')), (e) => String(e?.digest || e?.message).includes('NEXT_REDIRECT'));
    assert.ok(jar.get(shareCookieName(links.pw)), 'the unlock cookie');
    assert.deepEqual(names(await guest.list(links.pw)), ['a.jpg']);

    // Another link's cookie opens nothing here.
    const other = browser();
    other.set(shareCookieName(links.pw), shareCookieValue(links.pub, (await db.getShareRow(links.pw)).password_hash, process.env.AUTH_SECRET));
    use(other);
    assert.equal((await guest.list(links.pw)).status, 401);

    // Too many guesses lock it for everyone without the cookie.
    for (let i = 0; i < MAX_PASSWORD_FAILURES; i++) await db.recordShareFailure(links.pw);
    use(browser());
    assert.equal((await access.resolveFolderShareAccess(links.pw)).state, 'locked');
    assert.match((await unlockShare({}, form('hunter22'))).error, /Too many wrong passwords/);
    use(jar);
    assert.equal((await guest.list(links.pw)).status, 200, 'a browser already let in stays in');
    await db.clearShareFailures(links.pw);
    use(null);
  });

  test('expired, sharing off, or its sharer paused: nothing is handed out', async () => {
    await db.sql`UPDATE file_shares SET expires_at = ${Date.now() - 1000} WHERE token = ${links.week}`;
    assert.equal((await guest.list(links.week)).status, 410);
    assert.equal((await access.resolveFolderShareAccess(links.week)).state, 'expired');
    assert.equal((await guest.download(links.week, f.a.id)).location, `http://app.test/s/${links.week}`);

    globalThis.__flags = { ...mergeFlags({}), shares: false };
    try {
      const off = await guest.list(links.pub);
      assert.equal(off.status, 403);
      assert.match(off.body.error, /turned off/);
      assert.equal((await guest.download(links.pub, f.a.id)).location, `http://app.test/s/${links.pub}`);
    } finally {
      globalThis.__flags = undefined;
    }
    // Flags that cannot be read serve nothing either.
    globalThis.__flags = null;
    try {
      assert.equal((await guest.list(links.pub)).status, 403);
    } finally {
      globalThis.__flags = undefined;
    }

    await db.setPersonStatus(LIBED, { status: 'suspended', by: BOSS });
    try {
      assert.equal((await guest.list(links.lib)).status, 403);
      assert.equal((await access.resolveFolderShareAccess(links.lib)).state, 'paused');
    } finally {
      await db.setPersonStatus(LIBED, { status: 'active', by: BOSS });
    }
    assert.equal((await guest.list(links.lib)).status, 200);
  });

  test('a folder link is not a file link, nor the other way round', async () => {
    as(OWNER);
    const fileLink = await db.createShare({ fileId: f.a.id, createdBy: OWNER, mode: 'public' });
    made.tokens.push(fileLink.token);
    assert.equal((await access.resolveShareAccess(links.pub)).state, 'missing', 'the file routes serve no folder');
    assert.equal((await call(fileDownloadRoute.GET, `/s/${links.pub}/download`, { token: links.pub })).location, `http://app.test/s/${links.pub}`);
    assert.equal((await access.resolveFolderShareAccess(fileLink.token)).state, 'missing');
    assert.equal((await guest.list(fileLink.token)).status, 404);
    assert.equal((await access.resolveLinkAccess(links.pub)).target, 'folder');
    assert.equal((await access.resolveLinkAccess(fileLink.token)).target, 'file');
    as(OWNER);
    assert.equal((await api.revoke(fileLink.token)).status, 404, 'a file’s links are revoked through the file');
  });

  test('gone with its drive, and blocked when the folder is in a drive that stopped allowing it', async () => {
    const orphan = await db.createFolderShare({ folder: 'Q1', storagePrefix: `fs-nowhere-${tag}`, createdBy: OWNER });
    assert.equal((await access.resolveFolderShareAccess(orphan.token)).state, 'gone');
    assert.equal((await guest.list(orphan.token)).status, 404);
    const client = await db.createFolderShare({ folder: 'Q1/client', storagePrefix: P, createdBy: OWNER });
    assert.equal((await access.resolveFolderShareAccess(client.token)).state, 'blocked');
    assert.equal((await guest.list(client.token)).status, 403);
    await assert.rejects(db.createFolderShare({ folder: 'Q1', storagePrefix: P, createdBy: OWNER, mode: 'private' }), /public or password/);
    await assert.rejects(db.createFolderShare({ folder: '', storagePrefix: P, createdBy: OWNER }), /needs a folder/);
  });
});

describe('revoking, renaming and removing', { skip }, () => {
  test('revoke: the creator, the folder’s editors and admins — nobody else', async () => {
    as(VIEWER);
    assert.equal((await api.revoke(links.week)).status, 403);
    as(OUTSIDER);
    assert.equal((await api.revoke(links.week)).status, 403);
    assert.equal((await api.revoke(links.lib)).status, 403, 'nor a library folder they hold no grant on');
    as(CONTRIB);
    assert.equal((await api.revoke(links.week)).status, 200, 'an editor of the drive, whatever the role’s link capabilities');
    assert.equal(await db.getShareRow(links.week), null);
    assert.equal((await api.revoke(links.week)).status, 404);
    assert.equal((await api.revoke('../../etc')).status, 404);
    // An admin: any folder's, in a drive or the library, made or revoked.
    as(BOSS);
    const theirs = await api.make({ folder: LIB, kind: 'public', expires: '1' });
    assert.equal(theirs.status, 200);
    assert.equal((await api.revoke(theirs.body.share.token)).status, 200);
  });

  test('a revoked link stops at the next request', async () => {
    as(OWNER);
    assert.equal((await guest.list(links.pub)).status, 200);
    as(OWNER);
    assert.equal((await api.revoke(links.pub)).status, 200);
    const r = await guest.list(links.pub);
    assert.equal(r.status, 404);
    assert.equal((await guest.download(links.pub, f.a.id)).location, `http://app.test/s/${links.pub}`);
  });

  test('a link speaks for its maker only while they may still share the folder', async () => {
    as(OWNER);
    const mine = await api.make({ folder: 'Q1/sub', filespaceId: team.id, kind: 'public' });
    assert.equal(mine.status, 200);
    const token = mine.body.share.token;
    assert.deepEqual(names(await guest.list(token)), ['b.mp4']);
    await db.grantFilespaceAccess({ filespaceId: team.id, email: OWNER, role: 'viewer' });
    try {
      assert.equal((await access.resolveFolderShareAccess(token)).state, 'paused', 'a viewer now: the folder is not theirs to hand out');
      const r = await guest.list(token);
      assert.equal(r.status, 403);
      assert.match(r.body.error, /paused/);
      assert.equal((await guest.download(token, f.b.id)).location, `http://app.test/s/${token}`);
    } finally {
      await db.grantFilespaceAccess({ filespaceId: team.id, email: OWNER, role: 'editor' });
    }
    assert.deepEqual(names(await guest.list(token)), ['b.mp4'], 'and back when they are given it again');

    // In the library, their folder grant is what it speaks for.
    await db.revokeFolderAccess({ folder: LIB, subjectType: 'user', subject: LIBED });
    try {
      assert.equal((await guest.list(links.lib)).status, 403);
    } finally {
      await db.grantFolderAccess({ folder: LIB, subjectType: 'user', subject: LIBED, role: 'editor', grantedBy: BOSS });
    }
    assert.equal((await guest.list(links.lib)).status, 200);
    // A viewer grant is not enough: sharing a folder is changing who reaches it.
    await db.grantFolderAccess({ folder: LIB, subjectType: 'user', subject: LIBED, role: 'viewer', grantedBy: BOSS });
    try {
      assert.equal((await guest.list(links.lib)).status, 403);
    } finally {
      await db.grantFolderAccess({ folder: LIB, subjectType: 'user', subject: LIBED, role: 'editor', grantedBy: BOSS });
    }
  });

  test('whoever made a link can take it down after losing the drive', async () => {
    as(OWNER);
    const mine = await api.make({ folder: 'Q1/sub', filespaceId: team.id, kind: 'public', expires: '1' });
    assert.equal(mine.status, 200);
    await db.grantFilespaceAccess({ filespaceId: team.id, email: OWNER, role: 'viewer' });
    try {
      as(OWNER);
      assert.equal((await api.list('Q1/sub', team.id)).status, 403, 'no longer manages the folder’s links');
      assert.equal((await api.revoke(mine.body.share.token)).status, 200, 'but may revoke their own');
    } finally {
      await db.grantFilespaceAccess({ filespaceId: team.id, email: OWNER, role: 'editor' });
    }
  });

  test('a rename takes the scope’s links along; a delete takes them away', async () => {
    const top = await db.createFolderShare({ folder: 'R1', storagePrefix: P, createdBy: OWNER });
    const deep = await db.createFolderShare({ folder: 'R1/deep', storagePrefix: P, createdBy: OWNER });
    const near = await db.createFolderShare({ folder: 'R10', storagePrefix: P, createdBy: OWNER });
    const lib = await db.createFolderShare({ folder: 'R1', storagePrefix: null, createdBy: OWNER });
    const res = await db.renameFolder('R1', 'R2', { tag: P, moves: [{ id: f.r.id, folder: 'R2', toKey: `${P}/R2/r.jpg` }] });
    assert.equal(res.links, 2);
    assert.equal((await db.getShareTarget(top.token)).folder, 'R2');
    assert.equal((await db.getShareTarget(deep.token)).folder, 'R2/deep');
    assert.equal((await db.getShareTarget(near.token)).folder, 'R10', 'R10 is not inside R1');
    assert.equal((await db.getShareTarget(lib.token)).folder, 'R1', 'the library’s R1 is another folder');
    assert.deepEqual(names(await guest.list(top.token)), ['r.jpg'], 'still opens onto the folder it was made for');

    await db.deleteFolderRows('R2', { tag: P });
    assert.equal(await db.getShareRow(top.token), null);
    assert.equal(await db.getShareRow(deep.token), null);
    assert.ok(await db.getShareRow(near.token));
    assert.ok(await db.getShareRow(lib.token));
    made.tokens.push(near.token, lib.token);
  });

  test('a person’s links: on their drawer and in the admin list, and gone with them', async () => {
    const detail = await db.personDetail(OWNER);
    const folderLink = detail.links.find((l) => l.token === links.pw);
    assert.ok(folderLink, 'the drawer lists folder links');
    assert.equal(folderLink.target, 'folder');
    assert.equal(folderLink.folder, 'Q1');
    assert.equal(folderLink.driveName, `Team ${tag}`);
    assert.equal(folderLink.library, false);
    assert.equal(folderLink.kind, 'password');
    const all = await db.listAllShares({ creator: OWNER, limit: 500 });
    const row = all.rows.find((r) => r.token === links.pw);
    assert.equal(row.target, 'folder');
    assert.equal(row.folder, 'Q1');
    assert.equal(row.fileName, null);
    const libRow = (await db.listAllShares({ creator: LIBED })).rows.find((r) => r.token === links.lib);
    assert.equal(libRow.library, true);

    const goner = await db.createFolderShare({ folder: LIB, storagePrefix: null, createdBy: GONER });
    assert.equal(goner.reused, false, 'their own, not the open one LIBED made');
    const preview = await db.removePerson(GONER);
    assert.equal(preview.links, 1);
    await db.removePerson(GONER, { apply: true, by: BOSS });
    assert.equal(await db.getShareRow(goner.token), null);
  });

  test('a deleted drive takes its folders’ links with it', async () => {
    const tmp = await db.createFilespace({ name: `Tmp ${tag}`, bucket: 'b', prefix: `fst-${tag}`, createdBy: BOSS });
    const link = await db.createFolderShare({ folder: 'X', storagePrefix: `fst-${tag}`, createdBy: OWNER });
    const libLink = await db.createFolderShare({ folder: 'X', storagePrefix: null, createdBy: OWNER });
    made.tokens.push(libLink.token);
    await db.deleteFilespace(tmp.id);
    assert.equal(await db.getShareRow(link.token), null);
    assert.ok(await db.getShareRow(libLink.token));
  });
});
