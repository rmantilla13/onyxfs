import { NextResponse } from 'next/server';
import {
  createUpload, getUpload, deleteUpload, touchUpload, listUploads, getFilespaceForUser, getFilespaceForWrite,
  issueUploadKey,
} from '@/lib/db';
import { requirePrincipal, uploadCheck, can, refusal } from '@/lib/authz';
import {
  getStorageConfig, storageMode, cfgForFilespace, choosePartSize, partCount, buildObjectKey,
  s3CreateMultipartUpload, s3PresignUploadParts, s3ListParts,
  s3CompleteMultipartUpload, s3AbortMultipartUpload,
} from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resumable multipart upload.
 *
 * A single presigned PUT caps at 5 GB and loses everything on a dropped
 * connection. This splits the object into independently signed, independently
 * retryable parts.
 *
 * Actions (POST body `action`):
 *   create    → start an upload, get { id, partSize, partCount }
 *   sign      → presign a batch of part URLs
 *   status    → which parts S3 already holds (this is what resume reads)
 *   complete  → assemble the parts into the final object
 *   abort     → discard the upload and its parts
 *
 * Every action after `create` re-loads the upload scoped to the caller's email.
 * An upload id plus a part number is enough to write bytes into an object, so
 * ownership is re-proved on each call rather than assumed from the first one.
 */

/**
 * Resolve the storage config for this upload, honouring its filespace (drive)
 * scope. Writing into a drive takes an editor or owner of it, checked on
 * every call — someone made a viewer mid-upload cannot finish it — while
 * reading its parts or abandoning it only takes membership.
 * → { cfg } | { denied: true }
 */
async function configFor(upload, email, { write = true, principal } = {}) {
  const base = await getStorageConfig();
  if (storageMode(base) !== 's3') return { cfg: null };
  if (!upload?.filespaceId) return { cfg: base };
  const fs = write
    ? await getFilespaceForWrite(email, upload.filespaceId, principal)
    : await getFilespaceForUser(email, upload.filespaceId, principal);
  if (!fs) return write ? { denied: true } : { cfg: base };
  return { cfg: cfgForFilespace(base, fs) };
}

const readOnly = new Set(['status', 'abort']);
const noWrite = () => NextResponse.json({ error: 'You can view this drive but not add to it. Ask one of its owners for editor access.' }, { status: 403 });

/** GET → this user's resumable uploads, for a "pick up where you left off" UI. */
export async function GET() {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  return NextResponse.json({ uploads: await listUploads(g.email) });
}

