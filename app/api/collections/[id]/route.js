import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/authz';
import { listCollections, updateCollection, deleteCollection, moveCollection, listFilespacesForSpace, getFileMetadataSchema } from '@/lib/db';
import { validateCollectionInput, sameName } from '@/lib/collections';
import { collectionFor, collectionForClient, canEditCollections } from '@/lib/collection-scope';
import { collectionMoves } from '@/lib/library-move';
import { normalizeSchema } from '@/lib/dam';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One collection: rename it, change its rules, delete it. Whoever may edit
 * files in its drive (lib/collection-scope.js canEditCollections). One in a
 * drive the caller cannot open is a 404, the same as an id that never was.
 *
 * One made in All files while there is none (isStranded) is only moved into
 * a drive or deleted, by whoever may edit files.
 */

const json = (body, status = 200) => NextResponse.json(body, { status });

/**
 * PATCH { name?, match?, rules? } → { collection }. What is not sent stays.
 * PATCH { driveId } → { collection, renamed }: one made in All files, while
 * there is none, moved into a drive — under a free name there when its own
 * is taken (`renamed`).
 */
export async function PATCH(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const read = await readJsonBody(req);
  if (read.error) return json({ error: read.error }, read.status);
  if (read.body && typeof read.body === 'object' && !Array.isArray(read.body) && 'driveId' in read.body) {
    return moveIntoDrive(g, params.id, read.body);
  }
  const schema = normalizeSchema(await getFileMetadataSchema());
  const v = validateCollectionInput(read.body, { partial: true, schema });
  if (v.error) return json({ error: v.error }, 400);

  const drives = await listFilespacesForSpace(g.email, g.principal);
  const c = await collectionFor(params.id, g.principal, drives, { stranded: true });
  if (!c) return json({ error: 'No such collection.' }, 404);
  if (c.stranded) return json({ error: 'This collection is in no drive. Move it into a drive first.' }, 409);
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

/** The stranded collection `id`, moved into the drive `body.driveId` names. */
async function moveIntoDrive(g, id, body) {
  if (Object.keys(body).some((k) => k !== 'driveId')) return json({ error: 'Send { driveId } alone to move a collection.' }, 400);
  const target = typeof body.driveId === 'string' ? body.driveId : '';
  if (!target) return json({ error: 'Choose the drive to move it into.' }, 400);
  const drives = await listFilespacesForSpace(g.email, g.principal);
  const c = await collectionFor(id, g.principal, drives, { stranded: true });
  if (!c) return json({ error: 'No such collection.' }, 404);
  if (!c.stranded) return json({ error: 'A collection stays in the drive it was made in.' }, 400);
  const drive = drives.find((d) => d.id === target);
  if (!drive) return json({ error: 'That is not a drive you can open.' }, 400);
  if (!canEditCollections(g.principal, drive)) return json({ error: 'You can view this drive but not change it.' }, 403);
  // A drive's collection names are its own: a taken one gets the next free,
  // chosen again should one be made or moved in there meanwhile.
  for (let tries = 0; tries < 3; tries++) {
    const all = await listCollections();
    if ((all.find((x) => x.id === c.id)?.driveId ?? null) !== '') {
      return json({ error: 'It was moved meanwhile. Reload to see where.' }, 409);
    }
    const [{ name }] = collectionMoves([...all.filter((x) => x.driveId === target), c], { driveId: target });
    const moved = await moveCollection(c.id, { driveId: target, name, from: '', free: true });
    if (moved) return json({ collection: collectionForClient(moved, g.principal, drives), renamed: name !== c.name });
  }
  return json({ error: 'Collections were being added to that drive at the same time. Try again.' }, 409);
}

/** DELETE → { ok: true } */
export async function DELETE(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const c = await collectionFor(params.id, g.principal, null, { stranded: true });
  if (!c) return json({ error: 'No such collection.' }, 404);
  if (!c.canEdit) return json({ error: 'You can view this collection but not change it.' }, 403);
  // Only where it was allowed: one moved meanwhile is not this one to delete.
  if (!(await deleteCollection(c.id, { driveId: c.driveId }))) return json({ error: 'It was moved meanwhile. Reload to see where.' }, 409);
  return json({ ok: true });
}
