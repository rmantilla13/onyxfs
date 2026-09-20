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
 * Each has a NEXT_PUBLIC_* mirror for the client. Set them identically across
 * Production / Preview / Development, or a preview deploy will disagree with
 * production about who can sign in. Removing a value is immediate revocation
 * on the next deploy.
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

function getAllowedDomains(isClient = false) {
  return parseList(isClient ? process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN : process.env.ALLOWED_EMAIL_DOMAIN);
}

function getAllowedEmails(isClient = false) {
  return parseList(isClient ? process.env.NEXT_PUBLIC_ALLOWED_EMAILS : process.env.ALLOWED_EMAILS);
}

/**
 * Env-only check: does this address match an allowed domain or the explicit
 * list? Kept for UI hints and cheap client-side checks.
 *
 * This is NOT the gate — use isEmailGrantedAccess(), which also knows about
 * approved invites in the database. Onyx is invite-only by default: with no
 * ALLOWED_EMAIL_DOMAIN set this returns false for everyone, which is correct.
 */
export function isEmailAllowed(email, { isClient = false } = {}) {
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  if (!e.includes('@')) return false;
  if (getAllowedEmails(isClient).includes(e)) return true;
  return getAllowedDomains(isClient).some((d) => e.endsWith(`@${d}`));
}

/** Human-readable description for sign-in UI hints. */
export function describeAllowlist() {
  return 'invited';
}

function getAdminEmails(isClient = false) {
  const list = parseList(isClient ? process.env.NEXT_PUBLIC_ADMIN_EMAILS : process.env.ADMIN_EMAILS);
  return list.length ? list : [BOOTSTRAP_ADMIN];
}

export function isAdmin(email, { isClient = false } = {}) {
  if (!email) return false;
  return getAdminEmails(isClient).includes(String(email).trim().toLowerCase());
}

/**
 * Super-admins — a stricter subset for the surfaces that can break the
 * deployment or exfiltrate data: brand/white-label config, the storage
 * backend, and the secret override panel.
 */
function getSuperAdminEmails(isClient = false) {
  const list = parseList(isClient ? process.env.NEXT_PUBLIC_SUPER_ADMIN_EMAILS : process.env.SUPER_ADMIN_EMAILS);
  return list.length ? list : [BOOTSTRAP_ADMIN];
}

export function isSuperAdmin(email, { isClient = false } = {}) {
  if (!email) return false;
  return getSuperAdminEmails(isClient).includes(String(email).trim().toLowerCase());
}

/**
 * THE gate. Returns true iff the email is an env-admin (the founder backstop)
 * or has an approved row in `invite_requests`.
 *
 * The db import is dynamic on purpose: this module is also pulled into client
 * components for the sync helpers above, and those cannot reach the database.
 * A static import would drag the Neon driver into the browser bundle.
 */
export async function isEmailGrantedAccess(email) {
  if (!email) return false;
  if (isAdmin(email)) return true;
  const { isEmailApprovedInvite } = await import('./db.js');
  return await isEmailApprovedInvite(email);
}
