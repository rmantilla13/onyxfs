import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  updateFile, softDeleteFile, deleteFile, getFileById, getFileMetadataSchema,
  getFeatureFlags, buildPrincipal, canModifyFile, canAccessFile,
  setFileStorageKey, getFilespaceForUser,
} from '@/lib/db';
import {
  getStorageConfig, storageMode, s3MoveObject, s3DeleteObject, presignFileUrls,
  cfgForFilespace, folderToKeyPath,
} from '@/lib/storage';
import { normalizeSchema, validateMetadataPatch } from '@/lib/dam';

export const runtime = 'nodejs';

export const TRASH_PREFIX = '_trash';

// Long enough that a video paused mid-watch still seeks when it resumes. The
// listing signs for an hour, which is right for a thumbnail; a player issues
// a range request per seek, so an expired URL there fails as the browser's
// generic media error with nothing to explain it. Six hours is what
// s3PresignGet already documents as the playable-video default.
const DETAIL_URL_TTL = 21600;

/** GET /api/files/[id] — one file, authorized and presigned for playback. */
export async function GET(_req, { params }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const file = await getFileById(params.id);
  if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 });

  // Authorize → presign, in that order, so a URL is never minted for a file
  // the caller may not have.
  const principal = await buildPrincipal(session.user.email);
  if (!(await canAccessFile(file, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });

  const [signed] = await presignFileUrls([file], { expiresIn: DETAIL_URL_TTL });
  return NextResponse.json({
    file: signed,
    // The detail view hides the controls it would only get a 403 from.
    canWrite: await canModifyFile(file, principal),
  });
}

/**
 * The version an `If-Match` header is asserting, or undefined when the request
 * states no condition. HTTP clients quote an entity tag by habit, so `"7"`,
 * `W/"7"` and a bare `7` all mean the same thing here. `*` is the standard
 * "any current representation", i.e. no condition at all.
 *
 * A value we cannot parse comes back NaN, which fails the equality check at
 * the call site and so lands in the 409 branch — a precondition that cannot be
 * verified must not be treated as satisfied.
 */
function ifMatchVersion(raw) {
  if (raw == null) return undefined;
  const v = raw.trim().replace(/^W\//i, '').replace(/^"(.*)"$/s, '$1').trim();
  if (!v || v === '*') return undefined;
  return Number(v);
}

/**
 * PATCH /api/files/[id] — rename / move / tag / note / metadata.
 *
 * Authorized per file, not merely per session. Being signed in used to be the
 * whole check here, which meant any member could rename or re-tag anything in
 * the workspace by id. canModifyFile is a WRITE check and deliberately
 * stricter than the canAccessFile used for reads — see the note above it in
 * lib/db.js.
 *
 * Optionally conditional: `If-Match: <version>` (the `version` the client last
 * saw on the row) makes the write fail with 409 instead of clobbering someone
 * else's edit. The web UI does not send it yet, so an absent header is an
 * unconditional write, exactly as before.
 *
 * A folder change is a MOVE, and moves the object too — see below.
 */
export async function PATCH(req, { params }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { id } = params;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const existing = await getFileById(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const principal = await buildPrincipal(session.user.email);
  if (!(await canModifyFile(existing, principal))) {
    return NextResponse.json({ error: 'No access' }, { status: 403 });
  }

  const want = ifMatchVersion(req.headers.get('if-match'));
  if (want !== undefined && want !== Number(existing.version)) {
    // Hand back the row as it now stands, not just the number, so a client can
    // merge its edit against reality instead of re-fetching and guessing.
    return NextResponse.json({
      error: 'This file changed since you loaded it.',
      code: 'version_mismatch',
      currentVersion: Number(existing.version),
      file: existing,
    }, { status: 409 });
  }

  // Sanitize the metadata object against the field schema (drop unknown keys /
  // coerce types) so only valid fields are stored.
  if (body.metadata !== undefined) {
    const schema = normalizeSchema(await getFileMetadataSchema());
    body.metadata = validateMetadataPatch(body.metadata, schema);
  }

  // The object key encodes the folder, so changing `files.folder` alone leaves
  // the bucket where it was: the web and a mounted drive disagree, and the next
  // folder rename — which re-keys by folder prefix — re-keys the wrong set.
  const movingTo = body.folder !== undefined && String(body.folder) !== String(existing.folder || '')
    ? String(body.folder)
    : null;
  // Left undefined while the question does not arise (no move, or nothing in
  // the bucket to move); set to false only when the catalog moved without the
  // bytes, which is the one case a UI has to surface.
  let objectMoved;

  try {
    if (movingTo !== null && existing.storage === 's3' && existing.storageKey) {
      const base = await getStorageConfig();
      // Scope comes from the body like the folders route; the list route spells
      // the same thing ?filespace=, so accept either rather than silently
      // downgrading a scoped move to a catalog-only one.
      const filespaceId = body.filespaceId || new URL(req.url).searchParams.get('filespace') || null;
      const fs = filespaceId ? await getFilespaceForUser(session.user.email, filespaceId) : null;
      if (storageMode(base) === 's3') {
        if (!fs) {
          // Cross-prefix "All files" view. Without a filespace its prefix is
          // unknown, so the destination key cannot be computed — the folders
          // route skips the physical move here for the same reason. The
          // catalog move still happens; the flag is how the UI can say so.
          objectMoved = false;
        } else {
          const cfg = cfgForFilespace(base, fs);
          const prefix = (cfg.prefix || '').replace(/^\/+|\/+$/g, '');
          const name = existing.storageKey.slice(existing.storageKey.lastIndexOf('/') + 1);
          const newKey = [prefix, folderToKeyPath(movingTo), name].filter(Boolean).join('/');
          // True also when the key already reads right and nothing physical was
          // needed: what this reports is whether bucket and catalog agree.
          objectMoved = true;
          if (newKey !== existing.storageKey) {
            try {
              await s3MoveObject(cfg, existing.storageKey, newKey);
            } catch (e) {
              // Bytes first, and if the bytes do not move, nothing moves. The
              // folders route tolerates a partly-done bulk rename because the
              // alternative is abandoning hundreds of files mid-way; one file
              // has no such excuse, and a row pointing at a key that does not
              // exist is a file gone unreachable with no trace of where to.
              return NextResponse.json({ error: `Could not move the stored object: ${e.message}` }, { status: 500 });
            }
            try {
              // The old key died with the copy+delete, so record the new one
              // before the folder write rather than after it: ordered the other
              // way, a failure here would leave the row pointing at nothing.
              await setFileStorageKey(id, newKey);
            } catch (e) {
              return NextResponse.json({
                error: `The object moved but its new key could not be recorded (${e.message}). It is now at ${newKey}.`,
              }, { status: 500 });
            }
          }
        }
      }
    }

    const file = await updateFile(id, body);
    return NextResponse.json(objectMoved === undefined ? { file } : { file, objectMoved });
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

    // Same write gate as PATCH. A delete that only checks for a session is
    // the most destructive version of the same hole.
    const principal = await buildPrincipal(session.user.email);
    if (!(await canModifyFile(file, principal))) {
      return NextResponse.json({ error: 'No access' }, { status: 403 });
    }

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
