import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { createDesktopAuthCode } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cookie-gated. The signed-in browser session authorizes a desktop device.
 *
 * POST { code_challenge, state, kind?, label? }
 *   kind 'pkce' (default) → mints a single-use auth code bound to the session
 *     email + PKCE challenge, returns { redirect: 'onyxfs://callback?...' }
 *     for the browser to hand back to the desktop app via the custom scheme.
 *   kind 'pairing'        → mints a short human-typable code, returns { code }.
 *
 * This route is excluded from the auth-redirect middleware (so it 401s cleanly),
 * but it self-guards with auth() — only a real browser session can mint a code,
 * which is what keeps the desktop bound to the existing NextAuth allowlist.
 */
export async function POST(req) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (!(await isEmailGrantedAccess(email))) {
    return NextResponse.json({ error: 'Access not approved' }, { status: 403 });
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const kind = body.kind === 'pairing' ? 'pairing' : 'pkce';
  const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null;

  if (kind === 'pairing') {
    const { code, expiresAt } = await createDesktopAuthCode({ email, kind: 'pairing', label: label || 'Manual pairing' });
    return NextResponse.json({ code, expiresAt });
  }

  const challenge = String(body.code_challenge || '').trim();
  if (!challenge) return NextResponse.json({ error: 'code_challenge required' }, { status: 400 });
  const { code } = await createDesktopAuthCode({ email, codeChallenge: challenge, kind: 'pkce', label });
  const state = String(body.state || '');
  const redirect = `onyxfs://callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  return NextResponse.json({ redirect });
}
