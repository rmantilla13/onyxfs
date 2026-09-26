'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { firstLayer, isReady, markReady } from '@/lib/file-handoff';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
// A blob download that is still going after this shows its progress.
const PROGRESS_AFTER_MS = 300;

function mark(quality, id) {
  try { performance.mark(`onyx:stage:${quality}`, { detail: { id: id ?? null } }); } catch { /* no User Timing */ }
}

/** Load and decode `src` off to the side; resolves once it can be painted without a partial frame. */
function decodeUrl(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  const done = img.decode
    // decode() rejects for some very large pictures on iOS even though they
    // load: fall back to the load event.
    ? img.decode().catch(() => (img.complete && img.naturalWidth ? undefined : new Promise((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('load'));
    })))
    : new Promise((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('load')); });
  return { img, done };
}

/** `src` as a blob, with progress (0..1, or null when unknown). No-store: it may feed the fill-in. */
async function fetchBlob(src, { signal, onProgress }) {
  const r = await fetch(src, { mode: 'cors', cache: 'no-store', signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !total) return r.blob();
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got / total);
  }
  return new Blob(chunks, { type: r.headers.get('content-type') || '' });
}

/**
 * A picture that is on screen at once and sharpens in place.
 *
 * `layers` are [{ src, quality }] from blurriest to sharpest — the thumbnail
 * a tile was already showing, the large preview, the original — and the
 * frame shows the sharpest one it can at every moment:
 *
 *   - It starts from the sharpest layer this document has already decoded
 *     (lib/file-handoff.js), else the first, as a plain <img>: usually from
 *     the memory cache, painted in the same frame.
 *   - Each next layer is loaded and decoded off to the side (new Image(),
 *     img.decode()), and only then put on top — with decoding="sync", so it
 *     swaps with no partial paint — and the one beneath is dropped a frame
 *     later. With motion allowed it fades in over 90 ms.
 *   - An original that is the sharp layer (a file with no preview) is fetched
 *     as a blob instead, with a progress bar once it takes a while, and the
 *     blob goes to `onBlob` — so a writer's browser can make the preview
 *     from it without a second download.
 *   - A layer that fails (a URL that expired while a tab sat open) is signed
 *     again through GET /api/files/[id] once; failing again, it is skipped.
 *
 * The frame is shaped by CSS alone (the stage's --ratio, container units), so
 * it is right in the server's HTML, before any script. `actual` shows it at
 * the picture's own size instead (the file page's 100%). `children` render
 * inside the frame, over the picture — the review overlay.
 *
 * For the harness: `data-quality` on the frame is what is showing, and each
 * layer shown marks `onyx:stage:<quality>`.
 */
