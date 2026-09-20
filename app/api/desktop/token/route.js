import { NextResponse } from 'next/server';
import { consumeDesktopAuthCode, createDesktopToken } from '@/lib/db';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PKCE S256: challenge = base64url(sha256(verifier)), no padding. Web Crypto
// (not node:crypto) so this matches the desktop client byte-for-byte.
async function pkceChallenge(verifier) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(verifier)));
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Cookie-less. Exchanges a single-use auth code for a long-lived bearer token.
 *
 * POST { grant_type, code, code_verifier?, label? }
 *   grant_type 'authorization_code' → requires code_verifier; verifies PKCE.
 *   grant_type 'pairing_code'       → code was already bound to an email in the
 *                                     browser, no verifier needed.
 *
 * Returns { token, email, expiresAt }. The raw token is shown exactly once;
 * only its sha256 is stored server-side.
 */
export async function POST(req) {
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const grant = String(body.grant_type || 'authorization_code');
  const code = String(body.code || '').trim();
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });

  // Single-use: consume atomically. A wrong PKCE verifier burns the code — fine,
  // a legitimate client always holds the matching verifier; this blocks replay.
  const row = await consumeDesktopAuthCode(code);
  if (!row) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 });

  if (grant === 'authorization_code') {
    if (row.kind !== 'pkce') return NextResponse.json({ error: 'Wrong grant type for this code' }, { status: 400 });
    const verifier = String(body.code_verifier || '');
    if (!verifier || (await pkceChallenge(verifier)) !== row.codeChallenge) {
      return NextResponse.json({ error: 'PKCE verification failed' }, { status: 400 });
    }
  } else if (grant === 'pairing_code') {
    if (row.kind !== 'pairing') return NextResponse.json({ error: 'Wrong grant type for this code' }, { status: 400 });
  } else {
    return NextResponse.json({ error: 'Unsupported grant_type' }, { status: 400 });
  }

  // Re-check the live allowlist at issue time (defence in depth).
  if (!(await isEmailGrantedAccess(row.email))) {
    return NextResponse.json({ error: 'Access not approved' }, { status: 403 });
  }

  const label = typeof body.label === 'string' ? body.label.slice(0, 80) : row.label;
  const { token, email, expiresAt } = await createDesktopToken({ email: row.email, label });
  return NextResponse.json({ token, email, expiresAt });
}
