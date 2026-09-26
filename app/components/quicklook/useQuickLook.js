'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseKey } from '@/lib/selection';
import { quickLookItems, stepIndex, preloadPlan, keepDecoded, preloadUrl } from '@/lib/quicklook';
import { markReady } from '@/lib/file-handoff';
import { effectiveKind } from '@/lib/media';

const PRELOAD_AFTER_MS = 200;
const PRELOAD_PARALLEL = 2;

function fastConnection() {
  try {
    const c = navigator.connection;
    if (!c) return true;
    return !c.saveData && (!c.effectiveType || c.effectiveType === '4g');
  } catch { return true; }
}

const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches;

/**
 * Quick Look's state for the files view: what it is showing, stepping, the
 * history entry that lets Back (Android's, the Mac app's swipe, ⌘[) close it,
 * and the pictures it loads ahead.
 *
 *   open(key)    from Space on an item, the menus, the phone bar's More.
 *                More than one item selected: those, in view order, and
 *                stepping leaves the selection alone. Otherwise every folder
 *                and file shown, and stepping moves the selection (Finder),
 *                so closing lands on the last item looked at.
 *   step(±1)     at the last loaded file with more to load, loads the next
 *                page first (`loadMore`).
 *   close()      and focus goes back to the item.
 *
 * `order` is the view's keys (folders then files); `find(key)` gives the row
 * (a file) or { folder } for one.
 */
