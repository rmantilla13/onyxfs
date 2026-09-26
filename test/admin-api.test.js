// The admin APIs of Phase 1 (People, Roles & limits, Shared links, Trash,
// Maintenance, Invites): who may call them, and the pure rules they share
// (lib/people.js). The database half runs in test/people-db.test.js when
// TEST_DATABASE_URL is set.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// No database: every query would fail, which is the point — nothing here
// may reach one before the admin check has said yes.
process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
process.env.AUTH_SECRET = 'test-secret';
process.env.ADMIN_EMAILS = 'admin@example.com,owner@example.com';
process.env.SUPER_ADMIN_EMAILS = '';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const adminDir = join(root, 'app', 'api', 'admin');

function routes(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (name === 'route.js') out.push(p);
  }
  return out;
}

const HANDLERS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

describe('every admin route checks first', () => {
  const files = routes(adminDir);

  test('the new routes exist', () => {
    const rel = files.map((f) => relative(adminDir, f));
    for (const r of [
      'people/route.js', 'people/[id]/route.js', 'people/[id]/drives/route.js', 'people/[id]/suspend/route.js',
      'people/[id]/reactivate/route.js', 'people/[id]/signout-everywhere/route.js', 'people/[id]/devices/[tokenId]/route.js',
      'roles/route.js', 'policy/route.js', 'links/route.js', 'trash/route.js', 'trash/restore/route.js',
      'trash/purge/route.js', 'maintenance/route.js', 'maintenance/run/route.js', 'invites/route.js',
    ]) assert.ok(rel.includes(r), r);
  });

  for (const file of files) {
    const rel = relative(root, file);
    test(`${rel}: each handler's first await is the admin gate`, () => {
      const src = readFileSync(file, 'utf8');
      for (const h of HANDLERS) {
        const at = src.indexOf(`export async function ${h}(`);
        if (at < 0) continue;
        const body = src.slice(at);
        const first = /await\s+([A-Za-z]+)\(/.exec(body);
        assert.ok(first && /^require(Super)?Admin$/.test(first[1]), `${h} awaits ${first?.[1]} before the admin check`);
      }
    });
  }

  test('the storage backend takes a super-admin', () => {
    for (const r of ['storage/route.js', 'storage/test/route.js', 'storage/cors/route.js']) {
      const src = readFileSync(join(adminDir, r), 'utf8');
      assert.match(src, /requireSuperAdmin\(\)/, r);
      assert.doesNotMatch(src, /requireAdmin\(\)/, r);
    }
  });

  // Called with no session at all — as a request from outside would be.
  const CALLS = [
    ['people/route.js', 'GET'], ['people/[id]/route.js', 'GET'], ['people/[id]/route.js', 'PATCH'],
    ['people/[id]/route.js', 'DELETE'], ['people/[id]/drives/route.js', 'PUT'], ['people/[id]/suspend/route.js', 'POST'],
    ['people/[id]/reactivate/route.js', 'POST'], ['people/[id]/signout-everywhere/route.js', 'POST'],
    ['people/[id]/devices/[tokenId]/route.js', 'DELETE'], ['roles/route.js', 'GET'], ['roles/route.js', 'PUT'],
    ['policy/route.js', 'GET'], ['policy/route.js', 'PUT'], ['links/route.js', 'GET'], ['links/route.js', 'DELETE'],
    ['trash/route.js', 'GET'], ['trash/restore/route.js', 'POST'], ['trash/purge/route.js', 'POST'],
    ['maintenance/route.js', 'GET'], ['maintenance/run/route.js', 'POST'], ['invites/route.js', 'PATCH'],
  ];
  for (const [r, method] of CALLS) {
    test(`${method} ${r} without a session → 401, before any query`, async () => {
      const mod = await import(join(adminDir, r));
      const req = new Request('http://localhost/api/admin/x', {
        method, headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ ids: ['a'], tokens: ['t'], roles: [], status: 'approved', id: 'x' }),
      });
      const res = await mod[method](req, { params: { id: 'p1', tokenId: 't1' } });
      assert.equal(res.status, 401);
    });
  }
});

const { personActionProblem, parseEmails, presentPerson, displayNameFor, assignableRole } = await import('../lib/people.js');
const { parseRolesConfig } = await import('../lib/roles.js');
const { isInviteStatus, INVITE_STATUSES } = await import('../lib/db.js');

