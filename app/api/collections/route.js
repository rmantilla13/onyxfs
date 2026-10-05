import { NextResponse } from 'next/server';
import { requirePrincipal, libraryOpen, NO_LIBRARY } from '@/lib/authz';
import { listCollections, createCollection, listFilespacesForSpace, getFileMetadataSchema } from '@/lib/db';
import { validateCollectionInput, sameName, LIMITS } from '@/lib/collections';
import { canEditCollections, collectionForClient, visibleCollections } from '@/lib/collection-scope';
import { normalizeSchema } from '@/lib/dam';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Collections (lib/collections.js): the files that meet a set of rules on
 * their kind, tags and metadata, shared with everyone who can open the drive
 * they were made in. The web and Onyx for iPhone read them here, with the
 * session or the device's token.
 *
 * A collection grants nothing. Its files come from GET /api/files?collection=,
 * through the listing's own access rules.
 */

const json = (body, status = 200) => NextResponse.json(body, { status });

/**
 * GET → { collections: [{ id, driveId, name, match, rules, updatedAt, canEdit }], fields, canCreate }
 *
 * Every collection in All Files and in the drives the caller can open, by
 * drive then name. With what a client's rule editor needs and has no other
 * way to read: the workspace's metadata fields (lib/dam.js; their names and
 * choices, which every member sees on the web anyway), and where this caller
 * may make a collection — drive ids, '' for All Files.
 *
 * `?stranded=1` adds the collections made in All files while there is none
 * (lib/collection-scope.js isStranded), marked `stranded`, for whoever may
 * move or delete them: the web does; a client that cannot is not sent them.
 * A list it cannot read in full is a 503 rather than a short one: a client
 * keeps this as the whole list, and a short one reads as deletions.
 */
export async function GET(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  // The flags unread: whether there is an All files is not known, so which
  // collections are its is not either. A short list would read as deletions.
  if (g.principal.degraded) return json({ error: 'Collections could not be read just now. Try again.' }, 503);
  let all, drives, rawSchema;
  try {
    [all, drives, rawSchema] = await Promise.all([
      listCollections(), listFilespacesForSpace(g.email, g.principal, { strict: true }), getFileMetadataSchema(),
    ]);
  } catch (e) {
    console.warn('[collections] could not be read:', e.message);
    return json({ error: 'Collections could not be read just now. Try again.' }, 503);
  }
  const canCreate = [null, ...drives].filter((d) => canEditCollections(g.principal, d)).map((d) => (d ? d.id : ''));
  const stranded = new URL(req.url).searchParams.get('stranded') === '1';
  return json({
    collections: visibleCollections(all, g.principal, drives, { stranded }),
    fields: normalizeSchema(rawSchema).fields.map(({ key, label, type, options }) => ({ key, label, type, ...(options?.length ? { options } : {}) })),
    canCreate,
  });
}

/**
 * POST { name, driveId?, match?, rules } → 201 { collection }
 *
 * 400 names what is wrong; 403 is a drive the caller may not change; 409 a
 * name already used in that drive, or the most collections there may be.
 */
export async function POST(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const read = await readJsonBody(req);
  if (read.error) return json({ error: read.error }, read.status);
  const schema = normalizeSchema(await getFileMetadataSchema());
  const v = validateCollectionInput(read.body, { schema });
  if (v.error) return json({ error: v.error }, 400);

  const [all, drives] = await Promise.all([listCollections(), listFilespacesForSpace(g.email, g.principal)]);
  const drive = v.value.driveId ? drives.find((d) => d.id === v.value.driveId) : null;
  // The same answer for a drive that does not exist and one they are not in.
  if (v.value.driveId && !drive) return json({ error: 'That is not a drive you can open.' }, 400);
  if (!v.value.driveId && !libraryOpen(g.principal)) return json({ error: NO_LIBRARY, code: 'drive_required' }, 400);
  if (!canEditCollections(g.principal, drive)) {
    return json({ error: drive ? 'You can view this drive but not change it.' : 'Your role cannot make collections.' }, 403);
  }
  const here = all.filter((c) => c.driveId === v.value.driveId);
  if (all.length >= LIMITS.collections) {
    return json({ error: `There are ${LIMITS.collections} collections, the most there can be. Delete one first.` }, 409);
  }
  if (here.some((c) => sameName(c.name, v.value.name))) {
    return json({ error: `There is already a collection called “${v.value.name}” here.` }, 409);
  }
  const made = await createCollection(v.value, { createdBy: g.email });
  return json({ collection: collectionForClient(made, g.principal, drives) }, 201);
}
