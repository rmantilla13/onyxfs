// lib/passwords.js — passwords, made and checked. Server-only (node:crypto).
//
// Two things in Onyx take a password: a share link someone locked with one
// (lib/shares.js), and signing in, for the few accounts an admin has given
// one (lib/password-signin.js). Both keep an scrypt hash with a salt of its
// own and nothing else, in the one format below.
//
// Nobody chooses a sign-in password. Onyx makes it (newPassword), the admin
// who asked sees it once, and it goes wherever it is needed — App Store
// Connect, for App Review. So every one is long and random, and a guess at
// one is a guess at 80 bits.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** `scrypt$N$r$p$salt$hash`, salt and hash base64url. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Whether `password` is the one `stored` was made from. Anything but an scrypt hash is a no. */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, n, r, p, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64 || '', 'base64url');
  if (!expected.length) return false;
  try {
    const got = await scrypt(password, Buffer.from(saltB64 || '', 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return timingSafeEqual(got, expected);
  } catch {
    // Parameters scrypt refuses: a hash this module never wrote.
    return false;
  }
}

// ── Sign-in passwords ────────────────────────────────────────────────────────
// Crockford's base32 in lower case: no i, l, o or u, so nothing in one reads
// as something else. Four groups of four, typed on a phone by someone who
// has never seen Onyx: 16 characters, 80 bits.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const GROUPS = 4;
const GROUP = 4;

export function newPassword() {
  const bytes = randomBytes(GROUPS * GROUP);
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]);
  const groups = [];
  for (let i = 0; i < GROUPS; i++) groups.push(chars.slice(i * GROUP, (i + 1) * GROUP).join(''));
  return groups.join('-');
}

/** Wrong passwords in a row that lock an account's password, and for how long. */
export const MAX_SIGN_IN_FAILURES = 10;
export const SIGN_IN_LOCK_MS = 15 * 60 * 1000;
