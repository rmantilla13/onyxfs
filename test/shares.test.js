// Share links: the three kinds, their passwords, the unlock cookie, and the
// sign-in return path a private link depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  newShareToken, hashSharePassword, verifySharePassword,
  shareCookieName, shareCookieValue, shareCookieValid, shareState,
  MAX_PASSWORD_FAILURES,
} from '../lib/shares.js';
import { parseShareRequest, shareKind, isShareToken, expiryLabel, MIN_PASSWORD } from '../lib/share-kinds.js';
import { safeReturnPath } from '../lib/return-path.js';

test('tokens are 128-bit and URL-safe; old 12-hex tokens still pass the shape check', () => {
  const t = newShareToken();
  assert.match(t, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(newShareToken(), t);
  assert.ok(isShareToken(t));
  assert.ok(isShareToken('0123456789ab'));
  assert.ok(!isShareToken('../etc/passwd'));
  assert.ok(!isShareToken(''));
  assert.ok(!isShareToken('x'.repeat(65)));
});

test('passwords are salted scrypt, and verify', async () => {
  const a = await hashSharePassword('correct horse');
  const b = await hashSharePassword('correct horse');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(a, b, 'a salt per link: the same password never hashes the same twice');
  assert.equal(await verifySharePassword('correct horse', a), true);
  assert.equal(await verifySharePassword('correct horsE', a), false);
  assert.equal(await verifySharePassword('', a), false);
});

test('a link made before scrypt (unsalted SHA-256) still opens with its password', async () => {
  const legacy = createHash('sha256').update('hunter22').digest('hex');
  assert.equal(await verifySharePassword('hunter22', legacy), true);
  assert.equal(await verifySharePassword('hunter23', legacy), false);
  assert.equal(await verifySharePassword('hunter22', 'not-a-hash'), false);
  assert.equal(await verifySharePassword('hunter22', null), false);
});

test('the unlock cookie is bound to the token, the password hash and the secret', () => {
  const secret = 'test-secret';
  const v = shareCookieValue('tok', 'hash1', secret);
  assert.equal(shareCookieName('tok'), 'onyx_share_tok');
  assert.ok(shareCookieValid(v, 'tok', 'hash1', secret));
  assert.ok(!shareCookieValid(v, 'tok', 'hash2', secret), 'a changed password locks out the old cookie');
  assert.ok(!shareCookieValid(v, 'other', 'hash1', secret), 'one link\'s cookie does not open another');
  assert.ok(!shareCookieValid(v, 'tok', 'hash1', 'other-secret'));
  assert.ok(!shareCookieValid(`${v}x`, 'tok', 'hash1', secret));
  assert.ok(!shareCookieValid('', 'tok', 'hash1', secret));
  assert.throws(() => shareCookieValue('tok', 'hash1', ''), /AUTH_SECRET/);
});

test('a link is missing, expired, locked or ok', () => {
  const now = 1_000_000;
  assert.equal(shareState(null, now), 'missing');
  assert.equal(shareState({ expires_at: now - 1 }, now), 'expired');
  assert.equal(shareState({ expires_at: now }, now), 'expired');
  assert.equal(shareState({ expires_at: now + 1, pw_locked_until: now + 5 }, now), 'locked');
  assert.equal(shareState({ pw_locked_until: now - 5 }, now), 'ok');
  assert.equal(shareState({}, now), 'ok');
  assert.ok(MAX_PASSWORD_FAILURES >= 5);
});

test('a stored row presents as public, password or private', () => {
  assert.equal(shareKind({ mode: 'public' }), 'public');
  assert.equal(shareKind({ mode: 'public', password_hash: 'x' }), 'password');
  assert.equal(shareKind({ mode: 'public', hasPassword: true }), 'password');
  assert.equal(shareKind({ mode: 'private' }), 'private');
  assert.equal(shareKind({}), 'public');
});

test('a create request is checked before anything is stored', () => {
  assert.deepEqual(parseShareRequest({ kind: 'public' }), { mode: 'public', password: null, expiresInDays: null });
  assert.deepEqual(parseShareRequest({ kind: 'private', expires: '7' }), { mode: 'private', password: null, expiresInDays: 7 });
  assert.deepEqual(parseShareRequest({ kind: 'password', password: 'abcdef', expires: '1' }), { mode: 'public', password: 'abcdef', expiresInDays: 1 });
  assert.match(parseShareRequest({ kind: 'password', password: 'abc' }).error, new RegExp(String(MIN_PASSWORD)));
  assert.match(parseShareRequest({ kind: 'everyone' }).error, /who/);
  assert.match(parseShareRequest({ kind: 'public', expires: '365' }).error, /expires/);
  // A private link never takes a password, even if one is sent.
  assert.equal(parseShareRequest({ kind: 'private', password: 'abcdef' }).password, null);
});

test('expiry reads as a person would say it', () => {
  const now = 0;
  assert.equal(expiryLabel(null, now), null);
  assert.equal(expiryLabel(-1, now), 'Expired');
  assert.equal(expiryLabel(3600000, now), 'Expires in 1 hour');
  assert.equal(expiryLabel(7 * 86400000, now), 'Expires in 7 days');
});

test('after sign-in, only a path on this site is ever returned to', () => {
  assert.equal(safeReturnPath('/s/abc'), '/s/abc');
  assert.equal(safeReturnPath('/files?folder=a%2Fb#x'), '/files?folder=a%2Fb#x');
  // The middleware hands over a full URL: keep its path, never its host.
  assert.equal(safeReturnPath('http://localhost:3000/files?folder=a'), '/files?folder=a');
  assert.equal(safeReturnPath('https://evil.example/steal'), '/steal');
  assert.equal(safeReturnPath('//evil.example'), null);
  assert.equal(safeReturnPath('/\\evil.example'), null);
  assert.equal(safeReturnPath('javascript:alert(1)'), null);
  assert.equal(safeReturnPath(''), null);
  assert.equal(safeReturnPath(undefined), null);
});
