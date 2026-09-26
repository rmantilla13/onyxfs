import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, setFileThumbnail } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { presignFileUrls } from '@/lib/storage';
import { isThumbKey, mediaFacts } from '@/lib/media';

export const runtime = 'nodejs';

/**
 * PUT /api/files/[id]/thumbnail  Body: { thumbnailKey, media? }
 *
 * Attach a thumbnail the browser made for a file that has none (or whose
 * thumbnail is gone). The bytes went to the bucket through the presign route,
 * which named the key; this only records it. A write, so it takes the same
 * files.edit capability and canModifyFile check as PATCH.
 */
export async function PUT(req, { params }) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal } = g;
  const allowed = can(principal, 'files.edit');
  if (!allowed.ok) return refusal(allowed);
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!isThumbKey(body.thumbnailKey)) return NextResponse.json({ error: 'Not a thumbnail key.' }, { status: 400 });

  const existing = await getFileById(params.id);
  if (!existing || existing.deletedAt) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await canModifyFile(existing, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });

  try {
    const file = await setFileThumbnail(existing.id, body.thumbnailKey, mediaFacts(body.media));
    const [signed] = await presignFileUrls([file]);
    return NextResponse.json({ file: signed || file });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not save the thumbnail.' }, { status: 500 });
  }
}
