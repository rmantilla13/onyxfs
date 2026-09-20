import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { listFilesForUser, createFile, listFileFoldersForUser, listAllTags, buildPrincipal, getFilespaceForUser } from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import { encodeCursor, decodeCursor } from '@/lib/file-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel's default ceiling is 300s. Nothing here should take anywhere near
// that: every query in lib/db.js is bounded at 15s by the driver. A cap keeps
// a pathological request costing seconds instead of five minutes of a hung
// invocation — which is what the gateway timeouts on this route looked like.
export const maxDuration = 30;

/** GET /api/files?folder=&folderPrefix=&q=&kind=&tags=&tagMode=&sort= → { files, folders, tags } */
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
  const [folders, tags] = await Promise.all([
    listFileFoldersForUser(principal, { storagePrefix, filespace: storagePrefix }),
    listAllTags(principal),
  ]);
  return NextResponse.json({ files: signed, cursor: encodeCursor(cursor), total, folders, tags });
}

/** POST /api/files — record an uploaded asset. Body: { name, url, mime, size, kind, folder, storage, storageKey, tags } */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body.url) return NextResponse.json({ error: 'A file URL is required.' }, { status: 400 });
  try {
    const file = await createFile({ ...body, createdBy: session.user.email });
    // Presign so the just-uploaded file previews immediately on a private bucket.
    const [signed] = await presignFileUrls([file]);
    return NextResponse.json({ file: signed || file });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Save failed.' }, { status: 500 });
  }
}
