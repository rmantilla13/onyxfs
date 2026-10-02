import { NextResponse } from 'next/server';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { getFilespaceForWrite, canModifyFolder, setFolderMeta, getFileMetadataSchema } from '@/lib/db';
import { cleanFolder } from '@/lib/folder-ops';
import { normalizeSchema, validateMetadataPatch } from '@/lib/dam';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Generous for any real folder, small enough that a hand-made request cannot
// make a row a megabyte.
const MAX_TAGS = 50;
const MAX_TAG = 60;

const bad = (error, status = 400) => NextResponse.json({ error }, { status });

/**
 * PUT /api/files/folders/meta  { folder, filespaceId?, tags?, metadata? } → { tags, metadata }
 *
 * A folder's own tags (the whole list) and metadata (merged; a field sent as
 * null is cleared). The files inside inherit them as far as collections are
 * concerned (lib/collections.js) — nothing else reads them, and they change
 * no one's access.
 *
 * Who may: whoever may edit a file's tags and metadata (files.edit), and may
 * change this folder — a drive's editors and owners, or in the library a
 * grant that allows it (canModifyFolder), as a rename asks.
 */
export async function PUT(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal } = g;
  const read = await readJsonBody(req);
  if (read.error) return bad(read.error, read.status);
  const body = read.body || {};

  const allowed = can(principal, 'files.edit', { metadata: body.metadata !== undefined });
  if (!allowed.ok) return refusal(allowed);

  const folder = cleanFolder(body.folder);
  if (!folder) return bad('Choose a folder.');

  let tag = '';
  let driveRole = null;
  if (body.filespaceId) {
    const fs = await getFilespaceForWrite(principal.email, String(body.filespaceId), principal);
    if (!fs) return bad('You can view this drive but not change it.', 403);
    tag = cleanFolder(fs.prefix);
    driveRole = fs.role;
  }
  if (!(await canModifyFolder(folder, principal, { driveRole, tag }))) return bad('No access to that folder.', 403);

  let tags;
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) return bad('tags must be a list of words.');
    tags = [...new Set(body.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (tags.length > MAX_TAGS) return bad(`A folder can have at most ${MAX_TAGS} tags.`);
    if (tags.some((t) => t.length > MAX_TAG)) return bad(`Keep each tag to ${MAX_TAG} characters.`);
  }
  let metadata;
  if (body.metadata !== undefined) {
    if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) return bad('metadata must be an object.');
    // The workspace's fields only, coerced to their types; the media's own
    // facts (width, duration, …) are a file's, never a folder's.
    const clean = validateMetadataPatch(body.metadata, normalizeSchema(await getFileMetadataSchema()));
    delete clean.width;
    delete clean.height;
    metadata = clean;
  }
  if (tags === undefined && metadata === undefined) return bad('Send tags, metadata or both.');

  const saved = await setFolderMeta(folder, { tag, tags, metadata, createdBy: principal.email });
  return NextResponse.json(saved);
}
