// Read-only, drive-scoped device tokens (lib/token-scope.js): the routes such
// a token may reach, the principal it acts as — from an admin and from a
// member — and the drive check the file routes add.
//
// The admin case is the one that matters most: whoever connects an app is
// usually an admin, and an admin's principal answers yes to everything. Cut
// down, it must answer like a viewer of one drive and nothing more.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.SUPER_ADMIN_EMAILS = 'admin@example.com';

const { principalFrom, can, driveRoleOf, mountRole, libraryOpen } = await import('../lib/authz.js');
const { parseRolesConfig, BUILTIN_ROLES } = await import('../lib/roles.js');
const { driveAccess } = await import('../lib/drive-access.js');
const { mergeFlags } = await import('../lib/features.js');
const {
  READ_SCOPE, readTokenAllows, narrowPrincipal, withinTokenDrives, tokenHasDrive, grantableDrives, parseDriveIds, readScoped,
} = await import('../lib/token-scope.js');
const { parseScope, checkAuthorize, SCOPE } = await import('../lib/oauth.js');

const SHOOTS = { id: 'd1', prefix: 'shoots', shareKinds: null, quotaBytes: null };
const CLIENTS = { id: 'd2', prefix: 'clients', shareKinds: null, quotaBytes: null };
const DRIVES = [SHOOTS, CLIENTS];

const config = parseRolesConfig({ version: 2, roles: BUILTIN_ROLES, assignments: { 'member@example.com': 'member' } });
const flags = mergeFlags({ filespaces: true, library: true, shares: true });

function base(email, { isAdmin = false, roles = {} } = {}) {
  return principalFrom({
    email, isAdmin, isSuperAdmin: isAdmin, rolesConfig: config, globalFlags: flags,
    grants: isAdmin ? null : { drives: DRIVES, roles },
  });
}

const admin = () => narrowPrincipal(base('admin@example.com', { isAdmin: true }), { driveIds: ['d1'], drives: DRIVES });
const member = (roles = { d1: 'owner', d2: 'editor' }) =>
  narrowPrincipal(base('member@example.com', { roles }), { driveIds: ['d1'], drives: DRIVES });

describe('routes a read token may reach', () => {
  test('the feed, one file, its drives, and itself', () => {
    assert.ok(readTokenAllows('GET', '/api/files/delta'));
    assert.ok(readTokenAllows('GET', '/api/space/files/0b9c2c1e-1111-4222-8333-944455556666'));
    assert.ok(readTokenAllows('HEAD', '/api/space/files/abc'));
    assert.ok(readTokenAllows('GET', '/api/space/filespaces'));
    assert.ok(readTokenAllows('GET', '/api/desktop/me'));
    assert.ok(readTokenAllows('DELETE', '/api/desktop/me'));
  });

  test('nothing that writes, signs in, mints keys or runs tools', () => {
    for (const [m, p] of [
      ['POST', '/api/files/delta'],
      ['DELETE', '/api/space/files/abc'],
      ['POST', '/api/space/sts'],
      ['GET', '/api/space/sts'],
      ['POST', '/api/desktop/web-session'],
      ['GET', '/api/desktop/web-session'],
      ['POST', '/api/mcp'],
      ['GET', '/api/files'],
      ['POST', '/api/files'],
      ['POST', '/api/files/presign'],
      ['PATCH', '/api/files/abc'],
      ['GET', '/api/files/abc/download'],
      ['GET', '/api/space/files/abc/extra'],
      ['GET', '/api/admin/people'],
      ['POST', '/api/admin/trash/restore'],
      ['GET', '/api/collections'],
    ]) {
      assert.equal(readTokenAllows(m, p), false, `${m} ${p}`);
    }
  });
});

