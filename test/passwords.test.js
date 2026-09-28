// Sign-in passwords, for the accounts an admin gives one (App Review's): how
// they are made and checked, who may have one, and where the code may live.
// The database half — the lockout, replacing and removing one — runs in
// test/password-signin-db.test.js when TEST_DATABASE_URL is set.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// No database: authorizePassword must refuse cleanly without one.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.ADMIN_EMAILS = 'admin@example.com';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { newPassword, hashPassword, verifyPassword, MAX_SIGN_IN_FAILURES, SIGN_IN_LOCK_MS } = await import('../lib/passwords.js');
const { passwordCheckable, passwordTargetProblem, authorizePassword } = await import('../lib/password-signin.js');

describe('a made password', () => {
  test('four groups of four, in lower-case Crockford base32: nothing reads as something else', () => {
    for (let i = 0; i < 200; i++) {
      const p = newPassword();
      assert.match(p, /^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/, p);
      assert.doesNotMatch(p, /[ilou]/);
    }
  });

  test('random: no two alike, and every character turns up', () => {
    const seen = new Set();
    const chars = new Set();
    for (let i = 0; i < 2000; i++) {
      const p = newPassword();
      assert.ok(!seen.has(p), 'a repeat');
      seen.add(p);
      for (const c of p.replace(/-/g, '')) chars.add(c);
    }
    assert.equal(chars.size, 32, 'the whole alphabet, so every character carries its five bits');
  });
});

describe('hashing and checking', () => {
  test('salted scrypt, in the format share links keep', async () => {
    const a = await hashPassword('k7m2-qr8v-xd3h-fnpw');
    const b = await hashPassword('k7m2-qr8v-xd3h-fnpw');
    assert.match(a, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b, 'a salt of its own each time');
    assert.equal(await verifyPassword('k7m2-qr8v-xd3h-fnpw', a), true);
    assert.equal(await verifyPassword('k7m2-qr8v-xd3h-fnpX', a), false);
    assert.equal(await verifyPassword('K7M2-QR8V-XD3H-FNPW', a), false, 'exactly as made');
    assert.equal(await verifyPassword('', a), false);
  });

  test('anything but an scrypt hash is a no, and never a throw', async () => {
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update('hunter22').digest('hex');
    assert.equal(await verifyPassword('hunter22', sha), false, 'the unsalted form old share links kept is not a sign-in password');
    for (const stored of [null, undefined, '', 'scrypt$', 'scrypt$16384$8$1$$', 'scrypt$3$8$1$c2FsdA$aGFzaA', 'plain']) {
      assert.equal(await verifyPassword('hunter22', stored), false, String(stored));
    }
    assert.equal(await verifyPassword(undefined, await hashPassword('x')), false);
  });

  test('share links still verify through the same code', async () => {
    const { hashSharePassword, verifySharePassword } = await import('../lib/shares.js');
    const h = await hashSharePassword('correct horse');
    assert.equal(await verifyPassword('correct horse', h), true);
    assert.equal(await verifySharePassword('correct horse', await hashPassword('correct horse')), true);
  });
});

describe('who a password is checked for', () => {
  const record = { hash: 'scrypt$…', failures: 0, lockedUntil: null };
  const now = 1_000_000;

  test('never an admin, whatever is stored', () => {
    assert.equal(passwordCheckable({ record, admin: true, now }), 'admin');
    assert.equal(passwordCheckable({ record: null, admin: true, now }), 'admin');
  });

  test('only an address with a password', () => {
    assert.equal(passwordCheckable({ record: null, now }), 'no-password');
    assert.equal(passwordCheckable({ record: { ...record, hash: '' }, now }), 'no-password');
    assert.equal(passwordCheckable({ record, now }), 'ok');
  });

  test('not while it is locked, and again once the lock has passed', () => {
    assert.equal(passwordCheckable({ record: { ...record, lockedUntil: now + 1 }, now }), 'locked');
    assert.equal(passwordCheckable({ record: { ...record, lockedUntil: now }, now }), 'ok');
    assert.equal(passwordCheckable({ record: { ...record, lockedUntil: now - 1 }, now }), 'ok');
  });

  test('ten wrong in a row lock it for fifteen minutes', () => {
    assert.equal(MAX_SIGN_IN_FAILURES, 10);
    assert.equal(SIGN_IN_LOCK_MS, 15 * 60 * 1000);
  });
});

