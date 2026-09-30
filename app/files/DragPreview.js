'use client';

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import FolderGlyph from '@/app/components/ui/FolderGlyph';
import Icon from '@/app/components/ui/Icon';
import { baseName } from '@/lib/folder-ops';
import { lastPointer } from './usePointerIntent';
import {
  SPRING_MS, SPRING_WARN_MS, CHIP_H, OVER_SCALE, LAND_SCALE, LABEL_ROOM, HANG, SPRINGS,
  compactBox, previewLayout, hangAt, stepSpring, atRest, swayFor,
  describeFiles, classifyDrop, isRefused, springsOpen,
} from '@/lib/drag-preview';

/**
 * The picture a move drags, inside the library.
 *
 * The browser's drag image is a snapshot of the item at full size, which
 * hides the very folders it might go into. A move begun here (a card, a row,
 * a tile, a folder) swaps it for a blank one and draws its own instead, in
 * one fixed layer: the item lifts from where it is, at its own size, and
 * springs down to a thumbnail hanging beside the pointer — several files a
 * small stack with a count. Over a folder it can go into, the folder lights
 * up and the thumbnail shrinks a little further; over one it cannot (where
 * it is already, a folder into itself, one that may not be written) it
 * greys out and shows a no-entry mark. Held over a folder for a moment, the
 * folder opens (Finder's spring-loaded folders), so a drag can drill down.
 * Let go over a folder, it flies into it as the move starts; let go anywhere
 * else, or cancelled, it flies back to where it came from — and folders it
 * opened on the way close again. Files dragged in from the desktop are the
 * browser's to draw, and are left to it.
 *
 * All of that is lib/drag-preview.js, pure and tested; this applies it.
 * Nothing here re-renders the page: the layer is drawn once as the drag
 * starts, and moved on animation frames by transforms alone, from positions
 * taken from `dragover` on the window (Firefox reports 0,0 on `drag`). The
 * drop targets (FolderDrop, and the page: data-drop-target) are marked
 * with data attributes, which React leaves alone.
 *
 * Ending is the delicate part. `dragend` goes to the item that began the
 * drag, and a folder that springs open takes that item off the page — where
 * the window no longer hears it. So the end is taken from whichever comes
 * first: the item's own `dragend`, the window's, a `drop` anywhere on the
 * page, or the first pointer or key event after the drag (none reach a page
 * while one is under way).
 */

// The page's layer, while one is mounted: a ref to { folder, onSpring, onBack, onPrefetch }.
let host = null;
// The drag under way — and, once it has ended, while its picture flies home or into a folder.
let drag = null;
// The drag whose drop is being dispatched: the drop's own handlers ask about
// it after the drag itself has ended (and, without motion, gone).
let dropping = null;
let frameId = 0;
let seq = 0;

// What the layer draws: set as a drag starts, cleared once its picture has gone.
let shown = null;
const subs = new Set();
const store = {
  get: () => shown,
  subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
};
const nothing = () => null;
function publish(next) {
  shown = next;
  subs.forEach((fn) => fn());
}

// What the browser drags instead of the item: one transparent pixel,
// decoded before the first drag needs it (a picture still loading is ignored).
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
let blank = null;
function blankImage() {
  if (!blank && typeof Image !== 'undefined') {
    blank = new Image();
    blank.src = BLANK;
  }
  return blank;
}

// Without dragovers for this long the pointer has left the window (or the
// drag ended unheard): the picture fades until they come back.
const QUIET_MS = 1500;
// Pointer and key events this soon after the drag began were queued before it.
const STRAY_GRACE_MS = 250;
// …and later ones count as the drag's end only once dragovers have stopped.
const STRAY_QUIET_MS = 150;
// How long flying into a folder or home may take, at most.
const LAND_MS = 320;
const RETURN_MS = 650;
// The sources of a move stay dimmed this long after it lands: they are on
// their way out of the listing, and brightening first would flash them.
const UNDIM_AFTER_LAND_MS = 1200;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Whether a move begun on this page is under way. */
export function draggingHere() {
  return !!drag && !drag.ended;
}

