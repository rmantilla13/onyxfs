// The authorization core (lib/authz.js): every role × every action × each
// drive role × in and out of a drive, against the table in the proposal
// (§1.3), plus web/desktop parity.
//
// The failure that matters here is silent: a role that can do one thing
// more than intended does not throw, it just works. So the matrix is spelled
// out as data — what each role may do — and every cell is asserted, rather
// than a handful of cases someone thought of.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.SUPER_ADMIN_EMAILS = '';

const { principalFrom, can, mountRole, uploadAllowance, principalFlags, shareCapFor, driveRoleOf } = await import('../lib/authz.js');
const { parseRolesConfig, CAPABILITY_IDS, BUILTIN_ROLES } = await import('../lib/roles.js');
const { fileWriteDecision, folderRoleAllows, strongestFolderRole } = await import('../lib/db.js');
const { driveAccess } = await import('../lib/drive-access.js');
const { mergeFlags } = await import('../lib/features.js');

const DRIVE = { id: 'd1', prefix: 'team', shareKinds: null, quotaBytes: null };
const IN_DRIVE = 'team/Campaigns/hero.jpg';
const OUT_OF_DRIVE = 'files/Campaigns/hero.jpg';

const ROLES = ['admin', 'member', 'contributor', 'viewer'];
const DRIVE_ROLES = [null, 'viewer', 'editor', 'owner'];

const config = parseRolesConfig({
  version: 2,
  roles: BUILTIN_ROLES,
  assignments: {
    'member@example.com': 'member',
    'contributor@example.com': 'contributor',
    'viewer@example.com': 'viewer',
  },
});

/** A principal as getPrincipal would build it, from what it would have read. */
function principal(role, driveRole = null, { flags = {}, policy = null, person = null } = {}) {
  const email = `${role}@example.com`;
  return principalFrom({
    email,
    isAdmin: role === 'admin',
    person,
    rolesConfig: config,
    globalFlags: mergeFlags(flags),
    policy,
    grants: { drives: [DRIVE], roles: driveRole ? { d1: driveRole } : {} },
  });
}

const scopeOf = (p) => (p.isAdmin ? { isAdmin: true } : p.driveScope);
const W = new Set(['editor', 'owner']);

// ── The table ───────────────────────────────────────────────────────────────
// What each role may do, before any drive or file comes into it.
const CAN = {
  admin:       { upload: 1, edit: 1, delete: 1, folders: 1, private: 1, public: 1, reviewLinks: 1, comment: 1, decide: 1, ai: 1, drives: 1, mount: 1 },
  member:      { upload: 1, edit: 1, delete: 1, folders: 1, private: 1, public: 1, reviewLinks: 1, comment: 1, decide: 1, ai: 1, drives: 0, mount: 1 },
  contributor: { upload: 1, edit: 1, delete: 1, folders: 1, private: 1, public: 0, reviewLinks: 0, comment: 1, decide: 1, ai: 1, drives: 0, mount: 1 },
  viewer:      { upload: 0, edit: 0, delete: 0, folders: 0, private: 0, public: 0, reviewLinks: 0, comment: 1, decide: 1, ai: 0, drives: 0, mount: 1 },
};
const CAP_OF = {
  upload: 'files.upload', edit: 'files.edit', delete: 'files.delete', folders: 'folders.manage',
  private: 'shares.private', public: 'shares.public', reviewLinks: 'review.links',
  comment: 'review.comment', decide: 'review.decide', ai: 'ai.generate', drives: 'drives.create', mount: 'desktop.mount',
};
// The drive-role ceiling: the highest drive role each honours.
const CEILING = { admin: 'owner', member: 'owner', contributor: 'owner', viewer: 'viewer' };
const RANK = { viewer: 1, editor: 2, owner: 3 };
const capped = (granted, role) => (granted ? (RANK[granted] <= RANK[CEILING[role]] ? granted : CEILING[role]) : null);

