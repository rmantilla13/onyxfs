'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

// What is in a folder, for its tile: the newest few pictures in it and
// beneath it (POST /api/files/previews, lib/file-listing.js folderPreviews).
//
// Asked only for tiles on screen, and in batches: every tile that comes into
// view within a moment of the others is one request, of at most BATCH
// folders. Kept per drive and folder for a while, so scrolling back, a
// re-render or a sync update never asks again; a drive whose files the page
// changes is let go (forgetFolderPreviews) and its tiles on screen ask again.

const BATCH = 24;
const WAIT_MS = 40;
const KEEP_MS = 5 * 60 * 1000;
// After a failed request: the icon for this long before asking again.
const RETRY_MS = 30 * 1000;

const cache = new Map(); // key → { tiles, at } | { pending: true }
const listeners = new Set();
let queue = [];
let timer = null;

const keyOf = (filespace, folder) => `${filespace || ''}\u0000${folder || ''}`;
const emit = () => { for (const l of listeners) l(); };

async function flush() {
  timer = null;
  const batch = queue.splice(0, BATCH);
  if (queue.length) timer = setTimeout(flush, WAIT_MS);
  if (!batch.length) return;
  let previews = null;
  try {
    const r = await fetch('/api/files/previews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: batch.map(({ filespace, folder }) => ({ filespace, folder })) }),
    });
    if (r.ok) previews = (await r.json()).previews;
  } catch {}
  const at = Date.now();
  batch.forEach(({ key }, i) => {
    // A failed request is nothing to show for a while, then asked again —
    // not at once, which every render after it would turn into a loop.
    if (Array.isArray(previews?.[i])) cache.set(key, { tiles: previews[i], at, keep: KEEP_MS });
    else cache.set(key, { tiles: [], at, keep: RETRY_MS });
  });
  emit();
}

function request(filespace, folder) {
  const key = keyOf(filespace, folder);
  const had = cache.get(key);
  if (had?.pending || (had && Date.now() - had.at < had.keep)) return;
  cache.set(key, { pending: true });
  queue.push({ key, filespace: filespace || '', folder: folder || '' });
  if (!timer) timer = setTimeout(flush, WAIT_MS);
}

/**
 * Let go of every preview in `filespace` ('' for All files), after the page
 * changed what is in it — an upload, a move, a removal: a picture added deep
 * down is in the preview of every folder above it. The tiles on screen ask
 * again at once; the others when they are next seen.
 */
export function forgetFolderPreviews(filespace) {
  const prefix = keyOf(filespace, '');
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix) && !cache.get(key)?.pending) cache.delete(key);
  }
  emit();
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

/**
 * The preview of `folder` in `filespace` ('' for All files and for a top):
 * an array of { id, name, xs, sm, grid, width, height, placeholder }, empty
 * when there is nothing to show, null until it is known. Asked for once the
 * element `ref` is on screen (or near it).
 */
export function useFolderPreview(filespace, folder, { enabled = true } = {}) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  const key = keyOf(filespace, folder);
  const entry = useSyncExternalStore(subscribe, () => cache.get(key), () => undefined);

  useEffect(() => {
    if (!enabled) return undefined;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return undefined; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, key]);

  useEffect(() => {
    if (enabled && seen) request(filespace, folder);
  }, [enabled, seen, filespace, folder, entry]);

  return { ref, tiles: entry && !entry.pending ? entry.tiles : null };
}
