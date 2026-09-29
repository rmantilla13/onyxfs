import { NextResponse } from 'next/server';
import { resolveFolderShareAccess, folderLinkListing } from '@/lib/share-access';
import { linkSubpath } from '@/lib/folder-links';
import { decodeCursor } from '@/lib/file-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

// What the listing answers when the link does not let this browser in. The
// page (/s/<token>) says the same at length.
const CLOSED = {
  missing: [404, 'This link does not work.'],
  gone: [404, 'This folder is no longer available.'],
  expired: [410, 'This link has expired.'],
  password: [401, 'Enter the password first.'],
  locked: [401, 'Enter the password first.'],
  off: [403, 'Sharing is turned off.'],
  blocked: [403, 'This link is turned off.'],
  paused: [403, 'This link is paused.'],
  unavailable: [503, 'This link can’t be opened right now. Try again in a moment.'],
};

/**
 * GET /s/<token>/list?path=&cursor= → { files, cursor }
 *
 * The next page of a folder link's files, for the grid's "more" (the first
 * page comes with the page). Authorize → filter → presign, every time:
 *
 *   1. the link — the same gates as the page, decided again on each request
 *      (lib/share-access.js): a revoke, an expiry, a new password or a
 *      paused sharer stops the next page, not just the next visit
 *   2. `path` — a folder inside the link's, relative to it, in the canonical
 *      form its pages link to (lib/folder-links.js linkSubpath), else 404
 *   3. the files there that the link reaches now, one page, keyset-paged
 *      after `cursor` — the queries hold every row to the link's folder
 *   4. only those rows signed, and cut down to what a card draws
 */
export async function GET(req, { params }) {
  const access = await resolveFolderShareAccess(params?.token);
  if (access.state !== 'ok') {
    const [status, error] = CLOSED[access.state] || CLOSED.missing;
    return json({ error }, status);
  }
  const url = new URL(req.url);
  const sub = linkSubpath(url.searchParams.get('path'));
  if (sub == null) return json({ error: 'This folder is not in the link.' }, 404);
  const page = await folderLinkListing(access, {
    sub,
    cursor: decodeCursor(url.searchParams.get('cursor')),
    withFolders: false,
  });
  if (page.state) {
    const [status, error] = CLOSED[page.state] || CLOSED.unavailable;
    return json({ error }, status);
  }
  return json({ files: page.files, cursor: page.cursor }, 200);
}
