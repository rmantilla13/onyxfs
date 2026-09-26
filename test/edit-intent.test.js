// A list cell edits on Finder's slow second click, never on the first click
// of a row, and never under a double-click that opens the file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditIntent, EDIT_DELAY_MS } from '../lib/edit-intent.js';

function fakeTimers() {
  let next = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fire() { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
    get size() { return timers.size; },
    delays: () => [...timers.values()].map((t) => t.ms),
  };
}

test('a click on a row that was not selected only selects it', () => {
  const t = fakeTimers();
  const intent = createEditIntent(t);
  let edits = 0;
  assert.equal(intent.click({ wasSelected: false }, () => edits++), false);
  t.fire();
  assert.equal(edits, 0);
});

test('a click on a row already selected edits, after the delay', () => {
  const t = fakeTimers();
  const intent = createEditIntent(t);
  let edits = 0;
  assert.equal(intent.click({ wasSelected: true }, () => edits++), true);
  assert.equal(edits, 0, 'not at once');
  assert.deepEqual(t.delays(), [EDIT_DELAY_MS]);
  t.fire();
  assert.equal(edits, 1);
});

test('a double-click cancels the edit its first click scheduled', () => {
  const t = fakeTimers();
  const intent = createEditIntent(t);
  let edits = 0;
  intent.click({ wasSelected: true, detail: 1 }, () => edits++);
  // The second click of the pair arrives with detail 2 and schedules nothing.
  assert.equal(intent.click({ wasSelected: true, detail: 2 }, () => edits++), false);
  intent.dblclick();
  t.fire();
  assert.equal(edits, 0);
  assert.equal(intent.pending, false);
});

test('a second slow click replaces the first, so one edit starts', () => {
  const t = fakeTimers();
  const intent = createEditIntent(t);
  let edits = 0;
  intent.click({ wasSelected: true }, () => edits++);
  intent.click({ wasSelected: true }, () => edits++);
  assert.equal(t.size, 1);
  t.fire();
  assert.equal(edits, 1);
});

// ⌘- and ⇧-clicks change the selection; a click on one row of several picks
// it out of them. Neither is the slow second click that edits.
test('a modified click, or one on a row that was not the whole selection, never edits', () => {
  const t = fakeTimers();
  const intent = createEditIntent(t);
  let edits = 0;
  assert.equal(intent.click({ wasSelected: true, detail: 1, modified: true }, () => edits++), false);
  // FileList passes wasSelected only when the row was selected on its own.
  assert.equal(intent.click({ wasSelected: false, detail: 1 }, () => edits++), false);
  t.fire();
  assert.equal(edits, 0);
  assert.equal(intent.click({ wasSelected: true, detail: 1, modified: false }, () => edits++), true);
  t.fire();
  assert.equal(edits, 1);
});
