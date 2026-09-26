// Thumbnail siblings against a REAL S3 API, not a mock: a mock agrees with
// whatever key we compute, and the point is that the bytes land at the key
// the listing will sign, and that a second attempt replaces the first rather
// than landing beside it as "… (2)".
//
//   pip install 'moto[server]' && python -m moto.server -p 5111
//   (or TEST_S3_ENDPOINT / TEST_S3_KEY / TEST_S3_SECRET for another S3 API)
//
// Skips when nothing is listening.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { s3PresignSiblingPut, s3PresignPut, s3DeleteObject } from '../lib/storage.js';
import { thumbSiblingKey, isThumbKey, THUMB_SIZES } from '../lib/media.js';

const ENDPOINT = process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:5111';
const BUCKET = 'onyx-siblings-test';
const cfg = {
  provider: 's3', bucket: BUCKET, region: 'us-east-1', endpoint: ENDPOINT,
  accessKeyId: process.env.TEST_S3_KEY || 'test', secretAccessKey: process.env.TEST_S3_SECRET || 'test', prefix: '_thumbs',
};

let live = false;
let S3;
let client;

before(async () => {
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
    live = /BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(`${e?.name} ${e?.Code} ${e?.message}`);
  }
});

const exists = async (Key) => {
  try { await client.send(new S3.HeadObjectCommand({ Bucket: BUCKET, Key })); return true; } catch { return false; }
};
const text = async (Key) => (await client.send(new S3.GetObjectCommand({ Bucket: BUCKET, Key }))).Body.transformToString();
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'content-type': 'image/webp' }, body });

test('siblings land at the keys derived from the thumbnail’s, and a retry replaces them', async (t) => {
  if (!live) { t.skip(`no S3 API at ${ENDPOINT}`); return; }
  const grid = await s3PresignPut(cfg, { filename: `${crypto.randomUUID()}.webp`, contentType: 'image/webp' });
  assert.ok(isThumbKey(grid.key), grid.key);
  assert.equal((await put(grid.putUrl, 'grid')).status, 200);
  for (const size of THUMB_SIZES) {
    const key = thumbSiblingKey(grid.key, size);
    const first = await s3PresignSiblingPut(cfg, key, { contentType: 'image/webp' });
    assert.equal(first.key, key);
    assert.equal((await put(first.putUrl, `${size}-1`)).status, 200);
    // A second attempt (an upload that failed to record, retried) goes to
    // the same key, not "… (2)": the listing only ever signs this one.
    const again = await s3PresignSiblingPut(cfg, key, { contentType: 'image/webp' });
    assert.equal(again.key, key);
    assert.equal((await put(again.putUrl, `${size}-2`)).status, 200);
    assert.equal(await text(key), `${size}-2`);
  }
  // Replacing the thumbnail takes its siblings with it (dropReplaced).
  for (const k of [grid.key, ...THUMB_SIZES.map((s) => thumbSiblingKey(grid.key, s))]) await s3DeleteObject(cfg, k);
  for (const size of THUMB_SIZES) assert.equal(await exists(thumbSiblingKey(grid.key, size)), false);
});

test('an exact-key PUT is refused for anything but a sibling key', async () => {
  for (const key of ['files/a.jpg', '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp', 'drives/x/_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.sm.webp']) {
    await assert.rejects(s3PresignSiblingPut(cfg, key), /sibling/, key);
  }
});