describe('the capability table (§1.3)', () => {
  // AI is off by default (owner decision: every budget starts at $0), so the
  // ai.generate column is checked with the flag on; self-serve drives are
  // checked with the policy on in their own test below.
  const flags = { aiGenerate: true };
  for (const role of ROLES) {
    for (const [col, cap] of Object.entries(CAP_OF)) {
      test(`${role} · ${cap}`, () => {
        const p = principal(role, null, { flags });
        const d = can(p, cap, { canModify: true, expiresInDays: 7 });
        assert.equal(d.ok, !!CAN[role][col], `${role} ${cap}: ${d.reason || 'allowed'}`);
      });
    }
  }

  test('every capability is in the table', () => {
    assert.deepEqual(Object.values(CAP_OF).sort(), [...CAPABILITY_IDS].sort());
  });
});

describe('role × action × drive role × in/out of a drive', () => {
  for (const role of ROLES) {
    for (const granted of DRIVE_ROLES) {
      const p = principal(role, granted);
      const effective = role === 'admin' ? 'owner' : capped(granted, role);

      test(`${role}, granted ${granted || 'nothing'}: the drive role after the ceiling`, () => {
        assert.equal(driveRoleOf(p, 'd1'), effective);
      });

      for (const where of ['in', 'out']) {
        const key = where === 'in' ? IN_DRIVE : OUT_OF_DRIVE;
        const drive = driveAccess(key, scopeOf(p));

        test(`${role}, drive ${granted || 'none'}, ${where} of the drive: upload`, () => {
          const expected = !!CAN[role].upload && (where === 'out' || role === 'admin' || W.has(effective));
          assert.equal(can(p, 'files.upload', { drive }).ok, expected);
        });

        for (const [action, cap] of [['edit', 'files.edit'], ['delete', 'files.delete']]) {
          test(`${role}, drive ${granted || 'none'}, ${where} of the drive: ${action} their own file`, () => {
            // Their own upload: outside a drive the creator rule lets them
            // change it; inside, the drive decides — as their mount does.
            const file = { id: 'f', storageKey: key, folder: 'Campaigns', createdBy: p.email, visibility: 'org' };
            const write = fileWriteDecision({ file, principal: p, drive, action: cap });
            const expected = !!CAN[role][action] && (role === 'admin' || where === 'out' || W.has(effective));
            assert.equal(can(p, cap, { write }).ok && write.allowed, expected, write.reason);
          });

          test(`${role}, drive ${granted || 'none'}, ${where} of the drive: ${action} someone else's org-visible file`, () => {
            // Visible is not writable. Outside a drive only a grant would do.
            const file = { id: 'g', storageKey: key, folder: 'Campaigns', createdBy: 'other@example.com', visibility: 'org' };
            const write = fileWriteDecision({ file, principal: p, drive, action: cap });
            const expected = !!CAN[role][action] && (role === 'admin' || (where === 'in' && W.has(effective)));
            assert.equal(can(p, cap, { write }).ok && write.allowed, expected, write.reason);
          });
        }

        test(`${role}, drive ${granted || 'none'}, ${where} of the drive: manage folders`, () => {
          // folderRoleFor gives a drive's editors and owners the drive's
          // folders; outside a drive, with no folder grant, nobody but an
          // admin restructures.
          const folderRole = role === 'admin' ? 'owner' : strongestFolderRole([where === 'in' && W.has(effective) ? effective : null]);
          const expected = !!CAN[role].folders && folderRoleAllows(folderRole, 'modify');
          assert.equal(can(p, 'folders.manage', { folderRole }).ok, expected);
        });
      }

      test(`${role}, drive ${granted || 'none'}: manage the drive's members`, () => {
        const expected = role === 'admin' || effective === 'owner';
        assert.equal(can(p, 'drive.manageMembers', { driveRole: driveRoleOf(p, 'd1') }).ok, expected);
      });

      test(`${role}, drive ${granted || 'none'}: desktop mount role`, () => {
        const driveRole = driveRoleOf(p, 'd1');
        const m = mountRole({ driveRole, canUpload: can(p, 'files.upload').ok });
        if (!driveRole) assert.equal(m, null);
        else if (role === 'viewer') assert.equal(m, 'viewer', 'a Viewer mounts read-only, whatever they were granted');
        else assert.equal(m, driveRole);
      });
    }
  }
});

