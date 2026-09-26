// lib/review.js — the rules of review: who may do what, what a comment and a
// drawing may contain, and how a file's review status is derived.
//
// Pure, with no database and no framework, so the parts where a mistake is
// silent — an access rule, a coordinate that lands off the picture, a frame
// that reopens one early — are testable without either. The queries live in
// lib/db.js ("Review"), the route plumbing in lib/review-guard.js, and both
// defer to what is decided here.

import { toRate, frameAt, secondsOfFrame, timecode } from './video-time.js';

export const ANCHORS = ['general', 'frame', 'range', 'point'];
export const AUDIENCES = ['all', 'internal'];
export const DECISIONS = ['approved', 'changes_requested'];
export const BODY_MAX = 5000;
export const MENTIONS_MAX = 20;

// The drawing palette is six colours defined as CSS custom properties in
// app/components/review/review.css, so a shape stores an index into it rather
// than a colour: a brand change and dark mode both apply to old drawings.
export const ANNOTATION_COLORS = 6;
export const ANNOTATION_TOOLS = ['pen', 'arrow', 'rect'];
const MAX_SHAPES = 50;
const MAX_PEN_POINTS = 2000;
const MAX_POINTS = 10000;

export const STATUS_LABELS = {
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// Four decimals of a frame is a tenth of a pixel on an 8K picture: enough to
// draw with, and it keeps a pen stroke's JSON from carrying float noise.
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * May someone do `action` to a file's review? Returns { ok } or
 * { ok: false, status, error }.
 *
 *   flagOn     the `review` feature flag as this person has it — read on the
 *              server (lib/user-flags.js), never taken from the request
 *   canRead    they may see the file (canAccessFile: drives, visibility,
 *              grants); trashed files never get this far
 *   canModify  they may change the file (canModifyFile)
 *   isAuthor   the comment in question is theirs
 *
 * Reading, commenting, deciding and mentioning take only read access: a
 * reviewer who can see a cut can say what they think of it, which is the
 * point of the Viewer role. Editing a comment is its author's alone; deleting
 * or resolving one is also open to whoever may change the file, so a thread
 * can be tidied without its author.
 */
export function reviewDecision(action, { flagOn = false, canRead = false, canModify = false, isAuthor = false } = {}) {
  if (!flagOn) return { ok: false, status: 403, error: 'Review is turned off.' };
  if (!canRead) return { ok: false, status: 403, error: 'No access' };
  switch (action) {
    case 'read':
    case 'comment':
    case 'decide':
    case 'mention':
      return { ok: true };
    case 'edit':
      return isAuthor ? { ok: true } : { ok: false, status: 403, error: 'Only the person who wrote a comment can edit it.' };
    case 'delete':
    case 'resolve':
      return isAuthor || canModify
        ? { ok: true }
        : { ok: false, status: 403, error: 'Only its author, or someone who can change this file, can do that.' };
    default:
      return { ok: false, status: 400, error: 'Unknown review action.' };
  }
}

/**
 * A file's review status, from counts of what is on it:
 *
 *   changes_requested  any reviewer's current decision asks for changes
 *   approved           otherwise, at least one approval
 *   in_review          otherwise, any comment, or a review link to it
 *   null               nothing at all
 *
 * One request for changes outweighs any number of approvals on purpose: a
 * file is not approved while someone is still waiting on a change.
 */
export function deriveReviewStatus({ changes = 0, approved = 0, live = 0, links = 0 } = {}) {
  if (Number(changes) > 0) return 'changes_requested';
  if (Number(approved) > 0) return 'approved';
  if (Number(live) > 0 || Number(links) > 0) return 'in_review';
  return null;
}

/**
 * A drawing as a client sent it → { value } (null for no drawing) or
 * { error }.
 *
 *   { v: 1, srcW, srcH, shapes: [{ t: 'pen'|'arrow'|'rect', c, w, pts: [[x, y], …] }] }
 *
 * Points are fractions of the SOURCE frame, 0…1, so a drawing stays on the
 * thing it circles in fullscreen, after a resize and on letterboxed footage.
 * Anything outside the frame is refused rather than clamped: a point at 1.3
 * was not drawn on this picture. `w` is the stroke in thousandths of the
 * frame's width, so it scales with the picture too.
 */
export function validateAnnotation(input) {
  if (input == null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'That drawing is not in a form this can store.' };
  if (input.v !== 1) return { error: 'That drawing is from a version this does not read.' };
  const srcW = Number(input.srcW);
  const srcH = Number(input.srcH);
  if (!intIn(srcW, 1, 32768) || !intIn(srcH, 1, 32768)) return { error: 'The drawing does not say what size of picture it was made on.' };
  if (!Array.isArray(input.shapes)) return { error: 'That drawing has no shapes.' };
  if (!input.shapes.length) return { value: null };
  if (input.shapes.length > MAX_SHAPES) return { error: `A drawing can have up to ${MAX_SHAPES} shapes.` };

  let total = 0;
  const shapes = [];
  for (const s of input.shapes) {
    if (!s || typeof s !== 'object' || !ANNOTATION_TOOLS.includes(s.t)) return { error: 'Shapes are pen, arrow or rectangle.' };
    if (!intIn(s.c, 0, ANNOTATION_COLORS - 1)) return { error: 'That colour is not in the palette.' };
    const w = Number(s.w);
    if (!Number.isFinite(w) || w < 0.5 || w > 40) return { error: 'That stroke width is out of range.' };
    if (!Array.isArray(s.pts)) return { error: 'A shape needs points.' };
    const want = s.t === 'pen' ? [1, MAX_PEN_POINTS] : [2, 2];
    if (s.pts.length < want[0] || s.pts.length > want[1]) {
      return { error: s.t === 'pen' ? 'That stroke has too many points.' : 'Arrows and rectangles have two corners.' };
    }
    const pts = [];
    for (const p of s.pts) {
      if (!Array.isArray(p) || p.length !== 2) return { error: 'A point is an [x, y] pair.' };
      const [x, y] = p.map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return { error: 'Every point has to be on the picture.' };
      }
      pts.push([round4(x), round4(y)]);
    }
    total += pts.length;
    if (total > MAX_POINTS) return { error: 'That drawing is too detailed to store.' };
    shapes.push({ t: s.t, c: s.c, w: Math.round(w * 10) / 10, pts });
  }
  return { value: { v: 1, srcW, srcH, shapes } };
}

