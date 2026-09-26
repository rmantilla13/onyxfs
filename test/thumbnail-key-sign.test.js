// A row's thumbnail is presigned for everyone who can see the row. PATCH
// /api/files/[id] used to take thumbnailKey and thumbnailUrl from the client
// unchecked, so anyone able to edit one file of their own could point its
// thumbnail at any object in the bucket — another drive's file included —
// and read it back as a signed link from the listing. PATCH no longer takes
// either; this pins the second line of defence, which also covers rows
// written before the fix: only a thumbnail's key is ever signed as one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { thumbnailKeyToSign } from '../lib/storage.js';

const cfg = {
  provider: 's3', bucket: 'onyx', region: 'us-west-004',
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  accessKeyId: 'AKIAEXAMPLE0000000000', secretAccessKey: 'example-secret', prefix: 'files',
};

test('a thumbnail the server named is signed', () => {
  const key = '_thumbs/3f2b8c1e-0d4a-4a53-9a0e-2b7c5d1f6e90.webp';
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailKey: key }), key);
});

test('a legacy thumbnail next to its file is signed', () => {
  const key = 'files/Campaigns/x1y2z3-thumb-hero.jpg';
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailKey: key }), key);
});

test('a legacy thumbnail recorded only as a URL is signed', () => {
  const url = 'https://s3.us-west-004.backblazeb2.com/onyx/_thumbs/3f2b8c1e-0d4a-4a53-9a0e-2b7c5d1f6e90.jpg';
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailUrl: url }), '_thumbs/3f2b8c1e-0d4a-4a53-9a0e-2b7c5d1f6e90.jpg');
});

test('a key pointing at another drive’s file is not', () => {
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailKey: 'drives/finance/salaries.pdf' }), null);
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailKey: 'files/Campaigns/master.mov' }), null);
});

test('a URL pointing at another object is not, whatever its host', () => {
  // keyFromUrl takes the path of any URL, so the host is no protection.
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailUrl: 'https://s3.us-west-004.backblazeb2.com/onyx/drives/finance/salaries.pdf' }), null);
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailUrl: 'https://example.com/drives/finance/salaries.pdf' }), null);
});

test('a key that only mentions thumbs is not', () => {
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailKey: 'drives/finance/_thumbs.pdf' }), null);
  assert.equal(thumbnailKeyToSign(cfg, { thumbnailKey: 'drives/finance/thumbs/salaries.pdf' }), null);
});

test('no thumbnail is null', () => {
  assert.equal(thumbnailKeyToSign(cfg, {}), null);
  assert.equal(thumbnailKeyToSign(cfg, null), null);
});

test('PATCH /api/files/[id] drops thumbnail fields before anything else', async () => {
  // A route test would need a database; the order is what matters, so read it.
  const src = await readFile(new URL('../app/api/files/[id]/route.js', import.meta.url), 'utf8');
  const patch = src.slice(src.indexOf('export async function PATCH'));
  const drop = patch.indexOf('delete body.thumbnailKey');
  assert.ok(drop > 0, 'PATCH must drop thumbnailKey');
  assert.ok(patch.indexOf('delete body.thumbnailUrl') > 0, 'PATCH must drop thumbnailUrl');
  assert.ok(drop < patch.indexOf('updateFile('), 'dropped before the write');
});

test('updateFile does not write thumbnail columns', async () => {
  const src = await readFile(new URL('../lib/db.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function updateFile'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/thumbnail_(key|url)\s*=/.test(body), 'updateFile must not set a thumbnail');
});
