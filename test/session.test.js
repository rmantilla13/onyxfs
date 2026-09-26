// Whether a signed-in session still counts (lib/session.js sessionDecision).
//
// Auth.js's JWT stays valid until it expires, which is why revoking someone
// used to leave their browser signed in for weeks. These are the four ways a
// valid-looking session is refused now, and the cases that must not be.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
const { sessionDecision } = await import('../lib/session.js');

const row = (over = {}) => ({
  person: { email: 'm@example.com', status: 'active', sessionsValidAfter: null },
  inviteStatus: 'approved',
  deviceOk: true,
  ...over,
});

describe('sessionDecision', () => {
  test('an approved, active person with a current session is in', () => {
    assert.deepEqual(sessionDecision({ email: 'm@example.com', authAt: 1000, row: row() }), { ok: true });
  });

  test('no email, no session', () => {
    assert.equal(sessionDecision({ email: '', row: row() }).reason, 'no-session');
  });

  test('suspended → out', () => {
    const d = sessionDecision({ email: 'm@example.com', authAt: 5000, row: row({ person: { status: 'suspended' } }) });
    assert.deepEqual(d, { ok: false, reason: 'suspended' });
  });

  test('a session that began before the cutoff → out; after it → in', () => {
    const r = row({ person: { status: 'active', sessionsValidAfter: 2000 } });
    assert.equal(sessionDecision({ email: 'm@example.com', authAt: 1999, row: r }).reason, 'signed-out');
    assert.equal(sessionDecision({ email: 'm@example.com', authAt: 2000, row: r }).ok, true);
    assert.equal(sessionDecision({ email: 'm@example.com', authAt: 2500, row: r }).ok, true);
  });

  test('a token from before authAt existed counts as 0 — out, once a cutoff is set', () => {
    const r = row({ person: { status: 'active', sessionsValidAfter: 1 } });
    assert.equal(sessionDecision({ email: 'm@example.com', authAt: undefined, row: r }).reason, 'signed-out');
    // …and in, while none is: nobody is signed out by the upgrade itself.
    assert.equal(sessionDecision({ email: 'm@example.com', authAt: undefined, row: row() }).ok, true);
  });

  test('the Mac app’s web view ends with the device token it came from', () => {
    const d = sessionDecision({ email: 'm@example.com', authAt: 5000, deviceTokenId: 'dt1', row: row({ deviceOk: false }) });
    assert.equal(d.reason, 'device-revoked');
    // A plain browser session has no device, so a revoked device is not its business.
    assert.equal(sessionDecision({ email: 'm@example.com', authAt: 5000, row: row({ deviceOk: false }) }).ok, true);
  });

  test('no longer approved → out (invite denied, request deleted)', () => {
    for (const inviteStatus of ['denied', 'pending', null]) {
      assert.equal(sessionDecision({ email: 'm@example.com', authAt: 5000, row: row({ inviteStatus }) }).reason, 'not-approved', String(inviteStatus));
    }
  });

  test('someone with no people row yet is judged on their invite alone', () => {
    assert.equal(sessionDecision({ email: 'm@example.com', authAt: 5000, row: row({ person: null }) }).ok, true);
  });

  test('an env admin needs no invite and cannot be suspended — but can be signed out', () => {
    const base = { email: 'a@example.com', authAt: 1000, admin: true };
    assert.equal(sessionDecision({ ...base, row: row({ inviteStatus: null }) }).ok, true);
    assert.equal(sessionDecision({ ...base, row: row({ person: { status: 'suspended' } }) }).ok, true);
    assert.equal(sessionDecision({ ...base, row: row({ person: { status: 'active', sessionsValidAfter: 2000 } }) }).reason, 'signed-out');
  });
});
