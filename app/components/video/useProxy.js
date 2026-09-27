'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// While a job is waiting or transcoding, how often to look again. Slower than
// the transcript's five seconds: a transcode of a heavy master runs for many
// minutes, and a progress bar that moves every twenty seconds is honest.
const POLL_MS = 20000;
const PENDING = new Set(['queued', 'working']);

/**
 * A file's proxy rendition, kept current: { proxy, canRequest, canDelete }, and
 * the two things the web does to it — ask for one, forget it.
 *
 * The same shape as useTranscript, and the same arrangement: the transcode runs
 * on a Mac, so this page only asks and watches. Polling stops the moment the job
 * is done or failed — nothing but this page changes it then.
 *
 * `proxy.url` arrives with the finished job, so a page left open while a
 * transcode runs can switch to the rendition when it lands rather than needing a
 * reload.
 *
 * After a request the Mac app, when this page is inside it, is nudged to look at
 * its queue now rather than at its next poll (window.onyxMac).
 */
export default function useProxy(fileId, { enabled = true } = {}) {
  const [state, setState] = useState({ proxy: null, canRequest: false, canDelete: false, loaded: false, error: null });
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const url = `/api/files/${encodeURIComponent(fileId)}/proxy`;

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      // 404 is what the flag being off looks like, deliberately
      // (lib/proxies.js proxyDecision): not an error to show anyone.
      if (r.status === 404) { setState((s) => ({ ...s, loaded: true, error: null })); return; }
      if (!r.ok) throw new Error(body.error || `Could not read the proxy (HTTP ${r.status}).`);
      setState({ ...body, loaded: true, error: null });
    } catch (e) {
      setState((s) => ({ ...s, loaded: true, error: e.message || 'Could not read the proxy.' }));
    } finally {
      inflight.current = false;
    }
  }, [url]);

  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  const pending = PENDING.has(state.proxy?.status);
  useEffect(() => {
    if (!enabled || !pending) return undefined;
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, pending, load]);

  const send = useCallback(async (method) => {
    setBusy(true);
    try {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json' } });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Request failed (HTTP ${r.status}).`);
      return out;
    } finally {
      setBusy(false);
    }
  }, [url]);

  /** Ask for a proxy, or again — which is how a file whose bytes were replaced gets one of the new footage. */
  const request = useCallback(async () => {
    try {
      const out = await send('POST');
      setState({ ...out, loaded: true, error: null });
      try { window.onyxMac?.makeProxy?.(fileId); } catch { /* an older app, or none */ }
      return out;
    } catch (e) {
      setState((s) => ({ ...s, error: e.message }));
      return null;
    }
  }, [send, fileId]);

  const remove = useCallback(async () => {
    await send('DELETE');
    setState((s) => ({ ...s, proxy: { status: 'none' }, canDelete: false }));
  }, [send]);

  return { ...state, busy, request, remove, refresh: load };
}