describe('invite states', () => {
  test('approved, denied and pending — nothing else', () => {
    assert.deepEqual(INVITE_STATUSES, ['approved', 'denied', 'pending']);
    for (const s of INVITE_STATUSES) assert.ok(isInviteStatus(s));
    // 'banned' and friends were stored as sent and, since only 'approved'
    // lets anyone in, quietly revoked the person.
    for (const s of ['banned', 'Approved', '', null, undefined, 'revoked']) assert.equal(isInviteStatus(s), false, String(s));
  });
});

describe('what an admin may do to a person', () => {
  test('env admins are managed in ADMIN_EMAILS', () => {
    for (const action of ['role', 'suspend', 'remove']) {
      assert.match(personActionProblem({ actor: 'admin@example.com', target: 'owner@example.com', action }).error, /ADMIN_EMAILS/);
    }
  });

  test('nobody suspends or removes themselves', () => {
    // An admin is caught by the rule above first; a non-admin target that is
    // the actor (a super-admin tidying up) by this one.
    assert.match(personActionProblem({ actor: 'me@example.com', target: 'ME@example.com', action: 'suspend' }).error, /yourself/);
    assert.match(personActionProblem({ actor: 'me@example.com', target: 'me@example.com', action: 'remove' }).error, /yourself/);
  });

  test('everyone else is fair game, and signing out everywhere is always allowed', () => {
    assert.equal(personActionProblem({ actor: 'admin@example.com', target: 'm@example.com', action: 'suspend' }), null);
    assert.equal(personActionProblem({ actor: 'admin@example.com', target: 'owner@example.com', action: 'signout' }), null);
  });

  test('Admin is not an assignable role', () => {
    const cfg = parseRolesConfig(null);
    assert.equal(assignableRole(cfg, 'admin'), null);
    assert.equal(assignableRole(cfg, 'viewer').id, 'viewer');
    assert.equal(assignableRole(cfg, 'ghost'), null);
  });
});

describe('invite addresses', () => {
  test('commas, spaces and new lines; lowercased; each once', () => {
    const { emails, invalid } = parseEmails('A@x.com, b@y.org\nc@z.io;a@X.com');
    assert.deepEqual(emails, ['a@x.com', 'b@y.org', 'c@z.io']);
    assert.deepEqual(invalid, []);
  });

  test('what is not an address is reported, not dropped', () => {
    assert.deepEqual(parseEmails(['ok@x.com', 'nope', 'also@bad']).invalid, ['nope', 'also@bad']);
  });
});

describe('how a person is presented', () => {
  const ctx = { rolesConfig: parseRolesConfig({ roles: [{ id: 'admin', full: true }], assignments: {} }), policy: null, adminEmails: ['admin@example.com'] };

  test('the name: their own, then the request, then Okta, then the address', () => {
    assert.equal(displayNameFor({ email: 'a@x.com', person: { displayName: 'Ann' }, inviteName: 'A', userName: 'Ann O' }), 'Ann');
    assert.equal(displayNameFor({ email: 'a@x.com', person: {}, inviteName: 'A', userName: 'Ann O' }), 'A');
    assert.equal(displayNameFor({ email: 'a@x.com', person: {}, userName: 'Ann O' }), 'Ann O');
    assert.equal(displayNameFor({ email: 'ann.lee@x.com', person: {} }), 'ann.lee');
  });

  test('invited until they sign in; suspended wins', () => {
    const base = { person: { id: 'p', email: 'n@example.com', status: 'active', firstSeenAt: null }, hasUser: false };
    assert.equal(presentPerson(base, ctx).status, 'invited');
    assert.equal(presentPerson({ ...base, hasUser: true }, ctx).status, 'active');
    assert.equal(presentPerson({ ...base, person: { ...base.person, status: 'suspended' } }, ctx).status, 'suspended');
  });

  test('a holder of the retired Admin role is flagged, and shown as a Member', () => {
    const p = presentPerson({ person: { id: 'p', email: 'old@example.com', roleId: 'admin', status: 'active' } }, ctx);
    assert.equal(p.legacyAdmin, true);
    assert.equal(p.role.id, 'member');
    assert.equal(p.isAdmin, false);
  });

  test('an env admin shows as Admin, set in ADMIN_EMAILS, never legacy', () => {
    const p = presentPerson({ person: { id: 'p', email: 'admin@example.com', roleId: 'admin', status: 'active' } }, ctx);
    assert.equal(p.role.id, 'admin');
    assert.equal(p.adminSource, 'ADMIN_EMAILS');
    assert.equal(p.legacyAdmin, false);
  });

  test('last active is the later of a web visit and a device', () => {
    const p = presentPerson({ person: { id: 'p', email: 'n@example.com', lastSeenAt: 100 }, deviceLastUsedAt: 250 }, ctx);
    assert.equal(p.lastActiveAt, 250);
  });
});
