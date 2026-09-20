import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { listInviteRequests, updateInviteRequest, adminAddApprovedInvite, deleteInviteRequest, removeUserAccount } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const status = new URL(req.url).searchParams.get('status') || undefined;
  return NextResponse.json({ requests: await listInviteRequests({ status }) });
}

/** POST { email, name } — add someone directly, skipping the request queue. */
export async function POST(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email.includes('@')) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  const row = await adminAddApprovedInvite({ email, name: body.name || null, reviewedBy: guard.email });
  return NextResponse.json({ request: row });
}

/** PATCH { id, status, note } — approve or deny a pending request. */
export async function PATCH(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const row = await updateInviteRequest(body.id, { status: body.status, reviewedBy: guard.email, reviewNote: body.note || null });
  return NextResponse.json({ request: row });
}

/**
 * DELETE ?email= — revoke access.
 *
 * Both halves matter: dropping the invite row is what the allowlist reads, and
 * removing the user account is what invalidates any session already issued.
 * Doing only the first leaves a signed-in browser working until its JWT ages
 * out. Desktop tokens are cut off separately — lib/desktop-guard.js re-checks
 * the allowlist on every request, so they stop within one request.
 */
export async function DELETE(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const url = new URL(req.url);
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  const id = url.searchParams.get('id');
  if (!email && !id) return NextResponse.json({ error: 'email or id required' }, { status: 400 });
  if (id) await deleteInviteRequest(id);
  // removeUserAccount drops the invite row AND the auth account in one go.
  if (email) await removeUserAccount(email);
  return NextResponse.json({ ok: true });
}
