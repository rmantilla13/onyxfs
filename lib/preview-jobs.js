// lib/preview-jobs.js — which previews a file lacks, and the cheapest way to
// make them: for Admin → Previews and for a file's "Regenerate thumbnail".
//
// Pure. Its imports (lib/media.js, lib/poster.js, lib/folder-ops.js) reach
// neither the database nor the DOM, so the server, the browser and the tests
// share it. lib/db.js says the same rules again in SQL (PREVIEW_FILES and the
// predicates beside it), so the counts the admin page shows, the files its
// run is handed and what the browser then does all agree;
// test/previews-db.test.js holds the two to each other.

import { drawableKind, effectiveKind, isThumbKey, THUMB_SOURCE_MAX_BYTES } from './media.js';
import { thumbSiblingSizes, playerPosterFor } from './poster.js';
import { cleanFolder } from './folder-ops.js';

export const PREVIEW_KINDS = Object.freeze(['both', 'images', 'videos']);
export const PREVIEW_MODES = Object.freeze(['missing', 'everything']);

/**
 * What a browser can do with a file, from its type alone:
 *   'image', 'video'  every browser draws it
 *   'heic', 'tiff'    Safari does (lib/decode-probe.js); the others cannot
 *   'never'           a picture or a video no browser draws — RAW, a PSD, an
 *                     AVI: the Mac app makes its thumbnail, or nothing does
 *   null              not a picture or a video
 * A MOV is a 'video' though it may hold ProRes, which only Safari decodes:
 * nothing on the row says which codec is inside, so that shows only when a
 * browser tries.
 */
export function previewClass(file) {
  const kind = effectiveKind(file);
  if (kind !== 'image' && kind !== 'video') return null;
  const drawn = drawableKind(file);
  if (drawn) return drawn;
  if (drawableKind(file, { probe: { heic: true } })) return 'heic';
  if (drawableKind(file, { probe: { tiff: true } })) return 'tiff';
  return 'never';
}

/** The classes a browser draws, given what its decode probe found ({ heic, tiff }). */
export function drawnClasses(decodes = {}) {
  return ['image', 'video', ...(decodes?.heic ? ['heic'] : []), ...(decodes?.tiff ? ['tiff'] : [])];
}

/** The kinds (effectiveKind's words) a choice of 'images', 'videos' or 'both' covers. */
export function kindsFor(choice) {
  if (choice === 'images') return ['image'];
  if (choice === 'videos') return ['video'];
  return ['image', 'video'];
}

