// Work the page is doing that takes a while — moving or renaming a folder,
// deleting one, moving or removing files, redrawing a thumbnail, starting a
// batch of downloads — shown while it runs in the activity panel
// (app/components/ui/Activity.js), above the upload tray. How it ended is
// still a toast; the panel is for "this is happening, and this far along".
//
// Framework-free, like lib/upload-queue.js: a caller anywhere starts a task
// and gets a handle, whether or not it is inside a component. A task shows
// only once it has run SHOW_AFTER_MS — most finish before that, and a row
// that flashes for a tenth of a second reads as a glitch, not as progress.
// Changes reach the panel at most once a frame, so a stream of progress (a
// folder move reports each copy) does not re-render it per event.

export const SHOW_AFTER_MS = 400;

let tasks = [];
let seq = 0;
const listeners = new Set();
let scheduled = false;
let generation = 0;

function emit() {
  if (scheduled) return;
  scheduled = true;
  const gen = generation;
  const run = () => {
    if (gen !== generation) return;
    scheduled = false;
    for (const fn of listeners) fn(tasks);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

const FIELDS = ['title', 'detail', 'done', 'total'];
const patchOf = (spec) => Object.fromEntries(FIELDS.filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]]));

/**
 * Start a task — { title, detail?, done?, total? }, where done/total make a
 * bar that fills and without them it only moves. → a handle:
 *
 *   update({ title, detail, done, total })   any of them
 *   end()                                     it is over: the row goes
 *
 * Both are safe to call after end().
 */
export function startActivity(spec = {}) {
  const id = `a${++seq}`;
  tasks = [...tasks, { id, title: '', detail: '', done: null, total: null, ...patchOf(spec), startedAt: Date.now() }];
  emit();
  let over = false;
  return {
    id,
    update(patch = {}) {
      if (over) return;
      const next = patchOf(patch);
      tasks = tasks.map((t) => (t.id === id ? { ...t, ...next } : t));
      emit();
    },
    end() {
      if (over) return;
      over = true;
      tasks = tasks.filter((t) => t.id !== id);
      emit();
    },
  };
}

/** `work(task)` as a task that ends however `work` does. → what it returns. */
export async function withActivity(spec, work) {
  const task = startActivity(spec);
  try {
    return await work(task);
  } finally {
    task.end();
  }
}

/** Every task running now, oldest first. The same array until one changes. */
export function activitySnapshot() {
  return tasks;
}

/** fn(tasks) after changes, at most once a frame. → unsubscribe. */
export function subscribeActivity(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "3 of 234 files", with the counts as this reader writes numbers. */
export function countOf(done, total, noun = '') {
  const n = (v) => Number(v || 0).toLocaleString();
  return `${n(done)} of ${n(total)}${noun ? ` ${noun}` : ''}`;
}

/** For tests: forget every task and listener. */
export function _resetActivity() {
  tasks = [];
  seq = 0;
  listeners.clear();
  scheduled = false;
  generation++;
}
