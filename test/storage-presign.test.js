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

// Signed as of now, the URL changed every second and the browser fetched every
// thumbnail again on every page load.
test('a stable presigned GET is the same URL for the whole window', async (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const start = Date.UTC(2026, 8, 25, 0, 0, 0);
  Date.now = () => start + 1000;
  const a = await s3PresignGet(cfg, '_thumbs/a.webp', { expiresIn: 86400, stableFor: 86400 });
  Date.now = () => start + 86399 * 1000;
  const b = await s3PresignGet(cfg, '_thumbs/a.webp', { expiresIn: 86400, stableFor: 86400 });
  Date.now = () => start + 86400 * 1000;
  const c = await s3PresignGet(cfg, '_thumbs/a.webp', { expiresIn: 86400, stableFor: 86400 });
  assert.equal(a, b);
  assert.notEqual(b, c);
  const q = new URL(a).searchParams;
  assert.equal(q.get('X-Amz-Date'), '20260925T000000Z');
  // Still good for a full expiresIn at the very end of the window.
  assert.equal(q.get('X-Amz-Expires'), String(2 * 86400));
});

test('a stable URL never asks for more than SigV4 allows', async () => {
  const url = await s3PresignGet(cfg, 'files/a.mov', { expiresIn: 600000, stableFor: 86400 });
  assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '604800');
});
