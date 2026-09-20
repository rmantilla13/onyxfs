// Tests for WRITE authorization on a single file.
//
// The hole this closes: PATCH and DELETE /api/files/[id] checked only that a
// session existed. Any signed-in member could rename, move, re-tag or delete
// any file in the workspace by id. Invisible in a single-owner deployment,
// live the moment there is a second member or a bearer token.
//
// The tempting fix — reuse canAccessFile — is wrong, and that is the thing
// worth pinning down here. canAccessFile returns true for any file with
// visibility 'org', which is what every upload gets by default. Guarding a
// delete with it would have meant every member can delete everything, while
// looking like a fix.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { fileWriteDecision } = await import('../lib/db.js');

const file = (over = {}) => ({
  id: 'f1', name: 'a.mov', folder: 'Campaigns/Spring',
  createdBy: 'owner@example.com', visibility: 'org', ...over,
});
const who = (over = {}) => ({ email: 'someone@example.com', isAdmin: false, roleId: 'member', ...over });

describe('fileWriteDecision', () => {
  test('org visibility does NOT grant write', () => {
    // THE regression. Seeing and changing are different rights.
    const d = fileWriteDecision({ file: file({ visibility: 'org' }), principal: who() });
    assert.equal(d.allowed, false, 'an org-visible file was writable by a non-grantee');
    assert.equal(d.reason, 'no-grant');
  });

  test('the creator may write their own file', () => {
    const d = fileWriteDecision({ file: file(), principal: who({ email: 'owner@example.com' }) });
    assert.equal(d.allowed, true);
    assert.equal(d.reason, 'creator');
  });

  test('email comparison is case-insensitive', () => {
    const d = fileWriteDecision({
      file: file({ createdBy: 'Owner@Example.com' }),
      principal: who({ email: 'owner@example.com' }),
    });
    assert.equal(d.allowed, true);
  });

  test('an admin may write anything', () => {
    const d = fileWriteDecision({ file: file(), principal: who({ isAdmin: true }) });
    assert.equal(d.allowed, true);
    assert.equal(d.reason, 'admin');
  });

  describe('grants', () => {
    test('an editor or owner grant on the file allows writing', () => {
      for (const access of ['editor', 'owner']) {
        const d = fileWriteDecision({ file: file(), principal: who(), fileAccess: access });
        assert.equal(d.allowed, true, `${access} should be able to write`);
        assert.equal(d.reason, 'file-grant');
      }
    });

    test('a viewer grant on the file does not', () => {
      // Read access is not write access, however explicit.
      const d = fileWriteDecision({ file: file(), principal: who(), fileAccess: 'viewer' });
      assert.equal(d.allowed, false);
    });

    test('an editor grant on an ancestor folder allows writing', () => {
      const d = fileWriteDecision({ file: file(), principal: who(), folderRoles: ['editor'] });
      assert.equal(d.allowed, true);
      assert.equal(d.reason, 'folder-grant');
    });

    test('a viewer grant on a folder does not, even alongside other viewer grants', () => {
      const d = fileWriteDecision({ file: file(), principal: who(), folderRoles: ['viewer', 'viewer'] });
      assert.equal(d.allowed, false);
    });

    test('the most permissive grant wins when several apply', () => {
      const d = fileWriteDecision({ file: file(), principal: who(), folderRoles: ['viewer', 'owner'] });
      assert.equal(d.allowed, true);
    });
  });

  describe('the platform viewer rule', () => {
    test('a platform viewer cannot write even their own file', () => {
      // The files UI hides write controls from them; this is the half a
      // crafted request cannot route around.
      const d = fileWriteDecision({
        file: file({ createdBy: 'viewer@example.com' }),
        principal: who({ email: 'viewer@example.com', roleId: 'viewer' }),
      });
      assert.equal(d.allowed, false);
      assert.equal(d.reason, 'platform-viewer');
    });

    test('a platform viewer cannot write with an explicit editor grant either', () => {
      const d = fileWriteDecision({
        file: file(), principal: who({ roleId: 'viewer' }), fileAccess: 'owner',
      });
      assert.equal(d.allowed, false);
    });

    test('an admin is not blocked by a viewer role id', () => {
      const d = fileWriteDecision({ file: file(), principal: who({ roleId: 'viewer', isAdmin: true }) });
      assert.equal(d.allowed, true);
    });
  });

  test('a missing file is refused rather than assumed writable', () => {
    assert.equal(fileWriteDecision({ file: null, principal: who({ isAdmin: true }) }).allowed, false);
    assert.equal(fileWriteDecision({}).allowed, false);
  });

  test('an unknown grant string is not treated as write', () => {
    // Guards against a future role name silently meaning "allowed".
    for (const access of ['contributor', 'admin', '', null, undefined]) {
      assert.equal(fileWriteDecision({ file: file(), principal: who(), fileAccess: access }).allowed, false, String(access));
    }
  });
});
