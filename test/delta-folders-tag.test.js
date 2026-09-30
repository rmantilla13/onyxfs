// The sync feed's folder list, sent only when it changed. A drive mounted on
// a Mac asks /api/files/delta every few seconds with folders=1, and was sent
// the drive's whole folder list each time. Now each page carries a digest of
// the list (foldersTag); a client that sends back the one it holds, while it
// still matches, is sent the tag alone and keeps its list. A client that
// sends none — every one from before this — gets the list every time.
//
// The route runs for real, behind the real desktop guard; lib/db.js is the
// in-memory store of test/fixtures/delta-stubs.mjs.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { foldersTag } from '../lib/sync-scope.js';

process.env.ADMIN_EMAILS = 'boss@delta.test';
process.env.SUPER_ADMIN_EMAILS = '';
process.env.AUTH_SECRET = 'delta-folders-test-secret-0123456789abcdef';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const DB_STUB = new URL('./fixtures/delta-stubs.mjs', import.meta.url).href;
const STORE = new URL('./fixtures/mac-writes-stubs.mjs', import.meta.url).href;
const AUTH_STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH_STUB, shortCircuit: true };
    const r = next(specifier, context);
    // lib/db.js however it is named — except to the store, which borrows the
    // real module's pure rules.
    if (r.url.endsWith('/lib/db.js') && context.parentURL !== STORE && context.parentURL !== DB_STUB) {
      return { url: DB_STUB, shortCircuit: true };
    }
    return r;
  },
});

const route = await import('../app/api/files/delta/route.js');

