import { NextResponse } from 'next/server';
import { resolveShareAccess } from '@/lib/share-access';
import { getStorageConfig, storageMode, s3PresignGet, storageForKey, ORIGINAL_URL_TTL } from '@/lib/storage';
import { parseDownloadVariant } from '@/lib/download-formats';
import { variantDownload } from '@/lib/download-variants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /s/<token>/download — the shared file, as an attachment. The same
 * decision as the page (lib/share-access), made again rather than trusted
 * from having rendered it: the link may have been revoked, expired or
 * re-passworded since. Anyone not let in is sent to the page, which says why.
 *
 * Signed for six hours (ORIGINAL_URL_TTL), as the page's player is, so a
 * large download cut off part way can resume: a browser resumes by asking for
 * the same URL again. The trade is the player's too: revoking the link stops
 * every new download at once, but a URL already handed out keeps working for
 * up to six hours.
 *
 * `?variant=proxy` / `?variant=poster`: a video's streamable copy or its cover,
 * for the guests the page offers them to — decided after the link is.
 */
export async function GET(req, { params }) {
  const { token } = params;
  const access = await resolveShareAccess(token);
  if (access.state === 'signin') {
    return NextResponse.redirect(new URL(`/signin?callbackUrl=${encodeURIComponent(`/s/${token}`)}`, req.url));
  }
  if (access.state !== 'ok') return NextResponse.redirect(new URL(`/s/${token}`, req.url));

  const { file } = access;
  // A video's proxy or cover (lib/download-variants.js), past the same gates,
  // under the flags the link was let in by — the ones its page played by.
  const asked = parseDownloadVariant(new URL(req.url).searchParams.get('variant'));
  if (asked.error) return NextResponse.json({ error: asked.error }, { status: 400 });
  if (asked.variant) return variantDownload(file, asked.variant, { flags: access.flags });

  if (file.storage === 's3' && file.storageKey) {
    try {
      const cfg = await getStorageConfig();
      if (storageMode(cfg) === 's3') {
        // Signed where the object is: a drive in a bucket of its own keeps it there.
        const url = await s3PresignGet(await storageForKey(cfg, file.storageKey), file.storageKey, { download: true, filename: file.name, expiresIn: ORIGINAL_URL_TTL });
        return NextResponse.redirect(url);
      }
    } catch (e) {
      return NextResponse.json({ error: e.message || 'Could not prepare the download.' }, { status: 500 });
    }
  }
  return NextResponse.redirect(file.url);
}
