// lib/drag-preview.js — the arithmetic of the picture a move drags.
//
// A move inside the library drags a picture of what is moving in a layer of
// the page's own (app/files/DragPreview.js) rather than the browser's drag
// image: it starts where the item is, at its size, and springs down to a
// thumbnail hanging beside the pointer, so the folders it could go into stay
// in view. Everything that decides how it looks and where it may land is
// here and pure — the sizes, where it hangs, the springs, the sway, which
// folder a drop may go into and which may spring open — so it is pinned by
// test/drag-preview.test.js; the layer only applies it.

import { isWithin, parentOf } from './folder-ops.js';

/** How long a folder is hovered with a move before it opens (Finder's spring-loaded folders)… */
export const SPRING_MS = 800;
/** …when it starts to blink, to say it is about to, and when its listing is fetched ahead. */
export const SPRING_WARN_MS = 420;

/** The thumbnail a picture shrinks to: this share of its longer side, within these bounds (CSS px). */
export const COMPACT = { share: 0.45, min: 96, max: 140 };
/** A folder shrinks to a chip this tall. */
export const CHIP_H = 40;
/** Over a folder it can go into, a little smaller again. */
export const OVER_SCALE = 0.82;
/** Going into a folder, it shrinks to this share of its thumbnail as it fades. */
export const LAND_SCALE = 0.18;
/** The thumbnail hangs this far right of and below the pointer, clear of what is under it… */
export const HANG = { x: 14, y: 16 };
/** …and keeps this far inside the window, hanging left or above near an edge. */
export const MARGIN = 8;
/** Room below a picture for its name, when working out whether it fits below the pointer. */
export const LABEL_ROOM = 30;

/**
 * The springs, per unit mass: stiffness pulls toward the target, damping
 * resists speed. Position is nearly critical (a gentle lag, no wobble);
 * scale overshoots a touch as it shrinks; the tilt is loose, so it sways.
 */
export const SPRINGS = {
  move: { stiffness: 520, damping: 38 },
  scale: { stiffness: 420, damping: 30 },
  tilt: { stiffness: 240, damping: 15 },
};

/** The tilt: a resting lean, and how far speed swings it (deg per px/s), at most. */
export const SWAY = { rest: 2, gain: 0.009, max: 7 };

// Longer steps than this are split: the integration stays stable however
// long a frame took (a busy main thread, a tab in the background).
const MAX_STEP = 1 / 120;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * The thumbnail a picture of `box` (its width and height on screen) shrinks
 * to: the same shape, its longer side COMPACT.share of the picture's, within
 * COMPACT.min and COMPACT.max. A picture already smaller than that — a list
 * row's — grows to the minimum. A very long or tall shape is held to 1:2, so
 * a strip of a panorama is still a picture.
 */
export function compactBox(box, c = COMPACT) {
  let w = positive(box?.width);
  let h = positive(box?.height);
  if (!w || !h) { w = 4; h = 3; }
  const aspect = clamp(w / h, 0.5, 2);
  const long = clamp(Math.max(w, h) * c.share, c.min, c.max);
  return aspect >= 1
    ? { width: long, height: long / aspect }
    : { width: long * aspect, height: long };
}

/**
 * How the layer lays the picture out, and the scales it is shown at.
 *
 * It is laid out at the larger of the item's size and the thumbnail's, so it
 * is only ever scaled down: a picture scaled up is soft. `k` is how many
 * times the thumbnail's size that is — labels are set k times their size,
 * so they read at their own once it has shrunk. `start` is the scale that
 * puts it over the item where the drag began, `compact` the thumbnail's.
 * Heights decide, so a folder's chip (a fixed height, a width of its own)
 * works the same way as a picture of the item's own shape.
 */
export function previewLayout(from, compact) {
  const fromH = positive(from?.height) || compact.height;
  const k = Math.max(1, fromH / compact.height);
  return {
    k,
    width: compact.width * k,
    height: compact.height * k,
    start: Math.min(1, fromH / (compact.height * k)),
    compact: 1 / k,
  };
}

/**
 * Where the thumbnail's top-left corner goes for a pointer at `p`: below and
 * to the right of it, clear of whatever the pointer is over — or to its
 * left, or above it, when that would run past the edge of the window
 * (`view`) and the other side has room. `size` is the thumbnail's size on
 * screen, its name included; the flips say which corner is nearest the
 * pointer, which is the one it sways from.
 *
 * `lane` is a tall, narrow column of drop targets the pointer is in — the
 * folder tree — as { left, top, right, bottom }. Hanging below the pointer
 * there would cover the very folders it is moving toward, so it hangs just
 * beside the column instead, level with the pointer, when the window has room.
 */
