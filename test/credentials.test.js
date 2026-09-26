// Tests for the credential ladder.
//
// This decides how much authority a desktop client is handed. The failure mode
// that matters is not an error — it is quietly issuing a *broader* credential
// than intended, which nothing downstream would notice.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialPlan, fileKind, buildObjectKey, folderToKeyPath, isSystemKey, isThumbnailKey,
  storageProvider, staticRefusalMessage, b2KeyRequest, b2RegionFromEndpoint, b2RegionMismatch,
} from '../lib/storage.js';

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

    test('only an admin may use the deployment key', () => {
      // The static key reaches every drive in the bucket. An admin owns all
      // of it anyway; an editor of one drive would be handed every other.
      for (const role of ['editor', 'owner']) {
        assert.equal(credentialPlan(r2, { id: 'f' }, { role }).staticAllowed, false, `non-admin ${role}`);
        assert.equal(credentialPlan(r2, { id: 'f' }, { role, isAdmin: true }).staticAllowed, true, `admin ${role}`);
      }
      // …on every rung that could fall back to it.
      assert.equal(credentialPlan(aws, { id: 'f' }, { role: 'editor' }).staticAllowed, false);
      assert.equal(credentialPlan({ ...aws, endpoint: 'https://s3.us-west-004.backblazeb2.com' }, { id: 'f' }, { role: 'editor' }).staticAllowed, false);
    });

    test('an admin viewer role still never gets the static key', () => {
      assert.equal(credentialPlan(r2, { id: 'f' }, { role: 'viewer', isAdmin: true }).staticAllowed, false);
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

// ── Backblaze B2 ────────────────────────────────────────────────────────────
// B2 has no STS, which is why every non-AWS provider used to fall to the
// static key and viewers were refused outright. b2_create_key gives the same
// three guarantees AssumeRole does — one bucket, one prefix, an expiry — so
// B2 gets a real scoped rung. These tests cover the part that fails silently:
// a key that carries more authority than the role asked for.

const b2 = { ...aws, endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004' };

describe('Backblaze B2', () => {
  test('is detected from its endpoint', () => {
    assert.equal(storageProvider(b2), 'b2');
    assert.equal(storageProvider(r2), 'r2');
    assert.equal(storageProvider(aws), 'aws');
    assert.equal(storageProvider({ ...aws, endpoint: 'https://minio.internal' }), 'other');
  });

  test('every role gets the scoped rung, viewers included', () => {
    for (const role of ['viewer', 'editor', 'owner']) {
      assert.equal(credentialPlan(b2, { id: 'f' }, { role }).strategy, 'b2-native', role);
    }
  });

  test('nobody but an admin may fall back to the master key', () => {
    // The scoped rung is tried first, but if minting fails the admin rule
    // is what stops a member being handed the deployment's key.
    assert.equal(credentialPlan(b2, { id: 'f' }, { role: 'viewer' }).staticAllowed, false);
    assert.equal(credentialPlan(b2, { id: 'f' }, { role: 'editor' }).staticAllowed, false);
    assert.equal(credentialPlan(b2, { id: 'f' }, { role: 'owner', isAdmin: true }).staticAllowed, true);
  });

  test('the refusal names the B2 capability, not an AWS IAM action', () => {
    // An admin told to allow sts:GetFederationToken on B2 goes looking for a
    // setting that does not exist.
    assert.match(staticRefusalMessage(b2), /writeKeys/);
    assert.doesNotMatch(staticRefusalMessage(b2), /sts:/i);
    assert.match(staticRefusalMessage(aws), /sts:GetFederationToken/);
  });

  test('the region comes out of the endpoint', () => {
    assert.equal(b2RegionFromEndpoint('https://s3.us-west-004.backblazeb2.com'), 'us-west-004');
    assert.equal(b2RegionFromEndpoint('https://s3.eu-central-003.backblazeb2.com'), 'eu-central-003');
    assert.equal(b2RegionFromEndpoint('https://example.com'), null);
  });
});

describe('b2KeyRequest', () => {
  const base = { accountId: 'acct', bucketId: 'bkt', prefix: 'spaces/alpha', filespaceId: 'alpha' };

  test('a viewer key cannot write or delete', () => {
    // THE test. A viewer key carrying writeFiles is not an error anyone sees.
    const { capabilities } = b2KeyRequest({ ...base, role: 'viewer' });
    for (const cap of ['writeFiles', 'deleteFiles', 'writeKeys', 'deleteBuckets']) {
      assert.ok(!capabilities.includes(cap), `a viewer key carries ${cap}`);
    }
    assert.ok(capabilities.includes('readFiles'));
  });

  test('an editor key can write', () => {
    const { capabilities } = b2KeyRequest({ ...base, role: 'editor' });
    assert.ok(capabilities.includes('writeFiles'));
    assert.ok(capabilities.includes('deleteFiles'));
  });

  test('the prefix is terminated, so it cannot match a sibling', () => {
    // Without the trailing slash a key scoped to "spring" also reaches
    // "springboard/" — a different filespace.
    assert.equal(b2KeyRequest({ ...base, prefix: 'spring' }).namePrefix, 'spring/');
    assert.equal(b2KeyRequest({ ...base, prefix: '/spaces/alpha/' }).namePrefix, 'spaces/alpha/');
  });

  test('a key with no prefix is refused, not widened to the bucket', () => {
    assert.throws(() => b2KeyRequest({ ...base, prefix: '' }), /prefix/i);
    assert.throws(() => b2KeyRequest({ ...base, prefix: '///' }), /prefix/i);
  });

  test('it is always restricted to one bucket', () => {
    assert.equal(b2KeyRequest(base).bucketId, 'bkt');
    assert.throws(() => b2KeyRequest({ ...base, bucketId: '' }), /bucket/i);
  });

  test('the key always expires, and never lives longer than a day', () => {
    // B2 keeps a key until it expires, so an unbounded one accumulates a row
    // per mount forever.
    assert.equal(b2KeyRequest({ ...base, durationSeconds: 3600 }).validDurationInSeconds, 3600);
    assert.equal(b2KeyRequest({ ...base, durationSeconds: 999999 }).validDurationInSeconds, 24 * 60 * 60);
    assert.equal(b2KeyRequest({ ...base, durationSeconds: 5 }).validDurationInSeconds, 900);
    assert.equal(b2KeyRequest({ ...base, durationSeconds: undefined }).validDurationInSeconds, 3600);
  });

  test('the key name is legal for B2', () => {
    const { keyName } = b2KeyRequest({ ...base, filespaceId: 'a b/c@d' });
    assert.match(keyName, /^[A-Za-z0-9-]+$/, keyName);
    assert.ok(keyName.length <= 100);
  });
});

// ── B2 region / endpoint agreement ──────────────────────────────────────────
// The region and the endpoint are entered as separate fields and each looks
// fine alone. SigV4 signs the request with the region, so a disagreement
// surfaces as an authentication failure — which reads as "bad credentials"
// and sends people to regenerate a perfectly good key.
describe('b2RegionMismatch', () => {
  const b2cfg = (over = {}) => ({
    provider: 's3', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's',
    endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', ...over,
  });

  test('agreement is silent', () => {
    assert.equal(b2RegionMismatch(b2cfg()), null);
    assert.equal(b2RegionMismatch(b2cfg({ region: 'US-WEST-004' })), null, 'case should not matter');
  });

  test('a disagreement names both sides', () => {
    const m = b2RegionMismatch(b2cfg({ region: 'us-east-005' }));
    assert.match(m.detail, /us-east-005/);
    assert.match(m.detail, /us-west-004/);
    assert.match(m.fix, /us-west-004/);
  });

  test('a blank region is caught, since SigV4 still signs with something', () => {
    assert.match(b2RegionMismatch(b2cfg({ region: '' })).detail, /No region/);
  });

  test('an endpoint that is not a B2 endpoint is called out', () => {
    assert.match(b2RegionMismatch(b2cfg({ endpoint: 'https://s3.backblazeb2.com' })).detail, /not a recognisable/);
  });

  test('it says nothing about other providers', () => {
    assert.equal(b2RegionMismatch({ endpoint: '', region: 'us-east-1' }), null);
    assert.equal(b2RegionMismatch({ endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto' }), null);
  });
});
