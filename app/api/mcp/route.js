import { NextResponse } from 'next/server';
import { principalFromToken } from '@/lib/authz';
import { challengeHeader } from '@/lib/oauth';
import { bearerToken } from '@/lib/bearer-gate';
import { callRoute } from '@/lib/mcp/call';
import { handleBody } from '@/lib/mcp/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A big folder's move runs in steps (onyx_move_folder), each up to the
// rename route's own budget.
export const maxDuration = 300;

const MAX_BODY = 1024 * 1024;

const unauthorized = (origin, error) => new NextResponse(
  JSON.stringify({ error: error ? 'The token is not valid. Connect Onyx again.' : 'Connect Onyx to use it.' }),
  { status: 401, headers: { 'content-type': 'application/json', 'WWW-Authenticate': challengeHeader(origin, { error }) } },
);

const rpcError = (code, message, status = 400) =>
  NextResponse.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status });

/**
 * POST /api/mcp — Onyx as a remote MCP server (Streamable HTTP, stateless,
 * JSON responses), for Claude and other MCP clients. The bearer is a device
 * token from the OAuth flow (lib/oauth.js); every tool runs through Onyx's
 * own routes with it (lib/mcp/call.js), so it may do what the person may
 * and nothing more. Outside middleware's cookie gate: the token is the door.
 */
export async function POST(req) {
  const origin = req.nextUrl.origin;
  // The token alone says who this is. The routes the tools call take a
  // session cookie first, so a request carrying one — which Claude's never
  // does — is refused rather than let a cookie stand in for the token.
  if (/(?:^|;\s*)(?:__Secure-)?authjs\.session-token/.test(req.headers.get('cookie') || '')) {
    return rpcError(-32600, 'Send the bearer token without cookies.');
  }
  const raw = bearerToken(req.headers.get('authorization'));
  if (!raw) return unauthorized(origin, null);
  const who = await principalFromToken(req);
  if (!who) return unauthorized(origin, null);
  if (who.error) {
    if (who.error.status === 401) return unauthorized(origin, 'invalid_token');
    return who.error;
  }

  const text = await req.text().catch(() => '');
  if (text.length > MAX_BODY) return rpcError(-32600, 'The request is too large.', 413);
  let body;
  try { body = JSON.parse(text); } catch { return rpcError(-32700, 'Parse error'); }

  const ctx = {
    origin,
    email: who.email,
    call: (handler, opts) => callRoute(handler, { ...opts, token: raw, origin }),
  };
  const out = await handleBody(body, ctx);
  if (out === null) return new NextResponse(null, { status: 202 });
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
}

/** No server-initiated stream: this server only answers. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}

/** Nothing to end: there are no sessions. */
export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}
