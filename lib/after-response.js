import { waitUntil } from '@vercel/functions';

/**
 * Work a route finishes after it has answered: a trashed file's object moved
 * aside (lib/trash-move.js), which is slow for a large one and which nobody
 * should wait on. On Vercel the function lives until it settles (waitUntil,
 * within the route's maxDuration); elsewhere — `next dev`, a test — it simply
 * runs on. It never throws into the caller, and a failure is only logged: the
 * work is always something that can be picked up again later.
 */
const pending = new Set();

export function afterResponse(label, work) {
  const run = Promise.resolve()
    .then(work)
    .catch((e) => console.warn(`[after] ${label}:`, e?.message || e))
    .finally(() => pending.delete(run));
  pending.add(run);
  try { waitUntil(run); } catch {}
  return run;
}

/** Every piece of work started so far, finished: for tests, before they look. */
export async function afterResponseSettled() {
  while (pending.size) await Promise.allSettled([...pending]);
}
