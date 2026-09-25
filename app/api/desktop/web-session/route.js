import { NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { createDesktopAuthCode, consumeDesktopAuthCode, getOrCreateAuthUser } from '@/lib/db';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { pkceChallenge } from '@/lib/pkce';
import {
  HANDOFF_COOKIE, HANDOFF_TTL_MS, WEB_SESSION_MAX_AGE, sessionCookieName, safeNext, requestIsSecure,
} from '@/lib/web-handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sign the Mac app's web view in from its device token. lib/web-handoff.js
 * explains the four steps and why the secret travels as a cookie.
 *
 * POST (bearer) { challenge, next? } → { url }
 *   `challenge` is base64url(sha256(secret)); the secret stays in the app
 *   until it sets it as the `onyx_handoff` cookie in its web view.
 *
 * GET ?code=&next=  (in the web view, with that cookie)
 *   → the session cookie, and a redirect to `next`. Anything wrong sends the
 *   web view to the sign-in page instead: it is a page load, not an API call.
 */
export async function POST(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;

  let body = {};
  try { body = await req.json(); } catch {}
  const challenge = String(body.challenge || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return NextResponse.json({ error: 'challenge must be the base64url SHA-256 of a secret' }, { status: 400 });
  }

  const { code } = await createDesktopAuthCode({
    email: gate.email, codeChallenge: challenge, kind: 'web', label: 'web-session', ttlMs: HANDOFF_TTL_MS,
  });
  const url = new URL('/api/desktop/web-session', req.nextUrl.origin);
  url.searchParams.set('code', code);
  url.searchParams.set('next', safeNext(body.next));
  return NextResponse.json({ url: url.toString(), expiresAt: Date.now() + HANDOFF_TTL_MS });
}

export async function GET(req) {
  const origin = req.nextUrl.origin;
  const failed = (error) => {
    const res = NextResponse.redirect(new URL(`/signin?error=${error}`, origin));
    res.cookies.delete(HANDOFF_COOKIE);
    return res;
  };

  const code = req.nextUrl.searchParams.get('code') || '';
  const secret = req.cookies.get(HANDOFF_COOKIE)?.value || '';
  // Checked before the code is spent, so a stray visit without the secret
  // (a link pasted into a browser) cannot burn the app's code.
  if (!code || !secret) return failed('Verification');

  const row = await consumeDesktopAuthCode(code);
  if (!row || row.kind !== 'web') return failed('Verification');
  if ((await pkceChallenge(secret)) !== row.codeChallenge) return failed('Verification');
  if (!(await isEmailGrantedAccess(row.email))) return failed('AccessDenied');

  const user = await getOrCreateAuthUser(row.email);
  if (!user) return failed('Configuration');

  const secure = requestIsSecure({ protocol: req.nextUrl.protocol, forwardedProto: req.headers.get('x-forwarded-proto') });
  const name = sessionCookieName(secure);
  // The same claims auth.config.js's jwt callback puts in a session made by
  // signing in, so nothing downstream can tell the two apart.
  const token = await encode({
    token: { sub: user.id, id: user.id, email: user.email, name: user.name || null },
    secret: process.env.AUTH_SECRET,
    salt: name,
    maxAge: WEB_SESSION_MAX_AGE,
  });

  const res = NextResponse.redirect(new URL(safeNext(req.nextUrl.searchParams.get('next')), origin));
  res.cookies.set(name, token, { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge: WEB_SESSION_MAX_AGE });
  res.cookies.delete(HANDOFF_COOKIE);
  return res;
}
