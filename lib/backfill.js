// lib/backfill.js — the thumbnail backfill, loaded when it is first needed.
//
// Most rows already have every preview they need, so the code that draws
// them (lib/thumbnail-client.js: decoding, canvases, encoders, uploads) is
// not part of the files page or the file page. The first tile that asks for
// something — a missing thumbnail, the siblings of an old one, a preview from
// an original a viewer just fetched — loads it; requests made meanwhile wait
// for it in order.

/**
 * `request(file, opts)` as createThumbnailBackfill returns, loading its code
 * on the first call — and, for `{ wave: true }`, a sound's waveform
 * (lib/waveform-client.js createWaveformBackfill), whose code loads apart:
 * a library of pictures never needs it, nor one of sounds the pictures'.
 */
export function lazyThumbnailBackfill(onReady) {
  const pictures = lazily(() => import('./thumbnail-client').then((m) => m.createThumbnailBackfill(onReady)));
  const sounds = lazily(() => import('./waveform-client').then((m) => m.createWaveformBackfill(onReady)));
  return (file, opts) => (opts?.wave ? sounds(file) : pictures(file, opts));
}

/** A request function made by `load` on the first call; calls made meanwhile wait for it, in order. */
function lazily(load) {
  let request = null;
  let loading = null;
  const waiting = [];
  return (...args) => {
    if (request) { request(...args); return; }
    waiting.push(args);
    loading ||= load().then((made) => {
      request = made;
      for (const a of waiting.splice(0)) request(...a);
    }, () => { loading = null; });
  };
}

/**
 * A backfilled row, folded into the one on screen: the new previews and
 * facts, keeping everything the listing already holds (its signed original
 * URL, tags, review state).
 */
export function mergeBackfilled(row, f) {
  if (!row || !f || row.id !== f.id) return row;
  const next = { ...row };
  for (const k of ['thumbnailUrl', 'thumbnailKey', 'smUrl', 'xsUrl', 'thumbSizes', 'posterUrl', 'posterKey', 'metadata', 'seq']) {
    if (f[k] !== undefined) next[k] = f[k];
  }
  return next;
}

