// lib/proxy-guard.js — the opening every proxy route shares: who is asking
// (the browser's session or the Mac's bearer token, one principal either way),
// which file, whether it is live, whether the flag is on, and whether they may
// do what they ask.
//
// The rule is lib/proxies.js's (proxyDecision); this only gathers what it
// needs, on the server, from the session and the database — never from the
// request. Node only: it reaches lib/db.js.
//
// Deliberately the same shape as lib/transcript-guard.js, and it borrows that
// module's readJson and lost(): the body limit and the 409 mean the same thing
// in both queues, and a second copy would drift from the first.

import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/desktop-guard';
import { can } from '@/lib/authz';
import { getFileById, canAccessFile, canModifyFile } from '@/lib/db';
import { isFeatureEnabled } from '@/lib/features';
import { effectiveKind, isProxyKey } from '@/lib/media';
import { presignFileUrls, getStorageConfig, storageMode, s3DeleteObject } from '@/lib/storage';
import { proxyDecision, proxyJson, isProxyableKind, isStale } from '@/lib/proxies';

export { readJson, lost } from '@/lib/transcript-guard';

export const json = (body, status = 200) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Open a file's proxy for `action` (see proxyDecision). Returns
 * { email, principal, file, kind, flagOn, canWrite } or { error: Response }.
 *
 * `canWrite` — files.edit and write access to this file, drives applied — is
 * worked out for every action, reads included, because the read answers with
 * canRequest and canDelete: what the buttons show, which the writes then check
 * again for themselves.
 */
export async function openProxy(req, fileId, action = 'read') {
  const actor = await resolveActor(req);
  if (actor.error) return { error: actor.error };
  const { principal } = actor;
  const flagOn = isFeatureEnabled(principal.flags, 'proxies');
  // The flag first: off, nothing is looked up.
  if (!flagOn) {
    const d = proxyDecision(action, { flagOn });
    return { error: json({ error: d.error, ...(d.code ? { code: d.code } : {}) }, d.status) };
  }

  const file = await getFileById(fileId);
  const live = !!file && !file.deletedAt;
  const canRead = live ? await canAccessFile(file, principal) : false;
  const edit = can(principal, 'files.edit');
  // Only asked where it can matter: the write check is two queries, and a
  // refusal before it needs neither.
  const canModify = live && canRead && edit.ok ? await canModifyFile(file, principal) : false;
  const kind = file ? effectiveKind(file) : null;

  const d = proxyDecision(action, { flagOn, live, canRead, edit, canModify, kind });
  if (!d.ok) return { error: json({ error: d.error, ...(d.code ? { code: d.code } : {}) }, d.status) };
  return {
    email: principal.email,
    principal,
    file,
    kind,
    flagOn,
    canWrite: edit.ok && canModify,
  };
}

/**
 * The body GET, POST, PATCH and PUT answer with: the job (or a `none` status)
 * and what this caller may do next.
 *
 * `stale` is reported rather than hidden: a proxy of a file's previous contents
 * plays perfectly and shows the wrong footage, so the player must be able to
 * refuse it, and the detail page to offer a rebuild.
 *
 * A finished, current proxy also carries a playable `url`, so a player watching
 * a transcode can switch to the rendition when it lands instead of waiting for
 * a reload. Signed only in that one case: while a job is queued or working
 * there is nothing to sign, which is also when the web polls this.
 */
export async function proxyBody(ctx, row) {
  const stale = isStale(row, ctx.file);
  let url = null;
  if (row?.status === 'done' && !stale && row.proxyKey) {
    try {
      const [signed] = await presignFileUrls([{ ...ctx.file, proxyKey: row.proxyKey }], { previews: false });
      url = signed?.proxyUrl || null;
    } catch { /* the bucket's problem, not this answer's: the player keeps the master */ }
  }
  return {
    proxy: { ...proxyJson(row), stale, url },
    canRequest: !!ctx.canWrite && isProxyableKind(ctx.kind),
    canDelete: !!ctx.canWrite && !!row,
  };
}

/**
 * Delete one proxy rendition from the bucket, best effort.
 *
 * Called after the row that named it is gone or has let it go, so there is
 * nothing left pointing at it: the generic preview GC cannot find a proxy (its
 * key is not a column on `files`), and a rendition is big enough that waiting
 * for a sweep would be a real bill.
 *
 * Only a server-named proxy key, so a bug elsewhere cannot turn this into a
 * delete of something else. Never throws: a bucket that cannot be reached leaves
 * an orphaned object, which is the cheaper of the two failures.
 */
export async function dropProxyObject(key) {
  if (!isProxyKey(key)) return false;
  try {
    const cfg = await getStorageConfig();
    if (storageMode(cfg) !== 's3') return false;
    await s3DeleteObject(cfg, key);
    return true;
  } catch (e) {
    console.warn('[proxy] could not remove the old rendition:', e.message);
    return false;
  }
}
