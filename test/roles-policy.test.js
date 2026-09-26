// roles.config v2 and policy.limits (lib/roles.js, lib/policy.js): reading
// what is stored — v1 blobs included — validating what an admin saves, and
// the arithmetic of each person's effective limits.
//
// Back-compat is the part that fails quietly: a v1 blob read wrongly does
// not error, it gives someone a different role.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseRolesConfig, resolveRole, roleCaps, validateRolesConfig, capDriveRole, principalHasCap,
  BUILTIN_ROLES, CAPABILITY_IDS, READ_ONLY_ROLE,
} = await import('../lib/roles.js');
const { parsePolicy, validatePolicy, effectiveLimits, minLimit, overrideProblem, DEFAULT_POLICY } = await import('../lib/policy.js');

// What a v1 roles.config looked like when it was saved by the old editor.
const V1 = {
  roles: [
    { id: 'admin', name: 'Admin', full: true, features: {}, builtin: true },
    { id: 'member', name: 'Member', features: {}, builtin: true },
    { id: 'contributor', name: 'Contributor', features: { shares: false, folderAcl: false }, builtin: true },
    { id: 'viewer', name: 'Viewer', features: { metadata: false, trash: false, shares: false, filespaces: false }, builtin: true },
    { id: 'client', name: 'Client team', description: 'Outside agency', features: { shares: false, metadata: false } },
    { id: 'ops', name: 'Ops', features: {} },
  ],
  assignments: { 'Viewer@Example.com': 'viewer', 'agency@example.com': 'client', 'old@example.com': 'admin', 'ops@example.com': 'ops' },
  defaultRole: 'member',
};