/** Up to MENTIONS_MAX distinct, lowercased addresses; anything else dropped. */
export function normalizeMentions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    const e = String(m || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254 || out.includes(e)) continue;
    out.push(e);
    if (out.length >= MENTIONS_MAX) break;
  }
  return out;
}

/**
 * A new comment or reply as a client sent it → { value } or { error }.
 *
 * `kind` is the file's (effectiveKind): frames and ranges are for video, a
 * pin is for an image. `rate` and `totalFrames` are the file's frame model,
 * when it has one, to refuse a frame past the end.
 *
 * A reply belongs to its thread: no anchor and no drawing of its own.
 */
export function validateComment(input, { kind = 'other', rate = null, totalFrames = Infinity, isReply = false } = {}) {
  const b = input && typeof input === 'object' ? input : {};
  const body = typeof b.body === 'string' ? b.body.replace(/\r\n?/g, '\n').trim() : '';
  if (body.length > BODY_MAX) return { error: `A comment can be up to ${BODY_MAX.toLocaleString('en-US')} characters.` };
  if (b.audience != null && !AUDIENCES.includes(b.audience)) return { error: 'A comment is for everyone or internal.' };
  const audience = b.audience || 'all';
  const mentions = normalizeMentions(b.mentions);
  const parentId = typeof b.parentId === 'string' && b.parentId.length <= 64 ? b.parentId : null;
  const none = { frameIn: null, frameOut: null, fps: null, pointX: null, pointY: null };

  if (isReply) {
    if (b.annotation != null) return { error: 'A reply cannot carry a drawing.' };
    if (!body) return { error: 'Write a reply.' };
    return { value: { body, anchor: 'general', ...none, annotation: null, audience, parentId, mentions } };
  }

  const drawn = validateAnnotation(b.annotation);
  if (drawn.error) return { error: drawn.error };
  const annotation = drawn.value;
  if (!body && !annotation) return { error: 'Write a comment or draw on the picture.' };

  const anchor = b.anchor == null ? 'general' : b.anchor;
  if (!ANCHORS.includes(anchor)) return { error: 'A comment is pinned to a frame, a range, a point or nothing.' };

  if (anchor === 'frame' || anchor === 'range') {
    if (kind !== 'video') return { error: 'Only a video has frames to pin a comment to.' };
    const fps = toRate(b.fps);
    if (!fps) return { error: 'A frame needs the frame rate it was counted at.' };
    // Numbers as sent, not coerced: Number(null) is frame 0.
    const frameIn = b.frameIn;
    const frameOut = anchor === 'range' ? b.frameOut : null;
    if (!intIn(frameIn, 0, 1e9)) return { error: 'That frame is not in the video.' };
    if (anchor === 'range' && (!intIn(frameOut, 0, 1e9) || frameOut <= frameIn)) {
      return { error: 'A range ends after it starts.' };
    }
    // Past the end, judged on the file's own rate: the client may have
    // counted at an assumed one.
    if (Number.isFinite(totalFrames) && rate) {
      const last = commentFrame(anchor === 'range' ? frameOut : frameIn, fps, rate);
      if (last > totalFrames) return { error: 'That frame is past the end of the video.' };
    }
    return { value: { body, anchor, frameIn, frameOut, fps, pointX: null, pointY: null, annotation, audience, parentId, mentions } };
  }

  // A drawing on a video is drawn on a frame; without one it would float
  // over whatever happened to be on screen.
  if (annotation && kind === 'video') return { error: 'A drawing on a video needs the frame it was drawn on.' };

  if (anchor === 'point') {
    if (kind !== 'image') return { error: 'Pins are for images.' };
    const x = typeof b.pointX === 'number' ? b.pointX : NaN;
    const y = typeof b.pointY === 'number' ? b.pointY : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      return { error: 'A pin has to be on the picture.' };
    }
    return { value: { body, anchor, ...none, pointX: round4(x), pointY: round4(y), annotation, audience, parentId, mentions } };
  }

  return { value: { body, anchor: 'general', ...none, annotation, audience, parentId, mentions } };
}

