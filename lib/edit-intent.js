// lib/edit-intent.js — Finder's "slow second click" to edit, for the list's
// editable cells.
//
// A click on a cell selects its row, like a click anywhere else on the row.
// Only a plain click on a row that was ALREADY selected, and on its own,
// before that click starts editing — a ⌘- or ⇧-click changes the selection,
// and a click on one row of several is picking that row out of them — and
// not at once: a double-click opens the file, and its first click must not
// have opened an editor under the second. So the edit waits EDIT_DELAY_MS,
// and a double-click in that time cancels it.
//
// The timers are injectable, so the rule is tested without waiting.

export const EDIT_DELAY_MS = 350;

export function createEditIntent({ delay = EDIT_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null;
  const cancel = () => {
    if (pending) clearTimer(pending);
    pending = null;
  };
  return {
    /**
     * A single click on a cell. `wasSelected`: the row was the whole
     * selection before this click. `detail`: the click count (a second click
     * of a double-click is 2). `modified`: ⌘, Ctrl or ⇧ was held. `start()`
     * opens the editor. Returns whether an edit was scheduled.
     */
    click({ wasSelected, detail = 1, modified = false }, start) {
      cancel();
      if (!wasSelected || detail > 1 || modified) return false;
      pending = setTimer(() => { pending = null; start(); }, delay);
      return true;
    },
    /** A double-click: whatever edit the first click scheduled does not happen. */
    dblclick: cancel,
    cancel,
    get pending() { return pending != null; },
  };
}
