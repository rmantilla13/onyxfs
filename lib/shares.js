// lib/shares.js — the server-only half of share links: tokens, password
// hashing, the cookie that remembers a correct password, and the lockout.
// The kinds and the request rules are lib/share-kinds.js, which the client
// can import; this module needs node:crypto and must stay out of it.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/** 128 bits, URL-safe: 22 characters. Older links have 12 hex, and still resolve. */
export function newShareToken() {
  return randomBytes(16).toString('base64url');
}

// ── Passwords ────────────────────────────────────────────────────────────────
// scrypt with a salt per link. The rows this replaces held an unsalted
// SHA-256, which a GPU tries billions of times a second; those still verify,
// so a link made before this keeps working.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export async function hashSharePassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifySharePassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, saltB64, hashB64] = stored.split('$');
    const expected = Buffer.from(hashB64 || '', 'base64url');
    if (!expected.length) return false;
    const got = await scrypt(password, Buffer.from(saltB64 || '', 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return timingSafeEqual(got, expected);
  }
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
