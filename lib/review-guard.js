// lib/review-guard.js — the opening every review route shares: who is
// asking, which file, whether it is live, whether review is on for them, and
// whether they may do what they are asking.
//
// The rules are lib/review.js's (reviewDecision); this only gathers what they
// need, on the server, from the session and the database — never from the
// request. Node only: it reaches lib/db.js.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  getFileById, buildPrincipal, canAccessFile, canModifyFile,
  listFilespaces, listFilespaceMembers, getFileAcl,
} from '@/lib/db';
import { flagsForUser } from '@/lib/user-flags';
import { isFeatureEnabled } from '@/lib/features';
import { isAdmin } from '@/lib/auth-allowlist';
import { effectiveKind } from '@/lib/media';
import { drivesHolding } from '@/lib/drive-access';
import { reviewDecision } from '@/lib/review';

const json = (body, status) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Who may read and who may change this file, for review. Today that is the
 * library's own two questions (drives, visibility, grants, the creator rule);
 * the authorization core's can(principal, 'review.*', file) replaces the body
 * of this one function, and no route changes when it does.
 */
export async function reviewAccess(file, principal) {
  const [canRead, canModify] = await Promise.all([canAccessFile(file, principal), canModifyFile(file, principal)]);
  return { canRead, canModify };
}

/**
 * Open a file's review for `action` (see reviewDecision). Returns
 * { email, file, principal, access, kind } or { error: Response }.
 *
 * A trashed file is 404 like a missing one: its review is not served while it
 * waits to be purged. A comment-level action (edit, delete, resolve) opens
 * with 'read' and asks `allowed()` again once it knows whose comment it is.
 */
export async function openReview(fileId, action = 'read') {
  const session = await auth();
  const email = String(session?.user?.email || '').trim().toLowerCase();
  if (!email) return { error: json({ error: 'Not authenticated' }, 401) };

  const file = await getFileById(fileId);
  if (!file || file.deletedAt) return { error: json({ error: 'File not found' }, 404) };

  const principal = await buildPrincipal(email);
  const [{ flags }, access] = await Promise.all([flagsForUser(email), reviewAccess(file, principal)]);
  const flagOn = isFeatureEnabled(flags, 'review');
  const decision = reviewDecision(action, { flagOn, ...access });
  if (!decision.ok) return { error: json({ error: decision.error }, decision.status) };
  return { email, file, principal, access, flagOn, kind: effectiveKind(file) };
}

/** A second decision on an opened review, now that the comment's author is known. Null when allowed. */
export function refused(ctx, action, { isAuthor = false } = {}) {
  const d = reviewDecision(action, { flagOn: ctx.flagOn, ...ctx.access, isAuthor });
  return d.ok ? null : json({ error: d.error }, d.status);
}

/**
 * Of `emails`, those who may read `file` — each held to canAccessFile with a
 * principal of their own, the rule every read path uses, so a mention cannot
 * reach (or confirm the existence of) someone outside the file's audience.
 * `cap` bounds the lookups; each is a few queries.
 */
export async function peopleWhoCanRead(file, emails = [], { cap = 20 } = {}) {
  const out = [];
  for (const email of [...new Set(emails)].slice(0, cap)) {
    try {
      if (await canAccessFile(file, await buildPrincipal(email))) out.push(email);
    } catch { /* an unreadable principal reads nothing */ }
  }
  return out;
}

/**
 * For a file inside a drive: the addresses that could possibly read it — the
 * drive's members, the people it was shared with directly, and its uploader
 * (admins are added by the caller, who can test for one without a list).
 * Null for a file outside every drive, where the whole org may be its
 * audience. Only a shortlist: peopleWhoCanRead still has the last word.
 */
export async function drivePool(file) {
  const drives = drivesHolding(file.storageKey, await listFilespaces());
  if (!drives.length) return null;
  const pool = new Set();
  for (const d of drives) for (const m of await listFilespaceMembers(d.id)) pool.add(String(m.email || '').toLowerCase());
  for (const g of await getFileAcl(file.id)) if (g.scope === 'user') pool.add(String(g.principal || '').toLowerCase());
  if (file.createdBy) pool.add(String(file.createdBy).toLowerCase());
  return { has: (email) => pool.has(email) || isAdmin(email) };
}

export { json as reviewJson };
