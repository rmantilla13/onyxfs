// Presigned uploads must not carry a checksum. There is no body at signing
// time, so the SDK's default CRC32 is the checksum of zero bytes, and the
// bucket rejects the real bytes against it: 400 on every browser upload while
// the server-side write probe in the diagnostics passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s3PresignUploadParts, s3PresignGet } from '../lib/storage.js';

const cfg = {
  provider: 's3', bucket: 'onyx', region: 'us-west-004',
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  accessKeyId: 'AKIAEXAMPLE0000000000', secretAccessKey: 'example-secret', prefix: 'files',
};

const params = (url) => [...new URL(url).searchParams.keys()].map((k) => k.toLowerCase());

test('a presigned part upload carries no checksum', async () => {
  const [{ url }] = await s3PresignUploadParts(cfg, { key: 'files/a.mov', uploadId: 'u1', partNumbers: [1] });
  const keys = params(url);
  assert.ok(!keys.some((k) => k.startsWith('x-amz-checksum') || k === 'x-amz-sdk-checksum-algorithm'), keys.join(', '));
});

test('a presigned download does not ask for checksum mode', async () => {
  const url = await s3PresignGet(cfg, 'files/a.mov');
  assert.ok(!params(url).includes('x-amz-checksum-mode'), url);
});
