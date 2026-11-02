import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { createDesktopAuthCode, getOAuthClient, listFilespaces, markOAuthClientAllowed } from '@/lib/db';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { READ_SCOPE, checkAuthorize, withQuery } from '@/lib/oauth';
import { driveRoleOf, getPrincipal } from '@/lib/authz';
import { grantableDrives } from '@/lib/token-scope';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/oauth/authorize { clientId, redirectUri, state, challenge, scope, driveIds?, allow }
 *   → { redirect }
 *
 * The consent page's answer (app/oauth/authorize). Signed in by the session
 * alone, and only from this site's own page (Origin). What it was sent is
 * checked again against the client's registration — the page's word is not
 * taken — then a single-use code bound to the client, its redirect address
 * and its PKCE challenge is minted, or the client is told no.
 *
 * For `onyx.read`, the drives picked are checked against what this person
 * can open now, and at least one must be left: the code, and the token it
 * becomes, carry exactly those (lib/token-scope.js).
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
    response_type: 'code', code_challenge: b.challenge, code_challenge_method: 'S256', scope: b.scope,
  }, client);
  if (checked.error) return NextResponse.json({ error: checked.description || checked.error }, { status: 400 });
  const { value } = checked;
  if (b.allow !== true) {
    return NextResponse.json({ redirect: withQuery(value.redirectUri, { error: 'access_denied', state: value.state }) });
  }
  if (!(await isEmailGrantedAccess(user.email))) return NextResponse.json({ error: 'Access not approved' }, { status: 403 });
  let label = value.clientName;
  let driveIds = null;
  if (value.scope === READ_SCOPE) {
    const principal = await getPrincipal(user.email, { person: user.person });
    driveIds = grantableDrives(b.driveIds, (id) => !!driveRoleOf(principal, id));
    if (!driveIds.length) return NextResponse.json({ error: 'Choose at least one drive it may read.' }, { status: 400 });
    const names = new Map((await listFilespaces()).map((d) => [d.id, d.name]));
    label = `${value.clientName} · read-only · ${driveIds.map((id) => names.get(id) || id).join(', ')}`.slice(0, 120);
  }
  const { code } = await createDesktopAuthCode({
    email: user.email, codeChallenge: value.challenge, kind: 'oauth', label,
    clientId: value.clientId, redirectUri: value.redirectUri,
    scope: value.scope === READ_SCOPE ? READ_SCOPE : null, driveIds,
  });
  await markOAuthClientAllowed(value.clientId);
  return NextResponse.json({ redirect: withQuery(value.redirectUri, { code, state: value.state }) });
}