describe('the drive-role ceiling', () => {
  test('a Viewer granted editor is an editor nowhere', () => {
    // The live problem this fixes: refused on the web, handed write
    // credentials by STS.
    const p = principal('viewer', 'editor');
    assert.equal(p.driveScope.roles.d1, 'viewer');
    assert.equal(driveAccess(IN_DRIVE, p.driveScope).write, false);
    assert.equal(mountRole({ driveRole: driveRoleOf(p, 'd1'), canUpload: true }), 'viewer');
  });

  test('the listing patterns still count them a member, so they can read', () => {
    const p = principal('viewer', 'owner');
    assert.equal(driveAccess(IN_DRIVE, p.driveScope).read, true);
    assert.deepEqual(p.drivePatterns.mine, ['team/%']);
  });

  test('a custom role can set its own ceiling', () => {
    const cfg = parseRolesConfig({
      version: 2,
      roles: [...BUILTIN_ROLES, { id: 'editors-only', name: 'Editors only', caps: {}, limits: { driveCeiling: 'editor' } }],
      assignments: { 'e@example.com': 'editors-only' },
    });
    const p = principalFrom({ email: 'e@example.com', rolesConfig: cfg, globalFlags: mergeFlags({}), grants: { drives: [DRIVE], roles: { d1: 'owner' } } });
    assert.equal(driveRoleOf(p, 'd1'), 'editor');
    assert.equal(can(p, 'drive.manageMembers', { driveRole: driveRoleOf(p, 'd1') }).ok, false);
  });
});

describe('full access grants nothing', () => {
  const legacy = parseRolesConfig({
    roles: [{ id: 'admin', name: 'Admin', full: true, features: {} }, { id: 'boss', name: 'Boss', full: true }],
    assignments: { 'old-admin@example.com': 'admin', 'boss@example.com': 'boss' },
  });

  for (const email of ['old-admin@example.com', 'boss@example.com']) {
    test(`${email}: a Member, flagged, and owner of no drive they are not in`, () => {
      const p = principalFrom({ email, rolesConfig: legacy, globalFlags: mergeFlags({}), grants: { drives: [DRIVE], roles: {} } });
      assert.equal(p.isAdmin, false);
      assert.equal(p.roleId, 'member');
      assert.equal(p.legacyAdmin, true);
      assert.equal(driveRoleOf(p, 'd1'), null, 'the desktop-only "owner of every drive" is gone');
      assert.equal(can(p, 'admin').ok, false);
      assert.equal(can(p, 'trash.manage').ok, false);
    });
  }

  test('an env admin is an admin whatever their stored role', () => {
    const p = principalFrom({
      email: 'admin@example.com', isAdmin: true, person: { roleId: 'viewer' },
      rolesConfig: config, globalFlags: mergeFlags({}),
    });
    assert.equal(p.roleId, 'admin');
    assert.equal(can(p, 'files.upload', { drive: driveAccess(IN_DRIVE, { isAdmin: true }) }).ok, true);
    assert.equal(driveRoleOf(p, 'anything'), 'owner');
  });
});

describe('not capabilities', () => {
  test('admin and trash.manage are env admins alone', () => {
    for (const role of ROLES) {
      assert.equal(can(principal(role), 'admin').ok, role === 'admin', role);
      assert.equal(can(principal(role), 'trash.manage').ok, role === 'admin', role);
    }
  });

  test('the creator can always revoke their link — whatever their role', () => {
    for (const role of ROLES) {
      const p = principal(role);
      assert.equal(can(p, 'shares.revoke', { createdBy: p.email.toUpperCase(), canModify: false }).ok, true, role);
    }
  });

  test('so can anyone who can change the file; nobody else', () => {
    const p = principal('viewer');
    assert.equal(can(p, 'shares.revoke', { createdBy: 'someone@example.com', canModify: true }).ok, true);
    assert.equal(can(p, 'shares.revoke', { createdBy: 'someone@example.com', canModify: false }).ok, false);
  });

  test('an unknown action is refused', () => {
    // A typo in a guard must fail closed.
    assert.equal(can(principal('admin'), 'files.uplaod').ok, false);
    assert.equal(can(principal('member'), 'files.uplaod').ok, false);
  });

  test('no principal is a 401', () => {
    assert.equal(can(null, 'files.upload').status, 401);
  });
});