describe('reading roles.config', () => {
  test('nothing stored is the built-ins, default Member', () => {
    for (const saved of [null, undefined, {}, 'junk', []]) {
      const cfg = parseRolesConfig(saved);
      assert.equal(cfg.version, 2);
      assert.equal(cfg.defaultRole, 'member');
      assert.deepEqual(cfg.roles.map((r) => r.id), ['member', 'contributor', 'viewer']);
    }
  });

  test('v1: built-in copies are replaced by the v2 definitions', () => {
    const cfg = parseRolesConfig(V1);
    const viewer = cfg.roles.find((r) => r.id === 'viewer');
    assert.deepEqual(viewer, BUILTIN_ROLES.find((r) => r.id === 'viewer'));
    // The old Viewer's `filespaces: false` would have cut off its desktop
    // mounts now that the flag is enforced; the v2 Viewer mounts read-only.
    assert.equal(roleCaps(viewer).has('desktop.mount'), true);
  });

  test('v1: full roles are not roles any more', () => {
    const cfg = parseRolesConfig(V1);
    assert.equal(cfg.roles.some((r) => r.id === 'admin'), false);
    assert.deepEqual(cfg.legacyFullIds, ['admin']);
  });

  test('v1: a custom role keeps its name and every file capability', () => {
    // Only the id `viewer` was ever checked, so a custom role could always
    // upload, edit and delete. It still can.
    const client = parseRolesConfig(V1).roles.find((r) => r.id === 'client');
    assert.equal(client.name, 'Client team');
    assert.equal(client.builtin, false);
    const caps = roleCaps(client);
    for (const cap of ['files.upload', 'files.edit', 'files.delete', 'folders.manage']) assert.ok(caps.has(cap), cap);
    // …and `shares: false`, which did stop every link, still does.
    for (const cap of ['shares.private', 'shares.public', 'review.links']) assert.ok(!caps.has(cap), cap);
  });

  test('v1: assignments still resolve, case-insensitively', () => {
    const cfg = parseRolesConfig(V1);
    assert.equal(resolveRole('viewer@example.com', cfg).id, 'viewer');
    assert.equal(resolveRole('agency@example.com', cfg).id, 'client');
    assert.equal(resolveRole('nobody@example.com', cfg).id, 'member');
  });

  test('the people row wins over the v1 assignment', () => {
    assert.equal(resolveRole('viewer@example.com', parseRolesConfig(V1), { roleId: 'contributor' }).id, 'contributor');
  });

  test('a holder of the retired Admin role is a Member, flagged', () => {
    const r = resolveRole('old@example.com', parseRolesConfig(V1));
    assert.equal(r.id, 'member');
    assert.equal(r.legacyAdmin, true);
    // Even when the people row carries it.
    assert.equal(resolveRole('x@example.com', parseRolesConfig(null), { roleId: 'admin' }).legacyAdmin, true);
  });

  test('an env admin gets the implicit Admin role, with every capability', () => {
    const r = resolveRole('anyone@example.com', parseRolesConfig(V1), { isAdmin: true, roleId: 'viewer' });
    assert.equal(r.id, 'admin');
    assert.deepEqual([...roleCaps(r)].sort(), [...CAPABILITY_IDS].sort());
  });

  test('a role id that no longer exists falls back to the default', () => {
    const cfg = parseRolesConfig({ ...V1, defaultRole: 'contributor' });
    assert.equal(resolveRole('x@example.com', cfg, { roleId: 'deleted-role' }).id, 'contributor');
  });

  test('a default role that does not exist reads as Member', () => {
    assert.equal(parseRolesConfig({ defaultRole: 'ghost' }).defaultRole, 'member');
    assert.equal(parseRolesConfig({ defaultRole: 'admin', roles: V1.roles }).defaultRole, 'member');
  });

  test('v2: an edited built-in keeps its edits; unknown caps and bad limits are dropped', () => {
    const cfg = parseRolesConfig({
      version: 2,
      roles: [{
        id: 'member', name: 'Staff', caps: { 'shares.public': false, 'made.up': false, 'files.upload': 'no' },
        limits: { storageQuotaBytes: 5000, maxUploadBytes: -1, driveCeiling: 'god' },
      }],
    });
    const m = cfg.roles.find((r) => r.id === 'member');
    assert.equal(m.name, 'Staff');
    assert.deepEqual(m.caps, { 'shares.public': false });
    assert.equal(m.limits.storageQuotaBytes, 5000);
    assert.equal(m.limits.maxUploadBytes, null);
    assert.equal(m.limits.driveCeiling, 'owner');
  });

  test('v2 carries the retired full-role ids forward', () => {
    const saved = validateRolesConfig({ roles: parseRolesConfig(V1).roles, defaultRole: 'member' }, V1).config;
    assert.deepEqual(parseRolesConfig(saved).legacyFullIds, ['admin']);
  });

  test('reading is idempotent: a parsed config reads back as itself', () => {
    const once = parseRolesConfig(V1);
    assert.deepEqual(parseRolesConfig(once), once);
  });

  test('a hand-edited v2 blob is normalized before anyone is resolved against it', () => {
    const raw = { version: 2, legacyFullIds: [], roles: [{ id: 'boss', name: 'Boss', full: true }], assignments: { 'b@example.com': 'boss' } };
    const r = resolveRole('b@example.com', raw);
    assert.equal(r.id, 'member');
    assert.equal(r.legacyAdmin, true);
  });

  test('the read-only fallback role is the Viewer', () => {
    assert.equal(READ_ONLY_ROLE.id, 'viewer');
    assert.equal(roleCaps(READ_ONLY_ROLE).has('files.upload'), false);
  });
});

