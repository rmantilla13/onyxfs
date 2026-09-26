'use client';

import { useEffect, useRef } from 'react';
import { isTouch } from './usePointerIntent';
import { markReady } from '@/lib/file-handoff';

const HOVER_MS = 120;
const DWELL_MS = 350;
const MAX_REMEMBERED = 20;

function saveData() {
  try { return !!navigator.connection?.saveData; } catch { return false; }
}

/**
 * Getting a file's page ready before it is asked for.
 *
 *   hover     a pointer resting 120 ms on a tile prefetches the route's
 *             shell (`kind: 'auto'`): cheap, layouts only.
 *   dwell     one file selected for 350 ms with a mouse or pen (arrow-key
 *             repeat never rests that long) prefetches the whole page, and
 *             loads and decodes its large preview, so Space and Return are
 *             sharp at once.
 *
 * Next skips router.prefetch in development, so only the preview warming
 * shows there. Nothing on a connection that asks to save data; each file
 * once (the last 20 remembered).
 */
export default function useOpenPrefetch({ rootRef, router, selectedId, find }) {
  const done = useRef(new Map()); // id → 'auto' | 'full'
  const warm = useRef(null);
  const live = useRef(null);
  live.current = { router, find };

  const remember = (id, kind) => {
    done.current.delete(id);
    done.current.set(id, kind);
    while (done.current.size > MAX_REMEMBERED) done.current.delete(done.current.keys().next().value);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let timer = null;
    let over = null;
    const onOver = (e) => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      const id = e.target?.closest?.('.files-pane [data-file-id]')?.getAttribute('data-file-id') || null;
      if (id === over) return;
      over = id;
      clearTimeout(timer);
      if (!id || done.current.has(id) || saveData()) return;
      timer = setTimeout(() => {
        try { live.current.router.prefetch(`/files/${id}`, { kind: 'auto' }); } catch {}
        remember(id, 'auto');
      }, HOVER_MS);
    };
    root.addEventListener('pointerover', onOver, { passive: true });
    return () => { clearTimeout(timer); root.removeEventListener('pointerover', onOver); };
  }, [rootRef]);

  useEffect(() => {
    if (!selectedId || saveData()) return undefined;
    const t = setTimeout(() => {
      if (isTouch()) return;
      const id = String(selectedId);
      if (done.current.get(id) !== 'full') {
        try { live.current.router.prefetch(`/files/${id}`); } catch {}
        remember(id, 'full');
      }
      const f = live.current.find?.(id);
      const url = f?.posterUrl;
      if (url && warm.current?.src !== url) {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        (img.decode ? img.decode() : Promise.resolve()).then(() => markReady(url), () => {});
        // Held until the next one, so it stays decoded.
        warm.current = img;
      }
    }, DWELL_MS);
    return () => clearTimeout(t);
  }, [selectedId]);
}
