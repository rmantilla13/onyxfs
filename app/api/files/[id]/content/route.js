import { NextResponse } from 'next/server';
import { claimUploadKey, issueUploadKey, storageKeyInUse, replaceFileContent } from '@/lib/db';
import { requirePrincipal, uploadCheck, refusal } from '@/lib/authz';
import { s3HeadObject, s3DeleteObject, publicUrlForKey, presignFileUrls } from '@/lib/storage';
import { previewKeysOf, dropUnusedPreviews } from '@/lib/preview-gc';
import { replacementTarget, dirOf } from '@/lib/replace-content';
import { ifMatchVersion } from '@/lib/file-record';
import { fileKind } from '@/lib/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const answer = (status, error, extra = {}) => NextResponse.json({ error, ...extra }, { status });

/**
 * POST /api/files/[id]/content  { key, mime? }   [If-Match: <version>]
 *   → { file }
 *
 * Swap in new contents for a file: the same file — id, name, folder, tags,
 * comments, links — with new bytes. What a save over a file in Finder is.
 * `key` is the one POST /api/files/presign or the multipart route handed out
 * for `replaceOf: <this id>`, once the bytes are at it (PUT done, or
 * multipart `complete`). lib/replace-content.js has the design.
 *
 * Checked, in order: the caller (the browser's session or Onyx for Mac's
 * bearer token), files.edit and write access to the file and its drive
 * (replacementTarget); a key that already is the file's contents, which
 * answers as the swap did, so a retry is safe; If-Match, when sent; that
 * the key was issued to this caller for this file, taken once
 * (claimUploadKey); that the object is there, measured by the bucket, never
 * by the client; and the largest upload and the quotas, for what the file
 * grows by. Then one conditional UPDATE (replaceFileContent), which refuses
 * a file moved, trashed or replaced again while these bytes were uploading.
 *
 * After it commits: the old object is deleted, since Onyx keeps no versions
 * yet — unless another row still names it — and the old previews go with it,
 * to be made again from the new bytes. version, updated_at and seq move, so
 * /api/files/delta carries the change to every device. A transcript is left
 * alone and reads as stale (its source_key is the old key), which it is.
 *
 * Refused after the key is taken — over a limit, or the file changed — the
 * new object is deleted: it is provably the caller's (issued to them, for
 * this, and named by no row) and would otherwise sit in the bucket counted
 * by nothing. A refusal worth retrying as it stands (not there yet) hands
 * the key back instead.
 */
export async function POST(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal, email } = g;
  let body;
  try { body = await req.json(); } catch { return answer(400, 'Bad request'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return answer(400, 'Bad request');
  const key = typeof body.key === 'string' && body.key.length <= 2048 ? body.key : '';
  if (!key) return answer(400, 'The key the new contents were uploaded to is required.');
  const mime = typeof body.mime === 'string' && body.mime.trim() ? body.mime.trim().slice(0, 255) : null;

  const target = await replacementTarget(principal, params.id);
  if (target.error) return target.error;
  const { file, cfg, base } = target;

  // Already the file's contents: a swap that went through and is being asked
  // for again, its answer lost on the way back. Answered as the first time —
  // before If-Match, whose version that swap itself moved on.
  if (key === file.storageKey) {
    const [signed] = await presignFileUrls([file]);
    return NextResponse.json({ file: signed || file });
  }
  // Asked before the key is taken: the caller may resolve the conflict and
  // come back with the same upload.
  const want = ifMatchVersion(req.headers.get('if-match'));
  if (want !== undefined && want !== Number(file.version)) {
    return answer(409, 'This file changed since you loaded it.', {
      code: 'version_mismatch', currentVersion: Number(file.version), file,
    });
  }

  // Issued to this caller, for this file, within the day, and taken once:
  // what makes the object theirs to swap in — and theirs to delete, below.
  const issued = await claimUploadKey(key, email, { replaceOf: file.id });
  if (!issued) {
    return answer(403, 'These contents were not uploaded by you for this file, or it was too long ago. Upload them again.', { code: 'not_issued' });
  }
  const giveBack = () => issueUploadKey(key, email, { bucket: issued.bucket, replaceOf: file.id }).catch(() => {});
  // Only where the key was issued: a file that has since moved to a drive in
  // another bucket leaves its upload where it was, for the key to expire.
  const discard = () => (cfg.bucket === issued.bucket
    ? s3DeleteObject(cfg, key).catch(() => false)
    : giveBack());

  // The new object was put beside the old one. A file moved since then is
  // elsewhere, and its new contents would sit in the folder it left.
  if (dirOf(key) !== dirOf(file.storageKey) || cfg.bucket !== issued.bucket) {
    await discard();
    return answer(409, 'This file was moved while its new contents were uploading. Nothing was changed; upload them again.', { code: 'moved' });
  }
  // Named by another row: some other upload was recorded at this key, and
  // the object is that file's now. Neither kept nor deleted here.
  if (await storageKeyInUse(key, { exceptId: file.id })) {
    return answer(409, 'That stored object belongs to another file. Upload the new contents again.', { code: 'conflict' });
  }

  // The bucket's word on what arrived, never the client's.
  const facts = await s3HeadObject(cfg, key);
  if (!facts) {
    await giveBack();
    return answer(409, 'The new contents are not in storage yet. Finish uploading them, then try again.', { code: 'not_uploaded' });
  }
  const size = facts.size != null ? facts.size : null;
  const fits = await uploadCheck(principal, { key, size, replaces: file.size });
  if (!fits.ok) {
    await discard();
    return refusal(fits);
  }

  let row;
  try {
    row = await replaceFileContent(file.id, {
      fromKey: file.storageKey,
      toKey: key,
      url: publicUrlForKey(cfg, key),
      size,
      mime,
      // Only what a new type says: the name still decides the rest.
      kind: mime ? fileKind(mime, file.name) : null,
      contentHash: facts.etag || null,
    });
  } catch (e) {
    await giveBack();
    return answer(500, e.message || 'Could not save the new contents. Try again.');
  }
  if (!row) {
    await discard();
    return answer(409, 'This file was moved, deleted or given other contents while these were uploading. Nothing was changed.', { code: 'changed' });
  }

  // Committed. The old bytes go — there are no versions to keep them in yet
  // — unless another row still names the object (recorded before POST
  // /api/files refused a key in use). An object left behind costs storage;
  // one deleted from under another file loses it, so a failed check keeps it.
  if (!(await storageKeyInUse(file.storageKey).catch(() => true))) {
    await s3DeleteObject(cfg, file.storageKey).catch((e) => {
      console.warn(`[content] the old contents of ${file.id} could not be deleted from ${file.storageKey}:`, e.message);
    });
  }
  // Pictures of the old bytes. Previews live in the deployment's bucket,
  // under _thumbs/, whatever drive the file is in.
  await dropUnusedPreviews(previewKeysOf(file), { cfg: base });

  const [signed] = await presignFileUrls([row]);
  return NextResponse.json({ file: signed || row });
}
