// Tests for the object move that backs a per-file Move and a folder rename.
//
// These run against a REAL S3 API — `moto` on localhost — rather than a mock,
// because the thing worth testing is not that we call CopyObject: it is that
// the key we compute is the key the object actually lands at, and that the
// old one is gone afterwards. A mock would agree with whatever we wrote.
//
// Start one with:
//   pip install 'moto[server]' && python -m moto.server -p 5111
//
// Skipped, not failed, when nothing is listening — CI has no S3 and a test
// that fails for want of a local service teaches people to ignore red.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { folderToKeyPath, s3MoveObject } from '../lib/storage.js';

const ENDPOINT = process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:5111';
const BUCKET = 'onyx-move-test';

const cfg = {
  provider: 's3', bucket: BUCKET, region: 'us-east-1', endpoint: ENDPOINT,
  accessKeyId: 'test', secretAccessKey: 'test', prefix: 'files',
};

let live = false;
let S3;
let client;

before(async () => {
  // Probe with the SDK, not with fetch(ENDPOINT). moto's dev server does not
  // answer a bare GET / — the request simply hangs — so the old probe timed
  // out and the whole file skipped while a perfectly good S3 was listening on
  // the port. A false skip is worse than a false failure: nothing is red, so
  // nobody looks, and the tests quietly stop running.
  //
  // Creating the bucket IS the probe. It answers the question the tests
  // actually depend on — can we use S3 here — rather than whether something
  // is bound to the port.
  S3 = await import('@aws-sdk/client-s3');
  client = new S3.S3Client({
    region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestHandler: { requestTimeout: 3000, connectionTimeout: 1500 },
    maxAttempts: 1,
  });
  try {
    await client.send(new S3.CreateBucketCommand({ Bucket: BUCKET }));
    live = true;
  } catch (e) {
    // An existing bucket means it is very much alive; anything else means it
    // is not reachable.
    live = /BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(`${e?.name} ${e?.Code} ${e?.message}`);
  }
});

const put = (Key, Body) => client.send(new S3.PutObjectCommand({ Bucket: BUCKET, Key, Body }));
const body = async (Key) => {
  const r = await client.send(new S3.GetObjectCommand({ Bucket: BUCKET, Key }));
  return r.Body.transformToString();
};
const exists = async (Key) => {
  try { await client.send(new S3.HeadObjectCommand({ Bucket: BUCKET, Key })); return true; }
  catch { return false; }
};

// The key a move should target, built the way both callers build it.
const keyFor = (prefix, folder, basename) =>
  [prefix, folderToKeyPath(folder), basename].filter(Boolean).join('/');

describe('folderToKeyPath', () => {
  test('a root folder contributes no path segment', () => {
    // The .filter(Boolean) in the key builder depends on this being falsy —
    // otherwise the key gets a double slash and nothing can find it again.
    assert.ok(!folderToKeyPath(''));
    assert.ok(!folderToKeyPath(null));
  });

  test('nested folders survive the round trip into a key', () => {
    assert.equal(keyFor('files', 'Campaigns/Spring', 'clip.mov'), 'files/Campaigns/Spring/clip.mov');
    assert.equal(keyFor('files', '', 'clip.mov'), 'files/clip.mov');
  });
});

describe('s3MoveObject (needs a local S3)', () => {
  test('the bytes land at the new key and the old key is gone', async (t) => {
    if (!live) return t.skip(`no S3 at ${ENDPOINT}`);
    const from = 'files/Campaigns/move-a.mov';
    const to = keyFor('files', 'Campaigns/Spring', 'move-a.mov');
    await put(from, 'BYTES-A');

    await s3MoveObject(cfg, from, to);

    assert.equal(await body(to), 'BYTES-A', 'the object at the new key is not the one we moved');
    assert.equal(await exists(from), false, 'the old key still exists — this is a copy, not a move');
  });

  test('moving to the root prefix produces no double slash', async (t) => {
    if (!live) return t.skip(`no S3 at ${ENDPOINT}`);
    const from = 'files/Campaigns/move-b.mov';
    const to = keyFor('files', '', 'move-b.mov');
    await put(from, 'BYTES-B');

    await s3MoveObject(cfg, from, to);

    assert.equal(to, 'files/move-b.mov');
    assert.equal(await body(to), 'BYTES-B');
  });

  test('a move of a missing object throws rather than reporting success', async (t) => {
    if (!live) return t.skip(`no S3 at ${ENDPOINT}`);
    // This is the case the route must not swallow: if the copy fails and we
    // still commit the catalog row, the file becomes unreachable with no
    // record of where it went.
    await assert.rejects(() => s3MoveObject(cfg, 'files/does-not-exist.mov', 'files/elsewhere.mov'));
  });

  test('it reports false instead of throwing when it did not move anything', async (t) => {
    if (!live) return t.skip(`no S3 at ${ENDPOINT}`);
    // This is the contract that matters to every caller, and it is easy to
    // miss: s3MoveObject RETURNS FALSE rather than throwing when the config
    // is not ready, either key is empty, the keys match, or the SDK is
    // absent. A caller that only guards with try/catch will therefore call
    // setFileStorageKey for a move that never happened — and the row then
    // points at a key that does not exist, which is the one outcome worse
    // than a failed move.
    const from = 'files/Campaigns/move-c.mov';
    await put(from, 'BYTES-C');

    assert.equal(await s3MoveObject(cfg, from, ''), false, 'empty destination should report false');
    assert.equal(await s3MoveObject(cfg, '', 'files/x.mov'), false, 'empty source should report false');
    assert.equal(await s3MoveObject(cfg, from, from), false, 'a no-op move should report false');

    assert.equal(await body(from), 'BYTES-C', 'a refused move must leave the source alone');
  });

  test('a genuine move reports true', async (t) => {
    if (!live) return t.skip(`no S3 at ${ENDPOINT}`);
    const from = 'files/Campaigns/move-d.mov';
    await put(from, 'BYTES-D');
    assert.equal(await s3MoveObject(cfg, from, 'files/Archive/move-d.mov'), true);
  });
});
