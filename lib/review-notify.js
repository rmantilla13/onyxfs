// lib/review-notify.js — telling people what happened on a file's review.
//
// In-app only for now: rows in the existing `notifications` table, which the
// bell reads. Email, batched per file, comes later and will read the same
// events. Everything here is best-effort — a notification that fails to write
// must never fail the comment that caused it — and every recipient is held to
// canAccessFile first, so a comment's words never reach someone who has since
// lost access to the file (a drive they left, a grant that was revoked).

import {
  createNotification, listReviewWatchers, getFeatureFlags, buildPrincipal, canAccessFile,
} from './db.js';
import { snippet, anchorLabel } from './review.js';
import { toRate } from './video-time.js';

// A file with more followers than this is a broadcast, and notifying every
// one of them costs a principal lookup each. The first ones are told.
const MAX_RECIPIENTS = 50;

async function enabled() {
  try { return (await getFeatureFlags()).notifications !== false; } catch { return false; }
}

async function canRead(file, email) {
  try { return await canAccessFile(file, await buildPrincipal(email)); } catch { return false; }
}

const who = (name, email) => name || String(email || '').split('@')[0] || 'Someone';

/**
 * Where a notification takes you: the file, at the comment's moment, with
 * the comment selected. `t` is the timecode as the NLE shows it, which the
 * detail page reads against the file's own start timecode.
 */
export function reviewLink(file, comment) {
  const q = new URLSearchParams();
  if (comment?.id) q.set('c', comment.id);
  if (comment?.anchor === 'frame' || comment?.anchor === 'range') {
    const md = file?.metadata || {};
    const model = { fps: toRate(md.fps) || comment.fps, tcStart: md.tcStart || 0, dropFrame: !!md.dropFrame };
    q.set('t', anchorLabel({ ...comment, anchor: 'frame' }, model));
  }
  const qs = q.toString();
  return `/files/${encodeURIComponent(file.id)}${qs ? `?${qs}` : ''}`;
}

async function send(file, list, { title, body, link, metadata }) {
  const seen = new Set();
  let sent = 0;
  for (const [email, type, heading] of list) {
    if (!email || seen.has(email) || sent >= MAX_RECIPIENTS) continue;
    seen.add(email);
    if (!(await canRead(file, email))) continue;
    await createNotification({ userEmail: email, type, title: heading || title, body, link, metadata });
    sent += 1;
  }
  return sent;
}

/**
 * A comment or reply was posted. The people it mentions hear "mentioned
 * you", the author of the comment it replies to hears "replied", and the
 * file's other watchers hear "commented" — each person once, never the
 * person who wrote it.
 */
export async function notifyReviewComment({ file, comment, parent = null, actor }) {
  try {
    if (!(await enabled())) return 0;
    const me = String(actor || '').toLowerCase();
    const name = who(comment.author?.name, me);
    const list = [];
    for (const m of comment.mentions || []) if (m !== me) list.push([m, 'review.mention', `${name} mentioned you on ${file.name}`]);
    const parentAuthor = parent?.author?.email || null;
    if (parentAuthor && parentAuthor !== me) list.push([parentAuthor, 'review.reply', `${name} replied to your comment on ${file.name}`]);
    for (const w of await listReviewWatchers(file.id)) if (w !== me) list.push([w, 'review.comment', `${name} commented on ${file.name}`]);
    return await send(file, list, {
      body: snippet(comment.body) || 'Drew on the picture.',
      link: reviewLink(file, comment),
      metadata: { fileId: file.id, commentId: comment.id },
    });
  } catch (e) {
    console.warn('[review-notify] comment:', e.message);
    return 0;
  }
}

/** A reviewer approved or asked for changes. The uploader and the watchers hear of it. */
export async function notifyReviewDecision({ file, decision, actor, actorName = null }) {
  try {
    if (!(await enabled()) || !decision || decision.status === 'withdrawn') return 0;
    const me = String(actor || '').toLowerCase();
    const name = who(actorName, me);
    const heading = decision.status === 'approved'
      ? `${name} approved ${file.name}`
      : `${name} requested changes on ${file.name}`;
    const list = [];
    if (file.createdBy) list.push([String(file.createdBy).toLowerCase(), 'review.decision', heading]);
    for (const w of await listReviewWatchers(file.id)) list.push([w, 'review.decision', heading]);
    return await send(file, list.filter(([e]) => e !== me), {
      body: decision.note ? snippet(decision.note) : null,
      link: reviewLink(file, null),
      metadata: { fileId: file.id, decision: decision.status },
    });
  } catch (e) {
    console.warn('[review-notify] decision:', e.message);
    return 0;
  }
}
