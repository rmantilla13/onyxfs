// There is no sign-up. An address signs in because an admin added it
// (Admin → Access requests) or because it is in ADMIN_EMAILS, and nothing a
// stranger can reach adds one: the sign-in page only sends links to
// addresses already approved.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.jsx?$/.test(name)) out.push(p);
  }
  return out;
}

// What makes an address one that may sign in: the lib/db.js functions that
// write an approved (or pending) invite_requests row. The last is the
// sign-in page's request form, removed; its name stays here so it cannot
// come back unnoticed.
const WRITERS = ['adminAddApprovedInvite', 'updateInviteRequest', 'createOrGetInviteRequest'];

describe('no sign-up', () => {
  test('only the admin API decides who may sign in', () => {
    // Every handler there checks for an admin first (test/admin-api.test.js).
    const adminApi = join(root, 'app', 'api', 'admin') + sep;
    const definedIn = join(root, 'lib', 'db.js');
    const files = [...sources(join(root, 'app')), ...sources(join(root, 'lib'))];
    for (const file of files) {
      if (file.startsWith(adminApi) || file === definedIn) continue;
      const src = readFileSync(file, 'utf8');
      for (const w of WRITERS) {
        assert.doesNotMatch(src, new RegExp(`\\b${w}\\b`), `${relative(root, file)} uses ${w}`);
      }
    }
    assert.doesNotMatch(readFileSync(definedIn, 'utf8'), /\bcreateOrGetInviteRequest\b/);
  });

  test('a flag saved while requests were taken does not bring them back', async () => {
    const { getFlag, mergeFlags } = await import('../lib/features.js');
    assert.equal(getFlag('inviteRequests'), undefined);
    assert.equal('inviteRequests' in mergeFlags({ inviteRequests: true }), false);
  });
});