/**
 * The verdict for a drop on the folder at `path` (lib/drag-preview.js
 * classifyDrop), for FolderDrop's dropEffect and drop — or null for a drag
 * this page did not begin (files from the desktop, another tab's), which
 * keeps the old rules. Answers through the drop that ends a drag, too.
 */
export function dropVerdict(path) {
  const d = dropping || (drag && !drag.ended ? drag : null);
  if (!d) return null;
  return classifyDrop(d.what, { path, writable: true, pane: false, sprung: d.hops > 0 });
}

/**
 * During a drop on the page (not on a folder of its own): the folder it goes
 * into, when the drag has sprung that folder open — a drop in the window of
 * a folder drilled down to. Null otherwise: a drop beside the folders of the
 * folder it started in is nowhere.
 */
export function paneDrop() {
  return dropping?.dropped?.pane ? dropping.dropped.path : null;
}

/**
 * Begin the picture for a move that has just started — from a `dragstart`
 * handler, once its data is set. `spec` is
 *   { kind: 'files', ids, rows, label }   rows: the files being moved that the page has; label(row) → e.g. "PDF"
 *   { kind: 'folder', path }
 * The item is `e.currentTarget`. Returns false, leaving the browser's own
 * drag image, when there is no layer on the page or the image cannot be
 * swapped — or when a finger began it (an iPad's long-press), which the
 * system lifts with a preview of its own.
 */
export function beginDrag(e, spec) {
  const dt = e.dataTransfer;
  const img = blankImage();
  const el = e.currentTarget;
  if (!host || !dt?.setDragImage || !img?.complete || !(el instanceof Element)) return false;
  if (lastPointer().type === 'touch') return false;
  finishNow();
  dt.setDragImage(img, 0, 0);

  const now = performance.now();
  const reduced = reducedMotion();
  const isFolder = spec.kind === 'folder';
  const pic = isFolder ? el : (el.querySelector('.filecard-thumb') || el);
  const r = pic.getBoundingClientRect();
  const from = { left: r.left, top: r.top, width: r.width, height: r.height };
  const compact = isFolder ? { width: 0, height: CHIP_H } : compactBox(from);
  const layout = previewLayout(from, compact);

  let what;
  let content;
  let marks;
  if (isFolder) {
    what = { kind: 'folder', path: spec.path };
    content = { kind: 'folder', count: 1, name: baseName(spec.path) || spec.path, glyph: Math.round(26 * layout.k) };
    marks = [...document.querySelectorAll('[data-folder]')]
      .filter((x) => x.getAttribute('data-folder') === spec.path && !x.closest('.crumbs'));
  } else {
    const ids = spec.ids || [];
    what = describeFiles(ids, spec.rows);
    const rows = new Map((spec.rows || []).map((f) => [String(f.id), f]));
    const grabbed = el.getAttribute('data-file-id');
    const order = [grabbed, ...ids.map(String).filter((id) => id !== grabbed)].filter(Boolean).slice(0, 3);
    const want = new Set(ids.map(String));
    marks = [...document.querySelectorAll('[data-file-id]')].filter((x) => want.has(x.getAttribute('data-file-id')));
    const cardOf = (id) => (id === grabbed ? el : marks.find((x) => x.getAttribute('data-file-id') === id));
    content = {
      kind: 'files',
      count: ids.length,
      name: ids.length === 1 ? rows.get(grabbed)?.name || '' : '',
      pictures: order.map((id) => pictureOf(id, rows.get(id), cardOf(id), spec.label)),
    };
  }

  const d = {
    id: ++seq,
    kind: spec.kind,
    what,
    source: el,
    home: isFolder
      ? `[data-folder="${CSS.escape(spec.path)}"]`
      : `[data-file-id="${CSS.escape(el.getAttribute('data-file-id') || '')}"]`,
    marks,
    origin: host.current.folder,
    hops: 0,
    from,
    layout,
    reduced,
    pointer: { x: e.clientX, y: e.clientY },
    startedAt: now,
    seenAt: now,
    last: now,
    outside: false,
    hidden: false,
    snap: false,
    overNode: null,
    stale: false,
    laneEl: null,
    lane: null,
    target: null,
    warn: 0,
    spring: 0,
    quiet: 0,
    ended: false,
    dropped: null,
    phase: 'drag',
    phaseAt: 0,
    landAt: null,
    root: null,
    written: '',
    compacted: false,
    flipX: false,
    flipY: false,
    x: { p: from.left, v: 0 },
    y: { p: from.top, v: 0 },
    s: { p: layout.start, v: 0 },
    r: { p: 0, v: 0 },
  };
  if (reduced) {
    // No lift and no spring: a still thumbnail beside the pointer from the start.
    const h = hangAt(d.pointer, sizeOf(d, layout.compact), viewport());
    Object.assign(d, { flipX: h.flipX, flipY: h.flipY, compacted: true });
    d.x.p = h.x;
    d.y.p = h.y;
    d.s.p = layout.compact;
  }
  drag = d;
  for (const x of marks) x.setAttribute('data-drag-source', '');
  listen(d, true);
  publish({
    ...content,
    id: d.id,
    k: layout.k,
    width: isFolder ? null : layout.width,
    height: layout.height,
    compact: d.compacted,
    transform: transformOf(d),
  });
  return true;
}

