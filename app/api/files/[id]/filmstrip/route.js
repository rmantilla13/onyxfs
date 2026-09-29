import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, setFileFilmstrip, previewKeysInUse } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { presignFileUrls } from '@/lib/storage';
import { dropUnusedPreviews } from '@/lib/preview-gc';
import { isFilmstripKey, filmstripFacts, effectiveKind } from '@/lib/media';

export const runtime = 'nodejs';

/**
 * PUT /api/files/[id]/filmstrip  Body: { filmstripKey, filmstrip: { frames, columns, tileWidth, tileHeight } }
 *
 * Attach a video's hover-scrub sheet to a file already recorded. A browser
 * draws the sheet from the local file while it uploads (lib/filmstrip-client.js)
 * — forty seeks, slow in a hidden tab — and the upload is recorded without
 * waiting for it (lib/upload-client.js): the sheet comes here once it is in
 * the bucket, under the key the presign route named. The same checks as the
 * thumbnail PUT beside this: the files.edit capability, canModifyFile, a key
 * of the filmstrip kind (isFilmstripKey) with a geometry that describes a
 * decodable sheet (filmstripFacts) — both halves, as POST /api/files takes
 * them — and a key no other row holds; and the file is a video.
 *
 * Not on the Mac's bearer paths (lib/bearer-gate.js): only a browser makes
 * these.
 */
export async function PUT(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal } = g;
  const allowed = can(principal, 'files.edit');
  if (!allowed.ok) return refusal(allowed);
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!isFilmstripKey(body.filmstripKey)) return NextResponse.json({ error: 'Not a filmstrip key.' }, { status: 400 });
  const facts = filmstripFacts(body.filmstrip);
  if (!facts) return NextResponse.json({ error: 'Not a filmstrip layout.' }, { status: 400 });

  const existing = await getFileById(params.id);
  if (!existing || existing.deletedAt) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await canModifyFile(existing, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });
  // Only a video is scrubbed; a browser draws a sheet for nothing else
  // (lib/filmstrip-client.js), and one on another row would only be kept
  // alive by it.
  if (effectiveKind(existing) !== 'video') return NextResponse.json({ error: 'Only a video has a filmstrip.' }, { status: 400 });

  // A key the presign route named, and no other file's: keys are not secret,
  // and adopting another file's sheet would keep it signed on this row after
  // access to that file is gone (lib/db.js previewKeysInUse).
  let taken;
  try {
    taken = await previewKeysInUse([body.filmstripKey], { exceptId: existing.id });
  } catch {
    return NextResponse.json({ error: 'Could not check the filmstrip. Try again.' }, { status: 503 });
  }
  if (taken.size) return NextResponse.json({ error: 'That preview belongs to another file.' }, { status: 409 });

  let file;
  try {
    file = await setFileFilmstrip(existing.id, body.filmstripKey, facts);
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not save the filmstrip.' }, { status: 500 });
  }
  if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // The sheet this one replaced goes, once no row points at it; it would
  // otherwise stay in the bucket for good, reachable by nothing
  // (lib/preview-gc.js).
  if (existing.filmstripKey && existing.filmstripKey !== file.filmstripKey) {
    await dropUnusedPreviews({ stripKeys: [existing.filmstripKey] });
  }
  const [signed] = await presignFileUrls([file]);
  return NextResponse.json({ file: signed || file });
}
