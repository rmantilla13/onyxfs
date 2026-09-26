import { NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { createDesktopAuthCode, consumeDesktopAuthCode, getOrCreateAuthUser } from '@/lib/db';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { pkceChallenge } from '@/lib/pkce';
import {
  HANDOFF_COOKIE, HANDOFF_COOKIE_SECURE, HANDOFF_TTL_MS, WEB_SESSION_MAX_AGE,
  sessionCookieName, safeNext, authUsesHttps, handoffSecret,
} from '@/lib/web-handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sign the Mac app's web view in from its device token. lib/web-handoff.js
 * explains the four steps and why the secret travels as a cookie.
 *
 * POST (bearer) { challenge, next? } → { url }
 *   `challenge` is base64url(sha256(secret)); the secret stays in the app
 *   until it sets it as the handoff cookie in its web view. `url` is a PATH:
 *   the app resolves it against the server it is configured for, since this
 *   side cannot know which name it was reached by (a proxy, 127.0.0.1 or
 *   localhost), and a cookie set for one is not sent to another.
 *
 * GET ?code=&next=  (in the web view, with that cookie)
 *   → the session cookie, and a redirect to `next`. Anything wrong sends the
 *   web view to the sign-in page instead: it is a page load, not an API call.
 *   Redirects are relative, for the same reason.
 */

/** A redirect to a path on whatever host the browser used. */
function redirectTo(path) {
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

function clearHandoff(res) {
  res.cookies.set(HANDOFF_COOKIE_SECURE, '', { path: '/', maxAge: 0, secure: true });
  res.cookies.set(HANDOFF_COOKIE, '', { path: '/api/desktop/web-session', maxAge: 0 });
}
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
    // The session this becomes carries the token's id, and lib/session.js
    // ends it when the token is revoked.
    deviceTokenId: gate.tokenId,
  });
  const query = new URLSearchParams({ code, next: safeNext(body.next) });
  return NextResponse.json({ url: `/api/desktop/web-session?${query}`, expiresAt: Date.now() + HANDOFF_TTL_MS });
}

export async function GET(req) {
  const failed = (error) => {
    const res = redirectTo(`/signin?error=${error}`);
    clearHandoff(res);
    return res;
  };

  const secure = authUsesHttps({
    env: process.env,
    forwardedProto: req.headers.get('x-forwarded-proto'),
    protocol: req.nextUrl.protocol,
  });
  const code = req.nextUrl.searchParams.get('code') || '';
  const secret = handoffSecret(req.cookies, secure);
  // Checked before the code is spent, so a stray visit without the secret
  // (a link pasted into a browser) cannot burn the app's code.
  if (!code || !secret) return failed('Verification');

  const row = await consumeDesktopAuthCode(code);
  if (!row || row.kind !== 'web') return failed('Verification');
  if ((await pkceChallenge(secret)) !== row.codeChallenge) return failed('Verification');
  if (!(await isEmailGrantedAccess(row.email))) return failed('AccessDenied');

  const user = await getOrCreateAuthUser(row.email);
  if (!user) return failed('Configuration');

  const name = sessionCookieName(secure);
  // The same claims auth.config.js's jwt callback puts in a session made by
  // signing in, so nothing downstream can tell the two apart — plus the
  // device token it came from, so revoking that device signs this out too.
  const token = await encode({
    token: {
      sub: user.id, id: user.id, email: user.email, name: user.name || null,
      authAt: Date.now(), deviceTokenId: row.deviceTokenId || null,
    },
    secret: process.env.AUTH_SECRET,
    salt: name,
    maxAge: WEB_SESSION_MAX_AGE,
  });

  const res = redirectTo(safeNext(req.nextUrl.searchParams.get('next')));
  res.cookies.set(name, token, { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge: WEB_SESSION_MAX_AGE });
  clearHandoff(res);
  return res;
}
