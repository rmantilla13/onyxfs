// lib/preview-runner.js, driven with fakes: a `list` that pages rows from an
// array and a `work` whose jobs the test finishes when it chooses. What is
// held here is the run itself — the job each file is given, how many go at
// once, pausing, stopping, what is counted, and where a run that was left
// picks up again. The jobs themselves are lib/thumbnail-regen.js's, in a
// browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewRun, carriedOver, unfinished, initialRunState, NAMES_PER_REASON } from '../lib/preview-runner.js';

const OURS = (n) => `_thumbs/${String(n).padStart(8, '0')}-d9cb-469f-a165-70867728950e.webp`;
const POSTER = (n) => `_thumbs/${String(n).padStart(8, '0')}-d9cb-469f-a165-70867728950e.poster.webp`;
const PH = 'data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA==';

/** A picture of ours lacking what `lacks` names: 'thumbnail', 'sizes', 'placeholder', or nothing. */
function row(id, lacks = 'placeholder', over = {}) {
  const md = { width: 4000, height: 3000, ...(lacks === 'placeholder' || lacks === 'thumbnail' ? {} : { placeholder: PH }) };
  return {
    id, name: `${id}.jpg`, mime: 'image/jpeg', kind: 'image', size: 1000, storage: 's3', url: `https://s3.test/${id}.jpg`,
    thumbnailKey: lacks === 'thumbnail' ? null : OURS(id.replace(/\D/g, '') || 1),
    thumbnailUrl: lacks === 'thumbnail' ? null : `https://s3.test/${id}.webp`,
    thumbSizes: lacks === 'sizes' ? [] : ['sm', 'xs'],
    posterKey: lacks === 'thumbnail' ? null : POSTER(id.replace(/\D/g, '') || 1), metadata: md, ...over,
  };
}

/** `list` over rows in id order, `size` a page; the first page brings counts. Records the cursors it was asked for. */
function pager(rows, { size = 4, fail = null, counts = null } = {}) {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const asked = [];
  const list = async (after) => {
    asked.push(after);
    if (fail && fail(after, asked)) throw new Error('The files could not be listed. Try again.');
    const rest = sorted.filter((r) => r.id > after);
    const files = rest.slice(0, size);
    return {
      files, after: files.length ? files[files.length - 1].id : after, done: rest.length <= size,
      ...(after ? {} : { counts: counts || { total: sorted.length, heic: 0, tiff: 0, never: 0 } }),
    };
  };
  return { list, asked };
}

/** `work` whose jobs wait until the test settles them (or `auto` answers at once). */
function jobs({ auto = null } = {}) {
  const calls = [];
  const pending = new Map();
  let active = 0;
  let redraws = 0;
  const peak = { active: 0, redraws: 0 };
  const work = (file, job, { onBytes } = {}) => {
    calls.push([file.id, job]);
    active += 1;
    if (job === 'redraw') redraws += 1;
    peak.active = Math.max(peak.active, active);
    peak.redraws = Math.max(peak.redraws, redraws);
    const done = () => { active -= 1; if (job === 'redraw') redraws -= 1; };
    if (auto) {
      return new Promise((resolve, reject) => setImmediate(() => {
        done();
        try { resolve(auto(file, job, onBytes)); } catch (e) { reject(e); }
      }));
    }
    return new Promise((resolve, reject) => {
      pending.set(file.id, {
        resolve: (v) => { done(); resolve(v); },
        reject: (e) => { done(); reject(e); },
      });
    });
  };
  const finish = (id, value = { outcome: 'done' }) => {
    const p = pending.get(id);
    assert.ok(p, `${id} is not under way`);
    pending.delete(id);
    p.resolve(value);
  };
  return { work, calls, pending, peak, finish };
}

/** Run a run to a status, watching onChange. */
function watch() {
  const seen = [];
  let last = null;
  const onChange = (s) => { last = s; seen.push(s.status); };
  return { onChange, seen, get last() { return last; } };
}

