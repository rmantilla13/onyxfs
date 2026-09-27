'use server';

import { signIn } from '@/auth';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { hasConnectionString } from '@/lib/db';
import { printsSignInLinks } from '@/lib/signin-email';
import { safeReturnPath } from '@/lib/return-path';

/**
 * Send a magic link — but only to an address that is already approved.
 *
 * There is no sign-up. An address gets in because an admin added it (Admin →
 * Access requests) or because it is in ADMIN_EMAILS; nothing on this page
 * can add one.
 *
 * Pre-validating here rather than letting Auth.js's signIn callback reject at
 * the end means an unapproved address never receives an email at all. The
 * message back is deliberately the same shape either way: it says a link was
 * sent if the address is approved, without confirming whether it is. That
 * keeps this from being an oracle for who has access.
 */
export async function requestMagicLink(_prev, formData) {
  const email = String(formData.get('email') || '').trim().toLowerCase();
  if (!email.includes('@')) return { error: 'Enter a valid email address.' };

  // Before anything touches the database. Without a connection string the
  // Auth.js adapter throws from getUserByEmail, the catch below turns it into
  // "Try again in a moment", and that is a lie: retrying cannot help, and it
  // sends whoever is reading it to look at their inbox and their spam folder
  // instead of at the one environment variable that is missing. This is the
  // same treatment RESEND_API_KEY gets immediately below, and for the same
  // reason — a misconfiguration should name itself.
  if (!hasConnectionString().ok) {
    console.error('[signin] no DATABASE_URL (or POSTGRES_URL) — sign-in cannot reach the database. Set it in Vercel → Settings → Environment Variables and redeploy.');
    return { error: 'Sign-in is not available: this server has no database configured (DATABASE_URL is unset). Set it and redeploy — retrying will not help.' };
  }

  if (!(await isEmailGrantedAccess(email))) {
    // The browser gets the same answer either way (see above). In local
    // development there is no inbox to check, so say in the terminal why no
    // link appeared rather than leave it looking like a silent failure.
    if (printsSignInLinks()) {
      console.log(`[signin] ${email} is not approved (or is suspended), so no link was printed. Add it to ADMIN_EMAILS in .env.local, or approve an invite for it.`);
    }
    return { sent: true };
  }

  // Fail before Auth.js does anything. Without a key the Resend client throws
  // from its constructor inside sendVerificationRequest, after the
  // verification token has already been written — and the error it throws
  // ("Pass it to the constructor") says nothing about where the key goes.
  // Under `next dev` the link is printed instead, so no key is needed there.
  if (!process.env.RESEND_API_KEY && !printsSignInLinks()) {
    console.error('[signin] RESEND_API_KEY is not set — no sign-in email can be sent. Add it in Vercel → Settings → Environment Variables and redeploy.');
    return { error: 'Sign-in email is not configured on this server: RESEND_API_KEY is unset. Set it and redeploy.' };
  }

  try {
    // redirectTo is not optional here. Without it Auth.js takes the callback
    // URL from the page this action was posted from — /signin — so the
    // magic link verified, set the session cookie, and delivered the person
    // straight back to the sign-in form, which did not know they had arrived.
    // Where they were going, when the form carries it (a deep link, a
    // private share link); the library otherwise.
    const redirectTo = safeReturnPath(formData.get('callbackUrl')) || '/files';
    await signIn('resend', { email, redirect: false, redirectTo });
    return { sent: true };
  } catch (e) {
    console.error('[signin] magic link failed:', e.message);
    return { error: 'Could not send the sign-in email. Try again in a moment.' };
  }
}
