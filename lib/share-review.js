// lib/share-review.js — the opening every guest review route shares
// (app/s/[token]/review, /guest, /comments, /decision): whether the link
// still lets its holder in, whether it takes comments (or approvals), and
// which guest is asking. All of it decided on the server, from the link's
// row, the flags and a signed cookie — never from the request. The member
// routes' counterpart is lib/review-guard.js. Node only: it reaches
// lib/db.js.
//
// A guest is anyone holding a public link, or a password link with its
// password, that the sharer set to take comments (lib/share-kinds.js). They
// see the file's comments that are for everyone and not another link's
// (listReviewFeed with the link's token), with every address taken out
// (commentForGuest), and they may write comments and replies of their own —
// never internal, never mentioning anyone — and edit or delete those. On a
// link set to approve, they may approve or ask for changes too.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveShareAccess } from '@/lib/share-access';
import { readGuestCookie, guestCookieName } from '@/lib/shares';
import { countRecentLinkComments, getReviewCommentForLink } from '@/lib/db';
import { effectiveKind } from '@/lib/media';
import { visibleToLink } from '@/lib/review';

export const guestJson = (body, status) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

// What a route answers when the link no longer lets its holder in. The page
// (/s/<token>) says the same at length.
const CLOSED = {
  missing: [404, 'This link does not work.'],
  gone: [404, 'This file is no longer available.'],
  expired: [410, 'This link has expired.'],
  password: [401, 'Enter the password first.'],
  locked: [401, 'Enter the password first.'],
  off: [403, 'Sharing is turned off.'],
  paused: [403, 'This link is paused.'],
  unavailable: [503, 'This link can’t be opened right now. Try again in a moment.'],
};

// The brake on a link anyone may hold: how many comments one guest, and the
// whole link, may post in a window. Far above a real review — a reviewer
// working fast leaves a few a minute — and low enough that a script cannot
// bury a file's review.
export const GUEST_WINDOW_MS = 10 * 60 * 1000;
export const GUEST_LIMIT = 60;
export const GUEST_LINK_LIMIT = 300;

/** The guest this browser is on link `token`, from its signed cookie, or null. */
export function currentGuest(token) {
  return readGuestCookie(cookies().get(guestCookieName(token))?.value, token, process.env.AUTH_SECRET);
}

/**
 * Open a review link for `action` — 'read', 'comment', 'edit' or 'decide'.
 * → { token, file, kind, level, guest, row } or { error: Response }.
 *
 * Every call decides again, the way the member routes do on every poll: a
 * link revoked, expired, re-passworded, paused, or turned back to view-only
 * stops answering on the next request. Anything but reading takes a guest
 * (their name, given once, in the cookie).
 */
export async function openGuestReview(token, action = 'read') {
  const access = await resolveShareAccess(token);
  if (access.state !== 'ok') {
    const [status, error] = CLOSED[access.state] || CLOSED.missing;
    return { error: guestJson({ error }, status) };
  }
  if (!access.review) return { error: guestJson({ error: 'This link does not take comments.' }, 403) };
  if (action === 'decide' && access.review !== 'approve') {
    return { error: guestJson({ error: 'This link does not take approvals.' }, 403) };
  }
  const guest = currentGuest(token);
  if (action !== 'read' && !guest) {
    return { error: guestJson({ error: 'Add your name to comment.', code: 'guest' }, 401) };
  }
  return { token, file: access.file, kind: effectiveKind(access.file), level: access.review, guest, row: access.row };
}

/**
 * A comment this link's guests may see, on this file and not deleted — or a
 * 404, which is also the answer for one they may not see: a guest learns
 * nothing about a comment by asking for it.
 */
export async function loadForGuest(g, cid) {
  const found = await getReviewCommentForLink(String(cid || ''));
  if (!found || found.comment.fileId !== g.file.id || found.comment.deletedAt || !visibleToLink(found, g.token)) {
    return { error: guestJson({ error: 'Comment not found' }, 404) };
  }
  const isAuthor = !!g.guest && found.comment.author.guestId === g.guest.id;
  return { comment: found.comment, isAuthor };
}

/** A sentence when this guest, or this link, has posted too much lately; else null. */
export async function overLimit(g) {
  const n = await countRecentLinkComments(g.token, Date.now() - GUEST_WINDOW_MS, g.guest?.id || null);
  if (n.guest >= GUEST_LIMIT) return 'You have posted a lot of comments in the last few minutes. Wait a little, then try again.';
  if (n.link >= GUEST_LINK_LIMIT) return 'This link has taken a lot of comments in the last few minutes. Try again shortly.';
  return null;
}
