// lib/mcp/call.js — one of Onyx's own API routes, called in-process with the
// person's device token, as Onyx for Mac calls it over the network.
//
// Every tool goes through a route rather than lib/db.js: the route is where
// who may do what is decided (drive roles, the role's capabilities, feature
// flags, quotas), so Claude can do exactly what the person could on the web
// and nothing else — and a rule added to a route reaches Claude with it.

import { NextRequest } from 'next/server';

/**
 * Call `handler` (a route module's exported GET, POST, …) as `method` on
 * `path` with `query`, a JSON `body` and route `params`. Resolves
 * { ok, status, body } with the body parsed when it is JSON.
 */
export async function callRoute(handler, { method = 'GET', path, query = {}, body, params = {}, token, origin }) {
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { authorization: `Bearer ${token}`, origin };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new NextRequest(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handler(req, { params });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, body: parsed };
}

/** A route's refusal, as a sentence for the tool's result. */
export function refusalText(r) {
  const said = r?.body && typeof r.body === 'object' ? r.body.error || r.body.error_description : null;
  if (said) return String(said);
  if (r?.status === 404) return 'Not found, or not something this account can open.';
  if (r?.status === 403) return 'This account is not allowed to do that.';
  return `Onyx answered ${r?.status ?? 'nothing'}.`;
}
