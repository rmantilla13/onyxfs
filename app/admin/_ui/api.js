'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Read a response as the server wrote it: JSON when it is JSON, the text
 * otherwise, null when empty.
 */
async function readBody(r) {
  const text = await r.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * fetch for the admin sections. Resolves to the body; rejects with an Error
 * carrying `status` and the server's `body`, so a caller can show both
 * (AdminState) or act on a code (a 409 that wants a confirm). `json` is
 * sent as the request body.
 */
export async function api(url, { json, ...opts } = {}) {
  const init = { cache: 'no-store', ...opts };
  if (json !== undefined) {
    init.headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    init.body = JSON.stringify(json);
  }
  let r;
  try {
    r = await fetch(url, init);
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check the connection and try again.'), { status: 0, body: null });
  }
  const body = await readBody(r);
  if (!r.ok) {
    const message = (body && typeof body === 'object' && body.error) || `The server answered ${r.status}.`;
    throw Object.assign(new Error(message), { status: r.status, body });
  }
  return body;
}

/**
 * Load one resource for a client section: { data, error, loading, reload }.
 * `accept` lists statuses whose body is still the answer — /api/health's 503
 * is a report, not a failure to report. Reloading keeps the last data on
 * screen until the new answer arrives.
 */
export function useAdminResource(url, { accept = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true, status: 0 });
  const acceptKey = accept.join(',');
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    let r;
    try {
      r = await fetch(url, { cache: 'no-store' });
    } catch {
      if (mine === seq.current) {
        setState({ data: null, loading: false, status: 0, error: { message: 'Could not reach the server. Check the connection and try again.', status: 0, body: null } });
      }
      return;
    }
    const body = await readBody(r);
    if (mine !== seq.current) return;
    const ok = r.ok || acceptKey.split(',').includes(String(r.status));
    setState(ok
      ? { data: body, error: null, loading: false, status: r.status }
      : {
        data: null,
        loading: false,
        status: r.status,
        error: { message: (body && typeof body === 'object' && body.error) || `The server answered ${r.status}.`, status: r.status, body },
      });
  }, [url, acceptKey]);
  useEffect(() => { reload(); }, [reload]);
  const setData = useCallback((data) => setState((s) => ({ ...s, data })), []);
  return { ...state, reload, setData };
}
