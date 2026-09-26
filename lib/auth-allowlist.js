/**
 * Who may sign in, and who is an admin.
 *
 * Used by every auth code path:
 *   - auth.js signIn callback — the final gate before a session is issued
 *   - app/signin/actions.js   — pre-validates before a magic link is sent
 *   - lib/desktop-guard.js    — re-checked on EVERY desktop API request
 *   - lib/session.js          — re-checked, from a 30-second cache, on every
 *                               page and route that reads the session
 *
 * Onyx is invite-only. Nobody is let in by domain or by a list in the
 * environment: an address signs in because an admin approved it (an
 * `invite_requests` row) or because it is an admin. ALLOWED_EMAIL_DOMAIN and
 * ALLOWED_EMAILS were documented for a while and read by nothing, so they
 * are gone; `npm run doctor` says so if one is still set.
 *
 * Env vars, both comma-separated:
 *   ADMIN_EMAILS         — admins. Only these reach /admin.
 *   SUPER_ADMIN_EMAILS   — a stricter subset, for the storage backend and the
 *                          AI key and budget. Unset, it is ADMIN_EMAILS.
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
let announced = false;
function bootstrapFallback() {
  if (!announced) {
    announced = true;
    console.warn(
      '[auth] ADMIN_EMAILS is not set — falling back to the bootstrap admin '
      + 'compiled into lib/auth-allowlist.js. Set ADMIN_EMAILS to take ownership.',
    );
  }
  return [BOOTSTRAP_ADMIN];
}

/**
 * Every admin address, lowercased. Exported for the one other place that
 * needs the list rather than a yes or no: the invite table's first-run seed
 * in lib/db.js, which used to keep its own copy with its own defaults.
 */
export function getAdminEmails() {
  const list = parseList(process.env.ADMIN_EMAILS);
  return list.length ? list : bootstrapFallback();
}

export function isAdmin(email) {
  if (!email) return false;
  return getAdminEmails().includes(String(email).trim().toLowerCase());
}

/**
 * Super-admins — a stricter subset for the surfaces that can break the
 * deployment or run up a bill: the storage backend, and the AI key and
 * budget.
 *
 * Unset, it is every admin. That fallback is deliberate and it is not the
 * bootstrap address: an owner who never set SUPER_ADMIN_EMAILS must not find
 * the storage settings locked behind an address that is not theirs. A listed
 * super-admin who is not also an admin is not one — the tier narrows the
 * admins, it never adds to them.
 */
function getSuperAdminEmails() {
  const list = parseList(process.env.SUPER_ADMIN_EMAILS);
  return list.length ? list : getAdminEmails();
}

export function isSuperAdmin(email) {
  if (!email || !isAdmin(email)) return false;
  return getSuperAdminEmails().includes(String(email).trim().toLowerCase());
}

/**
 * THE gate. Returns true iff the email is an env-admin (the founder backstop)
 * or has an approved row in `invite_requests` and is not suspended.
 *
 * Admins are not checked for suspension: the People API refuses to suspend
 * one, and an admin locked out of the panel that would let them undo it is
 * the one lock-out that cannot be repaired from inside the product.
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
