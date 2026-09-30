// lib/ndjson.js: a route's work as it goes, one JSON line at a time, and the
// page reading it — progress lines, then the answer the plain response would
// have been. PATCH /api/files/folders streams a folder move this way
// (test/mac-writes-api.test.js has the route end of it).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ndjsonResponse, readNdjson, isNdjson } from '../lib/ndjson.js';

const enc = new TextEncoder();
/** A Response whose body arrives in exactly these pieces. */
const chunked = (...pieces) => new Response(new ReadableStream({
  start(c) { for (const p of pieces) c.enqueue(enc.encode(p)); c.close(); },
}));

describe('reading', () => {
  test('lines split across chunks, progress to onLine, the answer returned', async () => {
    const seen = [];
    const answer = await readNdjson(
      chunked('{"phase":"copy","do', 'ne":1,"total":2}\n{"phase":"copy","done":2,"total":2}\n{"status":200,', '"body":{"ok":true}}'),
      (l) => seen.push(l),
    );
    assert.deepEqual(seen, [{ phase: 'copy', done: 1, total: 2 }, { phase: 'copy', done: 2, total: 2 }]);
    assert.deepEqual(answer, { status: 200, body: { ok: true } });
  });

  test('a stream cut off before its answer: what came, and null', async () => {
    const seen = [];
    const answer = await readNdjson(chunked('{"phase":"check","done":3,"total":9}\n{"phase":"co'), (l) => seen.push(l));
    assert.deepEqual(seen, [{ phase: 'check', done: 3, total: 9 }]);
    assert.equal(answer, null);
  });

  test('a stream that errors part-way is read up to there', async () => {
    let pulls = 0;
    const res = new Response(new ReadableStream({
      pull(c) {
        if (pulls++ === 0) c.enqueue(enc.encode('{"phase":"copy","done":1,"total":4}\n'));
        else c.error(new Error('reset'));
      },
    }));
    const seen = [];
    assert.equal(await readNdjson(res, (l) => seen.push(l)), null);
    assert.deepEqual(seen, [{ phase: 'copy', done: 1, total: 4 }]);
  });

  test('blank and broken lines are skipped; no body is null', async () => {
    assert.deepEqual(await readNdjson(chunked('\n\nnot json\n{"status":409,"body":{}}\n')), { status: 409, body: {} });
    assert.equal(await readNdjson(new Response(null)), null);
  });
});

describe('writing', () => {
  test('progress within a phase at most every everyMs; a new phase and its last step always', async () => {
    const res = ndjsonResponse(async (report) => {
      for (let i = 1; i <= 50; i++) report('copy', i, 50);
      report('catalog');
      return { status: 200, body: { moved: 50 } };
    }, { everyMs: 60_000 });
    assert.ok(isNdjson(res));
    assert.equal(res.status, 200);
    const lines = [];
    const answer = await readNdjson(res, (l) => lines.push(l));
    assert.deepEqual(lines, [
      { phase: 'copy', done: 1, total: 50 },
      { phase: 'copy', done: 50, total: 50 },
      { phase: 'catalog', done: null, total: null },
    ]);
    assert.deepEqual(answer, { status: 200, body: { moved: 50 } });
  });

  test('a throw is a 500 answer, after the progress that was sent', async () => {
    const lines = [];
    const answer = await readNdjson(ndjsonResponse(async (report) => {
      report('check', 1, 2);
      throw new Error('database went away');
    }), (l) => lines.push(l));
    assert.deepEqual(lines, [{ phase: 'check', done: 1, total: 2 }]);
    assert.deepEqual(answer, { status: 500, body: { error: 'database went away' } });
  });

  test('a reader that goes away does not stop the work', async () => {
    let finished = false;
    const res = ndjsonResponse(async (report) => {
      for (let i = 0; i < 5; i++) { report(`step ${i}`); await new Promise((r) => setTimeout(r, 1)); }
      finished = true;
      return { status: 200, body: {} };
    });
    await res.body.cancel();
    for (let i = 0; i < 50 && !finished; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(finished);
  });
});
