'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A file's review, kept current: comments, decisions, the status, and the
 * mutations that change them.
 *
 * Polling, not realtime (the proposal's §4.7: the pooler rules out LISTEN,
 * and a function timeout rules out holding a stream per viewer). Every
 * `interval` while the page is visible and `enabled`, it asks for what
 * changed since its cursor; the answer is usually a 304 with no body. A tab in
 * the background asks nothing, and catches up the moment it is shown.
 *
 * What you post appears at once — inserted optimistically, then replaced by
 * the server's row. Rows are merged by `seq`, the server's change counter, so
 * a poll that raced a mutation can never put an older copy back.
 */
export default function useReviewFeed(fileId, { enabled = true, interval = 8000, me = null } = {}) {
  const [state, setState] = useState({
    comments: new Map(),
    decisions: new Map(),
    status: undefined,
    openComments: undefined,
    readSeq: null,
    loaded: false,
    error: null,
  });
  const cursor = useRef(0);
  const etag = useRef(null);
  const busy = useRef(false);

  const merge = useCallback((payload) => setState((prev) => {
    const comments = new Map(prev.comments);
    for (const c of payload.comments || []) {
      const old = comments.get(c.id);
      if (!old || (old.seq ?? 0) <= (c.seq ?? 0)) comments.set(c.id, c);
    }
    const decisions = new Map(prev.decisions);
    for (const d of payload.decisions || []) {
      const old = decisions.get(d.reviewer);
      if (!old || (old.seq ?? 0) <= (d.seq ?? 0)) decisions.set(d.reviewer, { ...old, ...d, name: d.name ?? old?.name ?? null });
    }
    return {
      comments,
      decisions,
      status: payload.status !== undefined ? payload.status : prev.status,
      openComments: payload.openComments !== undefined ? payload.openComments : prev.openComments,
      // How far this person had read before this visit: fixed at the first
      // load, so the dots stay on what was new when they arrived.
      readSeq: prev.readSeq ?? (payload.readSeq ?? null),
      loaded: true,
      error: null,
    };
  }), []);

  const poll = useCallback(async () => {
    if (busy.current || !fileId) return;
    busy.current = true;
    try {
      for (let page = 0; page < 20; page++) {
        const r = await fetch(`/api/files/${encodeURIComponent(fileId)}/review?after=${cursor.current}`, {
          cache: 'no-store',
          headers: etag.current ? { 'if-none-match': etag.current } : undefined,
        });
        if (r.status === 304) break;
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `Could not load comments (HTTP ${r.status}).`);
        etag.current = r.headers.get('etag');
        cursor.current = Math.max(cursor.current, Number(body.cursor) || 0);
        merge(body);
        if (!body.more) break;
      }
    } catch (e) {
      setState((s) => ({ ...s, loaded: true, error: e.message || 'Could not load comments.' }));
    } finally {
      busy.current = false;
    }
  }, [fileId, merge]);

  useEffect(() => {
    if (!enabled) return undefined;
    poll();
    const tick = () => { if (document.visibilityState === 'visible') poll(); };
    const timer = setInterval(tick, interval);
    const onShow = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [enabled, interval, poll]);

  // Every mutation answers with the row as stored and the file's status, and
  // is folded in exactly as a poll would be.
  const send = useCallback(async (url, method, body) => {
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `Request failed (HTTP ${r.status}).`);
    return out;
  }, []);

  const base = `/api/files/${encodeURIComponent(fileId)}`;

  const post = useCallback(async (input) => {
    const temp = {
      ...input,
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      pending: true,
      fileId,
      parentId: input.parentId || null,
      author: { email: me, name: null },
      anchor: input.anchor || 'general',
      mentions: input.mentions || [],
      resolvedAt: null,
      editedAt: null,
      deletedAt: null,
      createdAt: Date.now(),
      seq: Number.MAX_SAFE_INTEGER,
    };
    setState((s) => ({ ...s, comments: new Map(s.comments).set(temp.id, temp) }));
    try {
      const out = await send(`${base}/comments`, 'POST', input);
      setState((s) => {
        const comments = new Map(s.comments);
        comments.delete(temp.id);
        const old = comments.get(out.comment.id);
        if (!old || (old.seq ?? 0) <= out.comment.seq) comments.set(out.comment.id, out.comment);
        return { ...s, comments, status: out.status, openComments: out.openComments };
      });
      return out.comment;
    } catch (e) {
      setState((s) => {
        const comments = new Map(s.comments);
        comments.delete(temp.id);
        return { ...s, comments };
      });
      throw e;
    }
  }, [base, fileId, me, send]);

  const update = useCallback(async (id, patch) => {
    const out = await send(`${base}/comments/${encodeURIComponent(id)}`, 'PATCH', patch);
    merge({ comments: [out.comment], status: out.status, openComments: out.openComments });
    return out.comment;
  }, [base, merge, send]);

  const remove = useCallback(async (id) => {
    const out = await send(`${base}/comments/${encodeURIComponent(id)}`, 'DELETE');
    merge({ comments: [out.comment], status: out.status, openComments: out.openComments });
    return out.comment;
  }, [base, merge, send]);

  const decide = useCallback(async (status, note = null) => {
    const out = await send(`${base}/decision`, 'PUT', { status, note });
    merge({ decisions: out.decision ? [out.decision] : [], status: out.status, openComments: out.openComments });
    return out.decision;
  }, [base, merge, send]);

  return { ...state, post, update, remove, decide, refresh: poll };
}
