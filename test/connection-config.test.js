// "Is the database configured, and which variable says so?"
//
// This exists because of an outage. lib/db.js reads
// `DATABASE_URL || POSTGRES_URL`. Production was running on POSTGRES_URL —
// the variable the Supabase-Vercel integration injects — while everyone
// assumed DATABASE_URL was doing the work. Removing "the redundant one"
// removed the only connection string the deployment had, and the site went
// down: no sign-in, no library, every page reporting a database that was not
// configured.
//
// Two things are pinned here. The fallback itself, so nobody optimises it
// away without seeing what it means. And the sign-in action's behaviour when
// there is no connection at all, because what it said was "Could not send the
// sign-in email. Try again in a moment." — advice that cannot possibly work,
// aimed at an inbox rather than at the one missing variable.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { hasConnectionString } = await import('../lib/db.js');

describe('hasConnectionString', () => {
  let saved;
  beforeEach(() => { saved = { d: process.env.DATABASE_URL, p: process.env.POSTGRES_URL }; });
  afterEach(() => {
    if (saved.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.d;
    if (saved.p === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = saved.p;
  });

  const set = (d, p) => {
    if (d === null) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = d;
    if (p === null) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = p;
  };

  test('DATABASE_URL alone', () => {
    set('postgres://a/db', null);
    assert.deepEqual(hasConnectionString(), { ok: true, which: 'DATABASE_URL' });
  });

  test('POSTGRES_URL alone is a working configuration', () => {
    // THE one. If this ever returns ok:false, a deployment running on the
    // Supabase integration's variable goes dark — which is exactly the
    // outage this file is named after.
    set(null, 'postgres://b/db');
    assert.deepEqual(hasConnectionString(), { ok: true, which: 'POSTGRES_URL' });
  });

  test('with both set, DATABASE_URL is the one in use', () => {
    set('postgres://a/db', 'postgres://b/db');
    assert.equal(hasConnectionString().which, 'DATABASE_URL');
  });

  test('neither is not configured', () => {
    set(null, null);
    assert.deepEqual(hasConnectionString(), { ok: false, which: null });
  });

  test('an empty string is not a connection string', () => {
    // Vercel will happily store a variable with an empty value, and `||`
    // falls through it — so this must agree with what lib/db.js actually does.
    set('', 'postgres://b/db');
    assert.equal(hasConnectionString().which, 'POSTGRES_URL');
    set('', '');
    assert.equal(hasConnectionString().ok, false);
  });

  test('it reads the environment live, not a value captured at import', () => {
    // lib/config.js writes admin-panel overrides into process.env after this
    // module has loaded. A value closed over at import time would miss them.
    set(null, null);
    assert.equal(hasConnectionString().ok, false);
    set('postgres://late/db', null);
    assert.equal(hasConnectionString().ok, true, 'a variable set after import was not seen');
  });
});

describe('requestMagicLink with no database', () => {
  // The action imports @/auth, which pulls in a lot; importing it here is the
  // point, since the regression is that the failure happened deep inside the
  // Auth.js adapter and came back out as generic advice.
  let saved;
  beforeEach(() => { saved = { d: process.env.DATABASE_URL, p: process.env.POSTGRES_URL }; });
  afterEach(() => {
    if (saved.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.d;
    if (saved.p === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = saved.p;
  });

  const form = (email) => ({ get: (k) => (k === 'email' ? email : null) });

  test('it refuses, names the variable, and does not claim an email was sent', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    const { requestMagicLink } = await import('../app/signin/actions.js');
    const out = await requestMagicLink(null, form('someone@example.com'));

    assert.ok(!out.sent, 'claimed a sign-in email was sent with no database to send it from');
    assert.ok(out.error, 'no error returned');
    assert.match(out.error, /DATABASE_URL/, 'the message must name the variable to set');
    assert.doesNotMatch(
      out.error, /try again/i,
      'retrying cannot fix an unset variable; that advice sends people to their spam folder',
    );
  });

  test('a malformed address is still rejected first', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    const { requestMagicLink } = await import('../app/signin/actions.js');
    const out = await requestMagicLink(null, form('not-an-email'));
    assert.match(out.error, /valid email/);
  });
});
