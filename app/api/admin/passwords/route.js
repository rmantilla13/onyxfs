import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { isEmailApprovedInvite, setSignInPassword, removeSignInPassword } from '@/lib/db';
import { isAdmin } from '@/lib/auth-allowlist';
import { hashPassword, newPassword } from '@/lib/passwords';
import { passwordTargetProblem } from '@/lib/password-signin';
import { audit, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// The address goes in the body, never the URL, as with the People API.
async function readEmail(req) {
  let body = {};
  try { body = await req.json(); } catch { return { error: NextResponse.json({ error: 'Bad request' }, { status: 400 }) }; }
  return { email: String(body?.email || '').trim().toLowerCase() };
}

/**
 * POST { email } → { email, password, setAt } — give someone a password to
 * sign in with instead of an emailed link: for an account whose inbox nobody
 * reads, such as App Review's (lib/password-signin.js). A new one replaces
 * the old one at once.
 *
 * Onyx makes the password; nobody chooses it. This is the only time it is
 * shown — only its hash is kept — so the answer is never cached. Not for an
 * admin (ADMIN_EMAILS sign in with the link only), and only for someone who
 * may sign in at all.
 */
export async function POST(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const read = await readEmail(req);
  if (read.error) return read.error;
  const { email } = read;

  const admin = isAdmin(email);
  const approved = !admin && email.includes('@') ? await isEmailApprovedInvite(email) : false;
  const problem = passwordTargetProblem({ email, admin, approved });
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });

  const password = newPassword();
  const saved = await setSignInPassword(email, { hash: await hashPassword(password), by: guard.email });
  await audit(guard.email, 'person.password.set', personSubject(email));
  return NextResponse.json(
    { email: saved.email, password, setAt: saved.setAt },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * DELETE { email } — take someone's password away. They sign in with an
 * emailed link again; a browser or device they already signed in stays
 * signed in (sign them out everywhere for that).
 */
export async function DELETE(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const read = await readEmail(req);
  if (read.error) return read.error;
  const { email } = read;
  if (!email.includes('@')) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });

  const removed = await removeSignInPassword(email);
  if (removed) await audit(guard.email, 'person.password.remove', personSubject(email));
  return NextResponse.json({ ok: true, removed });
}
