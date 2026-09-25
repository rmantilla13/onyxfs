// The sync feed a native client enumerates against (/api/files/delta), and
// the handoff that signs the Mac app's window in.
//
// The feed used to hand every changed row in the workspace, presigned, to
// anyone signed in. What is pinned here is the shape of the fix: the rows are
// judged by the listing's own access rule, a row the caller may not see goes
// back as a bare id, and a change in who may see what — which writes no row —
// still reaches the device, through the scope fingerprint.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeltaQuery, buildFileQuery, accessClauses } from '../lib/file-query.js';
import { drivePatterns } from '../lib/drive-access.js';
import { accessFingerprint, syncScope } from '../lib/sync-scope.js';
import { safeNext, sessionCookieName, authUsesHttps, handoffSecret, HANDOFF_TTL_MS } from '../lib/web-handoff.js';
import { pkceChallenge } from '../lib/pkce.js';

const drives = [
  { id: 'brand', prefix: 'brand-assets' },
  { id: 'clients', prefix: 'clients' },
];
const member = {
  email: 'm@example.com', isAdmin: false, roleId: 'member', folderGrants: [],
  driveScope: { drives, roles: { brand: 'viewer' } },
  drivePatterns: { all: drivePatterns(drives), mine: drivePatterns([drives[0]]) },
};

