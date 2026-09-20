// Tests for multipart part sizing.
//
// The arithmetic here decides whether a given file can be uploaded at all.
// S3's limits are unforgiving and interact: parts below 5 MiB are rejected
// (except the last), there can be at most 10,000 of them, and exceeding either
// fails at a different point in the transfer — the part count only blows up
// near the end, after the bytes have already moved.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { choosePartSize, partCount } from '../lib/storage.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const TiB = 1024 * GiB;

const S3_MIN_PART = 5 * MiB;
const S3_MAX_PARTS = 10000;

describe('choosePartSize', () => {
  test('small files use the floor', () => {
    assert.equal(choosePartSize(1), 8 * MiB);
    assert.equal(choosePartSize(50 * MiB), 8 * MiB);
    assert.equal(choosePartSize(GiB), 8 * MiB);
  });

  test('the floor sits above S3 minimum, so no part is ever rejected as too small', () => {
    assert.ok(choosePartSize(1) >= S3_MIN_PART);
  });

  test('every realistic size stays within the 10,000-part limit', () => {
    // The sizes that matter for heavy video, plus the extremes.
    for (const size of [
      1, MiB, 100 * MiB, GiB, 5 * GiB, 40 * GiB, 100 * GiB, 500 * GiB, TiB, 4 * TiB,
    ]) {
      const ps = choosePartSize(size);
      const n = partCount(size, ps);
      assert.ok(n <= S3_MAX_PARTS, `${size} bytes → ${n} parts, over the limit`);
      assert.ok(ps >= S3_MIN_PART, `${size} bytes → ${ps} byte parts, under S3 minimum`);
    }
  });

  test('part size grows only once the floor would exceed the part limit', () => {
    // 8 MiB x 9000 = 72 GiB is the point where growth kicks in.
    const under = 70 * GiB;
    const over = 100 * GiB;
    assert.equal(choosePartSize(under), 8 * MiB, 'should still be at the floor');
    assert.ok(choosePartSize(over) > 8 * MiB, 'should have grown');
  });

  test('growth targets 9,000 parts, leaving headroom under the hard limit of 10,000', () => {
    // The size a client reports can be slightly off. Aiming at exactly 10,000
    // would let a small underestimate push a real upload over mid-flight,
    // which only surfaces after most of the bytes have moved.
    const size = 500 * GiB;
    const n = partCount(size, choosePartSize(size));
    assert.ok(n <= 9000, `expected headroom, got ${n} parts`);
  });

  test('part size is a whole number of MiB', () => {
    // Ragged sizes make the client's byte-offset arithmetic harder to reason
    // about for no benefit.
    for (const size of [100 * GiB, 250 * GiB, 900 * GiB]) {
      assert.equal(choosePartSize(size) % MiB, 0, `${size} produced a non-MiB part size`);
    }
  });

  test('above S3 object limit it throws rather than returning something unusable', () => {
    // Failing here, before a byte moves, beats failing on the final assemble.
    assert.throws(() => choosePartSize(6 * TiB), /5 TiB/);
  });

  test('nonsense input falls back to the floor instead of producing NaN', () => {
    // A NaN part size silently yields zero parts and an upload that appears to
    // succeed while transferring nothing.
    for (const bad of [0, -1, null, undefined, 'abc', NaN]) {
      const ps = choosePartSize(bad);
      assert.ok(Number.isFinite(ps) && ps >= S3_MIN_PART, `${bad} → ${ps}`);
    }
  });
});

describe('partCount', () => {
  test('counts whole and partial parts', () => {
    assert.equal(partCount(8 * MiB, 8 * MiB), 1);
    assert.equal(partCount(8 * MiB + 1, 8 * MiB), 2);
    assert.equal(partCount(24 * MiB, 8 * MiB), 3);
  });

  test('an empty file is zero parts', () => {
    assert.equal(partCount(0, 8 * MiB), 0);
    assert.equal(partCount(null, 8 * MiB), 0);
  });

  test('the last part may be below S3 minimum, which is allowed', () => {
    // S3 exempts the final part from the 5 MiB floor. A sizing scheme that
    // tried to avoid a small tail would be solving a problem that isn't real.
    const size = 8 * MiB + 1024;
    assert.equal(partCount(size, 8 * MiB), 2);
  });
});
