import { auth } from '@/auth';
import { getAvatarById } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/avatars/<id>?v=<version> → the picture.
 *
 * For signed-in people only: pictures are part of the workspace, not the
 * public web. The id is a hash of an address (avatarIdFor), so the URL
 * names nobody. Asked for at its current version, the answer never changes
 * and may be kept for good; any other version is served but not cached, so
 * a stale link shows the new picture and does not pin the old one.
 */
export async function GET(req, { params }) {
  const session = await auth();
  if (!session?.user?.email) return new Response('Not authenticated', { status: 401 });
  const found = await getAvatarById(params.id).catch(() => null);
  if (!found) return new Response('Not found', { status: 404 });
  const current = new URL(req.url).searchParams.get('v') === found.version;
  return new Response(found.image, {
    headers: {
      'content-type': found.type,
      'content-length': String(found.image.length),
      'cache-control': current ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}
