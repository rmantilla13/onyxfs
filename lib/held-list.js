// lib/held-list.js — a list kept for the document, not for one mount of a
// component: the files page's collections (app/files/FilesClient.js), which
// the router remounts with the props of an earlier render on Back.
//
// In the browser only. On the server a module is one for every request and
// every person, so a list kept there would be rendered into the next
// person's page: there get() is always null and set() keeps nothing.

const browser = () => typeof window !== 'undefined';

/**
 * { get, set, ask, newest }: the list held for `who` (null until one is, and
 * for anyone else — a tab signed into another account without a reload),
 * keeping one, and numbering requests — ask() hands out the next number,
 * newest(n) says whether n is still the last handed out — so only the newest
 * answer is taken over a slower, older one.
 */
export function heldList() {
  let list = null;
  let owner = null;
  let asked = 0;
  return {
    get: (who) => (browser() && who && who === owner ? list : null),
    set: (next, who) => {
      if (browser() && who) { list = next; owner = who; }
      return next;
    },
    ask: () => ++asked,
    newest: (n) => n === asked,
  };
}