export function hangAt(p, size, view, { hang = HANG, margin = MARGIN, lane = null } = {}) {
  let x = p.x + hang.x;
  let y = p.y + hang.y;
  let flipX = false;
  let flipY = false;
  if (x + size.width > view.width - margin && p.x - hang.x - size.width >= margin) {
    x = p.x - hang.x - size.width;
    flipX = true;
  }
  if (y + size.height > view.height - margin && p.y - hang.y - size.height >= margin) {
    y = p.y - hang.y - size.height;
    flipY = true;
  }
  const tall = lane && lane.bottom - lane.top > lane.right - lane.left;
  if (tall && p.x >= lane.left && p.x <= lane.right && lane.right + hang.x + size.width <= view.width - margin) {
    x = lane.right + hang.x;
    flipX = false;
  }
  return { x, y, flipX, flipY };
}

/**
 * One spring, `s` = { p, v } (position and velocity), moved `dt` seconds
 * toward `target`, in place. Semi-implicit Euler in steps short enough to
 * stay stable at these stiffnesses.
 */
export function stepSpring(s, target, dt, { stiffness, damping }) {
  let left = clamp(dt, 0, 0.1);
  while (left > 1e-6) {
    const h = Math.min(left, MAX_STEP);
    s.v += (-stiffness * (s.p - target) - damping * s.v) * h;
    s.p += s.v * h;
    left -= h;
  }
  return s;
}

/** Whether a spring has come to rest at `target`, within `eps` (and `eps` × 10 a second). */
export function atRest(s, target, eps = 0.5) {
  return Math.abs(s.p - target) < eps && Math.abs(s.v) < eps * 10;
}

/**
 * The tilt to spring toward, in degrees: a resting lean away from the
 * pointer, and a swing with the thumbnail's own horizontal speed `vx`
 * (px/s) — it trails behind a quick move like a card held by one corner.
 * Mirrored when it hangs to the pointer's left.
 */
export function swayFor(vx, flipX = false, sway = SWAY) {
  const swing = clamp((Number(vx) || 0) * sway.gain, -sway.max, sway.max);
  return (flipX ? -sway.rest : sway.rest) + swing;
}

/**
 * What a drag is, for deciding where it may go, from the rows being moved:
 * the folders they are in (a Set; `null` for a row the page does not have)
 * and whether any of them may be moved at all — each row carries the
 * server's `can` (app/files/can-for.js); one without it counts as movable,
 * as the page's own permission let the drag begin.
 */
export function describeFiles(ids, rows) {
  const byId = new Map((rows || []).filter(Boolean).map((f) => [String(f.id), f]));
  const folders = new Set();
  let editable = false;
  for (const id of ids || []) {
    const f = byId.get(String(id));
    folders.add(f ? f.folder || '' : null);
    if (!f || !f.can || typeof f.can !== 'object' || f.can.edit) editable = true;
  }
  return { kind: 'files', count: (ids || []).length, folders, editable };
}

/**
 * Where a drop may go.
 *
 * `drag` is describeFiles() for files, or { kind: 'folder', path } for a
 * folder. `target` is { path, writable, pane, sprung }: a folder in the
 * tree, a crumb, a folder tile or row — or the page around them (`pane`),
 * which is somewhere to drop only in a folder a drag has sprung open (Finder:
 * drop in the window you drilled down to).
 *
 *   'ok'      it can go there
 *   'same'    it is there already
 *   'self'    a folder onto itself, or into a folder inside it
 *   'locked'  nothing dragged may be moved, or the folder may not be written
 *   'none'    not a place to drop
 */
export function classifyDrop(drag, target) {
  if (!drag || !target || typeof target.path !== 'string') return 'none';
  if (target.pane && !target.sprung) return 'none';
  const dest = target.path;
  if (drag.kind === 'folder') {
    if (typeof drag.path !== 'string' || !drag.path) return 'none';
    if (isWithin(dest, drag.path)) return 'self';
    if (target.writable === false) return 'locked';
    return parentOf(drag.path) === dest ? 'same' : 'ok';
  }
  if (target.writable === false || drag.editable === false) return 'locked';
  const from = drag.folders;
  if (from && from.size === 1 && from.has(dest)) return 'same';
  return 'ok';
}

/** Whether a verdict lets a drop happen. */
export const isDroppable = (verdict) => verdict === 'ok';
/** Whether a verdict is a refusal the thumbnail should show (as opposed to nowhere in particular). */
export const isRefused = (verdict) => verdict === 'same' || verdict === 'self' || verdict === 'locked';

/**
 * Whether hovering `target` should spring it open, given the verdict and the
 * folder the page is showing (`current`). A folder it could go into, or the
 * folder it came from (to reach that folder's other folders); never the
 * dragged folder itself or one inside it, a folder the page already shows,
 * one that may not be written, or a crumb or the page (`spring` false):
 * opening those takes away the very place being aimed at.
 */
export function springsOpen(verdict, target, current) {
  if (!target?.spring || target.pane) return false;
  if (verdict !== 'ok' && verdict !== 'same') return false;
  return typeof target.path === 'string' && target.path !== current;
}
