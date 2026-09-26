import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  updateFile, softDeleteFile, deleteFile, getFileById, getFileMetadataSchema,
  getFeatureFlags, buildPrincipal, canModifyFile, canAccessFile,
  setFileStorageKey, getFilespaceForWrite,
} from '@/lib/db';
import {
  getStorageConfig, storageMode, s3MoveObject, s3DeleteObject, presignFileUrls,
  cfgForFilespace, folderToKeyPath, s3UniqueKey, s3ObjectExists, safeObjectName,
} from '@/lib/storage';
import { normalizeSchema, validateMetadataPatch } from '@/lib/dam';
import { keyFor, fileNameProblem } from '@/lib/folder-ops';

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
  // A trashed file is gone until it is restored: its row waits for the purge,
  // and a URL minted for it now would outlive the decision to delete it.
  if (!file || file.deletedAt) return NextResponse.json({ error: 'File not found' }, { status: 404 });

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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  // Never from here. The listing presigns whatever a row's thumbnail points
  // at, so a key or URL taken from the client would let anyone who can edit
  // one file mint a download link for any object in the bucket — another
  // drive's included. Thumbnails are recorded by PUT /api/files/[id]/thumbnail
  // and POST /api/files, which accept only a key the server named.
  delete body.thumbnailKey;
  delete body.thumbnailUrl;

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
  // coerce types) so only valid fields are stored. Read fresh: the settings
  // cache is per instance, and a field an admin added a moment ago on another
  // instance would otherwise be an "unknown key" here and silently dropped.
  if (body.metadata !== undefined) {
    const schema = normalizeSchema(await getFileMetadataSchema({ fresh: true }));
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

  // A rename on its own. The object's key ends in its name, so renaming only
  // the row would leave a mounted drive showing the old one; the key follows
  // when the object sits where this scope's uploads put it.
  if (body.name !== undefined) {
    const problem = fileNameProblem(body.name);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    body.name = String(body.name).trim();
  }
  const renamingTo = movingTo === null && body.name !== undefined && body.name !== existing.name ? body.name : null;
  if (renamingTo !== null && existing.storage === 's3' && existing.storageKey) {
    const base = await getStorageConfig();
    if (storageMode(base) === 's3') {
      const filespaceId = body.filespaceId || new URL(req.url).searchParams.get('filespace') || null;
      // Writing under a drive's prefix takes an editor of it.
      const fs = filespaceId ? await getFilespaceForWrite(session.user.email, filespaceId) : null;
      if (filespaceId && !fs) return NextResponse.json({ error: 'You can view this drive but not change it.' }, { status: 403 });
      const cfg = fs ? cfgForFilespace(base, fs) : base;
      const root = (fs ? String(fs.prefix || '') : String(base.prefix || 'files')).replace(/^\/+|\/+$/g, '');
      const dir = existing.storageKey.slice(0, existing.storageKey.lastIndexOf('/') + 1);
      if (root && existing.storageKey.startsWith(`${root}/`)) {
        const newKey = `${dir}${safeObjectName(renamingTo)}`;
        if (newKey !== existing.storageKey) {
          // Refuse rather than rename to "name (2)": the person asked for this
          // name, and silently getting another is worse than being told.
          if (await s3ObjectExists(cfg, newKey).catch(() => false)) {
            return NextResponse.json({ error: `A file called “${renamingTo}” is already stored in this folder.` }, { status: 409 });
          }
          try {
            await s3MoveObject(cfg, existing.storageKey, newKey);
          } catch (e) {
            return NextResponse.json({ error: `Could not rename the stored object: ${e.message}` }, { status: 500 });
          }
          try {
            await setFileStorageKey(id, newKey);
          } catch (e) {
            return NextResponse.json({
              error: `The object was renamed but its new key could not be recorded (${e.message}). It is now at ${newKey}.`,
            }, { status: 500 });
          }
        }
        objectMoved = true;
      } else {
        // Another filespace's object, seen from here: rename the row only.
        objectMoved = false;
      }
    }
  }

  try {
    if (movingTo !== null && existing.storage === 's3' && existing.storageKey) {
      const base = await getStorageConfig();
      // Scope comes from the body like the folders route; the list route spells
      // the same thing ?filespace=, so accept either rather than silently
      // downgrading a scoped move to a catalog-only one.
      const filespaceId = body.filespaceId || new URL(req.url).searchParams.get('filespace') || null;
      // Writing under a drive's prefix takes an editor of it.
      const fs = filespaceId ? await getFilespaceForWrite(session.user.email, filespaceId) : null;
      if (filespaceId && !fs) return NextResponse.json({ error: 'You can view this drive but not change it.' }, { status: 403 });
      // Unscoped, the file is movable when its key sits where an unscoped
      // upload would have put it (`<base prefix>/<folder>/<name>`); a key in
      // some filespace's prefix is not, since which bucket and prefix to
      // re-key it under is unknown from here.
      const name0 = existing.storageKey.slice(existing.storageKey.lastIndexOf('/') + 1);
      const unscopedOk = !fs && existing.storageKey === keyFor(base.prefix || 'files', existing.folder, name0);
      if (storageMode(base) === 's3') {
        if (!fs && !unscopedOk) {
          // The catalog move still happens; the flag is how the UI can say so.
          objectMoved = false;
        } else {
          const cfg = fs ? cfgForFilespace(base, fs) : base;
          const prefix = (cfg.prefix || (fs ? '' : 'files')).replace(/^\/+|\/+$/g, '');
          const name = existing.storageKey.slice(existing.storageKey.lastIndexOf('/') + 1);
          let newKey = [prefix, folderToKeyPath(movingTo), name].filter(Boolean).join('/');
          // CopyObject overwrites. A file of the same name already in the
          // destination would silently lose its bytes to this one, so take the
          // next free name the way an upload does ("a (2).jpg"), and keep the
          // catalog name matching what a mounted drive shows.
          if (newKey !== existing.storageKey) {
            newKey = await s3UniqueKey(cfg, newKey);
            const landed = newKey.slice(newKey.lastIndexOf('/') + 1);
            if (landed !== name && existing.name === name && body.name === undefined) body.name = landed;
          }
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
