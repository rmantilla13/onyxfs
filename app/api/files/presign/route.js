import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getStorageConfig, s3PresignPut, storageMode, cfgForFilespace, buildObjectKey } from '@/lib/storage';
import { getFilespaceForWrite, issueUploadKey } from '@/lib/db';
import { requirePrincipal, uploadCheck, can, refusal } from '@/lib/authz';

export const runtime = 'nodejs';

const THUMB_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * POST /api/files/presign  Body: { filename, contentType, size, folder, filespaceId?, thumb?, poster?, strip? }
 * Returns { putUrl, publicUrl, key } for a direct browser → custom-bucket PUT,
 * plus `cacheControl` for a preview (thumbnail, player poster or filmstrip),
 * which the PUT must send.
 * `folder` is baked into the object key so the bucket mirrors Onyx's folders.
 * Only valid when storage mode is 's3'.
 *
 * `size` is required for a file: it is checked against the largest upload
 * and the storage quota before anything is signed, and POST /api/files checks
 * again against the size that actually landed. A thumbnail, player poster or
 * filmstrip needs a role that can add or change files, and no size —
 * previews are not counted against anyone.
 */
export async function POST(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal, email } = g;

  const cfg = await getStorageConfig();
  if (storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'No custom bucket configured.', code: 'no_bucket' }, { status: 400 });
  }

  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  // Thumbnails go to a dedicated `_thumbs/` prefix — outside every filespace —
  // so they never show up as files in the listing or on a mounted drive. The
  // name is ours, not the client's: a fresh UUID never collides, and it is
  // what isThumbKey accepts when the key comes back to be recorded.
  let scoped = cfg;
  let folder = body.folder;
  let filename = body.filename;
  let contentType = body.contentType;
  let cacheControl;
  if (body.strip) {
    // A hover-scrub sprite sheet. WebP only: the sheet is 40 tiles, and JPEG
    // costs roughly three times the bytes for the same result.
    if (contentType !== 'image/webp') {
      return NextResponse.json({ error: 'A filmstrip must be WebP.' }, { status: 400 });
    }
    scoped = { ...cfg, prefix: '_thumbs' };
    folder = undefined;
    // `.strip.webp`, which isThumbKey does not match — so a strip can never be
    // recorded as a row's thumbnail, or the reverse.
    filename = `${randomUUID()}.strip.webp`;
    cacheControl = THUMB_CACHE_CONTROL;
  } else if (body.thumb || body.poster) {
    if (contentType !== 'image/webp' && contentType !== 'image/jpeg') {
      return NextResponse.json({ error: 'A thumbnail must be WebP or JPEG.' }, { status: 400 });
    }
    scoped = { ...cfg, prefix: '_thumbs' };
    folder = undefined;
    // A video's player poster is `.poster.<ext>`, which isThumbKey does not
    // match, so it can only ever be recorded in the poster column.
    filename = `${randomUUID()}${body.poster ? '.poster' : ''}.${contentType === 'image/webp' ? 'webp' : 'jpg'}`;
    // Never rewritten under the same key, so the browser may keep it.
    cacheControl = THUMB_CACHE_CONTROL;
  } else if (body.filespaceId) {
    // Scope the upload to a filespace's bucket prefix when one is selected, so the
    // object lands exactly where the desktop app mounts it. Adding to a drive
    // takes an editor or owner of it (lib/drive-access.js), after the ceiling
    // the platform role sets.
    const fs = await getFilespaceForWrite(email, body.filespaceId, principal);
    if (!fs) {
      return NextResponse.json({ error: 'You can view this drive but not add to it. Ask one of its owners for editor access.' }, { status: 403 });
    }
    scoped = cfgForFilespace(cfg, fs);
  }

  if (body.thumb || body.poster || body.strip) {
    // A preview for a new upload, or for an existing file someone may edit.
    const d = can(principal, 'files.upload');
    if (!d.ok && !can(principal, 'files.edit').ok) return refusal(d);
  } else {
    // Wherever it was aimed from, a file that would land inside a drive takes
    // an editor of that drive — an upload to All files included, should a
    // drive's prefix sit inside the library's. Previews are exempt: _thumbs/
    // is no drive's.
    const size = Number(body.size);
    if (body.size == null || body.size === '' || !Number.isFinite(size) || size < 0) {
      return NextResponse.json({ error: 'The upload needs its size in bytes.' }, { status: 400 });
    }
    const d = await uploadCheck(principal, { key: buildObjectKey(scoped, filename, folder), size });
    if (!d.ok) return refusal(d);
  }

  let out;
  try {
    out = await s3PresignPut(scoped, { filename, contentType, folder, cacheControl });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not presign upload.' }, { status: 500 });
  }
  if (!body.thumb && !body.poster && !body.strip) {
    // The key is this person's to record as a file (POST /api/files takes
    // only an issued key), and nobody else's. Unrecorded, the upload could
    // not be added to the library, so fail now rather than after the bytes.
    try { await issueUploadKey(out.key, email, { bucket: scoped.bucket }); } catch (e) {
      console.warn('[presign] could not record the issued key:', e.message);
      return NextResponse.json({ error: 'Could not start the upload. Try again.' }, { status: 503 });
    }
  }
  // S3 stores whatever Cache-Control the PUT carries, so the browser sends this.
  return NextResponse.json(cacheControl ? { ...out, cacheControl } : out);
}
