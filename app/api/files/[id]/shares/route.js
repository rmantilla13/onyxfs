import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFileById, buildPrincipal, canModifyFile, createShare, listSharesForFile } from '@/lib/db';
import { flagsForUser } from '@/lib/user-flags';
import { parseShareRequest, shareKind } from '@/lib/share-kinds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who may manage a file's links: someone signed in, whose role keeps the
 * `shares` feature, with WRITE access to the file. Write rather than read,
 * because a public link takes a file outside the workspace — which is not
 * something everyone who can see it should be able to do. The flag is read
 * here, not trusted from the client.
 */
async function gate(id) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const { flags } = await flagsForUser(email);
  if (!flags.shares) return { error: NextResponse.json({ error: 'Sharing is turned off for your role.' }, { status: 403 }) };
  const file = await getFileById(id);
  if (!file || file.deletedAt) return { error: NextResponse.json({ error: 'File not found' }, { status: 404 }) };
  const principal = await buildPrincipal(email);
  if (!(await canModifyFile(file, principal))) {
    return { error: NextResponse.json({ error: 'You can view this file but not share it.' }, { status: 403 }) };
  }
  return { email, file };
}

// What the dialog shows for a link. Never the password or its hash.
const present = (s) => ({
  token: s.token,
  kind: shareKind(s),
  expiresAt: s.expiresAt,
  viewCount: s.viewCount,
  createdAt: s.createdAt,
  createdBy: s.createdBy,
});

/** GET /api/files/[id]/shares → { shares } — the file's links, newest first. */
export async function GET(_req, { params }) {
  const g = await gate(params.id);
  if (g.error) return g.error;
  return NextResponse.json({ shares: (await listSharesForFile(g.file.id)).map(present) });
}

/**
 * POST /api/files/[id]/shares { kind: 'public'|'password'|'private',
 * password?, expires: 'never'|'1'|'7'|'30' } → { share }.
 */
export async function POST(req, { params }) {
  const g = await gate(params.id);
  if (g.error) return g.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = parseShareRequest(body);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { token } = await createShare({
    fileId: g.file.id,
    createdBy: g.email,
    mode: parsed.mode,
    password: parsed.password,
    expiresInDays: parsed.expiresInDays,
  });
  const share = (await listSharesForFile(g.file.id)).find((s) => s.token === token);
  return NextResponse.json({ share: present(share) });
}
