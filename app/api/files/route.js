import { NextResponse } from 'next/server';
import { createFile, getFilespaceForUser, storageKeyInUse, claimUploadKey, issueUploadKey } from '@/lib/db';
import { requirePrincipal, uploadCheck, refusal } from '@/lib/authz';
import { listFilesPage, listFolderTree, storagePrefixFor } from '@/lib/file-listing';
import { presignFileUrls, getStorageConfig, storageMode, cfgForFilespace, s3HeadObject, s3DeleteObject } from '@/lib/storage';
import { decodeCursor } from '@/lib/file-query';
import { uploadFields } from '@/lib/media';
import { parseFileRecord } from '@/lib/file-record';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel's default ceiling is 300s. Nothing here should take anywhere near
// that: every query in lib/db.js is bounded at 15s by the driver. A cap keeps
// a pathological request costing seconds instead of five minutes of a hung
// invocation — which is what the gateway timeouts on this route looked like.
export const maxDuration = 30;

/**
 * GET /api/files?folder=&folderPrefix=&q=&kind=&tags=&tagMode=&sort=&cursor=&folders= → { files, cursor, folders }
 *
 * `folders` (the sidebar tree) comes with the first page only, and not at all
 * with `folders=0`. It does not depend on the page or the filters, and
 * building it counts every file in the library.
 */
export async function GET(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal, email } = g;
  const url = new URL(req.url);

  const folderParam = url.searchParams.get('folder');
  const folderPrefix = url.searchParams.get('folderPrefix');
  const tagsParam = url.searchParams.get('tags');
  const kindParam = url.searchParams.get('kind');

  // Filespace scope (Space is filespace-aware): restrict to this filespace's prefix.
  const storagePrefix = await storagePrefixFor(email, url.searchParams.get('filespace'), principal);

  const opts = {
    folder: folderParam === null ? undefined : folderParam,
    folderPrefix: folderPrefix === null ? undefined : folderPrefix,
    q: url.searchParams.get('q') || undefined,
    kind: kindParam ? kindParam.split(',').filter(Boolean) : undefined,
    tags: tagsParam ? tagsParam.split(',').filter(Boolean) : undefined,
    tagMode: url.searchParams.get('tagMode') || 'all',
    sort: url.searchParams.get('sort') || 'new',
    // Keyset paging. The cursor is opaque and round-trips from the previous
    // page; a malformed one reads as "first page" rather than an error.
    cursor: decodeCursor(url.searchParams.get('cursor')),
    limit: Number(url.searchParams.get('limit')) || 100,
    // Counting matched rows costs a second pass over the predicate, so it is
    // opt-in — the grid only needs to know whether another page exists.
    withTotal: url.searchParams.get('withTotal') === '1',
  };

  // AUTHORIZE → FILTER → PRESIGN, in lib/file-listing.js — shared with the
  // files page, which renders the first page on the server.
  const page = await listFilesPage({ principal, opts, storagePrefix });
  // `folders=0` skips the tree; the web library fetches it separately from
  // /api/files/folders. Other callers still get it with the first page.
  const withFolders = !opts.cursor && url.searchParams.get('folders') !== '0';
  const folders = withFolders ? await listFolderTree({ principal, storagePrefix }) : undefined;
  return NextResponse.json({ ...page, folders });
}

/**
 * POST /api/files — record an uploaded asset.
 * Body: { name, url, mime, size, kind?, folder, storage, storageKey, tags, notes?,
 *         visibility?, thumbnailKey?, posterKey?, media?, filmstripKey?, filmstrip?, filespace? }
 * `media` is { width, height, duration } read by the browser while it made the thumbnail.
 * Only these fields are read (lib/file-record.js); anything else in the body
 * is ignored, so who, when and what the bytes hash to stay the server's word.
 *
 * An S3 record names an object, and recording it makes the recorder its
 * creator — able to open, move and delete it. So the key must be one this
 * person was handed for an upload (presign or multipart; lib/db.js
 * claimUploadKey), taken once, and one no other row already points at.
 * Anything else is someone else's object, or nobody's we know of.
 */