// The picture of one file: the one its card is showing when that is big
// enough for the thumbnail (it is loaded, so there is no wait), otherwise
// the grid poster, over the small one (a list row's) or the file's tiny
// placeholder until it has loaded. A file with no picture shows its type,
// as its card does.
function pictureOf(id, row, card, label) {
  const img = card?.querySelector('img.thumb-main');
  const showing = img?.complete && img.naturalWidth ? img.currentSrc || img.src : null;
  const big = !!showing && img.getBoundingClientRect().width >= 90;
  const poster = row?.thumbnailUrl || null;
  const src = big ? showing : poster || showing;
  const under = src === showing ? null : showing || row?.metadata?.placeholder || null;
  return { key: String(id), src, under, label: (row && (label?.(row) || row.kind)) || '' };
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

// The picture's size on screen at scale `s`, its name included — what must
// fit beside the pointer.
function sizeOf(d, s) {
  return { width: d.layout.width * s, height: d.layout.height * s + (d.kind === 'files' && d.what.count === 1 ? LABEL_ROOM : 0) };
}

// Pinned at the corner nearest the pointer (the one it hangs and sways
// from): translate there, turn, and translate back before scaling, with
// transform-origin at the top left.
function transformOf(d) {
  const s = d.s.p;
  const px = d.flipX ? d.layout.width * s : 0;
  const py = d.flipY ? d.layout.height * s : 0;
  const f = (n) => (Math.round(n * 100) / 100);
  return `translate3d(${f(d.x.p + px)}px,${f(d.y.p + py)}px,0) rotate(${f(d.r.p)}deg) translate(${f(-px)}px,${f(-py)}px) scale(${Math.round(s * 10000) / 10000})`;
}

// ── Listening ───────────────────────────────────────────────────────────────

const EVENTS = [
  ['dragenter', onOver], ['dragover', onOver], ['dragleave', onLeave], ['drop', onDropSeen], ['dragend', onEnd],
  ['pointermove', onStray], ['mousemove', onStray], ['pointerdown', onStray], ['mousedown', onStray], ['keydown', onStray],
];

function listen(d, on) {
  for (const [type, fn] of EVENTS) {
    if (on) window.addEventListener(type, fn, true);
    else window.removeEventListener(type, fn, true);
  }
  // The item's own dragend reaches it even once a folder has sprung open and
  // taken it off the page, where the window no longer hears it.
  if (on) d.source.addEventListener('dragend', onEnd);
  else d.source.removeEventListener('dragend', onEnd);
  // The frames stop while nothing moves, so a pointer that has gone quiet
  // (out of the window) is noticed by a slower clock.
  clearInterval(d.quiet);
  if (on) d.quiet = setInterval(() => { if (!d.hidden && performance.now() - d.seenAt > QUIET_MS) kick(); }, 500);
}

function onOver(e) {
  const d = drag;
  if (!d || d.ended) return;
  // A drag event with no position at all (Firefox's `drag`, never these — but cheap to be sure).
  if (!e.clientX && !e.clientY && !e.screenX && !e.screenY) return;
  d.pointer.x = e.clientX;
  d.pointer.y = e.clientY;
  d.seenAt = performance.now();
  d.outside = false;
  if (e.target !== d.overNode || d.stale) {
    d.overNode = e.target;
    d.stale = false;
    findLane(d, e.target);
    aim(d, e.target instanceof Element ? e.target.closest('[data-drop-target]') : null);
  }
  kick();
}

// The column of folders the pointer is in (the sidebar: data-drop-lane),
// which the thumbnail hangs beside rather than over (hangAt) — measured as
// the pointer comes into it, not at every node it crosses there.
function findLane(d, node) {
  const el = node instanceof Element ? node.closest('[data-drop-lane]') : null;
  if (el === d.laneEl) return;
  d.laneEl = el;
  const r = el?.getBoundingClientRect();
  d.lane = r && r.width ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
}

// Out of the window: nothing is entered, and the pointer is at or past an
// edge (WebKit never says what was entered, so the edge decides).
function onLeave(e) {
  const d = drag;
  if (!d || d.ended || e.relatedTarget) return;
  const { clientX: x, clientY: y } = e;
  if (x > 0 && y > 0 && x < window.innerWidth - 1 && y < window.innerHeight - 1) return;
  d.outside = true;
  d.overNode = null;
  findLane(d, null);
  aim(d, null);
  kick();
}

function onDropSeen(e) {
  const d = drag;
  if (!d || d.ended) return;
  if (e.clientX || e.clientY) { d.pointer.x = e.clientX; d.pointer.y = e.clientY; }
  const el = e.target instanceof Element ? e.target.closest('[data-drop-target]') : null;
  if (el !== d.target?.el) aim(d, el);
  const t = d.target;
  d.dropped = t && t.verdict === 'ok' ? { path: t.path, pane: t.pane } : null;
  // The drop's own handlers (FolderDrop's, the page's) run after this, on
  // the way back up, and ask dropVerdict()/paneDrop(): they are answered
  // until they have.
  dropping = d;
  setTimeout(() => { if (dropping === d) dropping = null; }, 0);
  end(d, d.dropped ? 'land' : 'return');
}

function onEnd() {
  if (drag && !drag.ended) end(drag, 'return');
}

// A pointer or key event: none reach a page during a drag, so one that does
// means the drag is over, its end unheard.
function onStray(e) {
  const d = drag;
  if (!d || d.ended) return;
  const now = performance.now();
  if (now - d.startedAt < STRAY_GRACE_MS || now - d.seenAt < STRAY_QUIET_MS) return;
  if ((e.type === 'pointermove' || e.type === 'mousemove') && e.buttons) return;
  if (e.type === 'keydown' && ['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) return;
  end(d, 'return');
}

// ── What the pointer is over ───────────────────────────────────────────────

// Point at a drop target (or at nothing): mark it, say on the picture whether
// it can go there, and, for a folder that may open, start the clock.
function aim(d, el) {
  // The page as a whole takes a drop into a folder sprung open — but not
  // from the sidebar, where anything but a folder is nowhere in particular.
  if (el?.hasAttribute('data-drop-pane') && d.lane) el = null;
  if (d.target && d.target.el === el) return;
  unaim(d);
  if (!el || !host) { setVerdict(d, 'none'); return; }
  const t = {
    el,
    path: el.getAttribute('data-drop-target') || '',
    pane: el.hasAttribute('data-drop-pane'),
    spring: el.hasAttribute('data-drop-spring'),
    writable: !el.hasAttribute('data-drop-readonly'),
    sprung: d.hops > 0,
  };
  t.verdict = classifyDrop(d.what, t);
  d.target = t;
  if (t.verdict === 'ok') el.setAttribute('data-drop', 'ok');
  else if (isRefused(t.verdict)) el.setAttribute('data-drop', 'no');
  setVerdict(d, t.verdict);
  if (!springsOpen(t.verdict, t, host.current.folder)) return;
  d.warn = setTimeout(() => {
    if (d.target !== t || d.ended) return;
    t.el.setAttribute('data-spring', 'armed');
    host?.current.onPrefetch?.(t.path);
  }, SPRING_WARN_MS);
  d.spring = setTimeout(() => springOpen(d, t), SPRING_MS);
}

function unaim(d) {
  clearTimeout(d.warn);
  clearTimeout(d.spring);
  const el = d.target?.el;
  if (el) {
    el.removeAttribute('data-drop');
    el.removeAttribute('data-spring');
  }
  d.target = null;
}

function setVerdict(d, v) {
  const root = d.root;
  if (!root) return;
  const shownAs = v === 'ok' ? 'ok' : isRefused(v) ? 'no' : null;
  if (shownAs) root.setAttribute('data-verdict', shownAs);
  else root.removeAttribute('data-verdict');
}

// Held long enough: open the folder. The first opens a step in history, the
// next replace it, and opening the one the drag began in steps back — so a
// drag that goes nowhere leaves history as it found it.
function springOpen(d, t) {
  if (drag !== d || d.ended || d.target !== t || !host) return;
  const h = host.current;
  if (t.path === h.folder) return;
  if (t.path === d.origin && d.hops > 0) {
    h.onBack?.();
    d.hops = 0;
  } else {
    h.onSpring?.(t.path, { replace: d.hops > 0 });
    d.hops += 1;
  }
  // What is under the pointer changes with the folder: look again.
  unaim(d);
  d.stale = true;
}

/** The folder on screen changed (a folder sprang open): what is under the pointer is looked at again. */
function refresh() {
  const d = drag;
  if (!d || d.ended) return;
  unaim(d);
  d.stale = true;
}

// ── The end ─────────────────────────────────────────────────────────────────

function end(d, how) {
  if (d.ended) return;
  d.ended = true;
  listen(d, false);
  const t = d.target;
  unaim(d);
  // Let go of nowhere, or cancelled: folders it opened close again.
  if (how === 'return' && d.hops > 0) host?.current.onBack?.();
  if (how === 'land' && t?.el?.isConnected) {
    const el = t.el;
    el.setAttribute('data-drop-land', '');
    setTimeout(() => el.removeAttribute('data-drop-land'), 450);
    // Into the folder's picture when it has one, else the middle of the target.
    const aimAt = t.pane ? null : (el.querySelector('.folder-glyph') || el);
    const r = aimAt?.getBoundingClientRect();
    d.landAt = r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { ...d.pointer };
  } else if (how === 'land') {
    d.landAt = { ...d.pointer };
  }
  d.phase = how;
  d.phaseAt = performance.now();
  d.last = d.phaseAt;
  const root = d.root;
  if (root) {
    root.setAttribute('data-phase', how);
    root.removeAttribute('data-hidden');
    if (how === 'return') root.removeAttribute('data-verdict');
  }
  if (d.reduced || !root) { done(d); return; }
  kick();
}

// Where the item is now — found again if the page has drawn it anew (a
// folder sprang open, and closed as the drag ended) — as the picture's
// top-left corner and scale; null when it is no longer on the page.
function homeOf(d) {
  let el = d.source.isConnected ? d.source : document.querySelector(d.home);
  if (el && d.kind === 'files') el = el.querySelector('.filecard-thumb') || el;
  const r = el?.getBoundingClientRect();
  if (!r || !r.height) return null;
  return { x: r.left, y: r.top, s: Math.min(1, r.height / d.layout.height) };
}

function done(d) {
  if (drag === d) drag = null;
  if (frameId) { cancelAnimationFrame(frameId); frameId = 0; }
  const marks = d.marks;
  const undim = () => marks.forEach((x) => x.removeAttribute('data-drag-source'));
  if (d.phase === 'land') setTimeout(undim, UNDIM_AFTER_LAND_MS);
  else undim();
  if (shown?.id === d.id) publish(null);
}

// A new drag while the last picture is still flying: it goes at once.
function finishNow() {
  const d = drag;
  if (!d) return;
  if (!d.ended) end(d, 'return');
  done(d);
}

// ── Frames ─────────────────────────────────────────────────────────────────

function kick() {
  const d = drag;
  if (frameId || !d?.root) return;
  // Resting frames are skipped, not counted: time is measured from here.
  if (d.phase === 'drag') d.last = performance.now();
  frameId = requestAnimationFrame(frame);
}

function frame(now) {
  frameId = 0;
  const d = drag;
  if (!d || !d.root) return;
  const dt = Math.min(0.064, Math.max(0, (now - d.last) / 1000));
  d.last = now;
  const L = d.layout;
  let tx; let ty; let ts; let tr = 0;

  if (d.phase === 'drag') {
    const hidden = d.outside || now - d.seenAt > QUIET_MS;
    if (hidden !== d.hidden) {
      d.hidden = hidden;
      if (hidden) d.root.setAttribute('data-hidden', '');
      else { d.root.removeAttribute('data-hidden'); d.snap = true; }
    }
    ts = L.compact * (d.target?.verdict === 'ok' ? OVER_SCALE : 1);
    // Which side it hangs on is decided at the thumbnail's size, so shrinking
    // over a folder never flips it; where it goes, at the size it is heading for.
    const side = hangAt(d.pointer, sizeOf(d, L.compact), viewport(), { lane: d.lane });
    d.flipX = side.flipX;
    d.flipY = side.flipY;
    const size = sizeOf(d, ts);
    tx = side.flipX ? d.pointer.x - HANG.x - size.width : side.x;
    ty = side.flipY ? d.pointer.y - HANG.y - size.height : side.y;
    tr = swayFor(d.x.v, side.flipX);
    if (d.snap) { d.x.p = tx; d.y.p = ty; d.x.v = 0; d.y.v = 0; d.snap = false; }
  } else if (d.phase === 'land') {
    ts = L.compact * LAND_SCALE;
    tx = d.landAt.x - (L.width * ts) / 2;
    ty = d.landAt.y - (L.height * ts) / 2;
  } else {
    const home = homeOf(d);
    if (home) {
      ({ x: tx, y: ty, s: ts } = home);
      d.root.removeAttribute('data-gone');
    } else {
      // Not on the page to go back to: it fades where it is.
      tx = d.x.p; ty = d.y.p; ts = d.s.p;
      d.root.setAttribute('data-gone', '');
    }
  }

  if (d.reduced) {
    d.x.p = tx; d.y.p = ty; d.s.p = ts; d.r.p = 0;
  } else {
    stepSpring(d.x, tx, dt, SPRINGS.move);
    stepSpring(d.y, ty, dt, SPRINGS.move);
    stepSpring(d.s, ts, dt, SPRINGS.scale);
    stepSpring(d.r, tr, dt, SPRINGS.tilt);
  }
  const t = transformOf(d);
  if (t !== d.written) { d.root.style.transform = t; d.written = t; }
  // Its labels and the rest of the stack come in once it is nearly down to size.
  if (!d.compacted && d.phase === 'drag' && d.s.p <= L.compact * 1.15) {
    d.compacted = true;
    d.root.setAttribute('data-compact', '');
  }

  const still = atRest(d.x, tx) && atRest(d.y, ty) && atRest(d.s, ts, 0.004) && atRest(d.r, tr, 0.3);
  if (d.phase === 'drag') {
    // At rest under a still pointer: no frames until the next dragover.
    if (still && d.compacted) return;
  } else {
    const took = now - d.phaseAt;
    if (d.phase === 'land' ? took > LAND_MS : still || took > RETURN_MS) { done(d); return; }
  }
  frameId = requestAnimationFrame(frame);
}

// ── The layer ──────────────────────────────────────────────────────────────

/**
 * The layer, once per page (FilesClient). `folder` is the folder on screen;
 * `onSpring(path, { replace })` opens a folder held under a drag, `onBack()`
 * returns from the ones it opened, `onPrefetch(path)` fetches a folder's
 * listing ahead of it opening.
 */
export default function DragLayer({ folder, onSpring, onBack, onPrefetch }) {
  const live = useRef(null);
  live.current = { folder, onSpring, onBack, onPrefetch };
  const snap = useSyncExternalStore(store.subscribe, store.get, nothing);
  const ref = useRef(null);

  useEffect(() => {
    host = live;
    blankImage();
    return () => {
      if (host !== live) return;
      host = null;
      finishNow();
    };
  }, []);

  useEffect(() => { refresh(); }, [folder]);

  // Straight after the layer is drawn, before it is painted: the chip's own
  // width, and the frames begin.
  useLayoutEffect(() => {
    const d = drag;
    const root = ref.current;
    if (!snap || !root || !d || d.id !== snap.id) return;
    d.root = root;
    if (d.kind === 'folder') d.layout = { ...d.layout, width: root.offsetWidth };
    d.written = root.style.transform;
    if (d.target) setVerdict(d, d.target.verdict);
    kick();
  }, [snap]);

  if (!snap) return null;
  return createPortal(
    <div
      ref={ref}
      className="drag-preview"
      data-compact={snap.compact ? '' : undefined}
      aria-hidden
      style={{ '--k': snap.k, width: snap.width ?? undefined, height: snap.height, transform: snap.transform }}
    >
      {snap.kind === 'folder' ? (
        <div className="drag-preview-chip">
          <FolderGlyph size={snap.glyph} />
          <span className="drag-preview-chip-name">{snap.name}</span>
        </div>
      ) : (
        <>
          {snap.pictures.slice(1).map((p) => <Picture key={p.key} p={p} under />)}
          {snap.pictures[0] && <Picture p={snap.pictures[0]} />}
          {snap.name && <span className="drag-preview-name">{snap.name}</span>}
        </>
      )}
      {snap.count > 1 && <span className="drag-preview-count">{snap.count.toLocaleString()}</span>}
      <span className="drag-preview-ban"><Icon name="ban" size={16} strokeWidth={2.5} /></span>
    </div>,
    document.body,
  );
}

// The pictures are the ones the cards already show (signed URLs, or a
// placeholder's data URL), not something next/image could optimize.
/* eslint-disable @next/next/no-img-element */
function Picture({ p, under = false }) {
  const hide = (e) => { e.currentTarget.style.visibility = 'hidden'; };
  return (
    <div className={under ? 'drag-preview-pic is-under' : 'drag-preview-pic'}>
      {p.under && <img src={p.under} alt="" draggable={false} onError={hide} />}
      {p.src
        ? <img src={p.src} alt="" draggable={false} decoding="sync" onError={hide} />
        : !p.under && <span className="drag-preview-label">{p.label}</span>}
    </div>
  );
}
/* eslint-enable @next/next/no-img-element */
