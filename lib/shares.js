// lib/shares.js — the server-only half of share links: tokens, password
// hashing, the cookie that remembers a correct password, the one that
// remembers a review link's guest, and the lockout.
// The kinds and the request rules are lib/share-kinds.js, which the client
// can import; this module needs node:crypto and must stay out of it.

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from './passwords.js';

/** 128 bits, URL-safe: 22 characters. Older links have 12 hex, and still resolve. */
export function newShareToken() {
  return randomBytes(16).toString('base64url');
}

// ── Passwords ────────────────────────────────────────────────────────────────
// scrypt with a salt per link (lib/passwords.js, which sign-in passwords use
// too). The rows this replaces held an unsalted SHA-256, which a GPU tries
// billions of times a second; those still verify, so a link made before this
// keeps working.
export async function hashSharePassword(password) {
  return hashPassword(password);
}

export async function verifySharePassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  if (stored.startsWith('scrypt$')) return verifyPassword(password, stored);
  // Legacy: hex SHA-256 of the password.
  if (!/^[0-9a-f]{64}$/.test(stored)) return false;
  const got = createHash('sha256').update(password).digest();
  return timingSafeEqual(got, Buffer.from(stored, 'hex'));
}

// ── Remembering a correct password ───────────────────────────────────────────
// Once the password is right, the share page sets an HttpOnly cookie holding
// an HMAC of the token and the stored hash. Bound to that hash, so a link
// whose password changes locks out everyone who only knew the old one; and it
// cannot be forged without AUTH_SECRET.
export const SHARE_COOKIE_HOURS = 12;

export function shareCookieName(token) {
  return `onyx_share_${token}`;
}

export function shareCookieValue(token, passwordHash, secret) {
  if (!secret) throw new Error('AUTH_SECRET is not set.');
  return createHmac('sha256', secret).update(`${token}.${passwordHash}`).digest('base64url');
}

export function shareCookieValid(value, token, passwordHash, secret) {
  if (!value || !secret || !passwordHash) return false;
  const want = Buffer.from(shareCookieValue(token, passwordHash, secret));
  const got = Buffer.from(String(value));
  return got.length === want.length && timingSafeEqual(got, want);
}

// ── Guests on a review link ──────────────────────────────────────────────────
// Someone a comment-taking link reaches gives a name and is given an id,
// both kept in an HttpOnly cookie scoped to the link's path and signed with
// AUTH_SECRET. The id is what makes a comment theirs to edit or delete: it
// is stored on the comment (review_comments.guest_id) and is their decision's
// reviewer ('guest:<id>'). The signature, not the id, is the secret — ids
// reach other people, as a comment's author — so an id cannot be made into
// a cookie without AUTH_SECRET. Bound to the link's token, so one link's
// guest is nobody on another. The name is only what they typed: it is shown
// with "Guest" beside it, and nothing trusts it.
export const GUEST_COOKIE_DAYS = 90;

/** 96 bits, URL-safe: 16 characters. */
export function newGuestId() {
  return randomBytes(12).toString('base64url');
}

export function guestCookieName(token) {
  return `onyx_guest_${token}`;
}

function guestSignature(token, id, name, secret) {
  return createHmac('sha256', secret).update(`guest.${token}.${id}.${name}`).digest('base64url');
}

/** The cookie for guest { id, name } on link `token`: id, name and signature, dot-separated. */
export function guestCookieValue(token, { id, name }, secret) {
  if (!secret) throw new Error('AUTH_SECRET is not set.');
  const encoded = Buffer.from(String(name), 'utf8').toString('base64url');
  return `${id}.${encoded}.${guestSignature(token, id, String(name), secret)}`;
}

/** The guest a cookie names on link `token`, { id, name }, or null for anything not signed for it. */
export function readGuestCookie(value, token, secret) {
  if (!value || !token || !secret) return null;
  const parts = String(value).split('.');
  if (parts.length !== 3) return null;
  const [id, encoded, sig] = parts;
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return null;
  const name = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!name) return null;
  const want = Buffer.from(guestSignature(token, id, name, secret));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return { id, name };
}

// ── Guessing ─────────────────────────────────────────────────────────────────
// Ten wrong passwords lock a link for fifteen minutes. Per link rather than
// per address: serverless keeps no memory between requests, and the link is
// what a guesser has. The owner can always make a new one.
export const MAX_PASSWORD_FAILURES = 10;
export const PASSWORD_LOCK_MS = 15 * 60 * 1000;

/** 'missing' | 'expired' | 'locked' | 'ok', for a stored row at `now`. */
export function shareState(row, now = Date.now()) {
  if (!row) return 'missing';
  if (row.expires_at != null && Number(row.expires_at) <= now) return 'expired';
  if (row.pw_locked_until != null && Number(row.pw_locked_until) > now) return 'locked';
  return 'ok';
}
