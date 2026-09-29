// lib/download-variants.js — what the download routes serve besides the
// original: a video's proxy (its streamable 1080p H.264 copy, lib/proxies.js)
// and its cover picture, each as an attachment with a proper name
// (lib/download-formats.js). Asked for as `?variant=` on the routes the
// original comes from — app/api/files/[id]/download for people signed in,
// app/s/[token]/download for a share link's guests — so each is behind
// exactly the gates the original is, and is only reached after them:
//
//   authorize   the caller's route: signed in and able to see the file, or a
//               share link that is valid, unexpired and unlocked
//   filter      here: a live video; for a proxy, the `proxies` flag (as the
//               caller has it — a link's guests, the flags it was let in by)
//               and a finished proxy of the file's current contents; for a
//               cover, a picture the server named
//   presign     here, last, and only the key found above: nothing the request
//               says is ever taken as a key
//
// Server-only: it reaches lib/db.js and the bucket.

import { NextResponse } from 'next/server';
import { finishedProxyKeys } from '@/lib/db';
import { isFeatureEnabled } from '@/lib/features';
import { effectiveKind, isPosterKey, isThumbKey, isProxyKey } from '@/lib/media';
import { getStorageConfig, storageMode, s3PresignGet, ORIGINAL_URL_TTL } from '@/lib/storage';
import { proxyDownloadName, coverDownloadName, proxyHeight } from '@/lib/download-formats';

const NO_PROXY = 'This video has no streamable copy to download.';
const NO_COVER = 'This video has no cover picture.';

const refuse = (status, error) => NextResponse.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

/**
 * The object behind `variant` for `file`, for someone already let in:
 * { key, filename }, or { status, error } when there is none to serve.
 * A proxy that is not finished, or was made of contents since replaced, is
 * none — the same rule the players use (lib/file-listing.js playableProxies),
 * so a download is offered and served exactly when one plays.
 */
export async function variantObject(file, variant, { flags } = {}) {
  if (!file || file.deletedAt) return { status: 404, error: 'File not found' };
  const video = effectiveKind(file) === 'video';
  if (variant === 'proxy') {
    // Off, an existing proxy is not served — as a 404, which is what the
    // proxy routes answer too (lib/proxies.js proxyDecision).
    if (!video || !isFeatureEnabled(flags, 'proxies')) return { status: 404, error: NO_PROXY };
    let keys;
    try {
      keys = await finishedProxyKeys([file]);
    } catch {
      return { status: 503, error: 'The streamable copy could not be looked up right now. Try again.' };
    }
    const key = keys.get(file.id);
    if (!isProxyKey(key)) return { status: 404, error: NO_PROXY };
    return { key, filename: proxyDownloadName(file.name, { height: proxyHeight(file) }) };
  }
  if (variant === 'poster') {
    if (!video) return { status: 404, error: NO_COVER };
    // The player's poster, else the grid thumbnail — the same frame, and the
    // one a small clip's player shows (lib/poster.js playerPosterFor).
    const key = isPosterKey(file.posterKey) ? file.posterKey : isThumbKey(file.thumbnailKey) ? file.thumbnailKey : null;
    if (!key) return { status: 404, error: NO_COVER };
    return { key, filename: coverDownloadName(file.name, { ext: key.endsWith('.jpg') ? 'jpg' : 'webp' }) };
  }
  return { status: 400, error: 'There is no such download of this file.' };
}

/**
 * A route's answer for `variant`: a redirect to the object, signed as an
 * attachment under its name, or the refusal. Signed for as long as the
 * original's download (ORIGINAL_URL_TTL), so a large proxy cut off part way
 * resumes as the original does; renditions are the app's own, in the base
 * bucket, wherever the file is.
 */
export async function variantDownload(file, variant, { flags } = {}) {
  const found = await variantObject(file, variant, { flags });
  if (!found.key) return refuse(found.status, found.error);
  try {
    const cfg = await getStorageConfig();
    if (storageMode(cfg) !== 's3') return refuse(404, variant === 'proxy' ? NO_PROXY : NO_COVER);
    const url = await s3PresignGet(cfg, found.key, { download: true, filename: found.filename, expiresIn: ORIGINAL_URL_TTL });
    return NextResponse.redirect(url);
  } catch (e) {
    return refuse(500, e.message || 'Could not prepare the download.');
  }
}
