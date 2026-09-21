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

// ── A hostname that can never resolve ──────────────────────────────────────
// describeConnection classified "…pooler.supabase.com" as "Supabase pooler,
// transaction mode" and returned no warning. The host was the documentation's
// horizontal ellipsis pasted as a literal character; every request died with
// ENOTFOUND while the diagnostic said the configuration was correct.
//
// The cause was a suffix match: /pooler\.supabase\.com$/ is true of anything
// ending in those characters, however malformed the rest. Exactly the mistake
// that let a scheme-less B2 endpoint pass every check in lib/storage.js — the
// substring matched, and the thing that actually parses disagreed.

const { describeConnection: describeConn } = await import('../lib/db.js');
const { ENV_VARS } = await import('../lib/integrations.js');

describe('describeConnection rejects unresolvable hostnames', () => {
  const url = (host) => `postgresql://postgres.abc:pw@${host}:6543/postgres`;

  test('the ellipsis placeholder is caught, not certified', () => {
    // THE regression.
    const { label, warn } = describeConn(url('…pooler.supabase.com'));
    assert.match(label, /INVALID hostname/);
    assert.doesNotMatch(label, /transaction mode/, 'a broken host was reported as a correct one');
    assert.ok(warn, 'no warning for a hostname that cannot resolve');
    assert.match(warn, /ENOTFOUND/);
  });

  test('it shows the character rather than its percent-encoding', () => {
    // The raw log said "%E2%80%A6pooler.supabase.com", which hides that the
    // problem is a single typographic character someone can see and delete.
    const { warn } = describeConn(url('…pooler.supabase.com'));
    assert.match(warn, /…/);
    assert.doesNotMatch(warn, /%E2%80%A6/);
  });

  test('it names the cause when the host looks like a copied placeholder', () => {
    const { warn } = describeConn(url('…pooler.supabase.com'));
    assert.match(warn, /placeholder/i);
  });

  test('angle-bracket placeholders fail to parse, and that path advises too', () => {
    // `<region>` is rejected by the URL parser outright, so it never reaches
    // the hostname check. That branch used to return no warning at all — a
    // bare "unparseable connection string" with nothing to act on.
    const { label, warn } = describeConn(url('<region>.pooler.supabase.com'));
    assert.match(label, /unparseable/);
    assert.ok(warn, 'an unparseable connection string must still explain itself');
    assert.match(warn, /placeholder/i);
    assert.match(warn, /postgresql:\/\//, 'show the shape of a correct value');
  });

  test('a genuinely malformed string is explained without inventing a cause', () => {
    const { warn } = describeConn('not a url at all');
    assert.ok(warn);
    assert.doesNotMatch(warn, /placeholder/i, 'do not claim a placeholder that is not there');
  });

  test('a valid pooler host is still classified correctly', () => {
    const { label, warn } = describeConn(url('aws-0-us-east-1.pooler.supabase.com'));
    assert.match(label, /transaction mode/);
    assert.equal(warn, null, 'a correct configuration must not warn');
  });

  test('the checks that follow are not skipped for a valid host', () => {
    // Guard against the fix short-circuiting the session-mode and direct
    // detection it sits in front of.
    assert.match(
      describeConn('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres').label,
      /SESSION mode/,
    );
    assert.match(
      describeConn('postgresql://u:p@db.abcdefghij.supabase.co:5432/postgres').label,
      /DIRECT/,
    );
  });

  test('no advice anywhere uses an ellipsis in a hostname position', () => {
    // The precise rule, and it is the one that bit us. "…" and "..." read as
    // prose and paste as characters: the URL parser accepts them, percent-
    // encodes them, and the failure surfaces much later as ENOTFOUND against
    // an unreadable "%E2%80%A6pooler.supabase.com".
    //
    // Angle brackets are deliberately still allowed. `<region>` is rejected
    // by the URL parser outright, and describeConnection names it as a copied
    // placeholder — it fails loudly and immediately, which is the behaviour we
    // want from something that cannot be a real value.
    const ellipsisHost = /(?:…|\.\.\.)(?=[A-Za-z0-9-]*\.(?:pooler\.supabase\.com|supabase\.co))/;

    const advice = [
      ...ENV_VARS.map((v) => [`ENV_VARS.${v.key}`, v.why]),
      // The runtime warnings are advice too, and are read far more often.
      ...['postgresql://u:p@db.abc.supabase.co:5432/postgres',
          'postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres']
        .map((u) => [`describeConnection(${u})`, describeConn(u).warn || '']),
    ];

    for (const [where, text] of advice) {
      assert.doesNotMatch(text, ellipsisHost, `${where} shows a host with an ellipsis glued to it`);
    }
  });

  test('the direct-connection warning leads with the reason it fails on Vercel', () => {
    // It used to talk only about connection limits. True, but not what
    // happens: db.<ref>.supabase.co publishes no A record, so on an IPv4-only
    // platform the name does not resolve and every query dies at getaddrinfo.
    // That reads as the database being down rather than as the wrong URL.
    const { warn } = describeConn('postgresql://u:p@db.abcdefghij.supabase.co:5432/postgres');
    assert.match(warn, /ENOTFOUND/);
    assert.match(warn, /IPv4|IPv6/);
    assert.match(warn, /6543/, 'say what to use instead');
  });
});
