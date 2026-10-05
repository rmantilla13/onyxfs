// The iPhone's Share Link sheet, against the web's own link routes with its
// device token: every method of a file's links (list, make, change, revoke)
// and of a folder's (list, make, revoke), the folder tree's marks and the
// account's `shares` — the real route handlers and queries against a real
// database. Runs with TEST_DATABASE_URL pointing at a throwaway database,
// and skips without one.
//
// Three things are replaced. '@/auth' resolves to a stub whose auth()
// returns whoever the test says has a browser session, and 'next/headers' to
// one with an empty jar, as in test/folder-shares-api.test.js. And the three
// settings every decision rests on (roles, flags, policy) are the test's own,
// read by lib/authz.js through a wrapper of lib/db.js's getSetting — so a
// role that may not use the apps, sharing turned off or a longest expiry is
// arranged without writing a settings row other test files read meanwhile.

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
process.env.ADMIN_EMAILS = 'boss@applinks.test';
process.env.AUTH_SECRET = 'app-share-links-test-secret';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const AUTH = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__session || null; }')}`;
const HEADERS = `data:text/javascript,${encodeURIComponent(`
  export function cookies() {
    const jar = new Map();
    return { get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined), set() {}, delete() {} };
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
          const own = globalThis.__settings;
          return own && Object.hasOwn(own, key) ? structuredClone(own[key]) : read(key, opts);
        }`;
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const db = await import('../lib/db.js');
const { BUILTIN_ROLES } = await import('../lib/roles.js');
const { SHARE_KINDS, SHARE_EXPIRY } = await import('../lib/share-kinds.js');
const sharesRoute = await import('../app/api/files/[id]/shares/route.js');
const shareRoute = await import('../app/api/files/[id]/shares/[token]/route.js');
const folderSharesRoute = await import('../app/api/files/folders/shares/route.js');
const folderShareRoute = await import('../app/api/files/folders/shares/[token]/route.js');
const foldersRoute = await import('../app/api/files/folders/route.js');
const filespacesRoute = await import('../app/api/space/filespaces/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const DOMAIN = 'applinks.test';
const BOSS = `boss@${DOMAIN}`;                  // ADMIN_EMAILS
const OWNER = `owner-${tag}@${DOMAIN}`;         // a Member, editor of the drive: the phone's owner
const VIEWER = `viewer-${tag}@${DOMAIN}`;       // a Member who views the drive
const CONTRIB = `contrib-${tag}@${DOMAIN}`;     // a Contributor, editor of the drive: private links only
const NOAPPS = `noapps-${tag}@${DOMAIN}`;       // editor of the drive, in a role that may not use the apps
const READER = `reader-${tag}@${DOMAIN}`;       // the Viewer role: a viewer in every drive, and no links
const NOLINKS = `nolinks-${tag}@${DOMAIN}`;     // editor of the drive, in a role that may make no kind of link
const OUTSIDER = `outsider-${tag}@${DOMAIN}`;   // signed in, in no drive, no grants
const LIBED = `libed-${tag}@${DOMAIN}`;         // an editor grant on one library folder
const NOAPPS_ROLE = `noapps-${tag}`;
const NOLINKS_ROLE = `nolinks-${tag}`;
const P = `apl-${tag}`;                         // the drive
const LIB = `AppLib-${tag}`;                    // a library folder

const baseSettings = () => ({
  'roles.config': {
    version: 2, defaultRole: 'member', assignments: {},
    roles: [
      ...BUILTIN_ROLES,
      { id: NOAPPS_ROLE, name: 'No apps', caps: { 'desktop.mount': false } },
      { id: NOLINKS_ROLE, name: 'No links', caps: { 'shares.private': false, 'shares.public': false, 'review.links': false } },
    ],
  },
  // These cases include the library's folders and files: a workspace with
  // an All files (the `library` flag, off by default since drives became
  // where files are kept).
  'features.flags': { library: true },
  'policy.limits': {},
});
/** The settings for the length of `fn`: flags and policy laid over the defaults. */
async function withSettings({ flags = {}, policy = {} }, fn) {
  const s = baseSettings();
  globalThis.__settings = { ...s, 'features.flags': { ...s['features.flags'], ...flags }, 'policy.limits': policy };
  try { return await fn(); } finally { globalThis.__settings = baseSettings(); }
}

const tokens = {};
const app = (email) => ({ token: tokens[email] });  // the iPhone: its device token, no session
const web = (email) => ({ cookie: email });          // a browser: a session, no token

async function call(handler, path, { method = 'GET', body, token, cookie, params = {} } = {}) {
  globalThis.__session = cookie ? { user: { email: cookie } } : null;
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handler(new Request(`http://app.test${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), { params });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const fileLinks = {
  list: (who, f) => call(sharesRoute.GET, `/api/files/${f.id}/shares`, { params: { id: f.id }, ...who }),
  make: (who, f, body) => call(sharesRoute.POST, `/api/files/${f.id}/shares`, { method: 'POST', body, params: { id: f.id }, ...who }),
  level: (who, f, token, review) => call(shareRoute.PATCH, `/api/files/${f.id}/shares/${token}`, {
    method: 'PATCH', body: { review }, params: { id: f.id, token }, ...who,
  }),
  revoke: (who, f, token) => call(shareRoute.DELETE, `/api/files/${f.id}/shares/${token}`, { method: 'DELETE', params: { id: f.id, token }, ...who }),
};
const folderLinks = {
  list: (who, folder, filespace) => call(folderSharesRoute.GET, `/api/files/folders/shares?${new URLSearchParams({ folder, ...(filespace ? { filespace } : {}) })}`, who),
  make: (who, body) => call(folderSharesRoute.POST, '/api/files/folders/shares', { method: 'POST', body, ...who }),
  revoke: (who, token) => call(folderShareRoute.DELETE, `/api/files/folders/shares/${token}`, { method: 'DELETE', params: { token }, ...who }),
};
const tree = (who, filespace) => call(foldersRoute.GET, `/api/files/folders${filespace ? `?filespace=${filespace}` : ''}`, who);
const places = (who) => call(filespacesRoute.GET, '/api/space/filespaces', who);

