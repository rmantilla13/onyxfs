import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getAvatarUrl, setAvatar, deleteAvatar } from '@/lib/db';
import { AVATAR_MAX_BYTES, AVATAR_SIZE, sniffImageType } from '@/lib/avatars';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Your own profile picture.
 *
 *   GET     → { url }        url null when you have none
 *   PUT     body: the image  → { url }
 *   DELETE                   → { url: null }
 *
 * An upload is checked by its bytes, not its name or claimed type, and is
 * never stored as sent: it is decoded and re-encoded (sharp) to a 256px
 * WebP square, cropped to what matters in the picture. That bounds its size
 * and leaves nothing of the original file — metadata, location, or anything
 * that is not an image — to be served back to anyone.
 */
async function signedIn() {
  const session = await auth();
  return session?.user?.email || null;
}

export async function GET() {
  const email = await signedIn();
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  return NextResponse.json({ url: await getAvatarUrl(email) });
}

export async function PUT(req) {
  const email = await signedIn();
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const declared = Number(req.headers.get('content-length')) || 0;
  if (declared > AVATAR_MAX_BYTES) return NextResponse.json({ error: 'That picture is over 4 MB.' }, { status: 413 });

  const bytes = Buffer.from(await req.arrayBuffer());
  if (!bytes.length) return NextResponse.json({ error: 'No picture was sent.' }, { status: 400 });
  if (bytes.length > AVATAR_MAX_BYTES) return NextResponse.json({ error: 'That picture is over 4 MB.' }, { status: 413 });
  if (!sniffImageType(bytes)) return NextResponse.json({ error: 'Use a JPEG, PNG, WebP or GIF picture.' }, { status: 415 });

  // A missing or broken sharp is the server's fault, not the picture's: say
  // so, and log it, rather than blaming the file.
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    console.error('[avatar] sharp is unavailable', e);
    return NextResponse.json({ error: 'Pictures cannot be processed on this server right now.' }, { status: 500 });
  }
  let image;
  try {
    image = await sharp(bytes, { limitInputPixels: 64_000_000, animated: false })
      .rotate() // honour the camera's orientation, then drop it with the rest of the metadata
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: sharp.strategy.attention })
      .webp({ quality: 86 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: 'That picture could not be read. Try a JPEG or PNG.' }, { status: 422 });
  }
  const url = await setAvatar(email, image, 'image/webp');
  return NextResponse.json({ url });
}

export async function DELETE() {
  const email = await signedIn();
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  await deleteAvatar(email);
  return NextResponse.json({ url: null });
}
