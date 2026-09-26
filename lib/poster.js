// lib/poster.js — how big a preview is drawn, and which frame of a video.
//
// Pure functions and constants, no imports. Shared by the generator
// (thumbnail-client.js, deciding what to draw), the grid (FileCard, deciding
// whether a stored thumbnail is one of the old small ones) and the tests.
//
// WHY THESE NUMBERS. Thumbnails used to be 480px on the long edge. The grid
// shows them `object-fit: cover` in a 4:3 card, so for anything wider than
// 4:3 it is the SHORT edge that has to fill the card: a 16:9 clip gave a
// 480x270 image to a card that is 190-340 CSS px wide — 285-510 device px
// tall on a 2x screen — and the same 480x270 was the <video> poster on a
// detail-page stage ~968 CSS px (1936 device px) wide. Both were upscaled, the
// player's four times over.

/**
 * The box a grid poster must cover: a 384x288 CSS-pixel card at 2x. The
 * widest a card gets is ~340 CSS px (two columns just under the 720px
 * breakpoint, globals.css); on desktop it is 180-280. Covering this box in
 * either orientation means `cover` never has to enlarge it on a 2x screen,
 * nor on a 3x phone, where cards are under 200 CSS px.
 */
export const GRID_POSTER_BOX = Object.freeze({ width: 768, height: 576 });
/** A panorama covering that box would be very long; it stops here. */
export const GRID_POSTER_MAX_EDGE = 2048;
/**
 * The player's poster (videos only — an image's detail view shows the
 * original). The stage is at most ~968 CSS px wide (1400px shell, less the
 * 360px inspector and gaps) and 70vh tall, so 1920 on the long edge is about
 * one image pixel per device pixel on a 2x screen.
 */
export const PLAYER_POSTER_MAX_EDGE = 1920;
/** Encoder settings. 0.78 WebP showed ringing once enlarged; at these sizes it is not enlarged, and 0.82 is still ~75KB for a 1024x576 aerial. */
export const WEBP_QUALITY = 0.82;
export const JPEG_QUALITY = 0.85;
/** The long edge every thumbnail was capped at before this module. */
export const LEGACY_THUMB_MAX = 480;

