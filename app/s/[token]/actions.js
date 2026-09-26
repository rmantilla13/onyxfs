'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getShareRow, recordShareFailure, clearShareFailures, isLinkCreatorPaused } from '@/lib/db';
import { readGlobalFlags } from '@/lib/authz';
import {
  shareState, verifySharePassword, shareCookieName, shareCookieValue, SHARE_COOKIE_HOURS,
} from '@/lib/shares';
import { shareKind, isShareToken } from '@/lib/share-kinds';

function lockedMessage(until) {
  const minutes = Math.max(1, Math.ceil((Number(until) - Date.now()) / 60000));
  return `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/**
 * The password form on /s/<token>. A right password sets an HttpOnly cookie,
 * scoped to this link's path and bound to its current password hash
 * (lib/shares.js), then reloads the page, which now lets the visitor in. A
 * wrong one counts toward the link's lockout.
 */
export async function unlockShare(_prev, formData) {
  const token = String(formData.get('token') || '');
  const password = String(formData.get('password') || '');
  if (!isShareToken(token)) return { error: 'This link does not work.' };
  const flags = await readGlobalFlags();
  if (!flags?.shares) return { error: 'Sharing is turned off.' };

  const row = await getShareRow(token);
  const state = shareState(row);
  if (state === 'missing' || state === 'expired' || shareKind(row) !== 'password') {
    return { error: 'This link is no longer available.' };
  }
  if (state === 'locked') return { error: lockedMessage(row.pw_locked_until) };
  // A paused link takes no guesses either: the page says why.
  if (row.created_by && await isLinkCreatorPaused(row.created_by).catch(() => true)) {
    return { error: 'This link is paused.' };
  }
  if (!password) return { error: 'Enter the password.' };

  if (!(await verifySharePassword(password, row.password_hash))) {
    const r = await recordShareFailure(token);
    if (r?.lockedUntil && r.lockedUntil > Date.now()) return { error: lockedMessage(r.lockedUntil) };
    return { error: 'That password is not right.' };
  }

  await clearShareFailures(token);
  cookies().set(shareCookieName(token), shareCookieValue(token, row.password_hash, process.env.AUTH_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/s/${token}`,
    maxAge: SHARE_COOKIE_HOURS * 3600,
  });
  // Outside any try: redirect() works by throwing.
  redirect(`/s/${token}`);
}
