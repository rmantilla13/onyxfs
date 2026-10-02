import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/authz';
import { listCollections, createCollection, listFilespacesForSpace, getFileMetadataSchema } from '@/lib/db';
import { validateCollectionInput, collectionVisible, sameName, LIMITS } from '@/lib/collections';
import { canEditCollections } from '@/lib/collection-scope';
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

const toClient = (c, principal, drives) => {
  const drive = c.driveId ? drives.find((d) => d.id === c.driveId) : null;
  return {
    id: c.id, driveId: c.driveId, name: c.name, match: c.match, rules: c.rules,
    updatedAt: c.updatedAt, canEdit: canEditCollections(principal, drive),
  };
};

/**
 * GET → { collections: [{ id, driveId, name, match, rules, updatedAt, canEdit }], fields, canCreate }
 *
 * Every collection in All Files and in the drives the caller can open, by
 * drive then name. With what a client's rule editor needs and has no other
 * way to read: the workspace's metadata fields (lib/dam.js; their names and
 * choices, which every member sees on the web anyway), and where this caller
 * may make a collection — drive ids, '' for All Files.
 */
export async function GET(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const [all, drives, rawSchema] = await Promise.all([
    listCollections(), listFilespacesForSpace(g.email, g.principal), getFileMetadataSchema(),
  ]);
  const canCreate = [null, ...drives].filter((d) => canEditCollections(g.principal, d)).map((d) => (d ? d.id : ''));
  return json({
    collections: all.filter((c) => collectionVisible(c, drives)).map((c) => toClient(c, g.principal, drives)),
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
  return json({ collection: toClient(made, g.principal, drives) }, 201);
}
