import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { listFilesForUser, createFile, listFileFoldersForUser, buildPrincipal, getFilespaceForUser } from '@/lib/db';
import { driveAccess } from '@/lib/drive-access';
import { presignFileUrls, getStorageConfig, storageMode, cfgForFilespace, s3HeadObject } from '@/lib/storage';
import { encodeCursor, decodeCursor } from '@/lib/file-query';
import { uploadFields } from '@/lib/media';

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
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const url = new URL(req.url);
  const principal = await buildPrincipal(session.user.email);

  const folderParam = url.searchParams.get('folder');
  const folderPrefix = url.searchParams.get('folderPrefix');
  const tagsParam = url.searchParams.get('tags');
  const kindParam = url.searchParams.get('kind');

  // Filespace scope (Space is filespace-aware): restrict to this filespace's prefix.
  const filespaceId = url.searchParams.get('filespace');
  const fs = filespaceId ? await getFilespaceForUser(session.user.email, filespaceId) : null;
  const storagePrefix = fs ? String(fs.prefix || '').replace(/^\/+|\/+$/g, '') : undefined;

  const opts = {
    folder: folderParam === null ? undefined : folderParam,
    folderPrefix: folderPrefix === null ? undefined : folderPrefix,
    q: url.searchParams.get('q') || undefined,
    kind: kindParam ? kindParam.split(',').filter(Boolean) : undefined,
    tags: tagsParam ? tagsParam.split(',').filter(Boolean) : undefined,
    tagMode: url.searchParams.get('tagMode') || 'all',
    sort: url.searchParams.get('sort') || 'new',
    storagePrefix,
    // Keyset paging. The cursor is opaque and round-trips from the previous
    // page; a malformed one reads as "first page" rather than an error.
    cursor: decodeCursor(url.searchParams.get('cursor')),
    limit: Number(url.searchParams.get('limit')) || 100,
    // Counting matched rows costs a second pass over the predicate, so it is
    // opt-in — the grid only needs to know whether another page exists.
    withTotal: url.searchParams.get('withTotal') === '1',
  };

  // AUTHORIZE → FILTER → PRESIGN. Access and filtering now happen inside the
  // query, so only the rows on this page reach presignFileUrls — previously
  // every row in the library was signed on every request.
  const { files, cursor, total } = await listFilesForUser(opts, principal);
  const signed = await presignFileUrls(files);
  // `folders=0` skips the tree; the web library fetches it separately from
  // /api/files/folders. Other callers still get it with the first page.
  const withFolders = !opts.cursor && url.searchParams.get('folders') !== '0';
  const folders = withFolders ? await listFileFoldersForUser(principal, { storagePrefix, filespace: storagePrefix }) : undefined;
  return NextResponse.json({ files: signed, cursor: encodeCursor(cursor), total, folders });
}

/**
 * POST /api/files — record an uploaded asset.
 * Body: { name, url, mime, size, kind?, folder, storage, storageKey, tags, thumbnailKey?,
 *         media?, filmstripKey?, filmstrip? }
 * `media` is { width, height, duration } read by the browser while it made the thumbnail.
 */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body.url) return NextResponse.json({ error: 'A file URL is required.' }, { status: 400 });

  // Recording a file makes its creator able to open it, so where it points is
  // checked like an upload: not by a platform viewer, not into our own
  // previews or trash, and not into a drive this person cannot add to.
  const principal = await buildPrincipal(session.user.email);
  if (principal.roleId === 'viewer' && !principal.isAdmin) {
    return NextResponse.json({ error: 'Your role can view files but not add them.' }, { status: 403 });
  }
  if (body.storageKey) {
    const key = String(body.storageKey);
    if (/^(_thumbs|_trash)\//.test(key)) {
      return NextResponse.json({ error: 'Not a file key.' }, { status: 400 });
    }
    const d = driveAccess(key, principal.isAdmin ? { isAdmin: true } : principal.driveScope);
    if (d.inDrive && !d.write) {
      return NextResponse.json({ error: 'That file is in a drive you can view but not add to.' }, { status: 403 });
    }
  }

  try {
    // The bucket's own word on what landed, never the client's: its ETag is
    // the content hash duplicates are found by, and its length the size the
    // Storage page adds up. Best-effort — a bucket that will not answer a
    // HEAD still gets its file recorded, just without a hash.
    const facts = await objectFacts(session.user.email, body);
    const file = await createFile({
      ...body,
      ...uploadFields(body),
      ...(facts?.size != null ? { size: facts.size } : {}),
      contentHash: facts?.etag || null,
      createdBy: session.user.email,
    });
    // Presign so the just-uploaded file previews immediately on a private bucket.
    const [signed] = await presignFileUrls([file]);
    return NextResponse.json({ file: signed || file });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Save failed.' }, { status: 500 });
  }
}

async function objectFacts(email, body) {
  if (body.storage !== 's3' || !body.storageKey) return null;
  try {
    const cfg = await getStorageConfig();
    if (storageMode(cfg) !== 's3') return null;
    const fs = body.filespace ? await getFilespaceForUser(email, String(body.filespace)) : null;
    return await s3HeadObject(fs ? cfgForFilespace(cfg, fs) : cfg, String(body.storageKey));
  } catch {
    return null;
  }
}
