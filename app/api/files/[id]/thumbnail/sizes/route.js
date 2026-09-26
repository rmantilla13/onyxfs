import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFileById, buildPrincipal, canModifyFile, recordThumbSizes, previewKeysInUse } from '@/lib/db';
import { getStorageConfig, storageMode, s3PresignSiblingPut, presignFileUrls } from '@/lib/storage';
import { isThumbKey, thumbSiblingKey, thumbSizesFrom, THUMB_SIZES, PREVIEW_CACHE_CONTROL } from '@/lib/media';

export const runtime = 'nodejs';

/**
 * The smaller siblings of a file's grid thumbnail (lib/poster.js: sm covers a
 * card, xs a list row), for a file that has a thumbnail but none of them — a
 * file from before they were made at upload. An editor's browser draws them
 * from the grid thumbnail it already shows, about 70 KB, never from the
 * original.
 *
 *   POST  → { thumbnailKey, contentType, cacheControl, siblings: { sm: { putUrl, key }, xs } }
 *           PUT URLs for the siblings of the row's CURRENT thumbnail. The keys
 *           are derived from that thumbnail's key on the server; nothing the
 *           client sends names an object.
 *   PUT   { thumbnailKey, sizes } → { file }: records which were uploaded, if
 *           the row still has that thumbnail (a thumbnail replaced in the
 *           meantime has no siblings yet).
 *
 * Both are writes, behind the same check as the thumbnail PUT (canModifyFile,
 * which applies drive rules). A viewer is refused before anything is signed.
 *
 * And both are refused for a thumbnail another row also holds. Being able to
 * edit this row is not being able to edit that one, and the siblings are
 * named after the thumbnail: signing them here would sign PUTs over another
 * file's renditions. The thumbnail PUT and the upload no longer record a key
 * another row uses (lib/db.js previewKeysInUse), but a row written before
 * they checked may still share one.
 */
async function authorize(id) {
  const session = await auth();
  if (!session?.user?.email) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const existing = await getFileById(id);
  if (!existing || existing.deletedAt) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  const principal = await buildPrincipal(session.user.email);
  if (!(await canModifyFile(existing, principal))) return { error: NextResponse.json({ error: 'No access' }, { status: 403 }) };
  return { existing };
}

/** A refusal when another row holds this row's thumbnail (or when that cannot be told), else null. */
async function sharedThumbnail(existing) {
  let taken;
  try {
    taken = await previewKeysInUse([existing.thumbnailKey], { exceptId: existing.id });
  } catch {
    return NextResponse.json({ error: 'Could not check the thumbnail. Try again.' }, { status: 503 });
  }
  return taken.size ? NextResponse.json({ error: 'That preview belongs to another file.' }, { status: 409 }) : null;
}

export async function POST(_req, { params }) {
  const { error, existing } = await authorize(params.id);
  if (error) return error;
  if (!isThumbKey(existing.thumbnailKey)) {
    return NextResponse.json({ error: 'This file has no thumbnail to make smaller ones from.' }, { status: 409 });
  }
  const shared = await sharedThumbnail(existing);
  if (shared) return shared;
  const cfg = await getStorageConfig();
  if (storageMode(cfg) !== 's3') return NextResponse.json({ error: 'No custom bucket configured.', code: 'no_bucket' }, { status: 400 });
  const contentType = existing.thumbnailKey.endsWith('.jpg') ? 'image/jpeg' : 'image/webp';
  try {
    const siblings = {};
    for (const size of THUMB_SIZES) {
      const key = thumbSiblingKey(existing.thumbnailKey, size);
      if (key) siblings[size] = await s3PresignSiblingPut(cfg, key, { contentType, cacheControl: PREVIEW_CACHE_CONTROL });
    }
    return NextResponse.json(
      { thumbnailKey: existing.thumbnailKey, contentType, cacheControl: PREVIEW_CACHE_CONTROL, siblings },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not presign.' }, { status: 500 });
  }
}

export async function PUT(req, { params }) {
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!isThumbKey(body.thumbnailKey)) return NextResponse.json({ error: 'Not a thumbnail key.' }, { status: 400 });
  const sizes = thumbSizesFrom(body.sizes);
  if (!sizes) return NextResponse.json({ error: 'No sizes.' }, { status: 400 });
  const { error, existing } = await authorize(params.id);
  if (error) return error;
  if (existing.thumbnailKey !== body.thumbnailKey) {
    return NextResponse.json({ error: 'The thumbnail changed.' }, { status: 409 });
  }
  const shared = await sharedThumbnail(existing);
  if (shared) return shared;
  const stored = await recordThumbSizes(existing.id, sizes, { thumbnailKey: body.thumbnailKey });
  if (!stored) return NextResponse.json({ error: 'The thumbnail changed.' }, { status: 409 });
  const [signed] = await presignFileUrls([{ ...existing, thumbSizes: stored.split(',') }], { filmstrip: false });
  return NextResponse.json({ file: signed });
}
