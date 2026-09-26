import { NextResponse } from 'next/server';
import { createFile, getFilespaceForUser, storageKeyInUse } from '@/lib/db';
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
 *         visibility?, thumbnailKey?, media?, filmstripKey?, filmstrip?, filespace? }
 * `media` is { width, height, duration } read by the browser while it made the thumbnail.
 * Only these fields are read (lib/file-record.js); anything else in the body
 * is ignored, so who, when and what the bytes hash to stay the server's word.
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

  try {
    // The bucket's own word on what landed, never the client's: its ETag is
    // the content hash duplicates are found by, and its length the size the
    // Storage page adds up — and the size the quota counts. Best-effort — a
    // bucket that will not answer a HEAD still gets its file recorded, just
    // without a hash, at the size the upload declared.
    const target = await objectTarget(email, record, principal);
    const facts = target ? await s3HeadObject(target.cfg, record.storageKey).catch(() => null) : null;
    const size = facts?.size != null ? facts.size : record.size;

    // Presign checked the size the browser declared; this checks the size
    // that arrived. Over a limit, the object is removed rather than left in
    // the bucket uncounted — unless some other row points at that key, in
    // which case it was never this upload's to remove.
    if (size != null) {
      const fits = await uploadCheck(principal, { key: record.storageKey, size });
      if (!fits.ok) {
        if (target && facts && !(await storageKeyInUse(record.storageKey))) {
          await s3DeleteObject(target.cfg, record.storageKey).catch(() => {});
        }
        return refusal(fits);
      }
    }

    const { filespace, media, filmstrip, ...fields } = record;
    const file = await createFile({
      ...fields,
      ...uploadFields(record),
      ...(size != null ? { size } : {}),
      contentHash: facts?.etag || null,
      createdBy: email,
    });
    // Presign so the just-uploaded file previews immediately on a private bucket.
    const [signed] = await presignFileUrls([file]);
    return NextResponse.json({ file: signed || file });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Save failed.' }, { status: 500 });
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
