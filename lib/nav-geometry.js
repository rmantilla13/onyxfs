// lib/nav-geometry.js — where an arrow key goes in the files pane.
//
// The pane is up to two sections one above the other — the folder tiles,
// then the files — each a grid of `cols` equal columns filled row by row (a
// list is a grid of one column). A position is { s, i }: section index and
// item index inside it. Pure, so the awkward cases are tested: the ragged
// last row, crossing from one section into the other, a phone's one column.
//
//   ← →         previous / next item, wrapping at row ends and crossing
//               between sections, as Finder's icon view does
//   ↑ ↓         the item above / below; from a row with nothing below it,
//               the last item; from the edge of a section, the nearest item
//               of the next one by horizontal centre
//   Home End    the first / last item of the whole pane
//   PageUp/Down `rowsPerPage` rows at a time

function sizes(sections) {
  return (sections || []).map((s) => ({
    count: Math.max(0, Math.floor(Number(s?.count) || 0)),
    cols: Math.max(1, Math.floor(Number(s?.cols) || 1)),
  }));
}

/** Position → index into the pane's flat order (sections one after another). */
export function flatIndex(sections, pos) {
  const list = sizes(sections);
  if (!pos || pos.s < 0 || pos.s >= list.length) return -1;
  let n = 0;
  for (let s = 0; s < pos.s; s++) n += list[s].count;
  return pos.i >= 0 && pos.i < list[pos.s].count ? n + pos.i : -1;
}

/** Flat index → position, or null past either end. */
export function posOf(sections, flat) {
  const list = sizes(sections);
  let n = Number(flat);
  if (!Number.isInteger(n) || n < 0) return null;
  for (let s = 0; s < list.length; s++) {
    if (n < list[s].count) return { s, i: n };
    n -= list[s].count;
  }
  return null;
}

/** The horizontal centre of column `col` of `cols`, as a fraction of the width. */
const centre = (col, cols) => (col + 0.5) / cols;

/** In a section, the item of `row` whose centre is nearest `x` (a fraction of the width). */
function nearestInRow(sec, row, x) {
  const col = Math.min(sec.cols - 1, Math.max(0, Math.floor(x * sec.cols)));
  return Math.min(sec.count - 1, row * sec.cols + col);
}

function nextSection(list, s, dir) {
  for (let t = s + dir; t >= 0 && t < list.length; t += dir) if (list[t].count > 0) return t;
  return -1;
}

function step(list, pos, key) {
  const sec = list[pos.s];
  const { i } = pos;
  const row = Math.floor(i / sec.cols);
  const lastRow = Math.floor((sec.count - 1) / sec.cols);
  const x = centre(i % sec.cols, sec.cols);
  switch (key) {
    case 'ArrowRight': {
      if (i + 1 < sec.count) return { s: pos.s, i: i + 1 };
      const t = nextSection(list, pos.s, 1);
      return t < 0 ? null : { s: t, i: 0 };
    }
    case 'ArrowLeft': {
      if (i > 0) return { s: pos.s, i: i - 1 };
      const t = nextSection(list, pos.s, -1);
      return t < 0 ? null : { s: t, i: list[t].count - 1 };
    }
    case 'ArrowDown': {
      if (i + sec.cols < sec.count) return { s: pos.s, i: i + sec.cols };
      // A row below that is too short to have this column: its last item.
      if (row < lastRow) return { s: pos.s, i: sec.count - 1 };
      const t = nextSection(list, pos.s, 1);
      return t < 0 ? null : { s: t, i: nearestInRow(list[t], 0, x) };
    }
    case 'ArrowUp': {
      if (i - sec.cols >= 0) return { s: pos.s, i: i - sec.cols };
      const t = nextSection(list, pos.s, -1);
      if (t < 0) return null;
      const above = list[t];
      return { s: t, i: nearestInRow(above, Math.floor((above.count - 1) / above.cols), x) };
    }
    default:
      return null;
  }
}

/**
 * Where `key` takes the keyboard from `pos`, or null when it goes nowhere
 * (an arrow at the edge of the pane, or a key this does not handle). With no
 * position yet, any movement key lands on the first item.
 */
export function navTarget(sections, pos, key, { rowsPerPage = 1 } = {}) {
  const list = sizes(sections);
  const total = list.reduce((n, s) => n + s.count, 0);
  if (!total) return null;
  const first = posOf(list, 0);
  const last = posOf(list, total - 1);
  if (key === 'Home') return first;
  if (key === 'End') return last;
  const valid = pos && pos.s >= 0 && pos.s < list.length && pos.i >= 0 && pos.i < list[pos.s].count;
  if (!valid) {
    return ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(key) ? first : null;
  }
  if (key === 'PageDown' || key === 'PageUp') {
    const dir = key === 'PageDown' ? 'ArrowDown' : 'ArrowUp';
    let at = pos;
    for (let n = 0; n < Math.max(1, Math.floor(rowsPerPage)); n++) {
      const next = step(list, at, dir);
      if (!next) break;
      at = next;
    }
    if (at === pos) return key === 'PageDown' ? (flatIndex(list, pos) === total - 1 ? null : last) : (flatIndex(list, pos) === 0 ? null : first);
    return at;
  }
  return step(list, pos, key);
}

/** Rows that fit in `viewport` px at `pitch` px per row, at least one. */
export function rowsPerViewport(viewport, pitch) {
  const v = Number(viewport);
  const p = Number(pitch);
  if (!(v > 0) || !(p > 0)) return 1;
  return Math.max(1, Math.floor(v / p) - 1);
}