describe('who an admin may give one', () => {
  test('someone who may sign in, and is not an admin', () => {
    assert.equal(passwordTargetProblem({ email: 'review@example.com', approved: true }), null);
  });

  test('never an admin: the panel stays behind proof of the inbox', () => {
    const p = passwordTargetProblem({ email: 'admin@example.com', admin: true, approved: true });
    assert.equal(p.status, 400);
    assert.match(p.error, /emailed link/);
  });

  test('not someone who cannot sign in, nor something that is not an address', () => {
    assert.equal(passwordTargetProblem({ email: 'gone@example.com', approved: false }).status, 400);
    assert.equal(passwordTargetProblem({ email: 'nobody', approved: true }).status, 400);
    assert.equal(passwordTargetProblem({ email: '', approved: true }).status, 400);
  });
});

describe('signing in with one', () => {
  test('refuses, without a throw, what cannot be a sign-in', async () => {
    for (const creds of [
      undefined, {}, { email: 'a@example.com' }, { password: 'x' },
      { email: 'not-an-address', password: 'x' },
      { email: 'a@example.com', password: 42 },
      { email: `${'a'.repeat(320)}@example.com`, password: 'x' },
      { email: 'a@example.com', password: 'x'.repeat(201) },
    ]) {
      assert.equal(await authorizePassword(creds), null, JSON.stringify(creds)?.slice(0, 60));
    }
  });

  test('refuses an address with no password — here, with no database at all', async () => {
    assert.equal(await authorizePassword({ email: 'someone@example.com', password: 'k7m2-qr8v-xd3h-fnpw' }), null);
    assert.equal(await authorizePassword({ email: 'admin@example.com', password: 'k7m2-qr8v-xd3h-fnpw' }), null);
  });
});

describe('where it lives', () => {
  const read = (p) => readFileSync(join(root, p), 'utf8');

  test('auth.js offers it as the "password" provider, checked by lib/password-signin.js', () => {
    const src = read('auth.js');
    assert.match(src, /Credentials\(\{\s*id: 'password'/);
    assert.match(src, /authorize: authorizePassword/);
  });

  test('the Edge half of the auth config stays clear of it (node:crypto and the database)', () => {
    const src = read('auth.config.js');
    assert.doesNotMatch(src, /password-signin|lib\/passwords|Credentials/);
    assert.doesNotMatch(read('middleware.js'), /password-signin|lib\/passwords/);
  });

  test('the sign-in page offers it, and carries the return path through it', () => {
    const client = read('app/signin/SignInClient.js');
    assert.match(client, /signInWithPassword/);
    assert.match(client, /name="password"/);
    assert.match(client, /autoComplete="current-password"/);
    // The app's /space/authorize comes back through callbackUrl: the password
    // form needs it as much as the link form does.
    const forms = client.split('<form').slice(1);
    const passwordForm = forms.find((f) => f.includes('submitPassword'));
    assert.ok(passwordForm, 'the password form');
    assert.match(passwordForm, /name="callbackUrl"/);
  });

  test('the hash stays on the server: nothing lists or shapes a person with it', () => {
    const db = read('lib/db.js');
    const holders = db.slice(db.indexOf('export async function listSignInPasswordHolders'));
    assert.doesNotMatch(holders.slice(0, holders.indexOf('\n}\n')), /password_hash/);
    const shape = db.slice(db.indexOf('export function shapePerson'));
    assert.doesNotMatch(shape.slice(0, shape.indexOf('\n}\n')), /password/);
  });
});