describe('flags are enforced by the decision', () => {
  test('shares off: no link of any kind, for anyone', () => {
    for (const role of ROLES) {
      const p = principal(role, null, { flags: { shares: false } });
      for (const cap of ['shares.private', 'shares.public', 'review.links']) {
        assert.equal(can(p, cap, { canModify: true }).ok, false, `${role} ${cap}`);
      }
    }
  });

  test('review off: no comments, decisions or review links', () => {
    const p = principal('member', null, { flags: { review: false } });
    for (const cap of ['review.comment', 'review.decide', 'review.links']) assert.equal(can(p, cap, { canModify: true }).ok, false, cap);
  });

  test('AI is off by default for everyone, admins included', () => {
    for (const role of ROLES) assert.equal(can(principal(role), 'ai.generate').ok, false, role);
  });

  test('filespaces off: no desktop at all', () => {
    for (const role of ROLES) assert.equal(can(principal(role, 'owner', { flags: { filespaces: false } }), 'desktop.mount').ok, false, role);
  });

  test('metadata off: a metadata edit is refused, a rename is not', () => {
    const p = principal('member', null, { flags: { metadata: false } });
    assert.equal(can(p, 'files.edit', { metadata: true }).ok, false);
    assert.equal(can(p, 'files.edit', { metadata: false }).ok, true);
  });

  test('the UI flags follow the capabilities: a Viewer is not offered Share', () => {
    assert.equal(principal('viewer').flags.shares, false);
    assert.equal(principal('contributor').flags.shares, true);
    assert.equal(principal('member').flags.aiGenerate, false);
    assert.equal(principalFlags(mergeFlags({ aiGenerate: true }), { isAdmin: false, caps: new Set(['ai.generate']) }).aiGenerate, true);
  });
});

describe('link rules', () => {
  test('the refusal says what the role can do instead', () => {
    assert.match(can(principal('contributor'), 'shares.public', { canModify: true }).reason, /private links only/);
    assert.match(can(principal('viewer'), 'shares.public', { canModify: true }).reason, /cannot make links/);
  });

  test('each kind needs its own capability', () => {
    assert.equal(shareCapFor('private'), 'shares.private');
    assert.equal(shareCapFor('public'), 'shares.public');
    assert.equal(shareCapFor('password'), 'shares.public');
    assert.equal(shareCapFor('review'), 'review.links');
  });

  test('a Contributor’s private links must expire within 30 days', () => {
    const p = principal('contributor');
    assert.equal(can(p, 'shares.private', { canModify: true, expiresInDays: null }).ok, false);
    assert.equal(can(p, 'shares.private', { canModify: true, expiresInDays: 30 }).ok, true);
    assert.equal(can(p, 'shares.private', { canModify: true, expiresInDays: 31 }).ok, false);
  });

  test('the org ceiling on link expiry holds for every role but admin', () => {
    const policy = { shareMaxExpiryDays: 7 };
    assert.equal(can(principal('member', null, { policy }), 'shares.public', { canModify: true, expiresInDays: 30 }).ok, false);
    assert.equal(can(principal('member', null, { policy }), 'shares.public', { canModify: true, expiresInDays: 7 }).ok, true);
    assert.equal(can(principal('admin', null, { policy }), 'shares.public', { canModify: true, expiresInDays: null }).ok, true);
  });

  test('a drive can narrow the kinds of link its files may have', () => {
    const p = principal('member', 'editor');
    assert.equal(can(p, 'shares.public', { canModify: true, kind: 'public', driveShareKinds: ['private'] }).ok, false);
    assert.equal(can(p, 'shares.private', { canModify: true, kind: 'private', driveShareKinds: ['private'] }).ok, true);
  });

  test('a drive whose kinds are none allows no link at all', () => {
    // [] is "no links on this drive" — the opposite of null, "every kind".
    const p = principal('member', 'editor');
    for (const [cap, kind] of [['shares.private', 'private'], ['shares.public', 'public'], ['shares.public', 'password']]) {
      const d = can(p, cap, { canModify: true, kind, driveShareKinds: [] });
      assert.equal(d.ok, false, kind);
      assert.match(d.reason, /turned off for this drive/);
    }
    assert.equal(can(p, 'shares.public', { canModify: true, kind: 'public', driveShareKinds: null }).ok, true);
  });

  test('no write access to the file, no link', () => {
    assert.equal(can(principal('member'), 'shares.private', { canModify: false }).ok, false);
  });
});

