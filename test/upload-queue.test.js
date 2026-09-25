// The web uploader's queue: how many files run at once, and what cancel,
// retry and the progress numbers do. `run` is a stand-in the test resolves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploadQueue, joinFolder, filesFromInput } from '../lib/upload-client.js';

const tick = () => new Promise((r) => setImmediate(r));

// A queue whose uploads wait for the test to finish or fail them.
function harness({ concurrency = 3 } = {}) {
  const calls = [];
  let clock = 0;
  let last = null;
  const settled = [];
  const queue = createUploadQueue({
    concurrency,
    now: () => clock,
    schedule: (fn) => fn(),
    onChange: (s) => { last = s; },
    onSettled: (s) => settled.push(s),
    run: (item, opts) => new Promise((resolve, reject) => {
      const call = { item, opts, resolve, reject };
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
      calls.push(call);
    }),
  });
  return {
    queue, calls, settled,
    snap: () => last,
    advance: (ms) => { clock += ms; },
    running: () => calls.filter((c) => !c.done),
    finish: async (call, value = { id: call.item.id }) => { call.done = true; call.resolve(value); await tick(); },
    fail: async (call, message) => { call.done = true; call.reject(new Error(message)); await tick(); },
  };
}

const file = (name, size = 100) => ({ name, size });

test('never runs more than the concurrency at once, and starts the next as one lands', async () => {
  const h = harness({ concurrency: 3 });
  h.queue.add(Array.from({ length: 10 }, (_, i) => ({ file: file(`f${i}`), folder: '' })));
  assert.equal(h.calls.length, 3);
  assert.equal(h.snap().counts.active, 10);
  await h.finish(h.calls[0]);
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls.filter((c) => !c.done).length, 3);
  while (h.running().length) await h.finish(h.running()[0]);
  assert.equal(h.calls.length, 10);
  assert.equal(h.snap().counts.done, 10);
  assert.equal(h.snap().running, false);
  assert.equal(h.settled.length, 1);
});

test('cancel aborts a running upload and frees its slot; a queued one never starts', async () => {
  const h = harness({ concurrency: 1 });
  h.queue.add([{ file: file('a') }, { file: file('b') }, { file: file('c') }]);
  const [a] = h.calls;
  h.queue.cancel(3); // queued
  h.queue.cancel(a.item.id); // running
  assert.equal(a.opts.signal.aborted, true);
  await tick();
  assert.deepEqual(h.calls.map((c) => c.item.name), ['a', 'b']);
  const byName = Object.fromEntries(h.snap().items.map((i) => [i.name, i.status]));
  assert.deepEqual(byName, { a: 'canceled', b: 'uploading', c: 'canceled' });
  // Canceled files leave the totals.
  assert.equal(h.snap().total, 100);
});

test('a failure is kept with its message and can be retried', async () => {
  const h = harness();
  h.queue.add([{ file: file('a') }]);
  await h.fail(h.calls[0], 'The bucket refused the upload.');
  let item = h.snap().items[0];
  assert.equal(item.status, 'error');
  assert.equal(item.error, 'The bucket refused the upload.');
  assert.equal(h.snap().counts.error, 1);

  h.queue.retry(item.id);
  assert.equal(h.calls.length, 2);
  await h.finish(h.calls[1]);
  item = h.snap().items[0];
  assert.equal(item.status, 'done');
  assert.equal(h.snap().counts.error, 0);
});

test('a retry resumes the multipart upload a failure left behind, but not one a cancel discarded', async () => {
  const h = harness();
  h.queue.add([{ file: file('big', 1e9) }]);
  h.calls[0].opts.onResumable('upl-1');
  await h.fail(h.calls[0], 'network');
  h.queue.retry(1);
  assert.equal(h.calls[1].item.resumeId, 'upl-1');

  h.calls[1].opts.onResumable('upl-1');
  h.queue.cancel(1);
  await tick();
  h.queue.retry(1);
  assert.equal(h.calls[2].item.resumeId, null);
});

test('only done and running work counts toward progress; speed and ETA come from recent bytes', async () => {
  const h = harness({ concurrency: 2 });
  h.queue.add([{ file: file('a', 1000) }, { file: file('b', 3000) }]);
  assert.equal(h.snap().speed, 0);
  assert.equal(h.snap().eta, null);
  h.advance(1000);
  h.calls[0].opts.onProgress(500);
  h.calls[1].opts.onProgress(500);
  const s = h.snap();
  assert.equal(s.total, 4000);
  assert.equal(s.sent, 1000);
  assert.equal(s.speed, 1000); // 1000 bytes in 1 s
  assert.equal(s.eta, 3); // 3000 bytes left
  // Progress past the size (a retried part) is clamped.
  h.calls[0].opts.onProgress(5000);
  assert.equal(h.snap().items[0].sent, 1000);
});

test('clear drops finished rows and keeps running ones', async () => {
  const h = harness({ concurrency: 1 });
  h.queue.add([{ file: file('a') }, { file: file('b') }]);
  await h.finish(h.calls[0]);
  h.queue.clear();
  assert.deepEqual(h.snap().items.map((i) => i.name), ['b']);
});

test('joinFolder keeps a dropped folder beneath the current one', () => {
  assert.equal(joinFolder('', ''), '');
  assert.equal(joinFolder('Clients', ''), 'Clients');
  assert.equal(joinFolder('', 'Shoot/RAW'), 'Shoot/RAW');
  assert.equal(joinFolder('Clients/', '/Shoot/RAW/'), 'Clients/Shoot/RAW');
});

test('filesFromInput keeps the folders of a folder pick and skips OS junk', () => {
  const picked = [
    { name: 'a.jpg', webkitRelativePath: 'Shoot/a.jpg' },
    { name: 'b.jpg', webkitRelativePath: 'Shoot/RAW/b.jpg' },
    { name: '.DS_Store', webkitRelativePath: 'Shoot/.DS_Store' },
    { name: 'loose.pdf', webkitRelativePath: '' },
  ];
  assert.deepEqual(filesFromInput(picked).map(({ file, dir }) => [file.name, dir]), [
    ['a.jpg', 'Shoot'],
    ['b.jpg', 'Shoot/RAW'],
    ['loose.pdf', ''],
  ]);
});
