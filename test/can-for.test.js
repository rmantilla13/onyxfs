// What the library's menus offer for a file (app/files/can-for.js), and how
// the listing works out the answer it reads (lib/file-listing.js
// withFileCan). A menu that offers what the route refuses is how a Member
// was shown Rename, Move and Delete on a colleague's file, and a 403 for
// trying.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.ADMIN_EMAILS = 'admin@example.com';

const { canFor, canForSome } = await import('../app/files/can-for.js');
const { withFileCan } = await import('../lib/file-listing.js');
const { principalFrom } = await import('../lib/authz.js');
const { parseRolesConfig } = await import('../lib/roles.js');
const { mergeFlags } = await import('../lib/features.js');

describe('canFor', () => {
  test("the server's answer decides, whatever the page allows", () => {
    const theirs = { id: 'a', can: { edit: false, delete: false, share: false } };
    assert.deepEqual(canFor(theirs, { canWrite: true }), { edit: false, delete: false, share: false });
    const mine = { id: 'b', can: { edit: true, delete: true, share: true } };
    assert.deepEqual(canFor(mine, { canWrite: false }), { edit: true, delete: true, share: true });
  });

  test('a row without an answer falls back to the page', () => {
    assert.deepEqual(canFor({ id: 'c' }, { canWrite: true }), { edit: true, delete: true, share: true });
    assert.deepEqual(canFor({ id: 'c' }, { canWrite: false }), { edit: false, delete: false, share: false });
    assert.deepEqual(canFor(null), { edit: false, delete: false, share: false });
  });

  test('a selection is offered an action when any of it allows it, never when none does', () => {
    const files = [
      { id: 'a', can: { edit: false, delete: false, share: false } },
      { id: 'b', can: { edit: true, delete: false, share: true } },
    ];
    assert.equal(canForSome(['a', 'b'], files, 'edit'), true);
    assert.equal(canForSome(['a', 'b'], files, 'delete'), false);
    assert.equal(canForSome(new Set(['a']), files, 'edit', { canWrite: true }), false);
    // Selected but not on this page: the page's answer.
    assert.equal(canForSome(['z'], files, 'delete', { canWrite: true }), true);
    assert.equal(canForSome(['z'], files, 'delete', { canWrite: false }), false);
  });
});

describe('withFileCan', () => {
  const config = parseRolesConfig(null);
  const who = (role, isAdmin = false) => principalFrom({
    email: `${role}@example.com`, isAdmin, person: isAdmin ? null : { email: `${role}@example.com`, roleId: role },
    rolesConfig: config, globalFlags: mergeFlags({}), grants: { drives: [], roles: {} },
  });
  const files = [
    { id: '1', createdBy: 'member@example.com', storageKey: 'files/a.jpg', folder: '' },
    { id: '2', createdBy: 'someone@example.com', storageKey: 'files/b.jpg', folder: '' },
  ];

  test('an admin may do anything to anything', async () => {
    const out = await withFileCan(files, who('admin', true));
    for (const f of out) assert.deepEqual(f.can, { edit: true, delete: true, share: true });
  });

  test('a Member: their own file, not a colleague’s', async () => {
    // No database here, so no grants: the creator rule alone decides.
    const out = await withFileCan(files, who('member'));
    assert.deepEqual(out[0].can, { edit: true, delete: true, share: true });
    assert.deepEqual(out[1].can, { edit: false, delete: false, share: false });
  });

  test('a Viewer changes nothing, even what they added', async () => {
    const mine = [{ ...files[0], createdBy: 'viewer@example.com' }];
    const [f] = await withFileCan(mine, who('viewer'));
    assert.equal(f.can.edit, false);
    assert.equal(f.can.delete, false);
  });

  test('the rows are otherwise untouched, and an empty page stays empty', async () => {
    const [f] = await withFileCan(files, who('member'));
    assert.equal(f.storageKey, 'files/a.jpg');
    assert.deepEqual(await withFileCan([], who('member')), []);
  });
});
