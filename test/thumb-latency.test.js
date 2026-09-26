// How slowly thumbnails are arriving, which decides how far ahead the grid mounts rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordThumbLatency, thumbLatency, thumbsAreSlow, resetThumbLatency } from '../lib/thumb-latency.js';

test('nothing seen: not slow', () => {
  resetThumbLatency();
  assert.equal(thumbLatency(), 0);
  assert.equal(thumbsAreSlow(), false);
});

test('a fast link stays fast, a slow one is slow after a few pictures', () => {
  resetThumbLatency();
  for (let i = 0; i < 10; i++) recordThumbLatency(3);
  assert.equal(thumbsAreSlow(), false);
  resetThumbLatency();
  recordThumbLatency(56);
  recordThumbLatency(60);
  assert.equal(thumbsAreSlow(), false, 'two is not enough to judge');
  recordThumbLatency(52);
  assert.equal(thumbsAreSlow(), true);
});

test('the average follows a change of link, and ignores nonsense', () => {
  resetThumbLatency();
  for (let i = 0; i < 5; i++) recordThumbLatency(60);
  for (let i = 0; i < 20; i++) recordThumbLatency(4);
  assert.equal(thumbsAreSlow(), false);
  recordThumbLatency(-1);
  recordThumbLatency(NaN);
  assert.ok(thumbLatency() < 10);
});
