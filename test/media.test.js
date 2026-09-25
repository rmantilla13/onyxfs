// What a file is, whether a browser can draw it, and which of an upload's
// fields the server decides for itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveKind, drawableKind, isThumbKey, mediaFacts, uploadFields, fmtDuration,
} from '../lib/media.js';

const KEY = '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp';

test('rows stored as other are classified again from mime and name', () => {
  assert.equal(effectiveKind({ kind: 'other', mime: 'video/quicktime', name: 'a.mov' }), 'video');
  assert.equal(effectiveKind({ kind: 'other', mime: 'image/png', name: 'a.png' }), 'image');
  assert.equal(effectiveKind({ kind: 'other', mime: 'application/zip', name: 'a.zip' }), 'other');
  assert.equal(effectiveKind({ kind: 'doc', mime: 'image/png', name: 'a.png' }), 'doc');
});

test('only formats an <img> or <video> decodes are drawable', () => {
  assert.equal(drawableKind({ mime: 'image/jpeg', name: 'a.jpg' }), 'image');
  assert.equal(drawableKind({ mime: '', name: 'a.webp' }), 'image');
  assert.equal(drawableKind({ mime: 'video/mp4', name: 'a.mp4' }), 'video');
  assert.equal(drawableKind({ mime: 'video/quicktime', name: 'a.mov' }), 'video');
  for (const f of [
    { mime: 'image/tiff', name: 'scan.tif' },
    { mime: 'image/heif', name: 'IMG_0001.heic' },
    { mime: 'image/x-canon-cr2', name: 'a.cr2' },
    { mime: 'application/pdf', name: 'a.pdf' },
    { mime: 'image/tiff', name: 'misnamed.jpg' },
  ]) assert.equal(drawableKind(f), null, f.name);
});

test('a thumbnail key must be one the presign route named', () => {
  assert.ok(isThumbKey(KEY));
  assert.ok(isThumbKey(KEY.replace('.webp', '.jpg')));
  for (const k of ['files/photo.jpg', '_thumbs/../files/photo.jpg', '_thumbs/abc.webp', `x${KEY}`, `${KEY}/x`, null, 42]) {
    assert.ok(!isThumbKey(k), String(k));
  }
});

test('registration classifies the kind and keeps only a valid thumbnail key', () => {
  const out = uploadFields({
    name: 'clip.mov', mime: 'video/quicktime', thumbnailKey: KEY, thumbnailUrl: 'https://evil.example/x.jpg',
    media: { width: 1920, height: 1080, duration: 42.04, extra: 1 },
  });
  assert.equal(out.kind, 'video');
  assert.equal(out.thumbnailKey, KEY);
  assert.equal(out.thumbnailUrl, null);
  assert.deepEqual(out.metadata, { width: 1920, height: 1080, duration: 42 });

  const bad = uploadFields({ name: 'a.jpg', mime: 'image/jpeg', thumbnailKey: 'files/someone-else.jpg' });
  assert.equal(bad.kind, 'image');
  assert.equal(bad.thumbnailKey, null);
  assert.deepEqual(bad.metadata, {});

  assert.equal(uploadFields({ name: 'a.bin', kind: 'audio' }).kind, 'audio');
  assert.equal(uploadFields({ name: 'a.bin', kind: 'nonsense' }).kind, 'other');
});

test('media facts drop anything that is not a sane positive number', () => {
  assert.deepEqual(mediaFacts({ width: '640', height: -1, duration: 'NaN' }), { width: 640 });
  assert.deepEqual(mediaFacts(null), {});
});

test('durations read like a player shows them', () => {
  assert.equal(fmtDuration(42.04), '0:42');
  assert.equal(fmtDuration(83.4), '1:23');
  assert.equal(fmtDuration(3725), '1:02:05');
  assert.equal(fmtDuration(0), '');
  assert.equal(fmtDuration(undefined), '');
});
