// lib/transcript-guard.js — the opening every transcript route shares: who is
// asking (the browser's session or the Mac's bearer token, one principal
// either way), which file, whether it is live, whether the flag is on, and
// whether they may do what they ask.
//
// The rule is lib/transcripts.js's (transcriptDecision); this only gathers
// what it needs, on the server, from the session and the database — never
// from the request. Node only: it reaches lib/db.js.

import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/desktop-guard';
import { can } from '@/lib/authz';
import { getFileById, canAccessFile, canModifyFile } from '@/lib/db';
import { isFeatureEnabled } from '@/lib/features';
import { effectiveKind } from '@/lib/media';
import { transcriptDecision, transcriptJson, isTranscribableKind, MAX_BODY_BYTES } from '@/lib/transcripts';

export const json = (body, status = 200) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Open a file's transcript for `action` (see transcriptDecision). Returns
 * { email, principal, file, kind, flagOn, canWrite } or { error: Response }.
 *
 * `canWrite` — files.edit and write access to this file, drives applied —
 * is worked out for every action, reads included, because the read answers
 * with canRequest and canDelete: what the buttons show, which the writes
 * then check again for themselves.
 */
export async function openTranscript(req, fileId, action = 'read') {
  const actor = await resolveActor(req);
  if (actor.error) return { error: actor.error };
  const { principal } = actor;
  const flagOn = isFeatureEnabled(principal.flags, 'transcripts');
  // The flag first: off, nothing is looked up.
  if (!flagOn) {
    const d = transcriptDecision(action, { flagOn });
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

  const d = transcriptDecision(action, { flagOn, live, canRead, edit, canModify, kind });
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
 * The body GET, POST and PUT answer with: the transcript (or null) and what
 * this caller may do next. Request: video or audio, with write access.
 * Delete: write access, and something to delete.
 */
export function transcriptBody(ctx, row) {
  return {
    transcript: transcriptJson(row, ctx.file),
    canRequest: !!ctx.canWrite && isTranscribableKind(ctx.kind),
    canDelete: !!ctx.canWrite && !!row,
  };
}

/**
 * A JSON body of at most 4 MB (the contract's limit). → { body } or
 * { error: Response }. The declared length is checked before anything is
 * read, and the text after, since a length header is only a claim.
 */
export async function readJson(req, { max = MAX_BODY_BYTES, optional = false } = {}) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { error: json({ error: 'That request is larger than 4 MB.' }, 413) };
  let text;
  try { text = await req.text(); } catch { return { error: json({ error: 'Bad request' }, 400) }; }
  if (Buffer.byteLength(text, 'utf8') > max) return { error: json({ error: 'That request is larger than 4 MB.' }, 413) };
  if (!text.trim()) return optional ? { body: {} } : { error: json({ error: 'Expected a JSON body.' }, 400) };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: json({ error: 'Expected a JSON object.' }, 400) };
    return { body };
  } catch {
    return { error: json({ error: 'That is not valid JSON.' }, 400) };
  }
}

/** 409 { code: 'lost' }: the job is not this caller's working job any more, and the Mac must stop it. */
export function lost() {
  return json({ error: 'This job is no longer yours: it was requested again, deleted or taken over. Stop working on it.', code: 'lost' }, 409);
}