export default function ProgressiveImage({
  layers: rawLayers, id, alt = '', actual = false, width, height, onDecoded, onBlob, onFailed, onSize, preloaded, className = '', children,
}) {
  const [overrides, setOverrides] = useState({});
  const layers = (rawLayers || [])
    .filter((l) => l && l.src)
    .map((l) => ({ ...l, src: overrides[l.quality] || l.src }));
  const sig = layers.map((l) => `${l.quality}\u0000${l.src}`).join('\u0001');
  // shown: the layer on top; below: the one beneath for a frame while a new
  // one comes up; skipped: layers that failed twice; fresh: `shown` arrived
  // by sharpening (not by mounting with it).
  const [state, setState] = useState(() => ({ sig, shown: firstLayer(layers), below: null, fresh: false, skipped: [] }));
  const [blobUrl, setBlobUrl] = useState(null);
  const [progress, setProgress] = useState(null);
  const refreshed = useRef(false);
  const live = useRef(null);
  live.current = { onDecoded, onBlob, onFailed, onSize, preloaded, id };

  // New layers (another file, or 100% adding the original): keep what is on
  // screen if it is still one of them, else start again from the sharpest
  // one ready.
  if (state.sig !== sig) {
    const cur = state.sig.split('\u0001')[state.shown];
    const keep = layers.findIndex((l) => `${l.quality}\u0000${l.src}` === cur);
    setState({ sig, shown: keep >= 0 ? keep : firstLayer(layers), below: null, fresh: false, skipped: [] });
  }

  const top = layers[state.shown] || null;
  const under = state.below != null ? layers[state.below] : null;

  // The layer beneath goes a frame after the new one is up.
  useIsoLayoutEffect(() => {
    if (state.below == null) return undefined;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => setState((s) => (s.below == null ? s : { ...s, below: null })));
    });
    return () => cancelAnimationFrame(raf);
  }, [state.below, state.shown]);

  // The next layer up (past any that failed), loaded and decoded before it
  // is shown.
  let next = state.shown + 1;
  while (next < layers.length && state.skipped.includes(next)) next++;
  useEffect(() => {
    const layer = layers[next];
    if (!layer) return undefined;
    let cancelled = false;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let slow = null;
    let objectUrl = null;
    const show = (src, cached = true) => {
      if (cancelled) return;
      if (cached) markReady(layer.src);
      if (src !== layer.src) markReady(src);
      setState((s) => (s.sig !== sig || s.shown >= next ? s : { ...s, shown: next, below: s.shown, fresh: true }));
    };
    const fail = async () => {
      if (cancelled) return;
      // Expired while the tab sat open? Signed again, once.
      if (!refreshed.current && id != null) {
        refreshed.current = true;
        try {
          const r = await fetch(`/api/files/${encodeURIComponent(id)}`, { cache: 'no-store' });
          const f = r.ok ? (await r.json()).file : null;
          const fresh = f && { thumb: f.thumbnailUrl, preview: f.posterUrl, original: f.url }[layer.quality];
          if (!cancelled && fresh && fresh !== layer.src) { setOverrides((o) => ({ ...o, [layer.quality]: fresh })); return; }
        } catch { /* skip the layer */ }
      }
      if (cancelled) return;
      // Skip it: the one after, if any, is tried from here.
      setState((s) => (s.sig !== sig ? s : { ...s, skipped: [...s.skipped, next] }));
      if (next === layers.length - 1) live.current.onFailed?.(layer.quality);
    };

    if (layer.quality === 'original' && live.current.onBlob) {
      slow = setTimeout(() => { if (!cancelled) setProgress(0); }, PROGRESS_AFTER_MS);
      const fetchIt = () => fetchBlob(layer.src, { signal: ctrl?.signal, onProgress: (p) => { if (!cancelled) setProgress((v) => (v == null ? v : p)); } });
      // Fetched ahead the same way by Quick Look (lib/original-preload.js)?
      const pre = live.current.preloaded?.(layer.src);
      (pre ? pre.catch(fetchIt) : fetchIt())
        .then(async (blob) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          const { done } = decodeUrl(objectUrl);
          await done;
          if (cancelled) return;
          const shownUrl = objectUrl;
          setBlobUrl(objectUrl);
          objectUrl = null;
          show(shownUrl, false); // not in the HTTP cache for an <img> elsewhere
          live.current.onBlob?.(blob);
        })
        // A refused fetch (a bucket with no CORS rule, say): shown as a plain image.
        .catch(() => (cancelled ? null : decodeUrl(layer.src).done.then(() => show(layer.src), fail)))
        .finally(() => { clearTimeout(slow); if (!cancelled) setProgress(null); });
    } else {
      decodeUrl(layer.src).done.then(() => show(layer.src), fail);
    }
    return () => {
      cancelled = true;
      clearTimeout(slow);
      ctrl?.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // One load per layer: `sig` names them all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, next]);

  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  // What is on screen, as the harness and the review overlay see it: each
  // quality once, when its picture is actually up — a layer that sharpened
  // in at once, the first one when it has loaded (or was ready already).
  const quality = top?.quality || null;
  const marked = useRef(new Set());
  const announce = (q) => {
    if (!q || marked.current.has(q)) return;
    marked.current.add(q);
    mark(q, live.current.id);
    live.current.onDecoded?.(q);
  };
  const topImg = useRef(null);
  useEffect(() => {
    if (!quality || !top) return;
    // A server-rendered picture may have loaded before React listened.
    const done = topImg.current?.complete && topImg.current.naturalWidth > 0;
    if (state.fresh || isReady(top.src) || done) announce(quality);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality, state.shown, state.fresh]);

  const srcOf = (l) => (l.quality === 'original' && blobUrl ? blobUrl : l.src);
  const style = actual && width > 0 && height > 0 ? { width, height } : undefined;
  return (
    <div className={`image-frame ${className}`.trim()} data-quality={quality || undefined} style={style}>
      {under && (
        <img key={`u:${under.quality}`} src={srcOf(under)} alt="" aria-hidden decoding="sync" draggable={false} />
      )}
      {top && (
        <img
          key={`t:${top.quality}`}
          ref={topImg}
          className={state.fresh ? 'is-new' : undefined}
          src={srcOf(top)}
          alt={alt}
          decoding={state.fresh || isReady(top.src) ? 'sync' : 'async'}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            markReady(img.currentSrc || top.src);
            announce(top.quality);
            if (img.naturalWidth) live.current.onSize?.(img.naturalWidth, img.naturalHeight, top.quality);
          }}
          onError={() => { if (state.shown === 0 && layers.length === 1) live.current.onFailed?.(top.quality); }}
        />
      )}
      {progress != null && (
        <div className="image-progress" role="progressbar" aria-label="Loading the full picture" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress || 0) * 100)}>
          <span style={{ width: `${Math.max(4, Math.round((progress || 0) * 100))}%` }} />
        </div>
      )}
      {children}
    </div>
  );
}
