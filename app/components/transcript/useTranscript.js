'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// While a job is waiting or running, how often to look again.
const POLL_MS = 5000;
const PENDING = new Set(['queued', 'working']);

// A poll brings the segments again even when they have not changed (a
// re-run in progress keeps the last run's). Keep the array already held
// when it is the same run's, so the captions track and the search index
// built from it are not rebuilt every five seconds.
function keepSegments(prev, next) {
  const a = prev?.transcript;
  const b = next?.transcript;
  if (a && b && a.finishedAt === b.finishedAt && a.segments?.length === b.segments?.length) {
    return { ...next, transcript: { ...b, segments: a.segments } };
  }
  return next;
}

/**
 * A file's transcript, kept current: { transcript, canRequest, canDelete },
 * and the two things the web does to it — ask for one, remove it.
 *
 * Polling, as the review panel does (useReviewFeed): every five seconds
 * while the job is queued or working and the page is visible, and at once
 * when a hidden tab is shown again. A finished, failed or absent transcript
 * is not polled at all — nothing changes it but this page.
 *
 * After a request the Mac app, when this page is inside it, is nudged to
 * look at its queue now rather than at its next poll (window.onyxMac).
 */
export default function useTranscript(fileId, { enabled = true } = {}) {
  const [state, setState] = useState({ transcript: null, canRequest: false, canDelete: false, loaded: false, error: null });
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const url = `/api/files/${encodeURIComponent(fileId)}/transcript`;

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `Could not load the transcript (HTTP ${r.status}).`);
      setState((prev) => keepSegments(prev, { ...body, loaded: true, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, loaded: true, error: e.message || 'Could not load the transcript.' }));
    } finally {
      inflight.current = false;
    }
  }, [url]);

  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  const pending = PENDING.has(state.transcript?.status);
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

  const send = useCallback(async (method, body) => {
    setBusy(true);
    try {
      const r = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Request failed (HTTP ${r.status}).`);
      return out;
    } finally {
      setBusy(false);
    }
  }, [url]);

  /** Ask for a transcript (or again). `language` is a BCP-47 tag, or null for the Mac's own. */
  const request = useCallback(async (language = null) => {
    const out = await send('POST', { language: language || null });
    setState((prev) => keepSegments(prev, { ...out, loaded: true, error: null }));
    try { window.onyxMac?.transcribe?.(fileId); } catch { /* an older app, or none */ }
    return out;
  }, [send, fileId]);

  const remove = useCallback(async () => {
    await send('DELETE');
    setState((s) => ({ ...s, transcript: null, canDelete: false }));
  }, [send]);

  return { ...state, busy, request, remove, refresh: load };
}
