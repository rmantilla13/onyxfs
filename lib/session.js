// lib/session.js — who is signed in, and whether that still counts.
// Node-only: never imported by middleware.js or auth.config.js, which run on
// the Edge and must not reach the database (see auth.config.js).
//
// Auth.js's session is a JWT. It says who signed in and when, and it stays
// valid until it expires — which is why "revoke" used to leave a browser
// signed in for weeks. getSessionUser is the check that closes that: every
// page loader and every /api route asks it rather than auth(), and it
// refuses a session when
//
//   the person is suspended,
//   the session was issued before their cutoff (sign out everywhere,
//     suspension: people.sessions_valid_after, against the JWT's authAt),
//   it is the Mac app's web view and the device token it came from has been
//     revoked (deviceTokenId), or
//   the address is no longer allowed in at all (no approved invite, not an
//     admin).
//
// All four come from ONE query (sessionRowFor), cached for 30 seconds per
// instance, which also brings the profile picture — replacing the separate
// getAvatarUrl every page used to await first. So a suspension reaches a
// signed-in browser within 30 seconds, and immediately on the instance that
// made it (forgetSession).

import { auth } from '@/auth';
import { sessionRowFor, upsertPerson, touchPersonSeen } from './db.js';
import { isAdmin } from './auth-allowlist.js';
import { avatarPath } from './avatars.js';

const CACHE_MS = 30_000;
// When the database will not answer, a recent answer is better than signing
// everyone out — but not a stale one. Past this, a failed read signs out.
const STALE_OK_MS = 5 * 60_000;
const SEEN_EVERY_MS = 10 * 60_000;

const cache = new Map(); // `${email}|${tokenId}` → { at, row }
const seenAt = new Map(); // email → last "last seen" write from this instance
const ensured = new Set(); // emails this instance has made sure have a row

/** Drop what this instance remembers about a person — after suspending them, say. */
export function forgetSession(email) {
  const e = String(email || '').trim().toLowerCase();
  for (const k of cache.keys()) if (k.startsWith(`${e}|`)) cache.delete(k);
}

/**
 * Whether a session still counts, from what was read. Pure → { ok, reason }.
 * `authAt` is when the JWT was issued (0 for tokens from before it was
 * stamped — which only matters for someone whose cutoff is later set, and
 * signing those out is what the cutoff is for).
 */
export function sessionDecision({ email, authAt = 0, deviceTokenId = null, row = null, admin = false }) {
  if (!email) return { ok: false, reason: 'no-session' };
  const person = row?.person || null;
  // Admins cannot be suspended (the People API refuses), so a stray status
  // on an admin's row is ignored rather than locking out the one account
  // that could undo it. Their cutoff still applies: signing out everywhere
  // is something an admin may want for themselves.
  if (person?.status === 'suspended' && !admin) return { ok: false, reason: 'suspended' };
  if (person?.sessionsValidAfter && (Number(authAt) || 0) < person.sessionsValidAfter) {
    return { ok: false, reason: 'signed-out' };
  }
  if (deviceTokenId && row && row.deviceOk === false) return { ok: false, reason: 'device-revoked' };
  if (!admin && row?.inviteStatus !== 'approved') return { ok: false, reason: 'not-approved' };
  return { ok: true };
}

async function loadRow(email, deviceTokenId) {
  const key = `${email}|${deviceTokenId || ''}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.row;
  try {
    const row = await sessionRowFor(email, deviceTokenId);
    cache.set(key, { at: now, row });
    return row;
  } catch (e) {
    console.warn('[session] could not check the session:', e.message);
    if (hit && now - hit.at < STALE_OK_MS) return hit.row;
    return undefined; // unknown — the caller decides
  }
}

/**
 * The signed-in person, or null. → { email, person, avatarUrl, authAt,
 * deviceTokenId, name }.
 *
 * `person` is their people row, or null when they have none yet (it is then
 * created, once per instance, in the background — the People list should
 * not depend on everyone having signed in since the table appeared).
 */
export async function getSessionUser() {
  let session;
  try {
    session = await auth();
  } catch {
    return null;
  }
  const email = String(session?.user?.email || '').trim().toLowerCase();
  if (!email) return null;
  const authAt = Number(session.user.authAt) || 0;
  const deviceTokenId = session.user.deviceTokenId || null;
  const admin = isAdmin(email);

  const row = await loadRow(email, deviceTokenId);
  if (row === undefined) {
    // The database did not answer and nothing recent is remembered. An env
    // admin is let through — they need to reach /api/health to see why —
    // and everyone else is treated as signed out: fail closed.
    if (!admin) return null;
  } else {
    const d = sessionDecision({ email, authAt, deviceTokenId, row, admin });
    if (!d.ok) return null;
  }

  const person = row?.person || null;
  if (!person && !ensured.has(email)) {
    ensured.add(email);
    upsertPerson(email, { seen: true }).catch(() => ensured.delete(email));
  } else if (person) {
    const last = seenAt.get(email) || 0;
    if (Date.now() - last > SEEN_EVERY_MS && (!person.lastSeenAt || Date.now() - person.lastSeenAt > SEEN_EVERY_MS)) {
      seenAt.set(email, Date.now());
      touchPersonSeen(email).catch(() => {});
    }
  }

  return {
    email,
    person,
    avatarUrl: row?.avatar ? avatarPath(row.avatar.id, row.avatar.version) : null,
    authAt,
    deviceTokenId,
    name: person?.displayName || session.user.name || null,
  };
}

/**
 * For a route: the signed-in person, or { error } with a 401 to return.
 */
export async function requireUser() {
  const user = await getSessionUser();
  if (user) return { user, email: user.email };
  const { NextResponse } = await import('next/server');
  return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
}
