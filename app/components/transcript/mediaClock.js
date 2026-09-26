/**
 * Where the player is, as a tiny store: the player writes it (timeupdate,
 * seeked) and the transcript panel subscribes. Kept out of React state on
 * purpose — the file page holds the player, the review panel and the
 * inspector, and re-rendering all of it four times a second for a
 * highlight in one list is how a page starts to stutter. A subscriber
 * reads it through useSyncExternalStore and re-renders only when what it
 * derives (the segment under the playhead) changes.
 */
export function createMediaClock() {
  let time = 0;
  const subs = new Set();
  return {
    get: () => time,
    set: (t) => {
      if (!Number.isFinite(t) || t === time) return;
      time = t;
      for (const fn of subs) fn();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