/** A decision as a client sent it → { value: { status, note } } or { error }. `status: null` withdraws. */
export function validateDecision(input) {
  const b = input && typeof input === 'object' ? input : {};
  if (b.status !== null && !DECISIONS.includes(b.status)) return { error: 'A decision is approved, changes requested, or none.' };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > 1000) return { error: 'A note can be up to 1,000 characters.' };
  return { value: { status: b.status, note: note || null } };
}

/**
 * A comment's frame on the file's rate. Frames are stored with the rate they
 * were counted at, because a comment made before the file was probed was
 * counted at the assumed 30fps; converting through time (the middle of the
 * stored frame) lands it on the frame that was on screen.
 */
export function commentFrame(frame, commentFps, fileFps) {
  if (frame == null || !Number.isFinite(Number(frame))) return null;
  const from = toRate(commentFps);
  const to = toRate(fileFps);
  if (!from || !to || (from.num === to.num && from.den === to.den)) return Number(frame);
  return frameAt(secondsOfFrame(frame, from), to);
}

/**
 * What a comment's anchor reads as in the list and the composer:
 * "01:00:12:04", "In 01:00:12:04 → Out 01:00:15:10", "Pin" or "General".
 * `model` is the file's { fps, tcStart, dropFrame }.
 */
export function anchorLabel(c, model = {}) {
  const tc = (f) => timecode(commentFrame(f, c.fps, model.fps), model);
  if (c?.anchor === 'frame' && c.frameIn != null) return tc(c.frameIn);
  if (c?.anchor === 'range' && c.frameIn != null && c.frameOut != null) return `In ${tc(c.frameIn)} → Out ${tc(c.frameOut)}`;
  if (c?.anchor === 'point') return 'Pin';
  return 'General';
}

/**
 * The rectangle a picture of srcW×srcH occupies inside a box of boxW×boxH
 * under `object-fit: contain`: { x, y, width, height } in the box's pixels.
 *
 * This is what keeps a drawing on the thing it circles. The <video> fills its
 * stage and letterboxes itself, so the stage's box is not the picture's; the
 * annotation layer is placed on this rectangle instead, and its points
 * (fractions of the source) are fractions of it.
 */
export function containRect(boxW, boxH, srcW, srcH) {
  const bw = Number(boxW) || 0;
  const bh = Number(boxH) || 0;
  const sw = Number(srcW) || 0;
  const sh = Number(srcH) || 0;
  if (bw <= 0 || bh <= 0 || sw <= 0 || sh <= 0) return { x: 0, y: 0, width: Math.max(0, bw), height: Math.max(0, bh) };
  const scale = Math.min(bw / sw, bh / sh);
  const width = sw * scale;
  const height = sh * scale;
  return { x: (bw - width) / 2, y: (bh - height) / 2, width, height };
}

/** A pointer at (clientX, clientY) over `rect` (a DOMRect of the picture) → [x, y] in 0…1, clamped. */
export function pointOnPicture(clientX, clientY, rect) {
  const w = rect?.width || 0;
  const h = rect?.height || 0;
  if (!w || !h) return [0, 0];
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return [round4(clamp((clientX - rect.left) / w)), round4(clamp((clientY - rect.top) / h))];
}

/** The first line of a comment, shortened for a notification or a marker's tooltip. */
export function snippet(body, max = 120) {
  const s = String(body || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The reviewer key a signed-in person's decision is stored under. */
export const userReviewer = (email) => `user:${String(email || '').trim().toLowerCase()}`;

/** Whether a file is something v1 review handles: a picture or a video. */
export function isReviewableKind(kind) {
  return kind === 'video' || kind === 'image';
}
