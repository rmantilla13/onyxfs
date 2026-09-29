// A drive always has an owner (lib/drive-access.js): who takes a drive on
// when a change would leave it with none, what the fix for drives that have
// none says before and after, and — pinned where they could quietly slip —
// the routes that make a drive or take an owner away passing the admin on.
// The statements themselves run in test/drive-owners-db.test.js, against a
// real database, when TEST_DATABASE_URL is set.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownerOfLastResort, lastOwnerRefusal } from '../lib/drive-access.js';
import { claimDrivesConfirm, claimedDrivesMessage } from '../lib/admin-drives.js';
import { attentionItems } from '../lib/admin-overview.js';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const admin = { email: 'Boss@Example.com', isAdmin: true };
const owner = { email: 'own@example.com', isAdmin: false };

describe('who takes a drive on when a change would leave it with no owner', () => {
  test('the admin making the change', () => {
    assert.equal(ownerOfLastResort({ actor: admin, targetEmail: 'last@example.com' }), 'boss@example.com');
  });

  test('never the person the change takes away: that would only undo it', () => {
    assert.equal(ownerOfLastResort({ actor: admin, targetEmail: ' boss@EXAMPLE.com ' }), null);
  });

  test('nobody, for anyone who is not an admin — their change is refused', () => {
    assert.equal(ownerOfLastResort({ actor: owner, targetEmail: 'last@example.com' }), null);
    assert.equal(ownerOfLastResort({ actor: { isAdmin: true }, targetEmail: 'last@example.com' }), null, 'an admin with no address');
    assert.equal(ownerOfLastResort({}), null);
  });

  test('the refusal says who the only owner is, and what to do first', () => {
    assert.equal(lastOwnerRefusal({ actor: admin, targetEmail: 'boss@example.com' }),
      'You are this drive’s only owner. Make someone else an owner first.');
    assert.equal(lastOwnerRefusal({ actor: owner, targetEmail: 'Last@Example.com' }),
      'last@example.com is this drive’s only owner. Make someone else an owner first.');
  });
});

describe('the fix for drives with no owner', () => {
  const one = [{ id: 'd1', name: 'Archive' }];
  const two = [{ id: 'd1', name: 'Archive' }, { id: 'd2', name: 'Acme' }];

  test('the confirm names every drive it changes: in the title for one, as a list for more', () => {
    const a = claimDrivesConfirm(one);
    assert.equal(a.title, 'Make yourself the owner of “Archive”?');
    assert.deepEqual(a.names, []);
    assert.equal(a.lead, null);
    const b = claimDrivesConfirm(two);
    assert.equal(b.title, 'Make yourself the owner of 2 drives?');
    assert.deepEqual(b.names, ['Archive', 'Acme']);
    assert.equal(b.confirmLabel, 'Make me the owner');
  });

  test('and says that nobody’s access changes, and how to hand a drive on', () => {
    const { lines } = claimDrivesConfirm(two);
    assert.match(lines[0], /owner of each\. Nobody’s access changes/);
    assert.match(lines[1], /add them as its owner, then remove yourself/);
    assert.match(claimDrivesConfirm(one).lines[0], /^You will be listed as its owner\./);
  });

  test('afterwards: what is the admin’s now, by name, and what had an owner by then', () => {
    assert.equal(claimedDrivesMessage({ claimed: one, skipped: [] }), 'You own “Archive” now.');
    assert.equal(claimedDrivesMessage({ claimed: two, skipped: ['d3'] }), 'You own “Archive” and “Acme” now. 1 had an owner by then.');
    const five = ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ id: `d${i}`, name }));
    assert.equal(claimedDrivesMessage({ claimed: five }), 'You own “A”, “B” and 3 more now.');
    assert.equal(claimedDrivesMessage({ claimed: five.slice(0, 3) }), 'You own “A”, “B” and “C” now.');
    assert.equal(claimedDrivesMessage({ claimed: [], skipped: ['d1'] }), 'Nothing changed: it has an owner now.');
    assert.equal(claimedDrivesMessage({ claimed: [], skipped: ['d1', 'd2'] }), 'Nothing changed: they have owners now.');
  });

  test('the Overview’s warning carries the drives its fix claims, one or many, and nothing else does', () => {
    const [single] = attentionItems({ drivesWithoutOwner: [{ id: 'd1', name: 'Archive', ownerCount: 0 }] });
    assert.deepEqual(single.claim, one, 'just what the route needs');
    assert.equal(single.href, '/admin/drives/d1#members', 'the link to add someone else is still there');
    const [many] = attentionItems({ drivesWithoutOwner: two });
    assert.deepEqual(many.claim, two);
    const [waiting] = attentionItems({ pending: [{ email: 'a@x.com' }] });
    assert.equal(waiting.claim, undefined);
  });
});

describe('every way in keeps the owner', () => {
  test('a drive is made with its owner: the admin’s and the self-serve route both name one', () => {
    assert.match(read('app/api/admin/filespaces/route.js'), /createFilespace\(\{[\s\S]*?owner: gate\.email,[\s\S]*?\}\)/);
    const self = read('app/api/filespaces/route.js');
    assert.match(self, /createFilespace\(\{[^}]*owner: email[^}]*\}\)/);
    assert.doesNotMatch(self, /grantFilespaceAccess/, 'no second statement, and no exception for admins');
  });

  test('a member change passes the admin on as the fallback owner, both ways, and refuses without one', () => {
    const src = read('app/api/filespaces/[id]/members/route.js');
    assert.match(src, /revokeFilespaceAccess\(\{[^}]*fallbackOwner[^}]*\}\)/);
    assert.match(src, /grantFilespaceAccess\(\{[^}]*fallbackOwner[^}]*\}\)/);
    assert.equal(src.match(/if \(r\.refused\) return lastOwner\(\);/g)?.length, 2);
    assert.match(src, /const lastOwner = \(\) => NextResponse\.json\([^;]*status: 409 \}\)/);
    const people = read('lib/people.js');
    assert.equal(people.match(/fallbackOwner: by/g)?.length, 2, 'applyGrantDiff, for People → drives and invites');
  });

  test('removing a person names the admin removing them, on both routes', () => {
    for (const r of ['app/api/admin/people/[id]/route.js', 'app/api/admin/invites/route.js']) {
      assert.match(read(r), /removePerson\(email, \{ apply: true, by: guard\.email \}\)/, r);
      assert.match(read(r), /auditDriveClaims\(guard\.email, result\.claimed/, r);
    }
  });

  test('the fix is never cached, and is recorded', () => {
    const src = read('app/api/admin/filespaces/claim/route.js');
    assert.match(src, /'cache-control': 'no-store'/);
    assert.match(src, /auditDriveClaims\(guard\.email, claimed\)/);
  });
});
