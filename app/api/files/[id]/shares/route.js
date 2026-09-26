import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, createShare, listSharesForFile } from '@/lib/db';
import { requirePrincipal, can, refusal, shareCapFor, shareKindsForKey } from '@/lib/authz';
import { parseShareRequest, shareKind } from '@/lib/share-kinds';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who may see and revoke a file's links: someone signed in with WRITE access
 * to the file (or an admin). Write rather than read, because a public link
 * takes a file outside the workspace — which is not something everyone who
 * can see it should be able to do.
 *
 * Deliberately not gated on the role's link capabilities or the `shares`
 * flag: this list is how links are revoked, and revoking only narrows
 * exposure. Making a link checks those, per kind, in POST.
 */
async function gate(id) {
  const g = await requirePrincipal();
  if (g.error) return g;
  const file = await getFileById(id);
  if (!file || file.deletedAt) return { error: NextResponse.json({ error: 'File not found' }, { status: 404 }) };
  const canModify = await canModifyFile(file, g.principal, { action: null });
  if (!canModify) {
    return { error: NextResponse.json({ error: 'You can view this file but not share it.' }, { status: 403 }) };
  }
  return { ...g, file, canModify };
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
 *
 * Each kind is its own capability — a private link stays inside the
 * workspace, a public or password one does not — and each is held to the
 * `shares` flag (read here, never taken from the client), the link kinds the
 * file's drive allows, and the longest expiry the role allows.
 */
export async function POST(req, { params }) {
  const g = await gate(params.id);
  if (g.error) return g.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = parseShareRequest(body);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const kind = parsed.password ? 'password' : parsed.mode;
  const allowed = can(g.principal, shareCapFor(kind), {
    canModify: g.canModify,
    kind,
    driveShareKinds: await shareKindsForKey(g.principal, g.file.storageKey),
    expiresInDays: parsed.expiresInDays,
  });
  if (!allowed.ok) return refusal(allowed);

  const { token, reused } = await createShare({
    fileId: g.file.id,
    createdBy: g.email,
    mode: parsed.mode,
    password: parsed.password,
    expiresInDays: parsed.expiresInDays,
  });
  if (!reused) {
    await audit(g.email, 'share.create', { type: 'file', id: g.file.id, label: g.file.name }, { kind, expiresInDays: parsed.expiresInDays });
  }
  const share = (await listSharesForFile(g.file.id)).find((s) => s.token === token);
  return NextResponse.json({ share: present(share) });
}
