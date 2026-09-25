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

// ── Filmstrip registration ─────────────────────────────────────────────────
// A filmstrip is two things a client sends: a key and a geometry. The key must
// be one the presign route named, or a row's preview could be pointed at any
// object in the bucket. The geometry becomes CSS background offsets, so a wrong
// number silently misaligns every tile in the sheet.

const { isFilmstripKey, filmstripFacts } = await import('../lib/media.js');

const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const STRIP_KEY = `_thumbs/${UUID}.strip.webp`;
const GOOD = { frames: 40, columns: 8, tileWidth: 160, tileHeight: 90 };

test('a filmstrip key and a thumbnail key can never be mistaken for each other', () => {
  // They share the _thumbs/ prefix, because the listing already excludes that
  // path and adding a term to that predicate costs something on every read.
  // `.strip` is what keeps them apart.
  assert.equal(isFilmstripKey(STRIP_KEY), true);
  assert.equal(isThumbKey(STRIP_KEY), false, 'a strip must not be recordable as a thumbnail');
  assert.equal(isFilmstripKey(`_thumbs/${UUID}.webp`), false, 'a thumbnail must not be recordable as a strip');
});

test('a filmstrip key must be one the presign route would have named', () => {
  for (const bad of [
    `files/${UUID}.strip.webp`,          // outside _thumbs/
    `_thumbs/${UUID}.strip.jpg`,         // WebP only
    `_thumbs/${UUID}.strip.webp.webp`,
    `_thumbs/../${UUID}.strip.webp`,
    '_thumbs/notauuid.strip.webp',
    `_thumbs/${UUID}.strip.webp?x=1`,
    null, undefined, 42, {},
  ]) {
    assert.equal(isFilmstripKey(bad), false, JSON.stringify(bad));
  }
});

test('a sane geometry is kept as integers', () => {
  assert.deepEqual(filmstripFacts(GOOD), GOOD);
  assert.deepEqual(filmstripFacts({ ...GOOD, frames: '40' }), GOOD, 'numeric strings are accepted');
});

test('a partial geometry is rejected outright, not half-stored', () => {
  // A layout missing one field cannot position anything, and storing it would
  // leave the player computing offsets from undefined.
  for (const k of Object.keys(GOOD)) {
    const partial = { ...GOOD };
    delete partial[k];
    assert.equal(filmstripFacts(partial), null, `missing ${k}`);
  }
  assert.equal(filmstripFacts(null), null);
  assert.equal(filmstripFacts('40x8'), null);
});

test('non-integer, zero and negative dimensions are refused', () => {
  for (const patch of [
    { frames: 0 }, { frames: -40 }, { frames: 40.5 }, { columns: 0 },
    { tileWidth: 0 }, { tileHeight: -90 }, { tileWidth: NaN }, { frames: Infinity },
  ]) {
    assert.equal(filmstripFacts({ ...GOOD, ...patch }), null, JSON.stringify(patch));
  }
});

test('a geometry describing a sheet no GPU will decode is refused', () => {
  // Past 4096px in either axis some mobile GPUs refuse the texture outright and
  // the WHOLE strip fails to decode, not just the tiles beyond the limit — so
  // this is rejected at registration rather than discovered on a phone.
  assert.equal(filmstripFacts({ frames: 40, columns: 40, tileWidth: 160, tileHeight: 90 }), null,
    '40 columns at 160px is 6400px wide');
  assert.equal(filmstripFacts({ frames: 200, columns: 4, tileWidth: 160, tileHeight: 90 }), null,
    '50 rows at 90px is 4500px tall');
  // The default layout stays comfortably inside it.
  assert.ok(filmstripFacts(GOOD));
});

test('a key without a geometry, or a geometry without a key, records neither', () => {
  assert.equal(uploadFields({ filmstripKey: STRIP_KEY }).filmstripKey, null,
    'a key with no geometry leaves the player unable to place a tile');
  assert.equal(uploadFields({ filmstrip: GOOD }).filmstripKey, null);
  assert.equal(uploadFields({ filmstrip: GOOD }).metadata.filmstrip, undefined,
    'no geometry is stored without a key to fetch');

  const both = uploadFields({ filmstripKey: STRIP_KEY, filmstrip: GOOD });
  assert.equal(both.filmstripKey, STRIP_KEY);
  assert.deepEqual(both.metadata.filmstrip, GOOD);
});

test('a forged filmstrip key is dropped along with its geometry', () => {
  const out = uploadFields({ filmstripKey: 'files/someone-elses-object.webp', filmstrip: GOOD });
  assert.equal(out.filmstripKey, null);
  assert.equal(out.metadata.filmstrip, undefined);
});