/** Let the run's promises settle until `cond` holds (or give up). */
async function until(cond, what = 'the condition') {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('a run gives each file its job', () => {
  test('the cheapest one; what needs none, or cannot be drawn here, is skipped with its reason; a throw is a failure', async () => {
    const rows = [
      row('f1', 'thumbnail'),
      row('f2', 'sizes'),
      row('f3', 'placeholder'),
      row('f4', 'nothing'),
      row('f5', 'thumbnail', { name: 'IMG.heic', mime: 'image/heic' }),
      row('f6', 'thumbnail'),
      row('f7', 'placeholder'),
    ];
    const { list } = pager(rows, { size: 3 });
    const w = jobs({
      auto: (file, job, onBytes) => {
        if (file.id === 'f6') throw new Error('HTTP 404');
        if (file.id === 'f7') return { outcome: 'skipped', reason: 'No placeholder could be drawn from its thumbnail.' };
        if (job === 'redraw') onBytes(1500);
        return { outcome: 'done' };
      },
    });
    const v = watch();
    const run = createPreviewRun({ params: { mode: 'missing', decodes: {} }, list, work: w.work, onChange: v.onChange });
    run.start();
    await until(() => v.last?.status === 'done', 'done');

    assert.deepEqual(w.calls.sort(), [['f1', 'redraw'], ['f2', 'sizes'], ['f3', 'placeholder'], ['f6', 'redraw'], ['f7', 'placeholder']]);
    const s = run.state();
    assert.equal(s.total, 7);
    assert.deepEqual([s.done, s.skipped, s.failed], [3, 3, 1]);
    assert.deepEqual(s.jobs, { redraw: 1, sizes: 1, placeholder: 1 });
    assert.equal(s.after, 'f7', 'every file dealt with');
    assert.deepEqual(s.current, []);
    const by = Object.fromEntries(s.reasons.map((r) => [r.reason, r]));
    assert.deepEqual(by['Nothing missing any more: it was made meanwhile.'].files, [{ id: 'f4', name: 'f4.jpg' }]);
    assert.equal(by['This browser cannot decode HEIC. Safari can.'].outcome, 'skipped');
    assert.equal(by['Its original is not in the bucket (HTTP 404).'].outcome, 'failed');
    assert.equal(by['No placeholder could be drawn from its thumbnail.'].count, 1);
  });

  test('everything: every file drawn whole, whatever it has', async () => {
    const rows = [row('f1', 'nothing'), row('f2', 'sizes'), row('f3', 'thumbnail')];
    const { list } = pager(rows);
    const w = jobs({ auto: () => ({ outcome: 'done' }) });
    const v = watch();
    const run = createPreviewRun({ params: { mode: 'everything' }, list, work: w.work, onChange: v.onChange });
    run.start();
    await until(() => v.last?.status === 'done', 'done');
    assert.deepEqual(w.calls.map(([, job]) => job), ['redraw', 'redraw', 'redraw']);
    assert.equal(run.state().jobs.redraw, 3);
  });

  test('reasons are grouped, and name only so many files each', async () => {
    const rows = Array.from({ length: NAMES_PER_REASON + 5 }, (_, i) => row(`f${String(i).padStart(3, '0')}`, 'nothing'));
    const { list } = pager(rows, { size: 20 });
    const v = watch();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: jobs().work, onChange: v.onChange });
    run.start();
    await until(() => v.last?.status === 'done', 'done');
    const [only] = run.state().reasons;
    assert.equal(run.state().reasons.length, 1);
    assert.equal(only.count, NAMES_PER_REASON + 5);
    assert.equal(only.files.length, NAMES_PER_REASON);
  });
});

describe('a few at a time', () => {
  test('three jobs at once, and never more than two of them full redraws', async () => {
    const rows = Array.from({ length: 24 }, (_, i) => row(`f${String(i).padStart(2, '0')}`, i % 3 ? 'thumbnail' : 'placeholder'));
    const { list } = pager(rows, { size: 5 });
    const w = jobs({ auto: () => ({ outcome: 'done' }) });
    const v = watch();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: w.work, onChange: v.onChange });
    run.start();
    await until(() => v.last?.status === 'done', 'done');
    assert.equal(run.state().done, 24);
    assert.equal(w.peak.active, 3);
    assert.equal(w.peak.redraws, 2);
  });

  test('a redraw waits for a place while a small job goes past it', async () => {
    const rows = [row('f1', 'thumbnail'), row('f2', 'thumbnail'), row('f3', 'thumbnail'), row('f4', 'placeholder')];
    const { list } = pager(rows);
    const w = jobs();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: w.work });
    run.start();
    await until(() => w.calls.length === 2, 'two redraws');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(w.calls, [['f1', 'redraw'], ['f2', 'redraw']], 'the third waits');
    w.finish('f1');
    await until(() => w.calls.length === 4, 'the third and the small one');
    assert.deepEqual(w.calls.slice(2).sort(), [['f3', 'redraw'], ['f4', 'placeholder']]);
    assert.equal(w.peak.redraws, 2);
  });
});

