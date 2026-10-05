// The copy in parts that moves a big file into a drive (s3CopyInParts, for
// Admin → Usage's "Move into a drive…"), against a REAL S3 API — `moto` on
// localhost, as test/storage-move.test.js — because what matters is what
// lands in the bucket: the bytes whole and in order, a copy cut off by its
// call's time carried on rather than begun again, and across buckets.
//
//   pip install 'moto[server]' && python -m moto.server -p 5111
//
// Skipped, not failed, when nothing is listening.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { s3CopyInParts } from '../lib/storage.js';

const ENDPOINT = process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:5111';
const BUCKET = 'onyx-parts-test';
const OTHER = 'onyx-parts-other';
const MiB = 1024 * 1024;
const PART = 5 * MiB; // S3's smallest part but the last

const cfg = {
  provider: 's3', bucket: BUCKET, region: 'us-east-1', endpoint: ENDPOINT,
  accessKeyId: 'test', secretAccessKey: 'test', prefix: 'files',
};

let live = false;
let S3;
let client;

before(async () => {
  S3 = await import('@aws-sdk/client-s3');
  client = new S3.S3Client({
    region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestHandler: { requestTimeout: 10000, connectionTimeout: 1500 },
    maxAttempts: 1,
  });
  live = true;
  for (const Bucket of [BUCKET, OTHER]) {
    try {
      await client.send(new S3.CreateBucketCommand({ Bucket }));
    } catch (e) {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(`${e?.name} ${e?.Code} ${e?.message}`)) live = false;
    }
  }
});

const put = (Key, Body, Bucket = BUCKET) => client.send(new S3.PutObjectCommand({ Bucket, Key, Body, ContentType: 'video/mp4' }));
const read = async (Key, Bucket = BUCKET) => {
  const r = await client.send(new S3.GetObjectCommand({ Bucket, Key }));
  return { bytes: Buffer.from(await r.Body.transformToByteArray()), type: r.ContentType };
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const partsOpen = async (Key) => {
  const ups = (await client.send(new S3.ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: Key }))).Uploads || [];
  const out = [];
  for (const u of ups.filter((x) => x.Key === Key)) {
    const p = await client.send(new S3.ListPartsCommand({ Bucket: BUCKET, Key, UploadId: u.UploadId }));
    out.push({ uploadId: u.UploadId, parts: (p.Parts || []).map((x) => x.PartNumber) });
  }
  return out;
};
const run = (name) => `${name}-${randomBytes(4).toString('hex')}`;

describe('copying a big file in parts', () => {
  test('whole in one call: every byte, in order, and the type kept', async (t) => {
    if (!live) return t.skip('no S3 listening');
    const bytes = randomBytes(12 * MiB + 1234);
    const from = `files/${run('whole')}.mp4`;
    const to = `team/${run('whole')}.mp4`;
    await put(from, bytes);
    assert.equal(await s3CopyInParts(cfg, from, to, { partBytes: PART }), true);
    const got = await read(to);
    assert.equal(sha(got.bytes), sha(bytes));
    assert.equal(got.type, 'video/mp4');
    assert.deepEqual(await partsOpen(to), [], 'no upload left open');
  });

  test('cut off by its call, the next carries on from the parts it made', async (t) => {
    if (!live) return t.skip('no S3 listening');
    // Ten parts: more than are copied at once, so a call told to stop at
    // once still leaves some for the next.
    const bytes = randomBytes(10 * PART);
    const from = `files/${run('cut')}.mp4`;
    const to = `team/${run('cut')}.mp4`;
    await put(from, bytes);

    assert.equal(await s3CopyInParts(cfg, from, to, { partBytes: PART, stop: () => true }), false, 'not whole yet');
    const first = await partsOpen(to);
    assert.equal(first.length, 1, 'one upload open');
    assert.ok(first[0].parts.length > 0 && first[0].parts.length < 10, `some parts made (${first[0].parts.length})`);

    assert.equal(await s3CopyInParts(cfg, from, to, { partBytes: PART }), true);
    assert.equal(sha((await read(to)).bytes), sha(bytes), 'the same bytes, the parts of both calls in order');
    assert.deepEqual(await partsOpen(to), []);
  });

  test('an original written again since the first call is copied afresh', async (t) => {
    if (!live) return t.skip('no S3 listening');
    const from = `files/${run('again')}.mp4`;
    const to = `team/${run('again')}.mp4`;
    await put(from, randomBytes(10 * PART));
    assert.equal(await s3CopyInParts(cfg, from, to, { partBytes: PART, stop: () => true }), false);
    // S3 keeps times to the second: let one go by, so the new original is
    // newer than the parts made of the old.
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = randomBytes(10 * PART + 77);
    await put(from, fresh);
    assert.equal(await s3CopyInParts(cfg, from, to, { partBytes: PART }), true);
    assert.equal(sha((await read(to)).bytes), sha(fresh), 'the new bytes, none of the old parts');
    assert.deepEqual(await partsOpen(to), [], 'the old upload was aborted');
  });

  test('from another bucket', async (t) => {
    if (!live) return t.skip('no S3 listening');
    const bytes = randomBytes(6 * MiB);
    const from = `files/${run('across')}.mp4`;
    const to = `team/${run('across')}.mp4`;
    await put(from, bytes, OTHER);
    assert.equal(await s3CopyInParts(cfg, from, to, { partBytes: PART, fromBucket: OTHER }), true);
    assert.equal(sha((await read(to)).bytes), sha(bytes));
    assert.equal(sha((await read(from, OTHER)).bytes), sha(bytes), 'the original is left where it was');
  });
});
