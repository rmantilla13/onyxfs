import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, setFileThumbnail, unreferencedPreviewKeys, previewKeysInUse } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { presignFileUrls, getStorageConfig, s3DeleteObject } from '@/lib/storage';
import { isThumbKey, isPosterKey, mediaFacts } from '@/lib/media';

export const runtime = 'nodejs';

/**
 * GET /api/files/[id]/thumbnail — 204 when the caller may record a thumbnail
 * for this file (the PUT below would be allowed), 403 or 404 when not.
 *
 * The backfill queue asks this before it decodes anything. Making a
 * thumbnail means downloading the original and uploading two previews, and
 * being able to write to the library is not being able to write to every
 * file in it; learning that from the PUT came after all of that work, and
 * left the uploads behind with nothing pointing at them. The same checks as
 * the PUT: the files.edit capability, then canModifyFile.
 */
export async function GET(_req, { params }) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal } = g;
  const allowed = can(principal, 'files.edit');
  if (!allowed.ok) return refusal(allowed);
  const existing = await getFileById(params.id);
  if (!existing || existing.deletedAt) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await canModifyFile(existing, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/**
 * PUT /api/files/[id]/thumbnail  Body: { thumbnailKey, posterKey?, media? }
 *
 * Attach a thumbnail the browser made for a file that has none, whose
 * thumbnail is gone, or whose thumbnail is one of the old small ones — and,
 * for a video, the player poster of the same frame. The bytes went to the
 * bucket through the presign route, which named the keys; this only records
 * them. A write, so it takes the same files.edit capability and
 * canModifyFile check as PATCH.
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
  if (body.posterKey != null && !isPosterKey(body.posterKey)) return NextResponse.json({ error: 'Not a poster key.' }, { status: 400 });

  const existing = await getFileById(params.id);
  if (!existing || existing.deletedAt) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await canModifyFile(existing, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });

  // A key the presign route named, and no other file's: keys are not secret,
  // and adopting another file's preview would keep it signed on this row
  // after access to that file is gone (lib/db.js previewKeysInUse).
  let taken;
  try {
    taken = await previewKeysInUse([body.thumbnailKey, body.posterKey], { exceptId: existing.id });
  } catch (e) {
    return NextResponse.json({ error: 'Could not check the thumbnail. Try again.' }, { status: 503 });
  }
  if (taken.size) return NextResponse.json({ error: 'That preview belongs to another file.' }, { status: 409 });

  let file;
  try {
    file = await setFileThumbnail(existing.id, body.thumbnailKey, mediaFacts(body.media), body.posterKey || null);
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not save the thumbnail.' }, { status: 500 });
  }
  if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await dropReplaced(existing, file);
  const [signed] = await presignFileUrls([file]);
  return NextResponse.json({ file: signed || file });
}

/**
 * Delete the previews this write replaced, once no row points at them. Every
 * old small thumbnail is replaced exactly once as the library is browsed, and
 * each would otherwise stay in the bucket for good, reachable by nothing.
 *
 * Only keys the presign route names (`_thumbs/<uuid>…`) are ever candidates —
 * never a legacy thumbnail stored beside the files, never a file. Best-effort:
 * a preview left behind costs a few kilobytes; a failed save would cost the
 * thumbnail.
 */
async function dropReplaced(before, after) {
  try {
    const keep = new Set([after.thumbnailKey, after.posterKey].filter(Boolean));
    const thumbKeys = isThumbKey(before.thumbnailKey) && !keep.has(before.thumbnailKey) ? [before.thumbnailKey] : [];
    const posterKeys = isPosterKey(before.posterKey) && !keep.has(before.posterKey) ? [before.posterKey] : [];
    const unused = await unreferencedPreviewKeys({ thumbKeys, posterKeys });
    if (!unused.length) return;
    const cfg = await getStorageConfig();
    await Promise.all(unused.map((key) => s3DeleteObject(cfg, key).catch(() => false)));
  } catch (e) {
    console.warn('[thumbnail] could not remove a replaced preview:', e.message);
  }
}
