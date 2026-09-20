import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFileById, getFileAcl, setFileAcl, buildPrincipal } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function ownerGate(id, email) {
  const file = await getFileById(id);
  if (!file) return { error: NextResponse.json({ error: 'File not found' }, { status: 404 }) };
  const principal = await buildPrincipal(email);
  const isOwner = principal.isAdmin || (file.createdBy || '').toLowerCase() === principal.email;
  if (!isOwner) return { error: NextResponse.json({ error: 'Only the owner or an admin can change sharing.' }, { status: 403 }) };
  return { file, principal };
}

/** GET → { visibility, acl } for a file the caller owns. */
export async function GET(req, { params }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const gate = await ownerGate(params.id, session.user.email);
  if (gate.error) return gate.error;
  return NextResponse.json({ visibility: gate.file.visibility, acl: await getFileAcl(params.id) });
}

/** PUT { visibility, users[], roles[] } — replace a file's sharing/ACL. */
export async function PUT(req, { params }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const gate = await ownerGate(params.id, session.user.email);
  if (gate.error) return gate.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  await setFileAcl(params.id, {
    visibility: body.visibility,
    users: Array.isArray(body.users) ? body.users : [],
    roles: Array.isArray(body.roles) ? body.roles : [],
    grantedBy: gate.principal.email,
  });
  return NextResponse.json({ ok: true });
}
