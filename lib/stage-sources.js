// lib/stage-sources.js — the pictures a viewer loads in turn.
//
// Split from lib/renditions.js, which the grid uses, so the file page (which
// needs only this) does not carry the grid's size arithmetic.

import { drawableKind } from './media.js';

const has = (file, size) => Array.isArray(file?.thumbSizes) && file.thumbSizes.includes(size);

/**
 * The layers a viewer (Quick Look, the file page, a share page) loads in
 * turn: a thumbnail it can show at once, then the large preview, then the
 * original — which an image is only shown at when there is no preview (or at
 * 100%). `probe` ({ heic, tiff }) lets an original a browser was seen to
 * decode be a layer. Any of the three may be null.
 */
export function stageSources(file, { probe } = {}) {
  const kind = drawableKind(file, { probe });
  const thumb = file?.thumbnailUrl || (has(file, 'sm') ? file?.smUrl : null) || null;
  const preview = file?.posterUrl || null;
  const original = kind === 'image' ? file?.url || null : null;
  return { thumb, preview, original };
}