export default function useQuickLook({ order, selectedKeys, find, more = false, loadMore, onStep, onClose }) {
  const [state, setState] = useState(null); // { keys (null: follow order), index, dir }
  const live = useRef(null);
  live.current = { order, selectedKeys, find, more, loadMore, onStep, onClose, state };
  const pushed = useRef(false);
  const ignorePop = useRef(false);

  const keysOf = (s) => (s ? s.keys || live.current.order : []);
  const currentKey = state ? keysOf(state)[state.index] || null : null;

  const open = useCallback((key) => {
    const L = live.current;
    if (!L.order.length) return;
    const items = quickLookItems({ order: L.order, selected: L.selectedKeys, start: key });
    const keys = items.follow ? null : items.keys;
    const index = items.follow ? Math.max(0, L.order.indexOf(key ?? L.order[items.index])) : items.index;
    try { performance.mark('onyx:ql:open', { detail: { key } }); } catch {}
    setState({ keys, index, dir: 1 });
    // One history entry, so Back closes Quick Look instead of leaving the
    // folder. Our keys are carried over (see FilesClient's navigate).
    if (!pushed.current) {
      try {
        const s = window.history.state || {};
        window.history.pushState({ onyxDepth: s.onyxDepth || 0, onyxFrom: s.onyxFrom ?? null, onyxQL: 1 }, '', window.location.href);
        pushed.current = true;
      } catch { pushed.current = false; }
    }
  }, []);

  const finish = useCallback((viaHistory) => {
    const L = live.current;
    const s = L.state;
    if (!s) return;
    const key = keysOf(s)[s.index] || null;
    try { performance.mark('onyx:ql:close', { detail: { key } }); } catch {}
    setState(null);
    if (pushed.current && !viaHistory) {
      ignorePop.current = true;
      pushed.current = false;
      window.history.back();
    }
    pushed.current = false;
    L.onClose?.(key);
  }, []);

  const close = useCallback(() => finish(false), [finish]);

  /**
   * Close to go somewhere else (Quick Look → a file's page, a folder): the
   * history entry is turned back into a plain one rather than gone back
   * through, which would race the navigation.
   */
  const dismiss = useCallback(() => {
    if (pushed.current) {
      try {
        const s = window.history.state || {};
        window.history.replaceState({ onyxDepth: s.onyxDepth || 0, onyxFrom: s.onyxFrom ?? null }, '', window.location.href);
      } catch {}
      pushed.current = false;
    }
    try { performance.mark('onyx:ql:close', { detail: {} }); } catch {}
    setState(null);
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (ignorePop.current) { ignorePop.current = false; return; }
      if (live.current.state) finish(true);
    };
    window.addEventListener('popstate', onPop);
    // A remount on an entry that still says Quick Look: it is not open now.
    try {
      const s = window.history.state;
      if (s && s.onyxQL) window.history.replaceState({ onyxDepth: s.onyxDepth || 0, onyxFrom: s.onyxFrom ?? null }, '', window.location.href);
    } catch {}
    return () => window.removeEventListener('popstate', onPop);
  }, [finish]);

  const step = useCallback(async (delta) => {
    const L = live.current;
    const s = L.state;
    if (!s) return;
    const keys = keysOf(s);
    const r = stepIndex(s.index, delta, keys.length, { more: !s.keys && L.more });
    let index = r.index;
    if (r.load && L.loadMore) {
      await L.loadMore();
      // Let the new rows render into `order`.
      await new Promise((res) => requestAnimationFrame(() => res()));
      const now = live.current;
      if (!now.state) return;
      if (now.order.length > keys.length) index = s.index + 1;
    }
    if (index === s.index) return;
    setState((cur) => (cur ? { ...cur, index, dir: delta < 0 ? -1 : 1 } : cur));
    const key = keysOf(s)[index] || live.current.order[index];
    if (key) L.onStep?.(key, { follow: !s.keys });
  }, []);

  // ── Loading ahead ────────────────────────────────────────────────────────
  // Once the current picture is sharp (or after a moment): the previews of
  // the next, the previous and the one after next in the direction of
  // travel, two at a time. Decoded pictures are held for the neighbours only
  // (a 2560px preview is ~17 MB decoded); the rest are let go.
  const held = useRef(new Map()); // url → { img, i }
  const [sharpAt, setSharpAt] = useState(null);
  const onSharp = useCallback((key) => setSharpAt(key), []);
  useEffect(() => {
    if (!state) {
      for (const { img } of held.current.values()) img.src = '';
      held.current.clear();
      return undefined;
    }
    const keys = keysOf(state);
    const index = state.index;
    const plan = preloadPlan(index, keys.length, state.dir);
    const phone = isPhone();
    const fast = fastConnection();
    const wanted = new Map();
    for (const i of plan) {
      const p = parseKey(keys[i]);
      if (p?.type !== 'file') continue;
      const f = live.current.find(keys[i]);
      if (!f || effectiveKind(f) !== 'image') continue;
      const url = preloadUrl(f, { distance: Math.abs(i - index), fast });
      if (url) wanted.set(url, i);
    }
    // Let go of what is no longer near.
    for (const [url, h] of held.current) {
      if (!wanted.has(url) && !keepDecoded(h.i, index, { phone })) {
        h.img.src = '';
        held.current.delete(url);
      }
    }
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      const queue = [...wanted].filter(([url]) => !held.current.has(url));
      let running = 0;
      const next = () => {
        if (cancelled) return;
        while (running < PRELOAD_PARALLEL && queue.length) {
          const [url, i] = queue.shift();
          const img = new Image();
          img.decoding = 'async';
          img.src = url;
          held.current.set(url, { img, i });
          running++;
          const done = () => { running--; next(); };
          (img.decode ? img.decode() : Promise.resolve()).then(() => { markReady(url); done(); }, done);
        }
      };
      next();
    };
    const key = keys[index];
    const t = setTimeout(start, sharpAt === key ? 0 : PRELOAD_AFTER_MS);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, sharpAt]);

  return {
    open, close, step, dismiss, onSharp,
    isOpen: !!state,
    currentKey,
    index: state ? state.index : 0,
    count: state ? keysOf(state).length : 0,
    follow: state ? !state.keys : false,
    // More to load past the end of what is stepped through.
    more: !!state && !state.keys && !!more,
  };
}
