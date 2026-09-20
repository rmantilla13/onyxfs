import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { bulkPatchFileMetadata, getFileMetadataSchema } from '@/lib/db';
import { normalizeSchema, validateMetadataPatch } from '@/lib/dam';

export const runtime = 'nodejs';

/**
 * POST /api/files/metadata-bulk — merge a metadata patch into many assets at
 * once (the Space bulk-edit bar). Body: { ids: string[], patch: object }. The
 * patch is validated against the field schema (unknown keys / wrong types are
 * dropped) so a stray request can't pollute the metadata JSONB.
 */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const raw = body.patch && typeof body.patch === 'object' ? body.patch : null;
  if (!ids.length || !raw) return NextResponse.json({ error: 'ids and patch are required.' }, { status: 400 });
  const schema = normalizeSchema(await getFileMetadataSchema());
  const patch = validateMetadataPatch(raw, schema);
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'No valid fields in the patch.' }, { status: 400 });
  try {
    const r = await bulkPatchFileMetadata(ids, patch);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Bulk update failed.' }, { status: 500 });
  }
}
