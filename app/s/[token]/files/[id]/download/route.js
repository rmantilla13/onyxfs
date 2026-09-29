import { NextResponse } from 'next/server';
import { resolveFolderShareAccess, folderLinkFile } from '@/lib/share-access';
import { linkFolderHref, linkFileHref } from '@/lib/folder-links';
import { getStorageConfig, storageMode, s3PresignGet, storageForKey, ORIGINAL_URL_TTL } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /s/<token>/files/<id>/download — one file of a folder link, as an
 * attachment. Decided again, in order, rather than trusted from the listing
 * that offered it:
 *
 *   1. the link (lib/share-access.js): revoked, expired, re-passworded,
 *      paused — anything but 'ok' goes to /s/<token>, which says why
 *   2. the file: one the link reaches now (folderLinkFile — in the folder or
 *      beneath it, live, where its folder says, the workspace's to see, not
 *      across a drive boundary). An id from anywhere else, or a file moved
 *      out since, goes to its page under the link, which says it is not in
 *      it; nothing about it is signed
 *   3. then, and only then, a URL for that one object
 *
 * Signed for six hours (ORIGINAL_URL_TTL), as a file link's download is, so
 * a large download cut off part way can resume; a URL already handed out
 * keeps working that long after a revoke, as there.
 */
export async function GET(req, { params }) {
  const { token, id } = params || {};
  const access = await resolveFolderShareAccess(token);
  if (access.state !== 'ok') return NextResponse.redirect(new URL(linkFolderHref(token), req.url));

  let file;
  try {
    file = await folderLinkFile(access, id);
  } catch {
    return NextResponse.json({ error: 'This link can’t be opened right now. Try again in a moment.' }, { status: 503 });
  }
  if (!file) return NextResponse.redirect(new URL(linkFileHref(token, String(id ?? '')), req.url));

  try {
    const cfg = await getStorageConfig();
    if (storageMode(cfg) === 's3') {
      // Signed where the object is: a drive in a bucket of its own keeps it there.
      const url = await s3PresignGet(await storageForKey(cfg, file.storageKey), file.storageKey, {
        download: true, filename: file.name, expiresIn: ORIGINAL_URL_TTL,
      });
      return NextResponse.redirect(url);
    }
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not prepare the download.' }, { status: 500 });
  }
  // A bucket behind a public address (no keys here to sign with): the row's own.
  return NextResponse.redirect(file.url);
}
