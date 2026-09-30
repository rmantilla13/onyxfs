// Sign-in passwords against a real Postgres: signing in with one, the
// lockout, replacing and removing one, and what removing the person takes.
// The rules without a database are test/passwords.test.js.
//
// Runs only with TEST_DATABASE_URL (a database you can write to), and skips
// cleanly without one, like the other database tests. Every row it makes is
// tagged with a random suffix and removed at the end.

import { test, describe, before, after } from 'node:test';
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
const describeDb = live ? describe : describe.skip;

const T = `t${Math.random().toString(36).slice(2, 8)}`;
const at = (name) => `${name}.${T}@example.com`;
const ADMIN = at('admin');

describeDb('sign-in passwords (database)', () => {
  let db, passwords, signin, allowlist;
  const made = new Set();

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.ADMIN_EMAILS = ADMIN;
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    assert.deepEqual(results.filter((r) => !r.ok), [], 'every guard runs on this database');
    passwords = await import('../lib/passwords.js');
    signin = await import('../lib/password-signin.js');
    allowlist = await import('../lib/auth-allowlist.js');
  });

  after(async () => {
    if (!db) return;
    for (const e of made) {
      await db.removePerson(e, { apply: true }).catch(() => {});
      await db.sql`DELETE FROM sign_in_passwords WHERE email = ${e}`.catch(() => {});
    }
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  /** An approved person with a made password → { email, password }. */
  async function withPassword(name) {
    const email = at(name);
    made.add(email);
    await db.adminAddApprovedInvite({ email, reviewedBy: ADMIN });
    await db.upsertPerson(email);
    const password = passwords.newPassword();
    await db.setSignInPassword(email, { hash: await passwords.hashPassword(password), by: ADMIN });
    return { email, password };
  }

  const stored = (email) => db.getSignInPassword(email);

  test('the right password signs in as the person an emailed link would', async () => {
    const { email, password } = await withPassword('review');
    const user = await signin.authorizePassword({ email: `  ${email.toUpperCase()} `, password });
    assert.ok(user, 'signed in');
    assert.equal(user.email, email, 'the address as the gate reads it');
    const [row] = await db.sql`SELECT id FROM "user" WHERE lower(email) = ${email}`;
    assert.equal(user.id, row.id, 'the Auth.js user row, so either way in carries one id');
    assert.equal(await allowlist.isEmailGrantedAccess(email), true, 'and the signIn callback lets them through');
  });

  test('a wrong one is counted, and the right one clears the count', async () => {
    const { email, password } = await withPassword('count');
    assert.equal(await signin.authorizePassword({ email, password: 'nope-nope-nope-nope' }), null);
    assert.equal(await signin.authorizePassword({ email, password: 'nope-nope-nope-nope' }), null);
    assert.equal((await stored(email)).failures, 2);
    assert.ok(await signin.authorizePassword({ email, password }));
    assert.equal((await stored(email)).failures, 0);
  });

  test('ten wrong in a row lock it, even against the right one, until the lock passes', async () => {
    const { email, password } = await withPassword('lock');
    for (let i = 0; i < passwords.MAX_SIGN_IN_FAILURES; i++) {
      assert.equal(await signin.authorizePassword({ email, password: `wrong-${i}` }), null);
    }
    const locked = await stored(email);
    assert.ok(locked.lockedUntil > Date.now() + passwords.SIGN_IN_LOCK_MS - 60_000, 'locked for the full time');
    assert.equal(locked.failures, 0, 'the count starts again under the lock');

    assert.equal(await signin.authorizePassword({ email, password }), null, 'the right password waits too');
    assert.equal(await signin.authorizePassword({ email, password: 'wrong-again' }), null);
    assert.equal((await stored(email)).failures, 0, 'nothing is counted while it is locked');

    await db.sql`UPDATE sign_in_passwords SET locked_until = ${Date.now() - 1} WHERE email = ${email}`;
    assert.ok(await signin.authorizePassword({ email, password }), 'open again once the lock has passed');
    assert.equal((await stored(email)).lockedUntil, null);
  });

  test('guesses racing each other cannot all slip in under the limit', async () => {
    const { email } = await withPassword('race');
    await Promise.all(Array.from({ length: passwords.MAX_SIGN_IN_FAILURES }, () => db.recordSignInPasswordFailure(email)));
    assert.ok((await stored(email)).lockedUntil > Date.now(), 'the tenth, whichever it was, locked it');
  });

  test('a new password replaces the old one at once, and lifts a lock', async () => {
    const { email, password } = await withPassword('replace');
    await db.sql`UPDATE sign_in_passwords SET failures = 4, locked_until = ${Date.now() + 60_000} WHERE email = ${email}`;
    const next = passwords.newPassword();
    await db.setSignInPassword(email, { hash: await passwords.hashPassword(next), by: ADMIN });
    assert.equal(await signin.authorizePassword({ email, password }), null, 'the old one is gone');
    assert.ok(await signin.authorizePassword({ email, password: next }));
    const s = await stored(email);
    assert.equal(s.failures, 0);
    assert.equal(s.lockedUntil, null);
  });

  test('an admin never signs in with one, even one written straight into the table', async () => {
    made.add(ADMIN);
    const password = passwords.newPassword();
    await db.setSignInPassword(ADMIN, { hash: await passwords.hashPassword(password), by: 'someone' });
    assert.equal(await signin.authorizePassword({ email: ADMIN, password }), null);
    assert.equal((await stored(ADMIN)).failures, 0, 'refused before it is checked, so not even counted');
  });

  test('an address with no password, or none at all, is refused', async () => {
    const email = at('nopassword');
    made.add(email);
    await db.adminAddApprovedInvite({ email, reviewedBy: ADMIN });
    assert.equal(await signin.authorizePassword({ email, password: passwords.newPassword() }), null);
    assert.equal(await signin.authorizePassword({ email: at('stranger'), password: passwords.newPassword() }), null);
  });

  test('suspending the person shuts the gate behind a right password', async () => {
    const { email, password } = await withPassword('suspend');
    await db.setPersonStatus(email, { status: 'suspended', by: ADMIN });
    assert.ok(await signin.authorizePassword({ email, password }), 'the password itself is right…');
    assert.equal(await allowlist.isEmailGrantedAccess(email), false, '…and the signIn callback refuses them');
  });

  test('the admin list says who has one, and never the hash', async () => {
    const { email } = await withPassword('listed');
    const holders = await db.listSignInPasswordHolders();
    const mine = holders.find((h) => h.email === email);
    assert.ok(mine);
    assert.deepEqual(Object.keys(mine).sort(), ['email', 'setAt', 'setBy']);
    assert.equal(mine.setBy, ADMIN);
    assert.ok(!JSON.stringify(holders).includes('scrypt$'));
  });

  test('taking it away, and removing the person, leave no password behind', async () => {
    const a = await withPassword('remove');
    assert.equal(await db.removeSignInPassword(a.email), true);
    assert.equal(await db.removeSignInPassword(a.email), false, 'nothing left to remove');
    assert.equal(await signin.authorizePassword(a), null);

    const b = await withPassword('removeperson');
    await db.removePerson(b.email, { apply: true });
    assert.equal(await stored(b.email), null);
    assert.equal(await signin.authorizePassword(b), null);
  });
});
