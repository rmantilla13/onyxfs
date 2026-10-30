import { NextResponse } from 'next/server';
import { requirePrincipal, can } from '@/lib/authz';
import { storagePrefixFor, folderPreviews, PREVIEW_MAX_FOLDERS } from '@/lib/file-listing';
import { cleanFolder } from '@/lib/folder-ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/files/previews { items: [{ filespace?, folder? }] } → { previews }
 *
 * What is in some folders, for the folder tiles and the drives' cards: each
 * item's newest pictures (lib/file-listing.js folderPreviews), the folder and
 * everything beneath it. `filespace` is a drive's id — none is All files —
 * and `folder` a path in it, '' its top. `previews` is parallel to `items`:
 * an array of { id, name, xs, sm, grid, width, height, placeholder } for
 * each, thumbnails only.
 *
 * Asked per item, as the listing is: a drive this person may not open, or
 * All files without the library, is an empty preview rather than an error —
 * one tile the page should not have drawn must not cost the others theirs.
 * At most PREVIEW_MAX_FOLDERS items in one request; the page asks for the
 * tiles on screen, a few at a time.
 *
 * The browser's session or Onyx for Mac's token (requirePrincipal(req)).
 */
export async function POST(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal, email } = g;
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items) return NextResponse.json({ error: 'Name the folders to preview.' }, { status: 400 });
  if (items.length > PREVIEW_MAX_FOLDERS) {
    return NextResponse.json({ error: `Ask for at most ${PREVIEW_MAX_FOLDERS} folders at a time.` }, { status: 400 });
  }

  // Each place once: a drive's prefix (or null, not theirs), and whether
  // All files is open to them at all.
  const places = new Map();
  const placeOf = async (filespace) => {
    if (places.has(filespace)) return places.get(filespace);
    let place;
    if (!filespace) {
      place = can(principal, 'library.use').ok ? { storagePrefix: undefined } : null;
    } else {
      const prefix = await storagePrefixFor(email, filespace, principal);
      place = prefix === null ? null : { storagePrefix: prefix };
    }
    places.set(filespace, place);
    return place;
  };

  // Group by place, ask each place's folders together, and put the answers
  // back in the order they were asked.
  const previews = new Array(items.length).fill(null).map(() => []);
  const groups = new Map();
  for (const [i, item] of items.entries()) {
    const filespace = typeof item?.filespace === 'string' ? item.filespace : '';
    const raw = typeof item?.folder === 'string' ? item.folder : '';
    if (raw.length > 1024) continue;
    const folder = cleanFolder(raw);
    if (!groups.has(filespace)) groups.set(filespace, []);
    groups.get(filespace).push({ i, folder });
  }
  for (const [filespace, asked] of groups) {
    const place = await placeOf(filespace);
    if (!place) continue;
    const got = await folderPreviews({ principal, storagePrefix: place.storagePrefix, folders: asked.map((a) => a.folder) });
    asked.forEach((a, k) => { previews[a.i] = got[k] || []; });
  }
  return NextResponse.json({ previews }, { headers: { 'cache-control': 'private, no-store' } });
}
