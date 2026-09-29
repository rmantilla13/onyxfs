import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, setFileThumbnail, setFilePoster, previewKeysInUse } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { presignFileUrls } from '@/lib/storage';
import { previewKeysOf, dropUnusedPreviews } from '@/lib/preview-gc';
import { isThumbKey, isPosterKey, mediaFacts, thumbSizesFrom } from '@/lib/media';

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
 *
 * Both methods take the browser's session or Onyx for Mac's bearer token
 * (requirePrincipal(req)): the Mac makes the thumbnails a browser has not,
 * for the files of the drives it syncs and the files it uploads, and asks
 * and records exactly as a browser does.
 */
export async function GET(req, { params }) {
  const g = await requirePrincipal(req);
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
 * PUT /api/files/[id]/thumbnail  Body: { thumbnailKey, posterKey?, thumbSizes?, media? }
 *                                   or { posterKey, media? } — the preview alone
 *
 * Attach a thumbnail the browser made for a file that has none, whose
 * thumbnail is gone, or whose thumbnail is one of the old small ones — and
 * the large picture of the same frame (a video's player poster, an image's
 * preview), and which of the thumbnail's smaller siblings were uploaded
 * (sizes only: their keys are the thumbnail's, lib/media.js). The bytes went
 * to the bucket through the presign route, which named the keys; this only
 * records them. A write, so it takes the same files.edit capability and
 * canModifyFile check as PATCH.
 *
 * With no thumbnailKey, only the large preview is recorded (setFilePoster):
 * an image whose thumbnail stands, given the preview a writer's browser drew
 * from the original it fetched to show it. Nothing else about the row moves
 * — not its thumbnail or siblings, not seq — so every device and every other
 * browser keeps the thumbnail it has.
 */
export async function PUT(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal } = g;
  const allowed = can(principal, 'files.edit');
  if (!allowed.ok) return refusal(allowed);
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const posterOnly = body.thumbnailKey == null && body.posterKey != null;
  if (!posterOnly && !isThumbKey(body.thumbnailKey)) return NextResponse.json({ error: 'Not a thumbnail key.' }, { status: 400 });
  if (body.posterKey != null && !isPosterKey(body.posterKey)) return NextResponse.json({ error: 'Not a poster key.' }, { status: 400 });

  const existing = await getFileById(params.id);
  if (!existing || existing.deletedAt) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await canModifyFile(existing, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });

  // A key the presign route named, and no other file's: keys are not secret,
  // and adopting another file's preview would keep it signed on this row
  // after access to that file is gone — and let the sizes route sign PUTs
  // over that file's siblings (lib/db.js previewKeysInUse).
  let taken;
  try {
    taken = await previewKeysInUse([body.thumbnailKey, body.posterKey], { exceptId: existing.id });
  } catch (e) {
    return NextResponse.json({ error: 'Could not check the thumbnail. Try again.' }, { status: 503 });
  }
  if (taken.size) return NextResponse.json({ error: 'That preview belongs to another file.' }, { status: 409 });

  let file;
  try {
    file = posterOnly
      ? await setFilePoster(existing.id, body.posterKey, mediaFacts(body.media))
      : await setFileThumbnail(existing.id, body.thumbnailKey, mediaFacts(body.media), body.posterKey || null, thumbSizesFrom(body.thumbSizes));
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
 * lib/preview-gc.js says which keys are ever candidates (only ones the
 * presign route names) and takes a replaced thumbnail's siblings with it.
 */
async function dropReplaced(before, after) {
  const keep = new Set([after.thumbnailKey, after.posterKey].filter(Boolean));
  const { thumbKeys, posterKeys } = previewKeysOf(before);
  await dropUnusedPreviews({ thumbKeys: thumbKeys.filter((k) => !keep.has(k)), posterKeys: posterKeys.filter((k) => !keep.has(k)) });
}