describe('the delta query', () => {
  test('judges rows by the listing rule, and reads every row since the cursor', () => {
    const { text, params } = buildDeltaQuery({ cursor: 42, limit: 10, principal: member });
    // The access rule is the listing's, word for word.
    const listing = buildFileQuery({ opts: {}, principal: member }).text;
    const rule = accessClauses({ principal: member, push: () => '$x' }).map((c) => c.replace(/\$\d+/g, '$x'));
    for (const clause of rule) {
      assert.ok(text.replace(/\$\d+/g, '$x').includes(clause), 'delta carries the access clause');
      assert.ok(listing.replace(/\$\d+/g, '$x').includes(clause), 'and so does the listing');
    }
    // It is a column, not a filter: rows that are not shown still come back,
    // so a device can be told to drop them.
    assert.match(text, /coalesce\(\([\s\S]*\), false\) AS shown/);
    assert.match(text, /WHERE f\.seq > \$\d+\s+ORDER BY f\.seq ASC\s+LIMIT \$\d+/);
    assert.equal(params.at(-2), 42);
    assert.equal(params.at(-1), 10);
  });

  test('an admin has no access clause, only what a file is', () => {
    const { text } = buildDeltaQuery({ principal: { isAdmin: true } });
    assert.doesNotMatch(text, /file_acl/);
    assert.match(text, /f\.deleted_at IS NULL/);
    assert.match(text, /storage_key !~/);
  });

  test('scoped to a drive, or to the library (files in no drive)', () => {
    const one = buildDeltaQuery({ principal: { isAdmin: true }, scope: syncScope({ drive: drives[0] }) });
    assert.ok(one.params.includes('brand-assets/%'));
    assert.match(one.text, /coalesce\(f\.storage_key, ''\) LIKE \$\d+/);

    const lib = buildDeltaQuery({ principal: { isAdmin: true }, scope: syncScope({ library: true, allDrives: drives }) });
    assert.ok(lib.params.some((p) => Array.isArray(p) && p.includes('brand-assets/%') && p.includes('clients/%')));
    assert.match(lib.text, /NOT \(coalesce\(f\.storage_key, ''\) LIKE ANY/);

    assert.deepEqual(syncScope({}), {}, 'no drive: everything the caller may see');
    assert.equal(syncScope({ drive: { id: 'x', prefix: '' } }), null, 'a drive with no prefix cannot be scoped');
  });

  test('limits are clamped, and nonsense falls back rather than truncating', () => {
    assert.equal(buildDeltaQuery({ limit: 5000 }).limit, 1000);
    assert.equal(buildDeltaQuery({ limit: -3 }).limit, 500);
    assert.equal(buildDeltaQuery({ limit: 'x' }).limit, 500);
    assert.equal(buildDeltaQuery({ cursor: -9 }).cursor, 0);
  });
});

describe('the scope fingerprint', () => {
  const all = drivePatterns(drives);

  test('is stable for the same access, whatever the order things arrive in', () => {
    const a = accessFingerprint(member, all);
    const shuffled = { ...member, driveScope: { drives, roles: { brand: 'viewer' } } };
    assert.equal(accessFingerprint(shuffled, [...all].reverse()), a);
  });

  test('moves when membership, role, grants, admin or the drives themselves change', () => {
    const base = accessFingerprint(member, all);
    const joined = { ...member, driveScope: { drives, roles: { brand: 'viewer', clients: 'editor' } } };
    const promoted = { ...member, driveScope: { drives, roles: { brand: 'owner' } } };
    const granted = { ...member, folderGrants: ['Campaigns'] };
    const seen = new Set([
      base,
      accessFingerprint(joined, all),
      accessFingerprint(promoted, all),
      accessFingerprint(granted, all),
      accessFingerprint({ ...member, isAdmin: true }, all),
      accessFingerprint(member, [...all, 'new-drive/%']),
    ]);
    assert.equal(seen.size, 6);
  });
});

describe('signing the app window in', () => {
  test('lands only on a path on this site', () => {
    assert.equal(safeNext('/files?drive=abc'), '/files?drive=abc');
    assert.equal(safeNext('https://evil.example/files'), '/files');
    assert.equal(safeNext('//evil.example'), '/files');
    assert.equal(safeNext('/\\evil.example'), '/files');
    assert.equal(safeNext('/signin'), '/files', 'not back to the form');
    assert.equal(safeNext('/verify/abc'), '/files');
    assert.equal(safeNext(undefined), '/files');
    assert.equal(safeNext('/files\n/x'), '/files');
  });

  test('names the session cookie as Auth.js does, deciding https the way it does', () => {
    assert.equal(sessionCookieName(true), '__Secure-authjs.session-token');
    assert.equal(sessionCookieName(false), 'authjs.session-token');
    // AUTH_URL wins over whatever the proxy says.
    assert.equal(authUsesHttps({ env: { AUTH_URL: 'https://onyx.example.com' }, forwardedProto: 'http' }), true);
    assert.equal(authUsesHttps({ env: { NEXTAUTH_URL: 'http://localhost:3000' }, forwardedProto: 'https' }), false);
    // Then the proxy, then the request, then https.
    assert.equal(authUsesHttps({ forwardedProto: 'https', protocol: 'http:' }), true);
    assert.equal(authUsesHttps({ forwardedProto: 'http', protocol: 'https:' }), false);
    assert.equal(authUsesHttps({ protocol: 'http:' }), false);
    assert.equal(authUsesHttps({}), true);
  });

  test('over https only the __Host- secret counts, so a sibling subdomain cannot plant one', () => {
    const jar = (o) => ({ get: (n) => (n in o ? { value: o[n] } : undefined) });
    assert.equal(handoffSecret(jar({ onyx_handoff: 'tossed' }), true), '');
    assert.equal(handoffSecret(jar({ '__Host-onyx_handoff': 'real', onyx_handoff: 'tossed' }), true), 'real');
    assert.equal(handoffSecret(jar({ onyx_handoff: 'local' }), false), 'local', 'plain http (localhost) uses the plain name');
  });

  test('the code is short-lived, and bound by the same S256 the device sign-in uses', async () => {
    assert.ok(HANDOFF_TTL_MS <= 60_000);
    // RFC 7636, Appendix B.
    assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('names are not patterns', () => {
  test('a folder or drive prefix with _ or % matches only itself and what is under it', () => {
    const { params } = buildFileQuery({ opts: { folderPrefix: 'Q1_2024', storagePrefix: '100%_brand' }, principal: { isAdmin: true } });
    assert.ok(params.includes('Q1\\_2024/%'), 'folder prefix escaped');
    assert.ok(params.includes('100\\%\\_brand/%'), 'drive prefix escaped');
    assert.ok(!params.includes('Q1_2024/%') && !params.includes('100%_brand/%'));
  });
});