describe('pause, resume and stop', () => {
  test('pause lets the jobs under way finish and takes no more; resume carries on to the end', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`f${i}`, 'placeholder'));
    const { list } = pager(rows, { size: 8 });
    const w = jobs();
    const v = watch();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: w.work, onChange: v.onChange });
    run.start();
    await until(() => w.pending.size === 3, 'three under way');
    run.pause();
    assert.equal(run.state().status, 'pausing');
    w.finish('f0');
    w.finish('f1');
    await until(() => run.state().done === 2, 'two done');
    assert.equal(run.state().status, 'pausing', 'one still under way');
    w.finish('f2');
    await until(() => run.state().status === 'paused', 'paused');
    await new Promise((r) => setImmediate(r));
    assert.equal(w.calls.length, 3, 'nothing taken while paused');
    assert.equal(run.state().after, 'f2');

    run.resume();
    assert.equal(run.state().status, 'running');
    for (const id of ['f3', 'f4', 'f5', 'f6', 'f7']) {
      await until(() => w.pending.has(id), id);
      w.finish(id);
    }
    await until(() => run.state().status === 'done', 'done');
    assert.equal(run.state().done, 8);
    assert.equal(w.calls.length, 8, 'each file once');
    assert.deepEqual(v.seen.filter((st, i, a) => st !== a[i - 1]), ['running', 'pausing', 'paused', 'running', 'done']);
  });

  test('stop ends it once the jobs under way are done; it cannot be resumed', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`f${i}`, 'placeholder'));
    const { list } = pager(rows);
    const w = jobs();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: w.work });
    run.start();
    await until(() => w.pending.size === 3, 'three under way');
    run.stop();
    assert.equal(run.state().status, 'stopping');
    for (const id of ['f0', 'f1', 'f2']) w.finish(id);
    await until(() => run.state().status === 'stopped', 'stopped');
    run.resume();
    run.start();
    await new Promise((r) => setImmediate(r));
    assert.equal(run.state().status, 'stopped');
    assert.equal(w.calls.length, 3);
    assert.equal(run.state().done, 3);
  });

  test('a paused run stops at once; nothing is under way', async () => {
    const { list } = pager([row('f1'), row('f2'), row('f3'), row('f4')], { size: 4 });
    const w = jobs();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: w.work, parallel: 1 });
    run.start();
    await until(() => w.pending.size === 1, 'one under way');
    run.pause();
    w.finish('f1');
    await until(() => run.state().status === 'paused', 'paused');
    run.stop();
    assert.equal(run.state().status, 'stopped');
  });
});

