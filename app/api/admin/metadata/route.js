import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getFileMetadataSchema, setFileMetadataSchema } from '@/lib/db';
import { readGlobalFlags } from '@/lib/authz';
import { addMetadataField } from '@/lib/dam';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST { label, type, options } — add a metadata field to the schema, which
 * makes it a facet, a list column and an editable value on every file.
 *
 * Admin rather than per-user: the schema is the workspace's, and a field one
 * person adds appears for everyone. Values are still written per file through
 * PATCH /api/files/[id], under that route's own write check.
 */
export async function POST(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  // The `metadata` flag, read here: off, the schema is not edited either.
  const flags = await readGlobalFlags();
  if (!flags?.metadata) return NextResponse.json({ error: 'Metadata is turned off.' }, { status: 403 });
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  let stored;
  try {
    // Strict and fresh: see getFileMetadataSchema. A failed read must stop
    // the write, not turn into "there were no custom fields".
    stored = await getFileMetadataSchema({ fresh: true, strict: true });
  } catch (e) {
    return NextResponse.json({ error: `Could not read the current fields: ${e.message}` }, { status: 503 });
  }

  const { schema, field, error } = addMetadataField(stored, {
    label: body.label,
    type: body.type,
    options: body.options,
  });
  if (error) return NextResponse.json({ error }, { status: 400 });

  await setFileMetadataSchema(schema, guard.email);
  return NextResponse.json({ schema, field });
}
