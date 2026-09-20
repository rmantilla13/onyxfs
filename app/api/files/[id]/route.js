import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { updateFile, softDeleteFile, deleteFile, getFileById, getFileMetadataSchema, getFeatureFlags } from '@/lib/db';
import { getStorageConfig, storageMode, s3MoveObject, s3DeleteObject } from '@/lib/storage';
import { normalizeSchema, validateMetadataPatch } from '@/lib/dam';

export const runtime = 'nodejs';

export const TRASH_PREFIX = '_trash';

/** PATCH /api/files/[id] — rename / move / tag / note / metadata. */
export async function PATCH(req, { params }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { id } = params;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  // Sanitize the metadata object against the field schema (drop unknown keys /
  // coerce types) so only valid fields are stored.
  if (body.metadata !== undefined) {
    const schema = normalizeSchema(await getFileMetadataSchema());
    body.metadata = validateMetadataPatch(body.metadata, schema);
  }
  try {
    const file = await updateFile(id, body);
    return NextResponse.json({ file });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Update failed.' }, { status: 500 });
  }
}

/**
 * DELETE /api/files/[id]
 *
 * With the `trash` feature on (the default) this is a soft delete: on S3 the
 * object is MOVED out of its prefix into `_trash/<id>/<key>`, so it disappears
 * from a mounted drive too rather than lingering in Finder after being deleted
 * on the web. The catalog row is flagged, not removed, and the daily
 * maintenance cron purges both after the retention window.
 *
 * With `trash` off, the object and the row are removed immediately.
 *
 * Which of the two happens is decided HERE, from the server's own flag state —
 * never from a request parameter. Letting the caller pick would make a
 * disabled-trash deployment's safety net bypassable with a query string.
 */
export async function DELETE(_req, { params }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { id } = params;
  try {
    const file = await getFileById(id);
    if (!file) return NextResponse.json({ ok: true }); // already gone

    const flags = await getFeatureFlags();
    const cfg = await getStorageConfig();
    const onS3 = file.storage === 's3' && file.storageKey && storageMode(cfg) === 's3';

    if (flags.trash === false) {
      if (onS3) {
        try {
          await s3DeleteObject(cfg, file.storageKey);
        } catch (e) {
          return NextResponse.json({ error: `Could not delete the stored object: ${e.message}` }, { status: 500 });
        }
      }
      await deleteFile(id);
      return NextResponse.json({ ok: true, trashed: false });
    }

    let trashKey = null;
    if (onS3) {
      try {
        trashKey = `${TRASH_PREFIX}/${id}/${file.storageKey}`;
        await s3MoveObject(cfg, file.storageKey, trashKey);
      } catch (e) {
        // Never silently lose the file — a failed move must surface, not
        // leave a row flagged as trashed while the object stays put.
        return NextResponse.json({ error: `Could not move file to trash: ${e.message}` }, { status: 500 });
      }
    }
    await softDeleteFile(id, { trashKey });
    return NextResponse.json({ ok: true, trashed: true });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Delete failed.' }, { status: 500 });
  }
}
