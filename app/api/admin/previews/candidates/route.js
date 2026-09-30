import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getFilespace, canonicalFolder, listPreviewCandidates, countPreviewCandidates } from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import { readPreviewScope, drawnClasses, kindsFor } from '@/lib/preview-jobs';
import { MEDIA_KEYS } from '@/lib/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAGE = 50;

// What a run reads of a row: its name and type, where its pictures are, and
// of its metadata only the facts about the media (the size a job draws at,
// the placeholder it may lack). Not the library's own fields, its tags or
// who added it: nothing a job needs.
const FIELDS = ['id', 'name', 'mime', 'kind', 'size', 'storage', 'folder', 'url', 'thumbnailKey', 'thumbnailUrl', 'thumbSizes', 'posterKey'];

function candidate(f) {
  const out = {};
  for (const k of FIELDS) if (f[k] !== undefined) out[k] = f[k];
  for (const size of Array.isArray(f.thumbSizes) ? f.thumbSizes : []) {
    if (typeof f[`${size}Url`] === 'string') out[`${size}Url`] = f[`${size}Url`];
  }
  const md = f.metadata && typeof f.metadata === 'object' ? f.metadata : {};
  out.metadata = Object.fromEntries(MEDIA_KEYS.filter((k) => md[k] !== undefined).map((k) => [k, md[k]]));
  return out;
}

/**
 * GET /api/admin/previews/candidates?drive=&folder=&kinds=&mode=&heic=&tiff=&after=&limit=
 *   → { files, after, done, counts? }
 *
 * The files an Admin → Previews run works through, a page at a time, in id
 * order after `after`: live files in the bucket in the scope asked for —
 * the whole library, one drive, a folder (and those in it) — of the kinds
 * asked for; every one this browser can draw with `mode=everything`, or
 * only those lacking a preview (lib/preview-jobs.js previewGaps). `heic`
 * and `tiff` say this browser decodes those (lib/decode-probe.js): a filter
 * on what to list, nothing more. A page may hold fewer files than `limit`,
 * even none, and not be the last (lib/db.js listPreviewCandidates): the
 * next starts at `after`, until `done`. The first page (no `after`) also
 * brings `counts`: { total, heic, tiff, never } — the files the run will be
 * handed, and those it will not be because this browser cannot draw them.
 *
 * Admins only, and the admin gate comes first. The run redraws previews of
 * files in every drive, which is an admin's to do: the thumbnail routes it
 * then calls authorize each write again (files.edit, canModifyFile).
 * Authorize → filter → presign: the scope is applied in the query, and only
 * the rows on the page are signed, after it.
 */
export async function GET(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const url = new URL(req.url);
  const scope = readPreviewScope(url.searchParams);
  let prefix = null;
  if (scope.drive) {
    const drive = await getFilespace(scope.drive).catch(() => null);
    if (!drive) return NextResponse.json({ error: 'That drive is not there any more.' }, { status: 404 });
    prefix = String(drive.prefix || '').replace(/^\/+|\/+$/g, '') || null;
  }
  // As the folder is stored in that scope, whichever way it was typed
  // (composed or not).
  const folder = scope.folder ? await canonicalFolder(scope.folder, prefix ? { tag: prefix, prefix } : {}) : null;
  const after = String(url.searchParams.get('after') || '');
  const limit = Number(url.searchParams.get('limit')) || PAGE;
  const query = { classes: drawnClasses(scope.decodes), kinds: kindsFor(scope.kinds), prefix, folder, mode: scope.mode };

  let page;
  let counts = null;
  try {
    [page, counts] = await Promise.all([
      listPreviewCandidates({ ...query, after, limit }),
      // One pass over the scope, once a run: a run without it only cannot
      // say how many are left.
      after ? null : countPreviewCandidates(query).catch((e) => {
        console.warn('[previews/candidates] count:', e.message);
        return null;
      }),
    ]);
  } catch (e) {
    console.warn('[previews/candidates]', e.message);
    return NextResponse.json({ error: 'The files could not be listed. Try again.' }, { status: 503 });
  }

  const signed = await presignFileUrls(page.files, { filmstrip: false });
  return NextResponse.json(
    { files: signed.map(candidate), after: page.after, done: page.done, ...(counts ? { counts } : {}) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
