// lib/selection.js — what a click, a modified click or an arrow key does to
// the selection, the way Finder does it.
//
// Pure, no imports, so the rules are tested without a DOM (the hook that
// applies them is app/files/useSelectionModel.js). The items are keys in view
// order: `f:<fileId>` for a file and `d:<folderPath>` for a folder, folders
// first, as the pane shows them.
//
// A selection is { keys: Set, anchor, focus }. The anchor is where a Shift
// range is measured from — the last item clicked without Shift — and the
// focus is the item the keyboard is on.
//
//   click                 the item alone, and it becomes the anchor
//   ⌘/Ctrl-click          the item flips, and it becomes the anchor
//   ⇧-click               anchor..item, replacing the rest
//   ⌘/Ctrl-⇧-click        anchor..item, added to the rest
//   arrow                 the item alone (selection follows focus)
//   ⇧-arrow               anchor..item
//   ⇧Space                the focused item flips

export const fileKey = (id) => `f:${id}`;
export const folderKey = (path) => `d:${path}`;

/** 'f:abc' → { type: 'file', id: 'abc' }, 'd:a/b' → { type: 'folder', id: 'a/b' }, anything else → null. */
export function parseKey(key) {
  const k = String(key ?? '');
  if (k.startsWith('f:')) return { type: 'file', id: k.slice(2) };
  if (k.startsWith('d:')) return { type: 'folder', id: k.slice(2) };
  return null;
}

export function emptySelection() {
  return { keys: new Set(), anchor: null, focus: null };
}

/**
 * Every key from `a` to `b` inclusive, in view order, whichever comes first.
 * An end that is not in `order` (the anchor's item scrolled out of a
 * filtered view, say) makes the range just `b`.
 */
export function rangeKeys(order, a, b) {
  const list = Array.isArray(order) ? order : [];
  const j = list.indexOf(b);
  if (j < 0) return [];
  const i = a == null ? -1 : list.indexOf(a);
  if (i < 0) return [b];
  return i <= j ? list.slice(i, j + 1) : list.slice(j, i + 1);
}

/** A click on `key`. `toggle` is ⌘ or Ctrl held, `range` is Shift held. */
export function clickSelect(state, key, { toggle = false, range = false, order = [] } = {}) {
  const cur = state || emptySelection();
  if (range) {
    const anchor = cur.anchor != null && order.includes(cur.anchor) ? cur.anchor : key;
    const span = rangeKeys(order, anchor, key);
    const keys = toggle ? new Set([...cur.keys, ...span]) : new Set(span);
    return { keys, anchor, focus: key };
  }
  if (toggle) {
    const keys = new Set(cur.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, anchor: key, focus: key };
  }
  return { keys: new Set([key]), anchor: key, focus: key };
}

/**
 * The keyboard moved to `key`. Without `extend` the selection follows it;
 * with it (Shift held) the selection is anchor..key, the anchor staying put
 * — or, when there is none yet, becoming the item the move started from.
 */
export function moveTo(state, key, { extend = false, order = [] } = {}) {
  const cur = state || emptySelection();
  if (!extend) return { keys: new Set([key]), anchor: key, focus: key };
  const from = [cur.anchor, cur.focus].find((k) => k != null && order.includes(k)) ?? key;
  return { keys: new Set(rangeKeys(order, from, key)), anchor: from, focus: key };
}

/** ⇧Space: flip the item, which becomes the anchor and the focus. */
export function toggleKey(state, key) {
  return clickSelect(state, key, { toggle: true });
}

/** A selection of exactly these keys, focused on the last. */
export function selectKeys(keys, { anchor, focus } = {}) {
  const list = [...(keys || [])];
  const last = list.length ? list[list.length - 1] : null;
  return { keys: new Set(list), anchor: anchor ?? list[0] ?? null, focus: focus ?? last };
}

/** Keys → the file ids and folder paths they name, as two Sets. */
export function splitKeys(keys) {
  const files = new Set();
  const folders = new Set();
  for (const k of keys || []) {
    const p = parseKey(k);
    if (p?.type === 'file') files.add(p.id);
    else if (p?.type === 'folder') folders.add(p.id);
  }
  return { files, folders };
}

/** The file ids and folder paths as keys, folders first — the view's order. */
export function joinKeys(files, folders) {
  return new Set([...[...(folders || [])].map(folderKey), ...[...(files || [])].map(fileKey)]);
}

/** Whether two Sets hold the same members. */
export function sameMembers(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