const STORAGE = { provider: 's3', bucket: 'onyx', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', endpoint: 'http://s3.test', prefix: 'files' };
const D1 = { id: 'd1', name: 'Team', bucket: 'onyx', prefix: 'team', region: 'us-east-1' };
const BOSS = 'boss@delta.test';
const ED = 'ed@delta.test';

function reset() {
  globalThis.__mw = {
    now: Date.now(), seq: 100, session: null,
    settings: new Map([['storage.config', STORAGE]]),
    people: new Map(), invites: new Set(), tokens: new Map(), drives: [D1], grants: new Map(), acl: new Map(),
    files: new Map(), folders: new Map(), uploads: new Map(), uploadKeys: new Map(), transcripts: new Map(),
    audit: [], tombstones: [],
    syncFolders: { team: ['Cuts', 'Cuts/Day 1', 'Empty'], '': ['Archive', 'Archive/2019'] },
    folderReads: 0,
  };
  for (const email of [BOSS, ED]) {
    globalThis.__mw.people.set(email, { id: randomUUID(), email, roleId: 'member', status: 'active', quotaBytes: null, maxUploadBytes: null });
    globalThis.__mw.invites.add(email);
  }
  globalThis.__mw.grants.set(`d1|${ED}`, 'editor');
}
beforeEach(reset);

function tokenFor(email) {
  const raw = `dt_live_${randomUUID()}`;
  globalThis.__mw.tokens.set(raw, { id: randomUUID(), email, expiresAt: globalThis.__mw.now + 86400_000 });
  return raw;
}

async function delta(token, query) {
  const res = await route.GET(new Request(`http://app.test/api/files/delta?${new URLSearchParams(query)}`, {
    headers: { authorization: `Bearer ${token}` },
  }));
  return { status: res.status, body: await res.json() };
}

describe('the folder list rides along only when it changed', () => {
  test('without a tag, the list comes every time, with the tag for it', async () => {
    const ed = tokenFor(ED);
    for (let i = 0; i < 2; i++) {
      const r = await delta(ed, { cursor: '0', drive: 'd1', folders: '1' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.folders, ['Cuts', 'Cuts/Day 1', 'Empty'], 'an older client is sent the list as before');
      assert.equal(r.body.foldersTag, foldersTag(['Cuts', 'Cuts/Day 1', 'Empty']));
    }
  });

  test('the tag handed back, still matching, is answered with the tag alone', async () => {
    const ed = tokenFor(ED);
    const first = await delta(ed, { cursor: '0', drive: 'd1', folders: '1' });
    const again = await delta(ed, { cursor: String(first.body.cursor), drive: 'd1', folders: '1', foldersTag: first.body.foldersTag });
    assert.equal(again.status, 200);
    assert.equal('folders' in again.body, false, 'not sent: the client keeps the list it has');
    assert.equal(again.body.foldersTag, first.body.foldersTag);
    assert.equal(again.body.cursor, first.body.cursor, 'the page itself is the same');
    assert.equal(again.body.scope, first.body.scope);
  });

  test('a folder made, renamed or removed since moves the tag, and the list comes whole', async () => {
    const ed = tokenFor(ED);
    const first = await delta(ed, { cursor: '0', drive: 'd1', folders: '1' });
    globalThis.__mw.syncFolders.team.push('Selects');
    const made = await delta(ed, { cursor: '0', drive: 'd1', folders: '1', foldersTag: first.body.foldersTag });
    assert.deepEqual(made.body.folders, ['Cuts', 'Cuts/Day 1', 'Empty', 'Selects']);
    assert.notEqual(made.body.foldersTag, first.body.foldersTag);

    globalThis.__mw.syncFolders.team = ['Cuts', 'Cuts/Day 1', 'Empty'];
    const removed = await delta(ed, { cursor: '0', drive: 'd1', folders: '1', foldersTag: made.body.foldersTag });
    assert.deepEqual(removed.body.folders, ['Cuts', 'Cuts/Day 1', 'Empty'], 'an empty list is a list too');
    assert.equal(removed.body.foldersTag, first.body.foldersTag, 'the same folders, the same tag');

    const renamed = await delta(ed, { cursor: '0', drive: 'd1', folders: '1', foldersTag: removed.body.foldersTag });
    assert.equal('folders' in renamed.body, false);
    globalThis.__mw.syncFolders.team = ['Cuts', 'Cuts/Day 2', 'Empty'];
    const after = await delta(ed, { cursor: '0', drive: 'd1', folders: '1', foldersTag: removed.body.foldersTag });
    assert.deepEqual(after.body.folders, ['Cuts', 'Cuts/Day 2', 'Empty']);
  });

  test('a tag that is not the list’s — made up, old, empty — gets the list', async () => {
    const ed = tokenFor(ED);
    for (const tag of ['nonsense', '', foldersTag([]), 'a'.repeat(32)]) {
      const r = await delta(ed, { cursor: '0', drive: 'd1', folders: '1', foldersTag: tag });
      assert.deepEqual(r.body.folders, ['Cuts', 'Cuts/Day 1', 'Empty'], JSON.stringify(tag));
    }
  });

  test('each caller’s own list, as narrowed for them, is what the tag is of', async () => {
    // The library's folders: an admin sees them all, a member only what a
    // grant gives them (none here). The admin's tag is not the member's.
    const boss = tokenFor(BOSS), ed = tokenFor(ED);
    const all = await delta(boss, { cursor: '0', drive: 'library', folders: '1' });
    assert.deepEqual(all.body.folders, ['Archive', 'Archive/2019']);
    const narrowed = await delta(ed, { cursor: '0', drive: 'library', folders: '1', foldersTag: all.body.foldersTag });
    assert.deepEqual(narrowed.body.folders, [], 'sent: their list is not the one the tag was of');
    assert.equal(narrowed.body.foldersTag, foldersTag([]));
  });

  test('without folders=1 nothing about folders is read or sent, a tag or not', async () => {
    const ed = tokenFor(ED);
    const r = await delta(ed, { cursor: '0', drive: 'd1', foldersTag: foldersTag(['Cuts']) });
    assert.equal(r.status, 200);
    assert.equal('folders' in r.body, false);
    assert.equal('foldersTag' in r.body, false);
    assert.equal(globalThis.__mw.folderReads, 0);
  });

  test('a quiet pass over a drive of thousands of folders is a few hundred bytes', async () => {
    const ed = tokenFor(ED);
    globalThis.__mw.syncFolders.team = Array.from({ length: 5000 }, (_, i) => `Projects/Client ${i % 50}/Shoot ${i}`);
    const full = await route.GET(new Request(`http://app.test/api/files/delta?${new URLSearchParams({ cursor: '100', drive: 'd1', folders: '1' })}`, {
      headers: { authorization: `Bearer ${ed}` },
    }));
    const fullBody = await full.text();
    const { foldersTag: tag } = JSON.parse(fullBody);
    const quiet = await route.GET(new Request(`http://app.test/api/files/delta?${new URLSearchParams({ cursor: '100', drive: 'd1', folders: '1', foldersTag: tag })}`, {
      headers: { authorization: `Bearer ${ed}` },
    }));
    const quietBody = await quiet.text();
    // 158 KB with the list, 127 bytes without, when this was written.
    assert.ok(fullBody.length > 100_000, `${fullBody.length} bytes with the list`);
    assert.ok(quietBody.length < 500, `${quietBody.length} bytes with the tag held`);
  });

  test('a drive the caller may not open is still a 404, whatever tag it sends', async () => {
    globalThis.__mw.drives.push({ id: 'd2', name: 'Studio', bucket: 'onyx', prefix: 'studio' });
    const ed = tokenFor(ED);
    const r = await delta(ed, { cursor: '0', drive: 'd2', folders: '1', foldersTag: foldersTag([]) });
    assert.equal(r.status, 404);
    assert.equal(globalThis.__mw.folderReads, 0);
  });
});

describe('the tag', () => {
  test('is of the names as a set: the order they are read in does not move it', () => {
    assert.equal(foldersTag(['b', 'a', 'a/c']), foldersTag(['a', 'a/c', 'b']));
    assert.equal(foldersTag([]), foldersTag());
  });

  test('moves with any name added, removed or changed — case and spaces included', () => {
    const seen = new Set([
      foldersTag(['a', 'b']), foldersTag(['a']), foldersTag(['a', 'b', 'c']), foldersTag(['a', 'B']),
      foldersTag(['a', 'b ']), foldersTag(['a/b']), foldersTag([]), foldersTag(['ab']),
    ]);
    assert.equal(seen.size, 8);
  });

  test('cannot be made to match by moving a name across the boundary between two', () => {
    assert.notEqual(foldersTag(['a,b']), foldersTag(['a', 'b']));
    assert.notEqual(foldersTag(['a"', 'b']), foldersTag(['a', '"b']));
  });
});
