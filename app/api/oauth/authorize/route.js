import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { createDesktopAuthCode, getOAuthClient, markOAuthClientAllowed } from '@/lib/db';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { checkAuthorize, withQuery } from '@/lib/oauth';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/oauth/authorize { clientId, redirectUri, state, challenge, allow }
 *   → { redirect }
 *
 * The consent page's answer (app/oauth/authorize). Signed in by the session
 * alone, and only from this site's own page (Origin). What it was sent is
 * checked again against the client's registration — the page's word is not
 * taken — then a single-use code bound to the client, its redirect address
 * and its PKCE challenge is minted, or the client is told no.
 */
export async function POST(req) {
  if (req.headers.get('origin') !== req.nextUrl.origin) {
    return NextResponse.json({ error: 'Allow it from Onyx’s own page.' }, { status: 403 });
  }
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const read = await readJsonBody(req, { max: 8 * 1024 });
  if (read.error) return NextResponse.json({ error: read.error }, { status: read.status });
  const b = read.body || {};
  const client = await getOAuthClient(String(b.clientId || ''));
  const checked = checkAuthorize({
    client_id: b.clientId, redirect_uri: b.redirectUri, state: b.state,
    response_type: 'code', code_challenge: b.challenge, code_challenge_method: 'S256',
  }, client);
  if (checked.error) return NextResponse.json({ error: checked.description || checked.error }, { status: 400 });
  const { value } = checked;
  if (b.allow !== true) {
    return NextResponse.json({ redirect: withQuery(value.redirectUri, { error: 'access_denied', state: value.state }) });
  }
  if (!(await isEmailGrantedAccess(user.email))) return NextResponse.json({ error: 'Access not approved' }, { status: 403 });
  const { code } = await createDesktopAuthCode({
    email: user.email, codeChallenge: value.challenge, kind: 'oauth', label: value.clientName,
    clientId: value.clientId, redirectUri: value.redirectUri,
  });
  await markOAuthClientAllowed(value.clientId);
  return NextResponse.json({ redirect: withQuery(value.redirectUri, { code, state: value.state }) });
}