export async function POST(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal, email } = g;

  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const action = String(body.action || '');

  const cfg = await getStorageConfig();
  if (storageMode(cfg) !== 's3') {
    // Vercel Blob has its own client-upload flow and no multipart API of ours
    // to drive, so this whole route is S3-only by construction.
    return NextResponse.json({ error: 'Resumable upload needs an S3 bucket (Admin → Storage).', code: 'no_bucket' }, { status: 400 });
  }

  try {
    if (action === 'create') {
      if (!body.filename) return NextResponse.json({ error: 'filename required' }, { status: 400 });
      // The declared size is what the part plan, the largest-upload limit and
      // the quota are all checked against; POST /api/files checks again
      // against what landed.
      const size = Number(body.size);
      if (body.size == null || !Number.isFinite(size) || size < 0) {
        return NextResponse.json({ error: 'The upload needs its size in bytes.' }, { status: 400 });
      }

      // Scope to the filespace so the object lands exactly where the desktop
      // app mounts it, not at the bucket root.
      let scoped = cfg;
      if (body.filespaceId) {
        const fs = await getFilespaceForWrite(email, body.filespaceId, principal);
        if (!fs) return noWrite();
        scoped = cfgForFilespace(cfg, fs);
      }

      // choosePartSize throws above the provider's single-object ceiling —
      // 5 TiB on S3, 10 TB on B2. Surfacing that here, before a single byte
      // moves, is much kinder than failing on the final assemble. It reads
      // the ceiling from the config the upload will actually use, so a
      // filespace on a different provider gets that provider's limit.
      const partSize = choosePartSize(size, scoped);

      // As in the presign route: a role that may add files, landing inside a
      // drive takes its editor, and the size is held to the limits.
      const d = await uploadCheck(principal, { key: buildObjectKey(scoped, body.filename, body.folder), size });
      if (!d.ok) return refusal(d);

      const { uploadId, key, name } = await s3CreateMultipartUpload(scoped, {
        filename: body.filename,
        contentType: body.mime,
        folder: body.folder,
      });

      const upload = await createUpload({
        uploadId, storageKey: key, filename: name, size,
        mime: body.mime || null, folder: body.folder || '',
        filespaceId: body.filespaceId || null, partSize, createdBy: email,
      });
      // Theirs to record as a file once assembled (POST /api/files). Issued
      // again at `complete`, which is what counts: an upload may take days.
      await issueUploadKey(key, email, { bucket: scoped.bucket });

      return NextResponse.json({
        id: upload.id, key, name, partSize,
        partCount: partCount(size, partSize),
      });
    }

    const upload = await getUpload(body.id, email);
    if (!upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    // Signing more parts or assembling them is still adding a file: a role
    // that lost files.upload mid-upload cannot finish it. Reading its parts
    // or abandoning it can.
    if (!readOnly.has(action)) {
      const d = can(principal, 'files.upload');
      if (!d.ok) return refusal(d);
    }
    const { cfg: scoped, denied } = await configFor(upload, email, { write: !readOnly.has(action), principal });
    if (denied) return noWrite();
    if (!scoped) return NextResponse.json({ error: 'Storage is not configured for S3.' }, { status: 400 });

    if (action === 'sign') {
      const numbers = Array.isArray(body.partNumbers)
        ? body.partNumbers.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10000)
        : [];
      if (!numbers.length) return NextResponse.json({ error: 'partNumbers required' }, { status: 400 });
      // Cap the batch so one request cannot ask us to mint thousands of
      // signatures — the client asks for more as it works through the file.
      const batch = numbers.slice(0, 100);
      const parts = await s3PresignUploadParts(scoped, {
        key: upload.storageKey, uploadId: upload.uploadId, partNumbers: batch,
      });
      touchUpload(upload.id).catch(() => {});
      return NextResponse.json({ parts });
    }

    if (action === 'status') {
      // S3 is the source of truth for what landed, so a resume needs no
      // client-side bookkeeping to have survived the reload.
      const parts = await s3ListParts(scoped, { key: upload.storageKey, uploadId: upload.uploadId });
      const uploaded = parts.reduce((n, p) => n + p.size, 0);
      return NextResponse.json({
        upload, parts, uploaded,
        partCount: partCount(upload.size, upload.partSize),
      });
    }

    if (action === 'complete') {
      // Take the manifest from S3 rather than from the request. The client's
      // ETags would usually match, but S3's list is authoritative and cannot be
      // wrong about what it is holding.
      const parts = await s3ListParts(scoped, { key: upload.storageKey, uploadId: upload.uploadId });
      const expected = partCount(upload.size, upload.partSize);
      if (upload.size && parts.length !== expected) {
        return NextResponse.json({
          error: `Upload incomplete: ${parts.length} of ${expected} parts received.`,
          code: 'incomplete', parts: parts.length, expected,
        }, { status: 409 });
      }
      const { key, publicUrl } = await s3CompleteMultipartUpload(scoped, {
        key: upload.storageKey, uploadId: upload.uploadId, parts,
      });
      // The key is theirs to record now — issued afresh, so however long the
      // upload took (and whether it began before keys were issued at all),
      // recording it is measured from here.
      await issueUploadKey(key, email, { bucket: scoped.bucket });
      // Drop the resume row only after S3 confirms assembly. Losing it earlier
      // would strand an upload that still needs completing.
      await deleteUpload(upload.id);
      return NextResponse.json({ key, publicUrl, name: upload.filename, size: upload.size, mime: upload.mime });
    }

    if (action === 'abort') {
      await s3AbortMultipartUpload(scoped, { key: upload.storageKey, uploadId: upload.uploadId });
      await deleteUpload(upload.id);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Upload failed.' }, { status: 500 });
  }
}
