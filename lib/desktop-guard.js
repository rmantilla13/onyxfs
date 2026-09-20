import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isEmailGrantedAccess, isAdmin } from '@/lib/auth-allowlist';
import { getDesktopTokenByRaw, touchDesktopToken, getRolesConfig } from '@/lib/db';
import { resolveRole } from '@/lib/roles';

/**
 * Desktop "owner" status = env-level admin (ADMIN_EMAILS) OR a full-access
 * platform role (the built-in Admin role, full: true). Both see every
 * filespace and mount as owner. A role-based Admin manages all filespaces on
 * the web, so the desktop must match — without this, full-role admins fell
 * through to grant-only access and saw "No filespaces yet". Non-full custom
 * roles still require explicit per-filespace grants.
 */
async function isOwnerActor(email) {
  if (isAdmin(email)) return true;
  try {
    const role = resolveRole(email, await getRolesConfig(), { isAdmin: false });
    return !!role?.full;
  } catch {
    return false; // roles are optional — fall back to env-admin only
  }
}

/**
 * Bearer-token guard for the Onyx Desktop desktop client. Use at the top of any
 * /api/space/* or /api/desktop/{me} route:
 *
 *   const gate = await requireDesktopAuth(req);
 *   if (gate.error) return gate.error;
 *   const { email, isAdmin } = gate;
 *
 * Returns {email, isAdmin} on success, {error: NextResponse} on failure.
 *
 * Security: the token is validated by hash against desktop_tokens AND the email
 * is re-checked against the LIVE allowlist on every request — so revoking a
 * user (removing their invite / ADMIN_EMAILS entry) cuts off the desktop within
 * one request, independent of the token's own expiry.
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
  // Live allowlist re-check — a revoked user's token stops working immediately.
  const ok = await isEmailGrantedAccess(row.email);
  if (!ok) {
    return { error: NextResponse.json({ error: 'Access revoked' }, { status: 403 }) };
  }
  // Fire-and-forget last-used bump; never block the request on it.
  touchDesktopToken(row.id).catch(() => {});
  return { email: row.email, tokenId: row.id, isAdmin: await isOwnerActor(row.email) };
}

/**
 * Dual guard for routes shared between the browser (cookie session) and the
 * desktop (bearer token). Tries the cookie first, then the bearer token.
 * Returns {email, isAdmin, via} or {error: NextResponse}.
 */
export async function resolveActor(req) {
  try {
    const session = await auth();
    const email = session?.user?.email;
    if (email) return { email, isAdmin: isAdmin(email), via: 'cookie' };
  } catch { /* fall through to bearer */ }
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate;
  return { email: gate.email, isAdmin: gate.isAdmin, via: 'bearer' };
}
