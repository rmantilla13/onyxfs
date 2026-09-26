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

// Previews: six-day windows, offset per key, so a library's previews do not
// all change URL — and all download again — at the same moment.
test('a phased preview URL is stable for its window, and windows differ per key', async (t) => {
  const { signingDate, keyHash, PREVIEW_URL_WINDOW, PREVIEW_URL_TTL } = await import('../lib/storage.js');
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const key = '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.sm.webp';
  const W = PREVIEW_URL_WINDOW * 1000;
  const phase = (keyHash(key) % PREVIEW_URL_WINDOW) * 1000;
  const start = Math.floor(Date.UTC(2026, 8, 25) / W) * W + phase;
  const opts = { expiresIn: PREVIEW_URL_TTL, stableFor: PREVIEW_URL_WINDOW, phased: true };
  Date.now = () => start + 1000;
  const a = await s3PresignGet(cfg, key, opts);
  Date.now = () => start + W - 1000;
  const b = await s3PresignGet(cfg, key, opts);
  Date.now = () => start + W;
  const c = await s3PresignGet(cfg, key, opts);
  assert.equal(a, b, 'one URL all window');
  assert.notEqual(b, c, 'a new one after it');
  assert.equal(new URL(a).searchParams.get('X-Amz-Expires'), '604800', 'six days plus one: exactly the SigV4 limit');
  assert.equal(signingDate(key, start + 5000, PREVIEW_URL_WINDOW, { phased: true }).getTime(), start);
  // Two keys roll over at different instants.
  const other = '_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.webp';
  assert.notEqual(keyHash(other) % PREVIEW_URL_WINDOW, keyHash(key) % PREVIEW_URL_WINDOW);
  // Never signed in the future.
  for (const k of [key, other, 'x']) {
    const now = Date.UTC(2026, 0, 1, 12);
    assert.ok(signingDate(k, now, PREVIEW_URL_WINDOW, { phased: true }).getTime() <= now);
  }
});

test('an unphased window starts on the boundary, as before', async () => {
  const { signingDate } = await import('../lib/storage.js');
  const now = Date.UTC(2026, 8, 25, 13, 30);
  assert.equal(signingDate('k', now, 3600).toISOString(), '2026-09-25T13:00:00.000Z');
});

// A listing signs five URLs a row; within a window each is the same string,
// so it is kept rather than signed again — and must be exactly what signing
// again would give.
test('a stable URL is kept for its window, and is what signing afresh gives', async (t) => {
  const { signedUrlCache } = await import('../lib/storage.js');
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => Date.UTC(2026, 8, 25, 3, 0, 0);
  const opts = { expiresIn: 86400, stableFor: 518400, phased: true };
  signedUrlCache.clear();
  const a = await s3PresignGet(cfg, '_thumbs/k.webp', opts);
  assert.equal(signedUrlCache.size, 1);
  const b = await s3PresignGet(cfg, '_thumbs/k.webp', opts);
  assert.equal(b, a);
  signedUrlCache.clear();
  assert.equal(await s3PresignGet(cfg, '_thumbs/k.webp', opts), a, 'the kept URL is the signer\'s own answer');
  // Anything that goes into the signature is a different entry.
  assert.notEqual(await s3PresignGet({ ...cfg, secretAccessKey: 'another-secret' }, '_thumbs/k.webp', opts), a);
  assert.notEqual(await s3PresignGet(cfg, '_thumbs/k.webp', { ...opts, expiresIn: 3600 }), a);
  assert.notEqual(await s3PresignGet(cfg, '_thumbs/k.webp', { ...opts, download: true }), a);
  assert.notEqual(await s3PresignGet(cfg, '_thumbs/j.webp', opts), a);
  // Unstable (signed as of now) URLs are never kept.
  const n = signedUrlCache.size;
  await s3PresignGet(cfg, '_thumbs/k.webp', { expiresIn: 600 });
  assert.equal(signedUrlCache.size, n);
});