describe('the principal a read token acts as', () => {
  for (const [who, make] of [['an admin', admin], ['a member who owns the drive', member]]) {
    describe(`cut down from ${who}`, () => {
      test('is no admin, has no library and no folder grants', () => {
        const p = make();
        assert.equal(p.isAdmin, false);
        assert.equal(p.isSuperAdmin, false);
        assert.equal(p.roleId, null);
        assert.equal(libraryOpen(p), false);
        assert.deepEqual(p.folderGrants, []);
        assert.ok(readScoped(p));
        assert.equal(can(p, 'admin').ok, false);
        assert.equal(can(p, 'superAdmin').ok, false);
      });

      test('reads the granted drive as a viewer and nothing else', () => {
        const p = make();
        assert.equal(driveRoleOf(p, 'd1'), 'viewer');
        assert.equal(driveRoleOf(p, 'd2'), null);
        assert.deepEqual(driveAccess('shoots/2026/a.jpg', p.driveScope), { inDrive: true, read: true, write: false });
        assert.deepEqual(driveAccess('clients/x.jpg', p.driveScope), { inDrive: true, read: false, write: false });
        assert.deepEqual(p.drivePatterns.write, []);
        assert.equal(mountRole({ driveRole: driveRoleOf(p, 'd1'), canUpload: can(p, 'files.upload').ok, overQuota: false }), 'viewer');
      });

      test('holds no capability that changes anything', () => {
        const p = make();
        for (const cap of ['files.upload', 'files.edit', 'files.delete', 'folders.manage', 'shares.private', 'shares.public', 'review.links', 'drives.create', 'ai.generate']) {
          assert.equal(p.caps.has(cap), false, cap);
        }
        assert.equal(p.flags.shares, false);
        assert.equal(can(p, 'desktop.mount').ok, true);
      });

      test('the file check keeps it inside its drives', () => {
        const p = make();
        assert.ok(withinTokenDrives(p, 'shoots/2026/a.jpg'));
        assert.equal(withinTokenDrives(p, 'clients/x.jpg'), false);
        assert.equal(withinTokenDrives(p, 'files/library/a.jpg'), false);
        assert.ok(tokenHasDrive(p, 'd1'));
        assert.equal(tokenHasDrive(p, 'd2'), false);
        assert.equal(tokenHasDrive(p, 'library'), false);
      });
    });
  }

  test('a drive the person lost is dropped from the token', () => {
    const p = member({ d2: 'editor' });
    assert.equal(driveRoleOf(p, 'd1'), null);
    assert.deepEqual(p.tokenScope.driveIds, []);
    assert.equal(withinTokenDrives(p, 'shoots/a.jpg'), false);
  });

  test('a principal from any other token is untouched by the checks', () => {
    const p = base('admin@example.com', { isAdmin: true });
    assert.equal(readScoped(p), false);
    assert.ok(withinTokenDrives(p, 'files/library/a.jpg'));
    assert.ok(tokenHasDrive(p, 'd2'));
  });
});

describe('consent and storage', () => {
  test('only drives the person can open are granted, once each, in order', () => {
    const canOpen = (id) => id === 'd1' || id === 'd3';
    assert.deepEqual(grantableDrives(['d3', 'd2', 'd1', 'd3', ''], canOpen), ['d3', 'd1']);
    assert.deepEqual(grantableDrives('d1', canOpen), []);
    assert.deepEqual(grantableDrives(undefined, canOpen), []);
  });

  test('the stored drive list reads back from JSON, and tolerates garbage', () => {
    assert.deepEqual(parseDriveIds('["d1","d2"]'), ['d1', 'd2']);
    assert.deepEqual(parseDriveIds(null), []);
    assert.deepEqual(parseDriveIds('not json'), []);
    assert.deepEqual(parseDriveIds('{"a":1}'), []);
  });
});

describe('the scope an authorization asks for', () => {
  test('onyx.read alone is read-only; anything else is the full scope, as before', () => {
    assert.equal(parseScope('onyx.read'), READ_SCOPE);
    assert.equal(parseScope(' onyx.read '), READ_SCOPE);
    assert.equal(parseScope(''), SCOPE);
    assert.equal(parseScope(undefined), SCOPE);
    assert.equal(parseScope('onyx'), SCOPE);
    assert.equal(parseScope('onyx onyx.read'), SCOPE);
    assert.equal(parseScope('openid profile'), SCOPE);
  });

  test('checkAuthorize carries the scope to the consent page', () => {
    const client = { id: 'onyx_abc', name: 'Rollout', redirectUris: ['https://rollout.test/api/onyx/callback'] };
    const params = {
      response_type: 'code', client_id: client.id, redirect_uri: client.redirectUris[0],
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 's1',
    };
    assert.equal(checkAuthorize({ ...params, scope: 'onyx.read' }, client).value.scope, READ_SCOPE);
    assert.equal(checkAuthorize(params, client).value.scope, SCOPE);
  });
});
