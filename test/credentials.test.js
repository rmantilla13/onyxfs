// Tests for the credential ladder.
//
// This decides how much authority a desktop client is handed. The failure mode
// that matters is not an error — it is quietly issuing a *broader* credential
// than intended, which nothing downstream would notice.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { credentialPlan, fileKind, buildObjectKey, folderToKeyPath, isSystemKey, isThumbnailKey } from '../lib/storage.js';

const aws = { provider: 's3', bucket: 'b', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK' };
const r2 = { ...aws, endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto' };

describe('credential ladder', () => {
  test('a filespace with its own keys uses them, for every role', () => {
    const fs = { id: 'f1', accessKeyId: 'FAK', secretAccessKey: 'FSK' };
    for (const role of ['viewer', 'editor', 'owner']) {
      const plan = credentialPlan(aws, fs, { role });
      assert.equal(plan.strategy, 'filespace-static');
      assert.equal(plan.staticAllowed, true, `${role} should be able to use a dedicated key`);
    }
  });

  test('a filespace with a key but no secret does NOT count as having its own keys', () => {
    // Half-configured credentials must not be treated as usable — that would
    // produce a client that authenticates with an undefined secret.
    const plan = credentialPlan(aws, { id: 'f1', accessKeyId: 'FAK' }, { role: 'owner' });
    assert.notEqual(plan.strategy, 'filespace-static');
  });

  test('plain AWS with no role ARN uses federation — scoped and expiring', () => {
    assert.equal(credentialPlan(aws, { id: 'f' }, { role: 'editor' }).strategy, 'federation');
  });

  test('a configured role ARN takes precedence over federation', () => {
    const plan = credentialPlan({ ...aws, roleArn: 'arn:aws:iam::1:role/x' }, { id: 'f' }, { role: 'viewer' });
    assert.equal(plan.strategy, 'assume-role');
  });

  test("a filespace's own role ARN overrides the global one", () => {
    const plan = credentialPlan(aws, { id: 'f', roleArn: 'arn:aws:iam::1:role/fs' }, { role: 'viewer' });
    assert.equal(plan.strategy, 'assume-role');
  });

  test('an explicit role ARN never degrades to a static key', () => {
    // An admin who configured a role asked for scoped credentials. Silently
    // handing out the master key instead would be the worst kind of fallback:
    // it succeeds, so nobody investigates.
    const plan = credentialPlan({ ...aws, roleArn: 'arn:aws:iam::1:role/x' }, null, { role: 'owner' });
    assert.equal(plan.staticAllowed, false);
  });

  test('a custom endpoint goes straight to static — no STS exists there', () => {
    assert.equal(credentialPlan(r2, { id: 'f' }, { role: 'editor' }).strategy, 'static');
  });

  describe('the viewer rule', () => {
    test('a viewer is refused a static key on a custom endpoint', () => {
      const plan = credentialPlan(r2, { id: 'f' }, { role: 'viewer' });
      assert.equal(plan.strategy, 'static');
      assert.equal(plan.staticAllowed, false,
        'a static key cannot be scoped or expired — giving one to a viewer grants full write access');
    });

    test('a viewer is refused the static fallback after federation fails', () => {
      const plan = credentialPlan(aws, { id: 'f' }, { role: 'viewer' });
      assert.equal(plan.strategy, 'federation');
      assert.equal(plan.staticAllowed, false);
    });

    test('editors and owners may use a static key', () => {
      for (const role of ['editor', 'owner']) {
        assert.equal(credentialPlan(r2, { id: 'f' }, { role }).staticAllowed, true);
      }
    });

    test('an unspecified role defaults to viewer, the least privileged', () => {
      // A caller that forgets to pass a role must not accidentally get write
      // credentials. Defaulting to the most restrictive reading is the only
      // safe direction for this particular default to fail in.
      assert.equal(credentialPlan(r2, { id: 'f' }, {}).staticAllowed, false);
      assert.equal(credentialPlan(r2, { id: 'f' }).staticAllowed, false);
    });

    test('an unrecognised role is treated as non-viewer, not as admin', () => {
      // Roles come from a grant table. An unknown value should not silently
      // unlock anything a viewer cannot do beyond the static rung.
      const plan = credentialPlan(r2, { id: 'f' }, { role: 'something-else' });
      assert.equal(plan.strategy, 'static');
    });
  });
});

describe('object keys', () => {
  test('a folder path becomes a key path, dropping empty segments', () => {
    assert.equal(folderToKeyPath('/Clients//Acme/'), 'Clients/Acme');
    assert.equal(folderToKeyPath(''), '');
    assert.equal(folderToKeyPath(null), '');
  });

  test('the bucket mirrors the in-app folder so a mounted drive matches the web', () => {
    const key = buildObjectKey({ prefix: 'files' }, 'Shot 01.mov', 'Clients/Acme');
    assert.equal(key, 'files/Clients/Acme/Shot 01.mov');
  });

  test('filenames keep spaces and parens but lose path separators', () => {
    const key = buildObjectKey({ prefix: 'files' }, 'a/b (2).mov', '');
    assert.ok(!key.slice('files/'.length).includes('/'), 'a filename must not introduce a path segment');
    assert.ok(key.includes('(2)'));
  });

  test('an empty filename still produces a usable key', () => {
    assert.ok(buildObjectKey({ prefix: 'files' }, '', '').endsWith('/file'));
    assert.ok(buildObjectKey({ prefix: 'files' }, '..', '').endsWith('/file'));
  });
});

describe('artifact detection', () => {
  test('thumbnails under the dedicated prefix are recognised', () => {
    assert.ok(isThumbnailKey('_thumbs/abc.webp'));
    assert.ok(isThumbnailKey('files/_thumbs/abc.webp'));
  });

  test('a real file whose name merely contains "thumbs" is not a thumbnail', () => {
    assert.ok(!isThumbnailKey('files/thumbsup.mov'));
    assert.ok(!isThumbnailKey('files/Xthumbs/real.mov'));
  });

  test('OS junk is detected by basename, not by path', () => {
    assert.ok(isSystemKey('files/Clients/.DS_Store'));
    assert.ok(isSystemKey('._resourcefork'));
    assert.ok(isSystemKey('files/Thumbs.db'));
    assert.ok(!isSystemKey('files/my.DS_Store.mov'));
  });
});

describe('file kind', () => {
  test('classifies by mime first, then extension', () => {
    assert.equal(fileKind('image/png', ''), 'image');
    assert.equal(fileKind('', 'clip.MOV'), 'video');
    assert.equal(fileKind('', 'track.wav'), 'audio');
    assert.equal(fileKind('application/pdf', ''), 'doc');
    assert.equal(fileKind('', 'archive.zip'), 'other');
  });

  test('an unknown mime falls through to the extension rather than giving up', () => {
    assert.equal(fileKind('application/octet-stream', 'clip.mp4'), 'video');
  });
});