describe('where a run picks up', () => {
  test('`after` moves only past files every one before which is done', async () => {
    const { list } = pager([row('f1'), row('f2'), row('f3')]);
    const w = jobs();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: w.work });
    run.start();
    await until(() => w.pending.size === 3, 'three under way');
    w.finish('f3');
    await until(() => run.state().done === 1, 'f3 done');
    assert.equal(run.state().after, '', 'f1 and f2 are not done yet');
    w.finish('f1');
    await until(() => run.state().done === 2, 'f1 done');
    assert.equal(run.state().after, 'f1');
    w.finish('f2');
    await until(() => run.state().status === 'done', 'done');
    assert.equal(run.state().after, 'f3');
  });

  test('a page that cannot be listed stops the run with the reason; trying again lists it again', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`f${i}`, 'placeholder'));
    let failed = false;
    const { list, asked } = pager(rows, {
      size: 3,
      fail: (after) => {
        if (after === 'f2' && !failed) { failed = true; return true; }
        return false;
      },
    });
    const w = jobs({ auto: () => ({ outcome: 'done' }) });
    const v = watch();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: w.work, onChange: v.onChange });
    run.start();
    await until(() => v.last?.status === 'error', 'error');
    await until(() => run.state().done === 3, 'the first page done');
    assert.equal(run.state().error, 'The files could not be listed. Try again.');
    run.resume();
    await until(() => v.last?.status === 'done', 'done');
    assert.equal(run.state().done, 6);
    assert.deepEqual(asked, ['', 'f2', 'f2'], 'the failed page, asked again');
  });

  test('a kept run carries on from where it was left, with its counts and its total', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`f${i}`, 'placeholder'));
    const kept = {
      ...initialRunState({ mode: 'missing', decodes: {} }),
      status: 'running', total: 6, done: 3, after: 'f2', current: [{ id: 'f3', name: 'f3.jpg', job: 'placeholder' }],
    };
    assert.equal(unfinished(kept), true);
    const from = carriedOver(JSON.parse(JSON.stringify(kept)));
    assert.equal(from.status, 'paused');
    assert.deepEqual(from.current, [], 'what was under way is done again');
    const { list, asked } = pager(rows, { counts: { total: 99, heic: 0, tiff: 0, never: 0 } });
    const w = jobs({ auto: () => ({ outcome: 'done' }) });
    const v = watch();
    const run = createPreviewRun({ from, list, work: w.work, onChange: v.onChange });
    assert.equal(run.state().status, 'paused');
    run.resume();
    await until(() => v.last?.status === 'done', 'done');
    assert.deepEqual(asked, ['f2']);
    assert.deepEqual(w.calls.map(([id]) => id), ['f3', 'f4', 'f5']);
    assert.equal(run.state().done, 6);
    assert.equal(run.state().total, 6, 'its own total, not a new count');
  });

  test('a finished run kept is a report, not a run to carry on', () => {
    for (const status of ['done', 'stopped']) {
      const kept = { ...initialRunState({ mode: 'missing' }), status, done: 4 };
      assert.equal(unfinished(kept), false);
      assert.equal(carriedOver(kept).status, status);
    }
    assert.equal(carriedOver(null), null);
    assert.equal(carriedOver({ status: 'running' }), null, 'nothing to say what it was over');
  });

  test('after a long pause the rest of a page is listed again, from the last file taken', async () => {
    let clock = 1_000_000;
    const rows = Array.from({ length: 5 }, (_, i) => row(`f${i}`, 'placeholder'));
    const { list, asked } = pager(rows, { size: 5 });
    const w = jobs();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: w.work, parallel: 1, now: () => clock });
    run.start();
    await until(() => w.pending.has('f0'), 'f0 under way');
    run.pause();
    w.finish('f0');
    await until(() => run.state().status === 'paused', 'paused');
    clock += 11 * 60_000;
    run.resume();
    for (const id of ['f1', 'f2', 'f3', 'f4']) {
      await until(() => w.pending.has(id), id);
      w.finish(id);
    }
    await until(() => run.state().status === 'done', 'done');
    assert.deepEqual(asked, ['', 'f0']);
    assert.equal(w.calls.length, 5);
  });

  test('an empty page that is not the last is followed by the next; one that goes nowhere ends the list', async () => {
    const script = new Map([
      ['', { files: [row('f1')], after: 'f1', done: false, counts: { total: 2, heic: 0, tiff: 0, never: 0 } }],
      ['f1', { files: [], after: 'f5', done: false }],
      ['f5', { files: [], after: 'f9', done: false }],
      ['f9', { files: [row('g2')], after: 'g2', done: true }],
    ]);
    const asked = [];
    const list = async (after) => { asked.push(after); return script.get(after); };
    const v = watch();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: jobs({ auto: () => ({ outcome: 'done' }) }).work, onChange: v.onChange });
    run.start();
    await until(() => v.last?.status === 'done', 'done');
    assert.deepEqual(asked, ['', 'f1', 'f5', 'f9']);
    assert.equal(run.state().done, 2);

    const stuck = [];
    const nowhere = async (after) => { stuck.push(after); return { files: [], after, done: false }; };
    const v2 = watch();
    const again = createPreviewRun({ params: { mode: 'missing' }, list: nowhere, work: jobs().work, onChange: v2.onChange });
    again.start();
    await until(() => v2.last?.status === 'done', 'done');
    assert.deepEqual(stuck, [''], 'asked once, not for ever');
  });

  test('the first page’s counts: the total, and what this browser leaves out', async () => {
    const { list } = pager([row('f1')], { counts: { total: 1, heic: 4, tiff: 1, never: 2 } });
    const v = watch();
    const run = createPreviewRun({ params: { mode: 'missing' }, list, work: jobs({ auto: () => ({ outcome: 'done' }) }).work, onChange: v.onChange });
    run.start();
    await until(() => v.last?.status === 'done', 'done');
    assert.equal(run.state().total, 1);
    assert.deepEqual(run.state().leftOut, { heic: 4, tiff: 1, never: 2 });
  });
});