const ALL_KINDS = SHARE_KINDS.map((k) => k.id);
const ALL_EXPIRIES = SHARE_EXPIRY.map((x) => x.id);
const request = (kind, expires, review) => ({ kind, expires, ...(kind === 'password' ? { password: 'hunter22' } : {}), ...(review ? { review } : {}) });

let drive;
const f = {};
const made = { files: [] };

before(async () => {
  if (!live) return;
  globalThis.__settings = baseSettings();
  await db.ensureSchema();
  drive = await db.createFilespace({ name: `App links ${tag}`, bucket: 'b', prefix: P, createdBy: BOSS });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: CONTRIB, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: NOAPPS, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: READER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: NOLINKS, role: 'editor' });
  for (const email of [OWNER, VIEWER, CONTRIB, NOAPPS, READER, NOLINKS, OUTSIDER, LIBED]) {
    await db.adminAddApprovedInvite({ email, name: email.split('@')[0], reviewedBy: 'test' });
  }
  await db.upsertPerson(CONTRIB, { roleId: 'contributor' });
  await db.upsertPerson(NOAPPS, { roleId: NOAPPS_ROLE });
  await db.upsertPerson(READER, { roleId: 'viewer' });
  await db.upsertPerson(NOLINKS, { roleId: NOLINKS_ROLE });
  await db.grantFolderAccess({ folder: LIB, subjectType: 'user', subject: LIBED, role: 'editor', grantedBy: BOSS });
  for (const email of [OWNER, VIEWER, CONTRIB, NOAPPS, READER, NOLINKS, OUTSIDER, LIBED, BOSS]) {
    tokens[email] = (await db.createDesktopToken({ email, label: 'iPhone' })).token;
  }

  const put = async (key, name, folder, kind, mime) => {
    const row = await db.createFile({
      name, folder, url: `http://s3.test/b/${key}`, mime, kind, size: 10, storage: 's3', storageKey: key, createdBy: OWNER,
    });
    made.files.push(row.id);
    return row;
  };
  f.cut = await put(`${P}/Cuts/cut.mp4`, 'cut.mp4', 'Cuts', 'video', 'video/mp4');
  f.pdf = await put(`${P}/Docs/brief.pdf`, 'brief.pdf', 'Docs', 'other', 'application/pdf');
  f.deep = await put(`${P}/Cuts/Day 1/take.mp4`, 'take.mp4', 'Cuts/Day 1', 'video', 'video/mp4');
  f.lib = await put(`files/${LIB}/Sub/l.jpg`, 'l.jpg', `${LIB}/Sub`, 'image', 'image/jpeg');
  f.elsewhere = await put(`files/Else-${tag}/e.jpg`, 'e.jpg', `Else-${tag}`, 'image', 'image/jpeg');
});