describe('self-serve drives', () => {
  test('off by default: only admins create drives', () => {
    assert.equal(can(principal('member'), 'drives.create', { ownedCount: 0 }).ok, false);
    assert.equal(can(principal('admin'), 'drives.create').ok, true);
  });

  test('on: Members up to the per-person limit; Contributors and Viewers never', () => {
    const policy = { drivesSelfServe: true, drivesPerPerson: 2 };
    assert.equal(can(principal('member', null, { policy }), 'drives.create', { ownedCount: 1 }).ok, true);
    assert.equal(can(principal('member', null, { policy }), 'drives.create', { ownedCount: 2 }).ok, false);
    assert.equal(can(principal('contributor', null, { policy }), 'drives.create', { ownedCount: 0 }).ok, false);
    assert.equal(can(principal('viewer', null, { policy }), 'drives.create', { ownedCount: 0 }).ok, false);
  });
});

describe('failing closed', () => {
  test('an unreadable config reads as Viewer, and every write is a 503', () => {
    const p = principalFrom({
      email: 'member@example.com', rolesConfig: config, globalFlags: null, grants: { drives: [DRIVE], roles: { d1: 'owner' } }, degraded: true,
    });
    assert.equal(p.degraded, true);
    for (const cap of ['files.upload', 'files.edit', 'files.delete', 'folders.manage', 'shares.private']) {
      const d = can(p, cap, { canModify: true });
      assert.equal(d.ok, false, cap);
      assert.equal(d.status, 503, cap);
    }
    // Reads carry on — the drive is still theirs to open, read-only.
    assert.equal(driveAccess(IN_DRIVE, p.driveScope).read, true);
    assert.equal(driveAccess(IN_DRIVE, p.driveScope).write, false);
    // And nothing that exposes files or spends money is switched on by the
    // defaults.
    assert.equal(p.flags.shares, false);
    assert.equal(p.flags.aiGenerate, false);
  });

  test('a degraded principal matches no role-subject grant — not the Viewer role’s', () => {
    // Grants made to the Viewer role (folder_access, file_acl) are matched
    // against roleId. Borrowing the read-only role's id during an outage
    // would hand every Member whatever those grants reach — a read that
    // fails open. Fewer grants, never different ones.
    for (const role of ['member', 'contributor', 'viewer']) {
      const p = principalFrom({
        email: `${role}@example.com`, person: { email: `${role}@example.com`, roleId: role },
        rolesConfig: config, globalFlags: null, grants: { drives: [DRIVE], roles: {} }, degraded: true,
      });
      assert.equal(p.roleId, null, role);
      assert.equal(p.role.degradedFrom, role, role);
      // The capabilities are still the read-only role's.
      assert.equal(can(p, 'files.upload').status, 503);
    }
    // Not degraded, the id is the role's own.
    assert.equal(principal('member').roleId, 'member');
    // An admin is never degraded out of anything.
    const a = principalFrom({ email: 'admin@example.com', isAdmin: true, rolesConfig: config, globalFlags: null, degraded: true });
    assert.equal(a.roleId, 'admin');
  });

  test('an admin is not locked out by a failed read', () => {
    const p = principalFrom({ email: 'admin@example.com', isAdmin: true, rolesConfig: config, globalFlags: null, degraded: true });
    assert.equal(can(p, 'files.upload').ok, true);
    assert.equal(can(p, 'admin').ok, true);
  });
});