function recorded(md) {
  const width = Number(md?.width);
  const height = Number(md?.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Whether a thumbnail should have smaller siblings: when the picture's size
 * is not on record, or it is big enough for one (lib/poster.js
 * thumbSiblingSizes). A tile asks the same (FileCard, needsSizes).
 */
export function siblingsExpected(metadata) {
  const d = recorded(metadata);
  return !d || Object.keys(thumbSiblingSizes(d)).length > 0;
}

/** Whether a video should have a player poster: when its size is not on record, or it is big enough for one (playerPosterFor). */
export function posterExpected(metadata) {
  const d = recorded(metadata);
  return !d || !!playerPosterFor(d);
}

/**
 * What of its previews a file lacks — what "Missing only" looks for:
 *   thumbnail    none the server named (isThumbKey): none at all, or one of
 *                the old ones, which cannot have siblings or a placeholder
 *   sizes        its thumbnail's smaller siblings, where it should have them
 *   placeholder  the tiny copy its row carries (lib/placeholder.js)
 *   poster       a video's player poster, where it should have one
 * A file lacking its thumbnail lacks everything; only that is named.
 */
export function previewGaps(file) {
  if (!isThumbKey(file?.thumbnailKey)) return ['thumbnail'];
  const md = file.metadata || {};
  const out = [];
  if (!(Array.isArray(file.thumbSizes) && file.thumbSizes.length) && siblingsExpected(md)) out.push('sizes');
  if (!md.placeholder) out.push('placeholder');
  if (effectiveKind(file) === 'video' && !file.posterKey && posterExpected(md)) out.push('poster');
  return out;
}

const MAX_MB = Math.round(THUMB_SOURCE_MAX_BYTES / (1024 * 1024));

/**
 * Why this browser will not draw `file` from its original, in words for the
 * list at the end of a run — or null when it will. `decodes` is what its
 * decode probe found.
 */
export function cannotDraw(file, { decodes = {} } = {}) {
  const c = previewClass(file);
  if (c === 'heic' && !decodes?.heic) return 'This browser cannot decode HEIC. Safari can.';
  if (c === 'tiff' && !decodes?.tiff) return 'This browser cannot decode TIFF. Safari can.';
  if (c === 'never' || c === null) return 'No browser decodes this format. The Mac app makes these as it syncs a drive.';
  if (file?.storage !== 's3') return 'Not in the bucket, where previews are kept.';
  if (effectiveKind(file) === 'image' && Number(file.size) > THUMB_SOURCE_MAX_BYTES) {
    return `Over ${MAX_MB} MB: too large to decode in a browser tab. The server draws these on its own, a few minutes after they are added (JPEG, PNG, WebP, TIFF, AVIF and GIF up to 450 MB), and Onyx for Mac the rest of a drive it syncs.`;
  }
  return null;
}

/**
 * The cheapest job that makes what a file lacks — or, with mode
 * 'everything', all of its previews again:
 *   'redraw'       its original decoded and every preview drawn from it
 *                  (lib/thumbnail-client.js makeThumbnail): the only way to
 *                  a thumbnail, and to a video's poster, which has to be the
 *                  thumbnail's own frame
 *   'sizes'        sm and xs drawn from the thumbnail it has (~70 KB), and
 *                  its placeholder when it has none (makeSizes)
 *   'placeholder'  the placeholder alone, from its smallest picture
 *                  (makePlaceholder)
 *   null           nothing this browser can make (cannotDraw, skipReason)
 * The two small jobs read only the thumbnail, so any browser can do them
 * whatever the original is: a HEIC whose thumbnail the Mac app made gets
 * its placeholder from Chrome.
 */
export function previewJob(file, { mode = 'missing', decodes = {} } = {}) {
  const redraw = !cannotDraw(file, { decodes });
  if (mode === 'everything') return redraw ? 'redraw' : null;
  const gaps = previewGaps(file);
  if (!gaps.length) return null;
  // Without the thumbnail's address there is nothing for the small jobs to
  // draw from.
  const whole = gaps.includes('thumbnail') || gaps.includes('poster') || !file.thumbnailUrl;
  if (whole && redraw) return 'redraw';
  if (gaps.includes('thumbnail') || !file.thumbnailUrl) return null;
  if (gaps.includes('sizes')) return 'sizes';
  if (gaps.includes('placeholder')) return 'placeholder';
  return null;
}

/** Why previewJob gave a file no job, in words. */
export function skipReason(file, { mode = 'missing', decodes = {} } = {}) {
  if (mode !== 'everything' && !previewGaps(file).length) return 'Nothing missing any more: it was made meanwhile.';
  return cannotDraw(file, { decodes }) || 'Nothing this browser can make of it.';
}

const CHANGED = 'Its thumbnail changed while the run went on.';

/**
 * A small job's answer (makeSizes, makePlaceholder: { file }, { skip },
 * { stale } or nothing) as a run counts it: { outcome, row?, reason? }.
 */
export function jobOutcome(job, out) {
  if (out?.file) return { outcome: 'done', row: out.file };
  if (out?.skip && job === 'sizes') return { outcome: 'skipped', reason: 'No smaller sizes to make from its thumbnail.' };
  if (out?.skip && job === 'placeholder') return { outcome: 'skipped', reason: 'No placeholder could be drawn from its thumbnail.' };
  return { outcome: 'skipped', reason: CHANGED };
}

/**
 * What went wrong with a job, in words: the browser's own messages are
 * written for a console, these for whoever reads the list at the end.
 */
export function failureReason(error, file = {}) {
  const msg = String(error?.message || error || '').trim();
  const mov = /\.mov$/i.test(String(file?.name || '')) || /quicktime/i.test(String(file?.mime || ''));
  if (/failed to fetch|networkerror|load failed|network error/i.test(msg)) {
    return 'Could not download it: the connection failed, or the bucket’s CORS rule does not allow this site.';
  }
  const status = /^HTTP (\d{3})$/.exec(msg)?.[1];
  if (status === '403') return 'The bucket refused the download (HTTP 403).';
  if (status === '404') return 'Its original is not in the bucket (HTTP 404).';
  if (/cannot decode the video|no video track/i.test(msg)) {
    return mov ? 'This browser cannot decode this video — ProRes, say. Safari can.' : 'This browser cannot decode this video.';
  }
  if (/source image cannot be decoded|encodingerror|cannot decode/i.test(msg)) return 'This browser cannot decode this picture.';
  if (/timed out/i.test(msg)) return 'Decoding it took too long.';
  if (/every frame tried was blank/i.test(msg)) return 'Every frame tried was blank, so it keeps no thumbnail.';
  return msg || 'Something went wrong.';
}

/**
 * Whether "Regenerate thumbnail" may be offered for a file (to someone who
 * may edit it): in the bucket, and a picture or a video this browser draws
 * from its original. HEIC and TIFF are offered until the decode probe has
 * said (`decodes` null) — Safari draws them, and the redraw says so if this
 * browser cannot.
 */
export function redrawOffered(file, { decodes = null } = {}) {
  if (file?.storage !== 's3') return false;
  const c = previewClass(file);
  if (c === 'heic' || c === 'tiff') return !decodes || !!decodes[c];
  if (c !== 'image' && c !== 'video') return false;
  return !(c === 'image' && Number(file.size) > THUMB_SOURCE_MAX_BYTES);
}

const flag = (v) => v === true || v === '1' || v === 'true';

/**
 * A run's scope as the page sends it and the candidates route reads it —
 * from URLSearchParams or a plain object: { drive, folder, kinds, mode,
 * decodes }. Anything it does not recognise is the default (the whole
 * library, pictures and videos, missing only), never an error: a mistyped
 * scope should not turn into "redraw everything".
 */
export function readPreviewScope(input) {
  const get = (k) => (typeof input?.get === 'function' ? input.get(k) : input?.[k]);
  const kinds = get('kinds');
  const mode = get('mode');
  return {
    drive: String(get('drive') || '').trim() || null,
    folder: cleanFolder(get('folder')) || null,
    kinds: PREVIEW_KINDS.includes(kinds) ? kinds : 'both',
    mode: PREVIEW_MODES.includes(mode) ? mode : 'missing',
    decodes: { heic: flag(get('heic')), tiff: flag(get('tiff')) },
  };
}

/** The query string for a scope (readPreviewScope's inverse), with a page's `after` and `limit`. */
export function previewScopeQuery(scope = {}, { after = '', limit } = {}) {
  const q = new URLSearchParams();
  if (scope.drive) q.set('drive', scope.drive);
  if (scope.folder) q.set('folder', scope.folder);
  q.set('kinds', PREVIEW_KINDS.includes(scope.kinds) ? scope.kinds : 'both');
  q.set('mode', PREVIEW_MODES.includes(scope.mode) ? scope.mode : 'missing');
  if (scope.decodes?.heic) q.set('heic', '1');
  if (scope.decodes?.tiff) q.set('tiff', '1');
  if (after) q.set('after', after);
  if (limit) q.set('limit', String(limit));
  return q.toString();
}
