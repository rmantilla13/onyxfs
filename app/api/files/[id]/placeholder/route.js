import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, setFilePlaceholder } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { presignFileUrls } from '@/lib/storage';
import { isThumbKey } from '@/lib/media';
import { placeholderFacts } from '@/lib/placeholder';

export const runtime = 'nodejs';

/**
 * PUT /api/files/[id]/placeholder  Body: { placeholder, thumbnailKey }
 *
 * Record the tiny copy of a file's thumbnail (lib/placeholder.js) that its
 * tile shows while the thumbnail loads — for a thumbnail made before there
 * were placeholders, drawn by an editor's browser from its smallest sibling.
 * `thumbnailKey` is the thumbnail it was drawn from: when the row's is not
 * that one any more, 409, and nothing is written. The same checks as the
 * thumbnail route: files.edit, then canModifyFile — asked before the body is
 * read.
 */
export async function PUT(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal } = g;
  const allowed = can(principal, 'files.edit');
  if (!allowed.ok) return refusal(allowed);
  const existing = await getFileById(params.id);
  if (!existing || existing.deletedAt) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await canModifyFile(existing, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });

  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const placeholder = placeholderFacts(body?.placeholder);
  if (!placeholder) return NextResponse.json({ error: 'Not a placeholder.' }, { status: 400 });
  if (!isThumbKey(body.thumbnailKey)) return NextResponse.json({ error: 'Not a thumbnail key.' }, { status: 400 });

  let file;
  try {
    file = await setFilePlaceholder(existing.id, placeholder, { thumbnailKey: body.thumbnailKey });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not save the placeholder.' }, { status: 500 });
  }
  if (file === 'changed') return NextResponse.json({ error: 'The thumbnail changed since.' }, { status: 409 });
  if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const [signed] = await presignFileUrls([file]);
  return NextResponse.json({ file: signed || file });
}