after(async () => {
  if (live) {
    globalThis.__settings = undefined;
    for (const id of made.files) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made.files})`.catch(() => {});
    await db.sql`DELETE FROM file_shares WHERE file_id = ANY(${made.files}) OR created_by LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM file_shares WHERE kind = 'folder' AND (storage_prefix = ${P} OR folder LIKE ${`%${tag}%`})`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM folder_access WHERE subject LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM folders WHERE filespace = ${P} OR name LIKE ${`%${tag}%`}`.catch(() => {});
    await db.sql`DELETE FROM desktop_tokens WHERE email LIKE ${`%-${tag}@${DOMAIN}`} OR (email = ${BOSS} AND label = 'iPhone')`.catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM people WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM audit_events WHERE actor LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('who is asking: the token, before anything is read', { skip }, () => {
  // Every method of every link route, for someone with no business there.
  const everything = (who) => [
    fileLinks.list(who, { id: 'no-such-file' }),
    fileLinks.make(who, { id: 'no-such-file' }, request('public', 'never')),
    fileLinks.level(who, { id: 'no-such-file' }, 'abcdefghijklmnopqrstuv', 'comment'),
    fileLinks.revoke(who, { id: 'no-such-file' }, 'abcdefghijklmnopqrstuv'),
    folderLinks.list(who, 'Cuts', 'no-such-drive'),
    folderLinks.make(who, { folder: 'Cuts', filespaceId: 'no-such-drive', kind: 'public' }),
    folderLinks.revoke(who, 'abcdefghijklmnopqrstuv'),
  ];

  test('no session and no token is a 401 on every method — not the 404 a missing file would be', async () => {
    for (const r of await Promise.all(everything({}))) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'Not authenticated');
    }
  });

  test('a token the server does not know, or no longer does, is a 401 everywhere', async () => {
    const revoked = await db.createDesktopToken({ email: OWNER, label: 'iPhone' });
    await db.revokeDesktopToken(revoked.id);
    const expired = await db.createDesktopToken({ email: OWNER, label: 'iPhone', ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    for (const token of ['dt_live_nobody', revoked.token, expired.token]) {
      for (const r of await Promise.all(everything({ token }))) {
        assert.equal(r.status, 401);
        assert.equal(r.body.error, 'Invalid or expired token');
      }
    }
  });

  test('a role that may not use the apps: its token is refused on every method, and its browser is not', async () => {
    const real = {
      list: () => fileLinks.list(app(NOAPPS), f.cut),
      make: () => fileLinks.make(app(NOAPPS), f.cut, request('public', '1')),
      level: () => fileLinks.level(app(NOAPPS), f.cut, 'abcdefghijklmnopqrstuv', 'comment'),
      revoke: () => fileLinks.revoke(app(NOAPPS), f.cut, 'abcdefghijklmnopqrstuv'),
      folders: () => folderLinks.list(app(NOAPPS), 'Cuts', drive.id),
      folder: () => folderLinks.make(app(NOAPPS), { folder: 'Cuts', filespaceId: drive.id, kind: 'public', expires: '1' }),
      unfolder: () => folderLinks.revoke(app(NOAPPS), 'abcdefghijklmnopqrstuv'),
    };
    for (const [what, go] of Object.entries(real)) {
      const r = await go();
      assert.equal(r.status, 403, what);
      assert.equal(r.body.error, 'Your role cannot use the desktop app.', what);
    }
    assert.deepEqual((await db.listSharesForFile(f.cut.id)).filter((s) => s.createdBy === NOAPPS), [], 'nothing made');
    const onWeb = await fileLinks.list(web(NOAPPS), f.cut);
    assert.equal(onWeb.status, 200, 'the web does not need the apps');
  });

  test('with drives and the apps turned off, no token reaches a link — an admin’s neither', async () => {
    await withSettings({ flags: { filespaces: false } }, async () => {
      for (const email of [OWNER, BOSS]) {
        const r = await fileLinks.list(app(email), f.cut);
        assert.equal(r.status, 403);
        assert.equal(r.body.error, 'Drives and desktop mounts are turned off.');
      }
      assert.equal((await fileLinks.list(web(OWNER), f.cut)).status, 200);
    });
  });

  test('a session wins over a token: a browser that sends both is its session', async () => {
    const r = await fileLinks.make({ cookie: OWNER, token: tokens[CONTRIB] }, f.pdf, request('public', '1'));
    assert.equal(r.status, 200, 'a Contributor’s token would have been refused a public link');
    assert.equal(r.body.share.createdBy, OWNER);
    await fileLinks.revoke(web(OWNER), f.pdf, r.body.share.token);
  });
});

describe('the same rules as the browser, in the same order', { skip }, () => {
  test('404 for no file, 403 for a viewer or an outsider — the same answer either way in', async () => {
    const cases = [
      [OWNER, (who) => fileLinks.list(who, { id: 'no-such-file' }), 404, /File not found/],
      [VIEWER, (who) => fileLinks.list(who, { id: 'no-such-file' }), 404, /File not found/],
      [VIEWER, (who) => fileLinks.list(who, f.cut), 403, /view this file but not share it/],
      [VIEWER, (who) => fileLinks.make(who, f.cut, request('public', '1')), 403, /view this file but not share it/],
      [OUTSIDER, (who) => fileLinks.list(who, f.cut), 403, /not share it/],
      [OWNER, (who) => fileLinks.level(who, f.cut, 'abcdefghijklmnopqrstuv', 'comment'), 404, /Link not found/],
      [OWNER, (who) => fileLinks.revoke(who, f.cut, 'abcdefghijklmnopqrstuv'), 404, /Link not found/],
      [VIEWER, (who) => folderLinks.list(who, 'Cuts', drive.id), 403, /view this drive but not share its folders/],
      [OUTSIDER, (who) => folderLinks.list(who, 'Cuts', drive.id), 403, /No access to that drive/],
      [OUTSIDER, (who) => folderLinks.list(who, LIB), 403, /view this folder but not share it/],
      [OWNER, (who) => folderLinks.list(who, '', drive.id), 400, /whole drive/],
      [OWNER, (who) => folderLinks.make(who, { folder: `Nope-${tag}`, filespaceId: drive.id, kind: 'public' }), 404, /no folder/],
      [OWNER, (who) => folderLinks.revoke(who, '../../etc'), 404, /Link not found/],
    ];
    for (const [email, go, status, message] of cases) {
      const phone = await go(app(email));
      const browser = await go(web(email));
      assert.equal(phone.status, status, `${email}: ${JSON.stringify(phone.body)}`);
      assert.match(phone.body.error, message);
      assert.deepEqual(phone, browser, 'the token is held to exactly what the session is');
    }
  });

  test('another file’s link is not found through this one, with a token as with a session', async () => {
    const made1 = await fileLinks.make(app(OWNER), f.cut, request('public', '1'));
    assert.equal(made1.status, 200);
    const token = made1.body.share.token;
    for (const who of [app(OWNER), web(OWNER)]) {
      assert.equal((await fileLinks.level(who, f.pdf, token, 'comment')).status, 404);
      assert.equal((await fileLinks.revoke(who, f.pdf, token)).status, 404);
      assert.equal((await folderLinks.revoke(who, token)).status, 404, 'a file’s link is revoked through the file');
    }
    assert.equal((await fileLinks.revoke(app(OWNER), f.cut, token)).status, 200);
  });

  test('the list and what may be made: the same whether a token or a session asks', async () => {
    for (const email of [OWNER, CONTRIB, BOSS]) {
      const phone = await fileLinks.list(app(email), f.cut);
      const browser = await fileLinks.list(web(email), f.cut);
      assert.equal(phone.status, 200);
      assert.deepEqual(phone.body, browser.body, email);
    }
  });
});

describe('what the list says may be made', { skip }, () => {
  const can = async (email, file = f.cut) => {
    const r = await fileLinks.list(app(email), file);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.can;
  };

  test('a Member’s photo or video: every kind, comments and approvals, any expiry', async () => {
    assert.deepEqual(await can(OWNER), {
      kinds: ['public', 'password', 'private'], review: ['comment', 'approve'], expires: ['never', '1', '7', '30'],
      maxExpiryDays: null, passwordMin: 6,
    });
    assert.deepEqual((await can(OWNER, f.pdf)).review, [], 'only photos and videos take comments through a link');
    assert.deepEqual(await can(BOSS), await can(OWNER), 'an admin, the same');
  });

  test('a Contributor: private links, within the role’s thirty days', async () => {
    assert.deepEqual(await can(CONTRIB), {
      kinds: ['private'], review: [], expires: ['1', '7', '30'], maxExpiryDays: 30, passwordMin: 6,
    });
  });

  test('the drive’s link kinds, the flags and the org’s longest expiry each take away', async () => {
    await db.updateFilespace(drive.id, { shareKinds: ['public'] });
    try {
      const c = await can(OWNER);
      assert.deepEqual(c.kinds, ['public'], 'no password or private link here');
      assert.deepEqual(c.review, [], 'nor a review link');
    } finally {
      await db.updateFilespace(drive.id, { shareKinds: null });
    }
    await db.updateFilespace(drive.id, { shareKinds: [] });
    try {
      assert.deepEqual(await can(OWNER), {
        kinds: [], review: [], expires: [], maxExpiryDays: null, passwordMin: 6, reason: 'Links are turned off for this drive.',
      });
    } finally {
      await db.updateFilespace(drive.id, { shareKinds: null });
    }
    await withSettings({ flags: { shares: false } }, async () => {
      const off = await can(OWNER);
      assert.deepEqual(off.kinds, []);
      assert.equal(off.reason, 'Sharing is turned off.');
    });
    await withSettings({ flags: { review: false } }, async () => {
      assert.deepEqual((await can(OWNER)).review, []);
    });
    await withSettings({ policy: { shareMaxExpiryDays: 7 } }, async () => {
      const c = await can(OWNER);
      assert.deepEqual(c.expires, ['1', '7']);
      assert.equal(c.maxExpiryDays, 7);
      assert.equal((await can(BOSS)).maxExpiryDays, null, 'an admin is held to no expiry');
    });
    await withSettings({ policy: { shareMaxExpiryDays: 0 } }, async () => {
      const c = await can(OWNER);
      assert.deepEqual([c.kinds, c.expires], [[], []], 'no expiry passes, so no link does');
      assert.match(c.reason, /at most 0 days/);
    });
  });

  test('a role that may make no link: said, and the list is still theirs to revoke from', async () => {
    const c = await can(NOLINKS);
    assert.deepEqual([c.kinds, c.review, c.expires], [[], [], []]);
    assert.equal(c.reason, 'Your role cannot make links.');
    // The Viewer role is a viewer in every drive: not even the list.
    const reader = await fileLinks.list(app(READER), f.cut);
    assert.equal(reader.status, 403);
    assert.match(reader.body.error, /view this file but not share it/);
  });

  test('everything offered is made, and nothing else is', async () => {
    const tried = [];
    for (const email of [OWNER, CONTRIB]) {
      for (const file of [f.cut, f.pdf]) {
        for (const kinds of [null, ['public', 'private']]) {
          await db.updateFilespace(drive.id, { shareKinds: kinds });
          try {
            const c = await can(email, file);
            for (const kind of ALL_KINDS) {
              for (const expires of ALL_EXPIRIES) {
                for (const review of [null, 'comment', 'approve']) {
                  const offered = c.kinds.includes(kind) && c.expires.includes(expires)
                    && (!review || (kind !== 'private' && c.review.includes(review)));
                  const r = await fileLinks.make(app(email), file, request(kind, expires, review));
                  tried.push(offered);
                  const what = `${email} ${file.name} drive:${kinds} ${kind} ${expires} ${review}`;
                  if (offered) {
                    assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
                    assert.equal(r.body.share.kind, kind, what);
                  } else {
                    assert.ok([400, 403].includes(r.status), `${what}: ${r.status}`);
                    assert.ok(r.body.error, what);
                  }
                }
              }
            }
          } finally {
            await db.updateFilespace(drive.id, { shareKinds: null });
          }
        }
      }
    }
    assert.ok(tried.some(Boolean) && tried.some((t) => !t), 'both kinds of answer were asked for');
    await db.sql`DELETE FROM file_shares WHERE file_id = ANY(${[f.cut.id, f.pdf.id]})`;
  });
});

describe('a link made, changed and revoked from the phone', { skip }, () => {
  test('made with the token: its maker, where it opens, what it can be changed to, and the audit', async () => {
    const r = await fileLinks.make(app(OWNER), f.cut, request('password', '7', 'comment'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.share;
    assert.equal(s.createdBy, OWNER);
    assert.equal(s.kind, 'password');
    assert.equal(s.review, 'comment');
    assert.equal(s.path, `/s/${s.token}`);
    assert.deepEqual(s.levels, ['view', 'comment', 'approve']);
    assert.ok(!('password' in s) && !('passwordHash' in s) && !('password_hash' in s), 'never the password');
    const [row] = await db.sql`SELECT action, subject_id FROM audit_events WHERE actor = ${OWNER} AND action = 'share.create' ORDER BY at DESC LIMIT 1`;
    assert.equal(row?.subject_id, f.cut.id);

    const listed = await fileLinks.list(app(OWNER), f.cut);
    assert.deepEqual(listed.body.shares.find((x) => x.token === s.token), s, 'listed as it was made');

    const up = await fileLinks.level(app(OWNER), f.cut, s.token, 'approve');
    assert.equal(up.status, 200);
    assert.equal(up.body.share.review, 'approve');
    const down = await fileLinks.level(app(OWNER), f.cut, s.token, 'view');
    assert.equal(down.status, 200);
    assert.equal(down.body.share.review, null);

    const gone = await fileLinks.revoke(app(OWNER), f.cut, s.token);
    assert.equal(gone.status, 200);
    assert.equal(await db.getShareRow(s.token), null);
    const [revoked] = await db.sql`SELECT action FROM audit_events WHERE actor = ${OWNER} AND action = 'share.revoke' ORDER BY at DESC LIMIT 1`;
    assert.equal(revoked?.action, 'share.revoke');
  });

  test('every level a link is offered at is taken, and no other', async () => {
    const made1 = [
      await db.createShare({ fileId: f.cut.id, createdBy: OWNER, mode: 'public', expiresInDays: 7 }),
      await db.createShare({ fileId: f.cut.id, createdBy: OWNER, mode: 'public', expiresInDays: 7, review: 'comment' }),
      await db.createShare({ fileId: f.cut.id, createdBy: OWNER, mode: 'public', password: 'hunter22', review: 'approve' }),
      await db.createShare({ fileId: f.cut.id, createdBy: OWNER, mode: 'private' }),
      await db.createShare({ fileId: f.pdf.id, createdBy: OWNER, mode: 'public', expiresInDays: 1 }),
    ];
    const expired = await db.createShare({ fileId: f.cut.id, createdBy: OWNER, mode: 'public', expiresInDays: 1, review: 'comment' });
    await db.sql`UPDATE file_shares SET expires_at = ${Date.now() - 1000} WHERE token = ${expired.token}`;
    const original = new Map();
    for (const { token } of [...made1, expired]) original.set(token, (await db.getShareRow(token)).review);

    let taken = 0;
    let refused = 0;
    for (const email of [OWNER, CONTRIB, BOSS]) {
      for (const file of [f.cut, f.pdf]) {
        const list = (await fileLinks.list(app(email), file)).body.shares;
        for (const s of list) {
          if (!original.has(s.token)) continue;
          if (s.kind === 'private') assert.deepEqual(s.levels, ['view'], 'a private link takes no comments');
          if (s.token === expired.token) assert.ok(!s.levels.includes('approve'), 'an expired link is opened up no further');
          for (const level of ['view', 'comment', 'approve']) {
            const r = await fileLinks.level(app(email), file, s.token, level);
            const what = `${email} ${s.kind} ${s.review || 'view'} → ${level}`;
            if (s.levels.includes(level)) {
              assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
              taken += 1;
            } else {
              assert.ok([400, 403].includes(r.status), `${what}: ${r.status}`);
              refused += 1;
            }
            await db.sql`UPDATE file_shares SET review = ${original.get(s.token)} WHERE token = ${s.token}`;
          }
        }
      }
    }
    assert.ok(taken > 0 && refused > 0);
    // A Contributor may close a link down, never open one up.
    const contrib = (await fileLinks.list(app(CONTRIB), f.cut)).body.shares.find((s) => s.token === made1[1].token);
    assert.deepEqual(contrib.levels, ['view', 'comment']);
    const owner = (await fileLinks.list(app(OWNER), f.cut)).body.shares;
    assert.deepEqual(owner.find((s) => s.token === made1[0].token).levels, ['view', 'comment', 'approve']);
    assert.deepEqual(owner.find((s) => s.token === expired.token).levels, ['view', 'comment'], 'closed down, never opened up');
    assert.deepEqual((await fileLinks.list(app(OWNER), f.pdf)).body.shares.find((s) => s.token === made1[4].token).levels, ['view'],
      'a document’s link takes no comments');
    await db.sql`DELETE FROM file_shares WHERE file_id = ANY(${[f.cut.id, f.pdf.id]})`;
  });
});

describe('a folder’s links from the phone', { skip }, () => {
  test('listed with what may be made, made, and revoked, with the token', async () => {
    const listed = await folderLinks.list(app(OWNER), 'Cuts', drive.id);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.can, {
      kinds: ['public', 'password'], review: [], expires: ['never', '1', '7', '30'], maxExpiryDays: null, passwordMin: 6,
    });
    const made1 = await folderLinks.make(app(OWNER), { folder: 'Cuts', filespaceId: drive.id, kind: 'password', password: 'hunter22', expires: '30' });
    assert.equal(made1.status, 200, JSON.stringify(made1.body));
    assert.equal(made1.body.share.kind, 'password');
    assert.equal(made1.body.share.createdBy, OWNER);
    assert.equal(made1.body.share.path, `/s/${made1.body.share.token}`);
    assert.deepEqual((await folderLinks.list(app(OWNER), 'Cuts', drive.id)).body.shares.map((s) => s.token), [made1.body.share.token]);
    assert.equal((await folderLinks.revoke(app(OWNER), made1.body.share.token)).status, 200);
    assert.equal(await db.getShareRow(made1.body.share.token), null);

    const contrib = await folderLinks.list(app(CONTRIB), 'Cuts', drive.id);
    assert.equal(contrib.status, 200, 'a Contributor manages the folder’s links');
    assert.deepEqual(contrib.body.can.kinds, []);
    assert.equal(contrib.body.can.reason, 'Your role can make private links only, not public or password ones.');

    const lib = await folderLinks.list(app(LIBED), LIB);
    assert.equal(lib.status, 200, 'a library folder, by its grant');
    assert.deepEqual(lib.body.can.kinds, ['public', 'password']);
  });

  test('everything offered is made, and nothing else is', async () => {
    for (const [email, folder, filespaceId] of [[OWNER, 'Cuts', drive.id], [CONTRIB, 'Cuts', drive.id], [LIBED, LIB, null]]) {
      for (const policy of [{}, { shareMaxExpiryDays: 7 }]) {
        await withSettings({ policy }, async () => {
          const c = (await folderLinks.list(app(email), folder, filespaceId)).body.can;
          for (const kind of ALL_KINDS) {
            for (const expires of ALL_EXPIRIES) {
              const offered = c.kinds.includes(kind) && c.expires.includes(expires);
              const r = await folderLinks.make(app(email), { folder, ...(filespaceId ? { filespaceId } : {}), ...request(kind, expires) });
              const what = `${email} ${folder} ${JSON.stringify(policy)} ${kind} ${expires}`;
              if (offered) assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
              else assert.ok([400, 403].includes(r.status) && r.body.error, `${what}: ${r.status}`);
            }
          }
        });
      }
    }
    await db.sql`DELETE FROM file_shares WHERE kind = 'folder' AND (storage_prefix = ${P} OR folder = ${LIB})`;
  });
});

describe('where Share Link… is offered', { skip }, () => {
  const marked = (r) => r.body.folders.filter((n) => n.share).map((n) => n.folder).sort();

  test('a drive’s tree: every folder for its editors, none for its viewers', async () => {
    const owner = await tree(app(OWNER), drive.id);
    assert.equal(owner.status, 200);
    assert.deepEqual(marked(owner), ['Cuts', 'Cuts/Day 1', 'Docs']);
    assert.deepEqual(owner, await tree(web(OWNER), drive.id), 'the same tree either way in');
    assert.deepEqual(marked(await tree(app(VIEWER), drive.id)), []);
    assert.deepEqual(marked(await tree(app(CONTRIB), drive.id)), ['Cuts', 'Cuts/Day 1', 'Docs'], 'to list and revoke, as on the web');
    for (const n of owner.body.folders) {
      const r = await folderLinks.list(app(OWNER), n.folder, drive.id);
      assert.equal(r.status, 200, `${n.folder}: marked, and the route agrees`);
    }
    for (const n of (await tree(app(VIEWER), drive.id)).body.folders) {
      assert.equal((await folderLinks.list(app(VIEWER), n.folder, drive.id)).status, 403, `${n.folder}: unmarked, and refused`);
    }
  });

  test('the library’s: a folder granted, and what is beneath it; an admin’s, all of it', async () => {
    const lib = await tree(app(LIBED));
    assert.equal(lib.status, 200);
    const mine = marked(lib);
    assert.ok(mine.includes(LIB) && mine.includes(`${LIB}/Sub`), JSON.stringify(mine));
    assert.ok(!mine.includes(`Else-${tag}`));
    for (const n of lib.body.folders.filter((x) => x.folder.includes(tag))) {
      const r = await folderLinks.list(app(LIBED), n.folder);
      assert.equal(r.status, n.share ? 200 : 403, `${n.folder}: the mark and the route agree`);
    }
    const admin = await tree(app(BOSS));
    assert.ok(admin.body.folders.every((n) => n.share === true), 'an admin shares any folder of the library');
    assert.deepEqual(marked(await tree(app(OUTSIDER))), []);
  });

  test('the account says whether it may share at all', async () => {
    assert.equal((await places(app(OWNER))).body.shares, true);
    assert.equal((await places(app(CONTRIB))).body.shares, true, 'private links are links');
    assert.equal((await places(app(READER))).body.shares, false, 'the Viewer role makes none');
    assert.equal((await places(app(NOLINKS))).body.shares, false, 'nor a role with no kind of link');
    await withSettings({ flags: { shares: false } }, async () => {
      assert.equal((await places(app(OWNER))).body.shares, false);
      assert.equal((await places(app(BOSS))).body.shares, false, 'off is off, for an admin too');
    });
  });
});