describe('web/desktop parity', () => {
  // The web builds its principal from the session (which hands in the people
  // row it read) and the desktop from the token (which reads it); both go
  // through getPrincipal → principalFrom. Given the same facts, every
  // decision must match — this pins that the only input that differs, how
  // the person row arrived, changes nothing.
  for (const role of ROLES) {
    for (const granted of DRIVE_ROLES) {
      test(`${role}, drive ${granted || 'none'}`, () => {
        const person = role === 'admin' ? null : { email: `${role}@example.com`, roleId: role, quotaBytes: null };
        const inputs = {
          email: `${role}@example.com`, isAdmin: role === 'admin', rolesConfig: config,
          globalFlags: mergeFlags({ aiGenerate: true }), grants: { drives: [DRIVE], roles: granted ? { d1: granted } : {} },
        };
        const web = principalFrom({ ...inputs, person });
        const desktop = principalFrom({ ...inputs, person: person ? { ...person } : null, tokenId: 'dt-1' });
        const actions = [...CAPABILITY_IDS, 'admin', 'trash.manage', 'drive.manageMembers', 'shares.revoke'];
        for (const key of [IN_DRIVE, OUT_OF_DRIVE]) {
          for (const action of actions) {
            const r = (p) => can(p, action, {
              drive: driveAccess(key, scopeOf(p)), canModify: true, expiresInDays: 7,
              driveRole: driveRoleOf(p, 'd1'), createdBy: 'x@example.com',
            });
            assert.deepEqual(r(web), r(desktop), `${action} ${key}`);
          }
        }
        assert.deepEqual(web.driveScope, desktop.driveScope);
        assert.deepEqual(web.limits, desktop.limits);
      });
    }
  }
});

describe('uploads and limits', () => {
  test('a Viewer’s zero quota never gets as far as the arithmetic', () => {
    const d = can(principal('viewer'), 'files.upload', { size: 10 });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('over the largest upload → 413 naming the limit', () => {
    const p = principal('member', null, { policy: { maxUploadBytes: 1024 * 1024 } });
    const d = can(p, 'files.upload', { size: 2 * 1024 * 1024 });
    assert.equal(d.status, 413);
    assert.equal(d.code, 'max_upload');
    assert.match(d.reason, /1\.0 MB/);
  });

  test('over the quota → 413 naming the quota and what is used', () => {
    const p = principal('member', null, { person: { quotaBytes: 10 * 1024 ** 3 } });
    const d = can(p, 'files.upload', { size: 2 * 1024 ** 3, usedBytes: 9 * 1024 ** 3 });
    assert.equal(d.status, 413);
    assert.equal(d.code, 'quota');
    assert.match(d.reason, /quota of 10 GB/);
    assert.match(d.reason, /9\.0 GB/);
    assert.equal(can(p, 'files.upload', { size: 1024 ** 3, usedBytes: 9 * 1024 ** 3 }).ok, true);
  });

  test('a drive quota is its own limit', () => {
    const p = principal('member', 'editor');
    const d = can(p, 'files.upload', { size: 10, driveQuotaBytes: 100, driveUsedBytes: 95 });
    assert.equal(d.code, 'drive_quota');
  });

  test('admins are not held to the ceilings they set', () => {
    const p = principal('admin', null, { policy: { storageQuotaBytes: 1, maxUploadBytes: 1 } });
    assert.equal(can(p, 'files.upload', { size: 10 ** 12, usedBytes: 10 ** 12 }).ok, true);
  });

  test('the Blob token allowance is the smaller of the largest upload and what is left', () => {
    assert.equal(uploadAllowance(principal('member')), null);
    const p = principal('member', null, { person: { quotaBytes: 1000, maxUploadBytes: 300 } });
    assert.equal(uploadAllowance(p, { usedBytes: 100 }), 300);
    assert.equal(uploadAllowance(p, { usedBytes: 900 }), 100);
    assert.equal(uploadAllowance(p, { usedBytes: 2000 }), 0);
  });

  test('a mount is read-only when uploads are not allowed or the quota is full', () => {
    assert.equal(mountRole({ driveRole: 'editor', canUpload: true, overQuota: true }), 'viewer');
    assert.equal(mountRole({ driveRole: 'owner', canUpload: false }), 'viewer');
    assert.equal(mountRole({ driveRole: 'owner', canUpload: true }), 'owner');
    assert.equal(mountRole({ driveRole: 'mystery', canUpload: true }), 'viewer');
  });
});
