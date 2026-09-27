import { openGuestReview, guestJson } from '@/lib/share-review';
import { newGuestId, guestCookieName, guestCookieValue, GUEST_COOKIE_DAYS } from '@/lib/shares';
import { guestName } from '@/lib/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /s/<token>/guest { name } → { guest: { id, name } }
 *
 * Who is commenting through a review link: the name they give, and an id
 * that makes their comments theirs to edit — in an HttpOnly cookie signed
 * for this link and scoped to its path (lib/shares.js). Posting again with
 * the cookie keeps the id and changes the name; comments already written
 * keep the name they were written under.
 *
 * Only on a link that takes comments, and only for someone it lets in —
 * a password link's password comes first.
 */
export async function POST(req, { params }) {
  const g = await openGuestReview(params.token, 'read');
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return guestJson({ error: 'Bad request' }, 400); }
  const name = guestName(body?.name);
  if (!name) return guestJson({ error: 'Enter your name.' }, 400);

  const guest = { id: g.guest?.id || newGuestId(), name };
  const res = guestJson({ guest }, 200);
  res.cookies.set(guestCookieName(g.token), guestCookieValue(g.token, guest, process.env.AUTH_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/s/${g.token}`,
    maxAge: GUEST_COOKIE_DAYS * 86400,
  });
  return res;
}
