// lib/thumbnail-worker.js — the worker lib/thumbnail-offthread.js starts, to
// draw an image's previews off the page's thread (lib/thumbnail-render.js).
//
//   { id, type: 'probe' }               → { id, caps }    what it can do here (workerCaps)
//   { id, type: 'image', blob, facts }  → { id, result }  makeThumbnail's result, media and all
//                                       or { id, error }  and the page draws the picture
//
// The page sends one message at a time and the next once it is answered.

import { renderImage, workerCaps } from './thumbnail-render.js';

self.onmessage = async ({ data }) => {
  const { id, type } = data || {};
  try {
    if (type === 'probe') self.postMessage({ id, caps: await workerCaps() });
    else if (type === 'image') self.postMessage({ id, result: await renderImage(data.blob, data.facts) });
    else self.postMessage({ id, error: `Nothing to do for ${type}.` });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