describe('saving roles (PUT /api/admin/roles)', () => {
  const roles = () => parseRolesConfig(null).roles;

  test('a valid save round-trips, keeping only `false` capabilities', () => {
    const input = { roles: [...roles(), { id: 'client', name: 'Client', caps: { 'shares.public': false, 'files.upload': true } }], defaultRole: 'member' };
    const r = validateRolesConfig(input, V1);
    assert.ok(r.config, r.error);
    assert.deepEqual(r.config.roles.find((x) => x.id === 'client').caps, { 'shares.public': false });
    // Assignments come from what is stored, never the request.
    assert.deepEqual(r.config.assignments, parseRolesConfig(V1).assignments);
  });

  test('full is refused', () => {
    const r = validateRolesConfig({ roles: [...roles(), { id: 'boss', name: 'Boss', full: true }] }, null);
    assert.match(r.error, /full access/i);
  });

  test('Admin is not a role', () => {
    assert.match(validateRolesConfig({ roles: [...roles(), { id: 'admin', name: 'Admin' }] }, null).error, /ADMIN_EMAILS/);
  });

  test('unknown capabilities and limits are refused, not dropped', () => {
    assert.match(validateRolesConfig({ roles: [...roles(), { id: 'x1', name: 'X', caps: { 'files.teleport': false } }] }, null).error, /unknown capability/);
    assert.match(validateRolesConfig({ roles: [...roles(), { id: 'x1', name: 'X', limits: { gigawatts: 1 } }] }, null).error, /unknown limit/);
  });

  test('limits are whole numbers of 0 or more, or null', () => {
    for (const v of [-1, 1.5, '10', true]) {
      assert.match(validateRolesConfig({ roles: [...roles(), { id: 'x1', name: 'X', limits: { storageQuotaBytes: v } }] }, null).error, /whole number/, String(v));
    }
    for (const v of [0, 10, null]) {
      assert.ok(validateRolesConfig({ roles: [...roles(), { id: 'x1', name: 'X', limits: { storageQuotaBytes: v } }] }, null).config, String(v));
    }
    assert.match(validateRolesConfig({ roles: [...roles(), { id: 'x1', name: 'X', limits: { driveCeiling: 'root' } }] }, null).error, /driveCeiling/);
  });

  test('built-ins cannot be deleted; custom ones can, and are reported', () => {
    assert.match(validateRolesConfig({ roles: roles().filter((r) => r.id !== 'viewer') }, null).error, /cannot be deleted/);
    const r = validateRolesConfig({ roles: roles() }, V1);
    assert.deepEqual(r.removed.sort(), ['client', 'ops']);
  });

  test('ids are slugs, unique; the default must exist', () => {
    assert.match(validateRolesConfig({ roles: [...roles(), { id: 'Bad Id', name: 'X' }] }, null).error, /not a valid role id/);
    assert.match(validateRolesConfig({ roles: [...roles(), { id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }] }, null).error, /twice/);
    assert.match(validateRolesConfig({ roles: roles(), defaultRole: 'ghost' }, null).error, /default role/);
  });
});

describe('capabilities of a hand-built principal', () => {
  test('read through its built-in role; an unknown role holds nothing', () => {
    assert.equal(principalHasCap({ roleId: 'member' }, 'files.upload'), true);
    assert.equal(principalHasCap({ roleId: 'viewer' }, 'files.upload'), false);
    assert.equal(principalHasCap({ roleId: 'mystery' }, 'files.upload'), false);
    assert.equal(principalHasCap({ roleId: 'viewer', isAdmin: true }, 'files.upload'), true);
    assert.equal(principalHasCap({ caps: new Set(['files.edit']) }, 'files.edit'), true);
  });

  test('capDriveRole takes the lower of the two', () => {
    assert.equal(capDriveRole('owner', 'viewer'), 'viewer');
    assert.equal(capDriveRole('editor', 'owner'), 'editor');
    assert.equal(capDriveRole('viewer', 'editor'), 'viewer');
    assert.equal(capDriveRole(null, 'owner'), null);
    assert.equal(capDriveRole('superuser', 'owner'), null);
  });
});

describe('policy.limits', () => {
  test('the defaults change nothing at deploy: storage unlimited, AI at $0', () => {
    const p = parsePolicy(null);
    assert.equal(p.storageQuotaBytes, null);
    assert.equal(p.maxUploadBytes, null);
    assert.equal(p.aiMonthlyBudgetCents, 0);
    assert.equal(p.drivesSelfServe, false);
    assert.deepEqual(p, DEFAULT_POLICY);
  });

  test('a bad stored field reads as its default', () => {
    const p = parsePolicy({ storageQuotaBytes: -5, aiConcurrency: 'lots', selfServeParentPrefix: '../etc', drivesSelfServe: 'yes' });
    assert.equal(p.storageQuotaBytes, null);
    assert.equal(p.aiConcurrency, DEFAULT_POLICY.aiConcurrency);
    assert.equal(p.selfServeParentPrefix, 'drives/');
    assert.equal(p.drivesSelfServe, false);
  });

  test('saving validates every field and refuses the whole save on one bad one', () => {
    assert.match(validatePolicy({ storageQuotaBytes: -1 }, null).error, /whole number/);
    assert.match(validatePolicy({ nope: 1 }, null).error, /Unknown policy field/);
    assert.match(validatePolicy({ selfServeParentPrefix: '_trash/' }, null).error, /folder path/);
    const ok = validatePolicy({ storageQuotaBytes: 10 ** 12, selfServeParentPrefix: 'team-drives' }, null);
    assert.equal(ok.policy.selfServeParentPrefix, 'team-drives/');
    assert.deepEqual(ok.changed.sort(), ['selfServeParentPrefix', 'storageQuotaBytes']);
  });

  test('the money fields need a super-admin', () => {
    const r = validatePolicy({ aiMonthlyBudgetCents: 5000 }, null, { superAdmin: false });
    assert.equal(r.status, 403);
    assert.ok(validatePolicy({ aiMonthlyBudgetCents: 5000 }, null, { superAdmin: true }).policy);
    // Sending the unchanged value is not a change.
    assert.ok(validatePolicy({ aiMonthlyBudgetCents: 0 }, null, { superAdmin: false }).policy);
  });
});

