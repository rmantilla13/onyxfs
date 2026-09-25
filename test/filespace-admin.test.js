// Filespace management rules: what a filespace may be set up as, who may
// change its members, and what deleting one leaves behind. The two decisions
// are pure; the count runs only with TEST_DATABASE_URL.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

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
const db = await import('../lib/db.js');
const { filespaceSetupProblem, filespaceMemberDecision } = db;

after(async () => { await db.sql.end({ timeout: 5 }).catch(() => {}); });

describe('filespaceSetupProblem', () => {
  const others = [{ id: 'a', name: 'Acme', bucket: 'main', prefix: 'clients/acme' }];

  test('a new, distinct scope is fine', () => {
    assert.equal(filespaceSetupProblem({ name: 'Globex', bucket: 'main', prefix: 'clients/globex' }, others), null);
  });

  test('nesting inside another filespace is allowed', () => {
    // A team space and a client space inside it is a real setup.
    assert.equal(filespaceSetupProblem({ name: 'Acme video', bucket: 'main', prefix: 'clients/acme/video' }, others), null);
  });

  test('same bucket and prefix is the same scope twice', () => {
    const p = filespaceSetupProblem({ name: 'Other', bucket: 'main', prefix: '/clients/acme/' }, others);
    assert.equal(p.status, 409);
    assert.match(p.error, /Acme/);
  });

  test('same prefix in a different bucket is a different scope', () => {
    assert.equal(filespaceSetupProblem({ name: 'Other', bucket: 'archive', prefix: 'clients/acme' }, others), null);
  });

  test('names are unique, case-insensitively', () => {
    assert.equal(filespaceSetupProblem({ name: ' acme ', bucket: 'x', prefix: 'y' }, others).status, 409);
  });

  test('rejects empty, root, relative and reserved prefixes', () => {
    for (const prefix of ['', '/', '///', 'a//b', 'a/../b', './a', '_thumbs', '_trash/x']) {
      const p = filespaceSetupProblem({ name: 'N', bucket: 'b', prefix }, []);
      assert.equal(p?.status, 400, `prefix ${JSON.stringify(prefix)} was accepted`);
    }
    assert.equal(filespaceSetupProblem({ name: '', bucket: 'b', prefix: 'p' }, []).status, 400);
    assert.equal(filespaceSetupProblem({ name: 'x'.repeat(81), bucket: 'b', prefix: 'p' }, []).status, 400);
  });
});

describe('filespaceMemberDecision', () => {
  const admin = { email: 'boss@example.com', isAdmin: true };
  const owner = { email: 'own@example.com', isAdmin: false };
  const base = { targetEmail: 'new@example.com', role: 'editor', grant: true };

  test('admins manage anyone, including people not yet invited', () => {
    assert.equal(filespaceMemberDecision({ ...base, actor: admin, actorRole: 'owner', targetCanSignIn: false }), null);
    assert.equal(filespaceMemberDecision({ ...base, actor: admin, targetEmail: admin.email, grant: false }), null);
  });

  test('owners manage members of their filespace', () => {
    assert.equal(filespaceMemberDecision({ ...base, actor: owner, actorRole: 'owner' }), null);
    assert.equal(filespaceMemberDecision({ ...base, actor: owner, actorRole: 'owner', role: 'owner' }), null);
    assert.equal(filespaceMemberDecision({ ...base, actor: owner, actorRole: 'owner', grant: false }), null);
  });

  test('editors and viewers do not', () => {
    for (const actorRole of ['editor', 'viewer', null]) {
      assert.equal(filespaceMemberDecision({ ...base, actor: owner, actorRole }).status, 403);
    }
  });

  test('an owner cannot change their own grant', () => {
    const d = filespaceMemberDecision({ ...base, actor: owner, actorRole: 'owner', targetEmail: 'OWN@example.com', role: 'viewer' });
    assert.equal(d.status, 403);
    assert.equal(filespaceMemberDecision({ ...base, actor: owner, actorRole: 'owner', targetEmail: owner.email, grant: false }).status, 403);
  });

  test('an owner can only add people who can sign in', () => {
    assert.equal(filespaceMemberDecision({ ...base, actor: owner, actorRole: 'owner', targetCanSignIn: false }).status, 400);
    // Removing a stale grant for such an address is still fine.
    assert.equal(filespaceMemberDecision({ ...base, actor: owner, actorRole: 'owner', targetCanSignIn: false, grant: false }), null);
  });

  test('admins are never stored as grants, and roles are checked', () => {
    assert.equal(filespaceMemberDecision({ ...base, actor: admin, targetIsAdmin: true }).status, 400);
    assert.equal(filespaceMemberDecision({ ...base, actor: admin, role: 'superuser' }).status, 400);
    assert.equal(filespaceMemberDecision({ ...base, actor: admin, targetEmail: 'not-an-email' }).status, 400);
  });
});

test('countFilesUnderPrefix counts only live files under that exact prefix', { skip: !live && 'TEST_DATABASE_URL not reachable' }, async () => {
  const T = `fs_${Date.now().toString(36)}`;
  const mk = (key, size = 10) => db.createFile({
    name: key.slice(key.lastIndexOf('/') + 1), url: `http://s3.test/b/${key}`, mime: 'text/plain',
    size, folder: '', storage: 's3', storageKey: key, createdBy: 'test@example.com',
  });
  try {
    await mk(`${T}/a_b/one.txt`, 5);
    await mk(`${T}/a_b/sub/two.txt`, 7);
    const gone = await mk(`${T}/a_b/three.txt`, 100);
    await db.softDeleteFile(gone.id);
    // `_` is a LIKE wildcard: "a_b" must not take in "axb", and the prefix
    // must not match a sibling that merely starts with it.
    await mk(`${T}/axb/four.txt`, 1000);
    await mk(`${T}/a_bc/five.txt`, 1000);
    assert.deepEqual(await db.countFilesUnderPrefix(`/${T}/a_b/`), { files: 2, bytes: 12 });
    assert.deepEqual(await db.countFilesUnderPrefix(''), { files: 0, bytes: 0 });
  } finally {
    await db.sql`DELETE FROM files WHERE storage_key LIKE ${T + '/%'}`.catch(() => {});
  }
});
