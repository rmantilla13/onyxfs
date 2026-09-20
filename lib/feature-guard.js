import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFeatureFlags, getRolesConfig, getActiveWorkspace, getWorkspace } from '@/lib/db';
import { isFeatureEnabled, applyBetaAdminFlags, mergeFlags } from '@/lib/features';
import { resolveRole, effectiveFlags, mergeRolesConfig } from '@/lib/roles';
import { isAdmin } from '@/lib/auth-allowlist';
import { readAdminPreview } from '@/lib/admin-preview';

/**
 * Phased-release feature gating (server-only).
 *
 * resolveFeaturesForUser → the same resolution the layout uses for the nav:
 *   saved flags (over phase defaults) → narrowed by the user's role → beta
 *   features forced on for admins/super-admins. Keeping one resolver means the
 *   nav, the page guard, and the API guard can never disagree about what a given
 *   user can see.
 *
 * requireFeature → page guard (redirects home when off).
 * featureGate    → API guard (returns a 403 Response when off, else null).
 *
 * Middleware can't reach the DB (edge runtime), so gating lives here, per
 * page/route, where the Node runtime + DB + session are all available.
 */
export async function resolveFeaturesForUser(session) {
  const email = session?.user?.email;
  // Super-admin "preview as" — when set, resolve the app as the previewed role
  // and/or workspace instead of the super-admin's own elevated view. Inert for
  // anyone who isn't a super-admin (readAdminPreview enforces that).
  const preview = await readAdminPreview(email).catch(() => null);
  // The identity we resolve for: a previewed specific user, else the live user.
  const targetEmail = preview?.user || email;

  // Base flags come from the (explicit preview → target's active) workspace's
  // own tool set when it has a config; otherwise the global platform flags.
  // This is what makes each workspace a different experience.
  let flags;
  try {
    let ws = null;
    if (preview?.workspace) ws = await getWorkspace(preview.workspace);
    else if (targetEmail) ws = await getActiveWorkspace(targetEmail);
    flags = (ws && ws.flags && Object.keys(ws.flags).length) ? mergeFlags(ws.flags) : await getFeatureFlags();
  } catch {
    flags = await getFeatureFlags().catch(() => ({}));
  }
  if (targetEmail) {
    try {
      const targetAdmin = isAdmin(targetEmail);
      if (preview?.role) {
        // Explicit role override — narrow by that role exactly as it would see it.
        const role = mergeRolesConfig(await getRolesConfig()).roles.find((r) => r.id === preview.role) || { features: {} };
        flags = effectiveFlags(flags, role);
      } else {
        // The target's own role (their real assignment, or the live user's).
        const role = resolveRole(targetEmail, await getRolesConfig(), { isAdmin: targetAdmin });
        flags = effectiveFlags(flags, role);
      }
      // Beta-admin reveal:
      //  - previewing a specific USER: mirror their real view (reveal iff they're an admin).
      //  - previewing a role/workspace only: honest un-elevated view (no reveal).
      //  - not previewing at all: the live user's own view.
      if (preview?.role) { /* honest role view — no reveal */ }
      else if (preview?.user) flags = applyBetaAdminFlags(flags, targetAdmin);
      else if (!preview) flags = applyBetaAdminFlags(flags, targetAdmin);
    } catch {
      /* fall back to the unnarrowed flags */
    }
  }
  return flags;
}

export async function featureEnabledForSession(flag, session) {
  const flags = await resolveFeaturesForUser(session);
  return isFeatureEnabled(flags, flag);
}

/** Page guard: call at the top of a server page. Redirects when the feature is off. */
export async function requireFeature(flag, { to = '/' } = {}) {
  const session = await auth();
  if (!session) redirect('/signin');
  if (!(await featureEnabledForSession(flag, session))) redirect(to);
  return session;
}

/**
 * API guard: returns a 403 NextResponse when the feature is off (401 if signed
 * out), or null when allowed. Usage:
 *   const blocked = await featureGate('ugcStudio'); if (blocked) return blocked;
 */
export async function featureGate(flag) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (!(await featureEnabledForSession(flag, session))) {
    return NextResponse.json({ error: 'This feature isn’t available yet.', code: 'feature_off' }, { status: 403 });
  }
  return null;
}