describe('effective limits', () => {
  const member = BUILTIN_ROLES.find((r) => r.id === 'member');
  const viewer = BUILTIN_ROLES.find((r) => r.id === 'viewer');

  test('min(org ceiling, override ?? role value), null being no limit', () => {
    assert.equal(minLimit(null, null), null);
    assert.equal(minLimit(null, 5), 5);
    assert.equal(minLimit(5, null), 5);
    assert.equal(minLimit(5, 3), 3);
    const l = effectiveLimits({ role: member, person: { quotaBytes: 500 }, policy: { storageQuotaBytes: 1000 } });
    assert.equal(l.storageQuotaBytes, 500);
    // An override above the ceiling is capped by it.
    assert.equal(effectiveLimits({ role: member, person: { quotaBytes: 5000 }, policy: { storageQuotaBytes: 1000 } }).storageQuotaBytes, 1000);
    // No override: the role's value, under the ceiling.
    assert.equal(effectiveLimits({ role: member, policy: { storageQuotaBytes: 1000 } }).storageQuotaBytes, 1000);
    assert.equal(effectiveLimits({ role: member, policy: null }).storageQuotaBytes, null);
  });

  test('a Viewer: zero quota, zero upload, viewer ceiling', () => {
    const l = effectiveLimits({ role: viewer, policy: null });
    assert.equal(l.storageQuotaBytes, 0);
    assert.equal(l.maxUploadBytes, 0);
    assert.equal(l.driveCeiling, 'viewer');
  });

  test('every AI budget is $0 until the owner sets one', () => {
    for (const role of BUILTIN_ROLES) assert.equal(effectiveLimits({ role, policy: null }).aiMonthlyCents, 0, role.id);
    // With an org budget and a role budget, the smaller wins.
    const custom = { ...member, limits: { ...member.limits, aiMonthlyCents: 1000 } };
    assert.equal(effectiveLimits({ role: custom, policy: { aiMonthlyBudgetCents: 5000 } }).aiMonthlyCents, 1000);
    assert.equal(effectiveLimits({ role: custom, policy: { aiMonthlyBudgetCents: 500 } }).aiMonthlyCents, 500);
  });

  test('admins: no quota, no upload limit, AI against the org budget', () => {
    const l = effectiveLimits({ role: member, policy: { storageQuotaBytes: 1, maxUploadBytes: 1, aiMonthlyBudgetCents: 900 }, isAdmin: true });
    assert.equal(l.storageQuotaBytes, null);
    assert.equal(l.maxUploadBytes, null);
    assert.equal(l.aiMonthlyCents, 900);
  });

  test('an override may not sit above the org ceiling', () => {
    assert.match(overrideProblem('quotaBytes', 2000, { storageQuotaBytes: 1000 }), /ceiling of 1000/);
    assert.equal(overrideProblem('quotaBytes', 500, { storageQuotaBytes: 1000 }), null);
    assert.equal(overrideProblem('quotaBytes', null, { storageQuotaBytes: 1000 }), null);
    assert.match(overrideProblem('maxUploadBytes', -3, null), /whole number/);
    assert.match(overrideProblem('aiMonthlyCents', 100, null), /ceiling of 0/);
  });
});
