import { NextResponse } from 'next/server';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { getDesktopTokenByRaw, touchDesktopToken, upsertPerson } from '@/lib/db';
import { getPrincipal } from '@/lib/authz';
import { getSessionUser } from '@/lib/session';

// Emails this instance has made sure have a people row. The row is where a
// person's role and status live; a desktop-only user who has not opened the
// web since the table appeared gets theirs on first use.
const ensured = new Set();

/**
 * Bearer-token guard for the desktop clients. Use at the top of any
 * /api/space/* or /api/desktop/{me} route:
 *
 *   const gate = await requireDesktopAuth(req);
 *   if (gate.error) return gate.error;
 *   const { email, isAdmin, principal } = gate;
 *
 * Returns {email, tokenId, isAdmin, principal} on success, {error:
 * NextResponse} on failure. `principal` is lib/authz.js getPrincipal's — the
 * same one the web builds for the same email, so a desktop client can never
 * be told yes where the web says no. (A full-access platform role used to
 * make someone owner of every drive here, and only here. Owner of everything
 * is now exactly ADMIN_EMAILS, everywhere.)
 *
 * Security: the token is validated by hash against desktop_tokens AND the email
 * is re-checked against the LIVE allowlist on every request — so revoking or
 * suspending someone cuts off the desktop within one request, independent of
 * the token's own expiry. Suspension and "sign out everywhere" also delete
 * the tokens outright.
 */
export async function requireDesktopAuth(req) {
  const header = req?.headers?.get?.('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const raw = m?.[1]?.trim();
  if (!raw) {
    return { error: NextResponse.json({ error: 'Missing bearer token' }, { status: 401 }) };
  }
  let row;
  try {
    row = await getDesktopTokenByRaw(raw);
  } catch (e) {
    return { error: NextResponse.json({ error: 'Auth check failed' }, { status: 500 }) };
  }
  if (!row) {
    return { error: NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 }) };
  }
  // Live allowlist re-check — a revoked or suspended user's token stops
  // working immediately.
  const ok = await isEmailGrantedAccess(row.email);
  if (!ok) {
    return { error: NextResponse.json({ error: 'Access revoked' }, { status: 403 }) };
  }
  if (!ensured.has(row.email)) {
    ensured.add(row.email);
    upsertPerson(row.email, { seen: true }).catch(() => ensured.delete(row.email));
  }
  // Fire-and-forget last-used bump; never block the request on it.
  touchDesktopToken(row.id).catch(() => {});
  let principal;
  try {
    principal = await getPrincipal(row.email, { tokenId: row.id });
  } catch {
    return { error: NextResponse.json({ error: 'Could not check your access. Try again.' }, { status: 503 }) };
  }
  return { email: row.email, tokenId: row.id, isAdmin: principal.isAdmin, principal };
}

/**
 * Dual guard for routes shared between the browser (cookie session) and the
 * desktop (bearer token). Tries the cookie first, then the bearer token.
 * Returns {email, isAdmin, via, principal} or {error: NextResponse}.
 */
export async function resolveActor(req) {
  try {
    const user = await getSessionUser();
    if (user) {
      const principal = await getPrincipal(user.email, { person: user.person, tokenId: user.deviceTokenId || null });
      return { email: user.email, isAdmin: principal.isAdmin, via: 'cookie', principal };
    }
  } catch { /* fall through to bearer */ }
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate;
  return { email: gate.email, isAdmin: gate.isAdmin, via: 'bearer', principal: gate.principal };
}
