// lib/password-signin.js — signing in with a password, for the accounts an
// admin has given one. Server-only: it reads the database, so auth.js may
// import it and auth.config.js (the Edge half) must not.
//
// Onyx signs people in with an emailed link: holding the inbox is the whole
// proof of who you are. A password is the exception, for an account nobody
// reads the mail of — App Review's, which Apple signs in to before a build
// may go out to testers. An admin makes one (POST /api/admin/passwords) and
// the sign-in page takes it.
//
// It is a narrower door than the link, not a second one beside it:
//
//   - Only an account an admin gave a password has one. Nobody chooses it:
//     Onyx makes it, 80 random bits (lib/passwords.js), and keeps its hash.
//   - Never an admin. ADMIN_EMAILS sign in with the link and nothing else,
//     so the admin panel stays behind proof of the inbox. Refused here as
//     well as when one is set, so a row written some other way opens nothing.
//   - Past the password, the gate is the link's: auth.js's signIn callback
//     checks that the address is approved and not suspended.
//   - Ten wrong guesses lock the password for fifteen minutes.
//   - Every refusal looks the same and takes as long, so the form says
//     nothing about who has a password.

import {
  getSignInPassword, recordSignInPasswordFailure, clearSignInPasswordFailures, getOrCreateAuthUser,
} from './db.js';
import { isAdmin } from './auth-allowlist.js';
import { hashPassword, verifyPassword, newPassword } from './passwords.js';

const MAX_EMAIL = 320;
const MAX_PASSWORD = 200;

// The hash of a password nobody knows, checked when there is nothing real to
// check: an address with no password takes as long to refuse as a wrong
// guess at one that has.
let decoy = null;
function decoyHash() {
  if (!decoy) decoy = hashPassword(newPassword());
  return decoy;
}

/**
 * Whether a password may be checked for this address — 'ok' — or why not:
 * 'admin', 'no-password' or 'locked'. Pure.
 */
export function passwordCheckable({ record = null, admin = false, now = Date.now() } = {}) {
  if (admin) return 'admin';
  if (!record?.hash) return 'no-password';
  if (record.lockedUntil && record.lockedUntil > now) return 'locked';
  return 'ok';
}

/**
 * Auth.js's authorize for the 'password' provider: the user to sign in, or
 * null. Null is all Auth.js is told, whatever the reason, and the sign-in
 * page says the same thing for every one.
 */
export async function authorizePassword(credentials) {
  const email = String(credentials?.email ?? '').trim().toLowerCase();
  const password = typeof credentials?.password === 'string' ? credentials.password : '';
  if (!email.includes('@') || email.length > MAX_EMAIL || !password || password.length > MAX_PASSWORD) return null;

  let record;
  try {
    record = await getSignInPassword(email);
  } catch (e) {
    console.warn('[auth] could not read a sign-in password:', e.message);
    return null;
  }
  const state = passwordCheckable({ record, admin: isAdmin(email) });
  if (state !== 'ok') {
    await verifyPassword(password, await decoyHash());
    if (state === 'admin' && record) {
      console.warn(`[auth] password refused for ${email}: an admin signs in with an emailed link only`);
    }
    return null;
  }
  if (!(await verifyPassword(password, record.hash))) {
    await recordSignInPasswordFailure(email).catch(() => {});
    return null;
  }
  if (record.failures || record.lockedUntil) await clearSignInPasswordFailures(email);
  // The Auth.js user row an emailed link would have made, so a session from
  // either carries the same id.
  const user = await getOrCreateAuthUser(email);
  if (!user) return null;
  return { id: user.id, email, name: user.name || null };
}

/**
 * Why an admin may not give `email` a password — { status, error } — or null.
 * Pure: the route says whether the address is an admin and may sign in.
 */
export function passwordTargetProblem({ email, admin = false, approved = false } = {}) {
  if (!email || !String(email).includes('@')) return { status: 400, error: 'A valid email is required.' };
  if (admin) {
    return { status: 400, error: 'Admins sign in with an emailed link only: a password would be a second, weaker way into the admin panel.' };
  }
  if (!approved) {
    return { status: 400, error: 'They can’t sign in at the moment. Add them (or reactivate them) first, then give them a password.' };
  }
  return null;
}
