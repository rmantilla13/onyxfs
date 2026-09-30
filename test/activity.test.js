// lib/activity.js: the work in progress the activity panel shows — started
// anywhere, updated as it goes, gone when it ends, and reaching the panel
// at most once a frame however often it changes.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startActivity, withActivity, activitySnapshot, subscribeActivity, countOf, _resetActivity,
} from '../lib/activity.js';

const frame = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => _resetActivity());

test('a task is there from its start, changes only what an update names, and goes when it ends', () => {
  const t = startActivity({ title: 'Moving “Shoot”', total: 3, done: 0 });
  const [row] = activitySnapshot();
  assert.deepEqual({ ...row, startedAt: 0 }, { id: t.id, title: 'Moving “Shoot”', detail: '', done: 0, total: 3, startedAt: 0 });
  assert.ok(Math.abs(row.startedAt - Date.now()) < 1000);

  t.update({ done: 2, detail: '2 of 3 files', unknown: 'ignored' });
  assert.deepEqual([activitySnapshot()[0].done, activitySnapshot()[0].detail, activitySnapshot()[0].title], [2, '2 of 3 files', 'Moving “Shoot”']);
  assert.ok(!('unknown' in activitySnapshot()[0]));

  t.end();
  assert.deepEqual(activitySnapshot(), []);
  t.update({ done: 3 });
  t.end();
  assert.deepEqual(activitySnapshot(), [], 'after its end, a handle changes nothing');
});

test('the snapshot is the same array until something changes', () => {
  startActivity({ title: 'one' });
  const a = activitySnapshot();
  assert.equal(activitySnapshot(), a);
  startActivity({ title: 'two' });
  assert.notEqual(activitySnapshot(), a);
  assert.deepEqual(activitySnapshot().map((t) => t.title), ['one', 'two'], 'oldest first');
});

test('a burst of changes reaches a listener once', async () => {
  const calls = [];
  const off = subscribeActivity((tasks) => calls.push(tasks.length));
  const t = startActivity({ title: 'copying', total: 100, done: 0 });
  for (let i = 1; i <= 100; i++) t.update({ done: i });
  await frame();
  assert.deepEqual(calls, [1]);
  t.end();
  await frame();
  assert.deepEqual(calls, [1, 0]);
  off();
  startActivity({ title: 'unheard' });
  await frame();
  assert.deepEqual(calls, [1, 0], 'no calls after unsubscribing');
});

test('withActivity ends the task however the work ends', async () => {
  assert.equal(await withActivity({ title: 'fine' }, async (t) => { t.update({ detail: 'busy' }); return 42; }), 42);
  assert.deepEqual(activitySnapshot(), []);
  await assert.rejects(withActivity({ title: 'broken' }, async () => { throw new Error('nope'); }), /nope/);
  assert.deepEqual(activitySnapshot(), []);
});

test('countOf', () => {
  assert.equal(countOf(3, 1234, 'files'), `3 of ${(1234).toLocaleString()} files`);
  assert.equal(countOf(0, 2), '0 of 2');
  assert.equal(countOf(null, undefined, 'files'), '0 of 0 files');
});
