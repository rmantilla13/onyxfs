/**
 * Who may sign in, and who is an admin.
 *
 * Used by every auth code path:
 *   - auth.js signIn callback — the final gate before a session is issued
 *   - app/signin/actions.js   — pre-validates before a magic link is sent
 *   - lib/desktop-guard.js    — re-checked on EVERY desktop API request
 *
 * Env vars, all comma-separated:
 *   ALLOWED_EMAIL_DOMAIN — domains, e.g. "onyxfs.io,example.com"
 *   ALLOWED_EMAILS       — individual addresses outside any allowed domain
 *   ADMIN_EMAILS         — admins. Only these reach /admin.
 *   SUPER_ADMIN_EMAILS   — a stricter subset, for brand + storage config.
 *
 * There are no NEXT_PUBLIC_* mirrors, and there should not be. Each of these
 * used to have one, read through an `isClient` parameter — which nothing in
 * the repository ever passed, and could not usefully have passed: every
 * importer of this module is server-side. So the mirrors did nothing, while
 * .env.local.example told you to set them; setting NEXT_PUBLIC_ADMIN_EMAILS
 * would have published the admin list into the browser bundle in exchange for
 * no behaviour at all. If a client component ever needs to know whether the
 * signed-in user is an admin, pass it down as a prop from a server component
 * that called isAdmin() — do not re-introduce a public mirror.
 *
 * None of this is a backdoor: a listed address still has to complete the full
 * magic-link flow and prove control of the inbox. The list decides who is
 * ALLOWED; the email decides who they ARE.
 */

// The founder account. Defaulted so a fresh deploy is reachable before any env
// var is set — override ADMIN_EMAILS in production.
const BOOTSTRAP_ADMIN = 'hi@rickymantilla.com';

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Say once, per instance, that a hardcoded address is currently the only
// admin. Unset ADMIN_EMAILS is a legitimate first-deploy state and a bad
// steady state, and the two are indistinguishable from the outside: everything
// works, for one person, for reasons found nowhere in the configuration.
const announced = new Set();
function bootstrapFallback(which) {
  if (!announced.has(which)) {
    announced.add(which);
    console.warn(
      `[auth] ${which} is not set — falling back to the bootstrap admin `
      + `compiled into lib/auth-allowlist.js. Set ${which} to take ownership.`,
    );
  }
  return [BOOTSTRAP_ADMIN];
}

function getAllowedDomains() {
  return parseList(process.env.ALLOWED_EMAIL_DOMAIN);
}

function getAllowedEmails() {
  return parseList(process.env.ALLOWED_EMAILS);
}

/**
 * Env-only check: does this address match an allowed domain or the explicit
 * list? Kept for UI hints and cheap checks.
 *
 * This is NOT the gate — use isEmailGrantedAccess(), which also knows about
 * approved invites in the database. Onyx is invite-only by default: with no
 * ALLOWED_EMAIL_DOMAIN set this returns false for everyone, which is correct.
 */
export function isEmailAllowed(email) {
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  if (!e.includes('@')) return false;
  if (getAllowedEmails().includes(e)) return true;
  return getAllowedDomains().some((d) => e.endsWith(`@${d}`));
}

/** Human-readable description for sign-in UI hints. */
export function describeAllowlist() {
  return 'invited';
}

function getAdminEmails() {
  const list = parseList(process.env.ADMIN_EMAILS);
  return list.length ? list : bootstrapFallback('ADMIN_EMAILS');
}

export function isAdmin(email) {
  if (!email) return false;
  return getAdminEmails().includes(String(email).trim().toLowerCase());
}

/**
 * Super-admins — a stricter subset for the surfaces that can break the
 * deployment or exfiltrate data: brand/white-label config, the storage
 * backend, and the secret override panel.
 */
function getSuperAdminEmails() {
  const list = parseList(process.env.SUPER_ADMIN_EMAILS);
  return list.length ? list : bootstrapFallback('SUPER_ADMIN_EMAILS');
}

export function isSuperAdmin(email) {
  if (!email) return false;
  return getSuperAdminEmails().includes(String(email).trim().toLowerCase());
}

/**
 * THE gate. Returns true iff the email is an env-admin (the founder backstop)
 * or has an approved row in `invite_requests`.
 *
 * The db import stays dynamic: this is the module every auth path imports,
 * including auth.config.js's neighbours on the Edge, and lib/db.js must never
 * reach the Edge bundle. (An older comment here claimed the reason was that
 * client components import this module. They do not — every importer is
 * server-side. The Edge constraint is the real one, and it still holds.)
 */
export async function isEmailGrantedAccess(email) {
  if (!email) return false;
  if (isAdmin(email)) return true;
  const { isEmailApprovedInvite } = await import('./db.js');
  return await isEmailApprovedInvite(email);
}