export async function POST(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal, email } = g;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = parseFileRecord(body);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { record } = parsed;

  // Recording a file makes its creator able to open it, so where it points is
  // checked like an upload: a role that may add files, not into our own
  // previews or trash (parseFileRecord), and not into a drive this person
  // cannot add to. Size waits for the bucket's answer below.
  const allowed = await uploadCheck(principal, { key: record.storageKey });
  if (!allowed.ok) return refusal(allowed);

  const s3 = record.storage === 's3';
  let issued = null;
  if (s3) {
    if (await storageKeyInUse(record.storageKey)) {
      return NextResponse.json({ error: 'That stored object already belongs to a file in the library.' }, { status: 409 });
    }
    issued = await claimUploadKey(record.storageKey, email);
    if (!issued) {
      return NextResponse.json({
        error: 'This upload was not started by you, or it was too long ago. Upload the file again.',
        code: 'not_issued',
      }, { status: 403 });
    }
  }
  // From here the key is taken. Should the row not get written, hand it back
  // so the browser can try recording again.
  const giveBack = () => (issued ? issueUploadKey(record.storageKey, email, issued).catch(() => {}) : null);

  try {
    // The store's own word on what landed, never the client's: the bucket's
    // ETag is the content hash duplicates are found by, and its length (or
    // Blob's) the size the Storage page adds up — and the size the quota
    // counts. Best-effort — a store that will not answer still gets its file
    // recorded, just without a hash, at the size the upload declared.
    const target = s3 ? await objectTarget(email, record, principal) : null;
    const facts = target
      ? await s3HeadObject(target.cfg, record.storageKey).catch(() => null)
      : record.storage === 'blob' ? await blobFacts(record.url) : null;
    const size = facts?.size != null ? facts.size : record.size;

    // Presign checked the size the browser declared; this checks the size
    // that arrived. Over a limit, an S3 object is removed rather than left in
    // the bucket uncounted: its key was issued to this person, for this
    // upload, and no row uses it (both checked above), so it is theirs and
    // nobody else's. A Blob URL proves no such thing — the store is public
    // and its URLs are not ours to hand out — so that one is only refused.
    if (size != null) {
      const fits = await uploadCheck(principal, { key: record.storageKey, size });
      if (!fits.ok) {
        if (target && target.cfg.bucket === issued.bucket) await s3DeleteObject(target.cfg, record.storageKey).catch(() => {});
        else await giveBack();
        return refusal(fits);
      }
    }

    const { filespace, media, filmstrip, ...fields } = record;
    const file = await createFile({
      ...fields,
      ...uploadFields(record),
      ...(size != null ? { size } : {}),
      contentHash: s3 ? facts?.etag || null : null,
      createdBy: email,
    });
    // Presign so the just-uploaded file previews immediately on a private bucket.
    const [signed] = await presignFileUrls([file]);
    return NextResponse.json({ file: signed || file });
  } catch (e) {
    await giveBack();
    return NextResponse.json({ error: e.message || 'Save failed.' }, { status: 500 });
  }
}

/**
 * A Vercel Blob upload's real size, or null when the store will not say (no
 * token, a URL that is not ours, the network). Only the size: Blob has no
 * content hash to offer.
 */
async function blobFacts(url) {
  try {
    const { head } = await import('@vercel/blob');
    const r = await head(url);
    return r?.size != null && Number.isFinite(Number(r.size)) ? { size: Number(r.size) } : null;
  } catch {
    return null;
  }
}

/** The bucket config an S3 record's object lives under, or null when there is nothing to ask. */
async function objectTarget(email, record, principal) {
  if (record.storage !== 's3' || !record.storageKey) return null;
  try {
    const cfg = await getStorageConfig();
    if (storageMode(cfg) !== 's3') return null;
    const fs = record.filespace ? await getFilespaceForUser(email, String(record.filespace), principal) : null;
    return { cfg: fs ? cfgForFilespace(cfg, fs) : cfg };
  } catch {
    return null;
  }
}