function dims(input) {
  const width = Number(input?.width);
  const height = Number(input?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function scaled(src, scale) {
  return {
    width: Math.max(1, Math.round(src.width * scale)),
    height: Math.max(1, Math.round(src.height * scale)),
  };
}

/**
 * The grid poster for a `width`x`height` source: the smallest size that covers
 * GRID_POSTER_BOX, so a 16:9 clip is 1024x576 and a 3:4 photo 768x1024. Never
 * larger than the source — enlarging only adds bytes. Null without usable
 * dimensions.
 */
export function gridPosterSize(source) {
  const s = dims(source);
  if (!s) return null;
  const cover = Math.max(GRID_POSTER_BOX.width / s.width, GRID_POSTER_BOX.height / s.height);
  return scaled(s, Math.min(1, cover, GRID_POSTER_MAX_EDGE / Math.max(s.width, s.height)));
}

/** The player poster for a source: PLAYER_POSTER_MAX_EDGE on the long edge, never enlarged. */
export function playerPosterSize(source) {
  const s = dims(source);
  if (!s) return null;
  return scaled(s, Math.min(1, PLAYER_POSTER_MAX_EDGE / Math.max(s.width, s.height)));
}

/**
 * The player poster worth making for a video source, or null when it would be
 * barely bigger than the grid poster — a 640x360 clip's grid poster is the
 * whole frame already — so a second, near-identical upload buys nothing and
 * the player shows the thumbnail instead. "Barely" is under 1.25x the width.
 */
export function playerPosterFor(source) {
  const player = playerPosterSize(source);
  const grid = gridPosterSize(source);
  if (!player || !grid) return null;
  return player.width >= grid.width * 1.25 ? player : null;
}

/**
 * Whether a stored thumbnail of `poster` dimensions (as the browser decoded
 * it) is materially smaller than what gridPosterSize makes for its `source`
 * today — which is how a thumbnail from before this module is recognised,
 * with no marker stored anywhere: every one of them is at most 480px long.
 *
 * Both edges have to fall short by more than 10%, so rounding, or a JPEG
 * fallback a pixel off, never triggers a remake. A source too small to do
 * better is never undersized, so a small image is not remade on every visit.
 * With no source dimensions on record (rows from before they were recorded),
 * only a thumbnail at or under the old cap is suspect; remaking it records
 * the dimensions, and the question is settled from then on.
 */
export function isUndersizedPoster(poster, source) {
  const p = dims(poster);
  if (!p) return false;
  const want = gridPosterSize(source);
  if (!want) return Math.max(p.width, p.height) <= LEGACY_THUMB_MAX;
  return p.width < want.width * 0.9 && p.height < want.height * 0.9;
}

/**
 * The sizes to draw through on the way from `from` down to `to`, ending with
 * `to`. Each step at most halves: a single canvas draw that shrinks by more
 * than 2x samples too few source pixels and aliases — fine detail shimmers
 * into moiré, most visibly in WebKit (the Mac app's web view) and Firefox. The
 * first step is drawn straight from the source, so the largest intermediate
 * is a quarter of its area, never a full-size copy — and never more than
 * MAX_INTERMEDIATE_EDGE on a side: iOS Safari refuses a canvas over ~16.7M
 * pixels, and a 100-megapixel photo's first halving is well past that. Such
 * a source takes one larger first step instead.
 */
export const MAX_INTERMEDIATE_EDGE = 4096;

export function downscalePlan(from, to) {
  const f = dims(from);
  const t = dims(to);
  if (!f || !t) return [];
  const steps = [];
  let w = f.width;
  let h = f.height;
  while (w / 2 > t.width && h / 2 > t.height) {
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
    if (Math.max(w, h) <= MAX_INTERMEDIATE_EDGE) steps.push({ width: w, height: h });
  }
  steps.push({ width: t.width, height: t.height });
  return steps;
}

/**
 * The moments of a clip worth trying as its poster, in order.
 *
 * A tenth of the way in (at least a second, at most halfway) as before — the
 * very first frame is so often black, a slate or a fade. Then a quarter and
 * halfway, for when that one is still dark: a long black leader, a slow fade
 * up, a title on black. Never past the middle, where a clip is still about
 * what it opened with. Unknown length: just past the start.
 */
export function posterTimes(duration) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return [0.1];
  // To the millisecond: finer than any frame, and 1.2 rather than 1.2000000000000002.
  const ms = (t) => Math.round(t * 1000) / 1000;
  const times = [ms(Math.min(Math.max(1, d * 0.1), d / 2))];
  for (const f of [0.25, 0.5]) {
    const t = ms(d * f);
    if (t > times[times.length - 1] + 0.25) times.push(t);
  }
  return times;
}

/**
 * Mean and standard deviation of luma (Rec. 601, 0-255) over RGBA pixels —
 * a frame drawn a few dozen pixels wide, which is plenty to tell black from
 * picture and cheap enough to do per candidate.
 */
export function frameStats(rgba) {
  const n = Math.floor((rgba?.length || 0) / 4);
  if (!n) return { mean: 0, spread: 0 };
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    sum += y;
    sq += y * y;
  }
  const mean = sum / n;
  return { mean, spread: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/**
 * Black, white or flat: a frame nobody would recognise the clip by. Dark is
 * not blank — a night shot has a low mean and plenty of spread.
 */
export function isBlankFrame(stats) {
  const mean = Number(stats?.mean);
  const spread = Number(stats?.spread);
  if (!Number.isFinite(mean) || !Number.isFinite(spread)) return false;
  return spread < 6 || mean < 12 || mean > 245;
}

/**
 * Which of the candidates' stats to use: the first that is not blank, or —
 * when every one is — the one with the most going on. Null for none.
 */
export function chooseFrame(statsList) {
  if (!Array.isArray(statsList) || !statsList.length) return null;
  const first = statsList.findIndex((s) => !isBlankFrame(s));
  if (first >= 0) return first;
  let best = 0;
  statsList.forEach((s, i) => { if (Number(s?.spread) > Number(statsList[best]?.spread)) best = i; });
  return best;
}
