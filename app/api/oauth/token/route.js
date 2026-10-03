import { NextResponse } from 'next/server';
import { consumeDesktopAuthCode, createDesktopToken } from '@/lib/db';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { pkceChallenge } from '@/lib/pkce';
import { ACCESS_TOKEN_TTL_S, SCOPE } from '@/lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fail = (error, description, status = 400) =>
  NextResponse.json({ error, error_description: description }, { status, headers: { 'Cache-Control': 'no-store' } });

/** The request's parameters, form-encoded (as OAuth sends them) or JSON. */
async function params(req) {
  const type = req.headers.get('content-type') || '';
  const text = await req.text().catch(() => '');
  if (text.length > 16 * 1024) return {};
  if (type.includes('application/json')) {
    try { return JSON.parse(text) || {}; } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * POST /api/oauth/token — a code from /oauth/authorize becomes an access
 * token: a device token labelled with the client's name, which the person
 * sees among their devices and can sign out. Single use; the code must come
 * back with the verifier of its challenge, from the client it was issued to,
 * for the address it was sent to.
 */
export async function POST(req) {
  const p = await params(req);
  if (p.grant_type !== 'authorization_code') return fail('unsupported_grant_type', 'Only authorization_code is supported.');
  const code = String(p.code || '');
  if (!code) return fail('invalid_request', 'code is required.');
  const row = await consumeDesktopAuthCode(code);
  if (!row || row.kind !== 'oauth') return fail('invalid_grant', 'The code is not valid, or was used already.');
  if (String(p.client_id || '') !== row.clientId) return fail('invalid_grant', 'The code was issued to another client.');
  if (p.redirect_uri && p.redirect_uri !== row.redirectUri) return fail('invalid_grant', 'redirect_uri does not match.');
  const verifier = String(p.code_verifier || '');
  if (!verifier || (await pkceChallenge(verifier)) !== row.codeChallenge) return fail('invalid_grant', 'PKCE verification failed.');
  if (!(await isEmailGrantedAccess(row.email))) return fail('access_denied', 'This account no longer has access.', 403);
  const { token } = await createDesktopToken({ email: row.email, label: row.label || 'Claude', ttlMs: ACCESS_TOKEN_TTL_S * 1000 });
  return NextResponse.json(
    { access_token: token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, scope: SCOPE },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
