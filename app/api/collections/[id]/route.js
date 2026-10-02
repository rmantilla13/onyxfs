import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/authz';
import { listCollections, updateCollection, deleteCollection, listFilespacesForSpace, getFileMetadataSchema } from '@/lib/db';
import { validateCollectionInput, sameName } from '@/lib/collections';
import { collectionFor } from '@/lib/collection-scope';
import { normalizeSchema } from '@/lib/dam';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One collection: rename it, change its rules, delete it. Whoever may edit
 * files in its drive (lib/collection-scope.js canEditCollections). One in a
 * drive the caller cannot open is a 404, the same as an id that never was.
 */

const json = (body, status = 200) => NextResponse.json(body, { status });

/** PATCH { name?, match?, rules? } → { collection }. What is not sent stays. */
export async function PATCH(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const read = await readJsonBody(req);
  if (read.error) return json({ error: read.error }, read.status);
  const schema = normalizeSchema(await getFileMetadataSchema());
  const v = validateCollectionInput(read.body, { partial: true, schema });
  if (v.error) return json({ error: v.error }, 400);

  const drives = await listFilespacesForSpace(g.email, g.principal);
  const c = await collectionFor(params.id, g.principal, drives);
  if (!c) return json({ error: 'No such collection.' }, 404);
  if (!c.canEdit) return json({ error: 'You can view this collection but not change it.' }, 403);
  if (v.value.rules && !v.value.rules.length) return json({ error: 'Add at least one rule, or every file would match.' }, 400);
  if (v.value.name && !sameName(v.value.name, c.name)) {
    const taken = (await listCollections()).some((x) => x.id !== c.id && x.driveId === c.driveId && sameName(x.name, v.value.name));
    if (taken) return json({ error: `There is already a collection called “${v.value.name}” here.` }, 409);
  }
  const next = await updateCollection(c.id, {
    name: v.value.name ?? c.name,
    match: v.value.match ?? c.match,
    rules: v.value.rules ?? c.rules,
  });
  if (!next) return json({ error: 'No such collection.' }, 404);
  return json({
    collection: { id: next.id, driveId: next.driveId, name: next.name, match: next.match, rules: next.rules, updatedAt: next.updatedAt, canEdit: true },
  });
}

/** DELETE → { ok: true } */
export async function DELETE(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const c = await collectionFor(params.id, g.principal);
  if (!c) return json({ error: 'No such collection.' }, 404);
  if (!c.canEdit) return json({ error: 'You can view this collection but not change it.' }, 403);
  await deleteCollection(c.id);
  return json({ ok: true });
}
