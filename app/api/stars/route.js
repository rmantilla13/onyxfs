import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/authz';
import { listFolderStars, setFolderStar, listFilespacesForSpace } from '@/lib/db';
import { cleanFolder, folderPathProblem } from '@/lib/folder-ops';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The most stars one person keeps. The sidebar lists them all.
const MAX_STARS = 200;

/**
 * A person's starred folders — the files sidebar's shortcuts (lib/db.js
 * folder_stars). Each person reads and writes only their own: the owner is
 * the session or Onyx for Mac's token, never a parameter. A star in a drive
 * comes back only while that drive is one they can open.
 *
 * A star grants nothing. Opening one is a listing like any other, through
 * /api/files and its access rules.
 */

const json = (body, status = 200) => NextResponse.json(body, { status });

/** Their stars whose drive — '' for the library — they can still open. */
async function visibleStars(email, principal) {
  const [stars, drives] = await Promise.all([listFolderStars(email), listFilespacesForSpace(email, principal)]);
  const ids = new Set(drives.map((d) => d.id));
  return { stars: stars.filter((s) => !s.driveId || ids.has(s.driveId)), drives };
}

/** GET → { stars: [{ driveId, folder }] }, oldest first. */
export async function GET(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { stars } = await visibleStars(g.email, g.principal);
  return json({ stars: stars.map(({ driveId, folder }) => ({ driveId, folder })) });
}

/**
 * PUT { driveId?, folder, starred } → { stars }
 *
 * Star or unstar a folder; either is idempotent. 400 for a path that is not
 * a folder's, or a drive they cannot open; 409 at the most one person keeps.
 */
export async function PUT(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const read = await readJsonBody(req);
  if (read.error) return json({ error: read.error }, read.status);
  const body = read.body || {};
  const folder = cleanFolder(body.folder);
  const problem = folderPathProblem(folder);
  if (problem) return json({ error: problem }, 400);
  const driveId = String(body.driveId || '');
  const starred = body.starred !== false;

  const { stars, drives } = await visibleStars(g.email, g.principal);
  // The same answer for a drive that does not exist and one they are not
  // in: which drives exist is not theirs to find out from here.
  if (driveId && !drives.some((d) => d.id === driveId)) {
    return json({ error: 'That is not a drive you can open.' }, 400);
  }
  const has = stars.some((s) => s.driveId === driveId && s.folder === folder);
  if (starred && !has && stars.length >= MAX_STARS) {
    return json({ error: `You have ${MAX_STARS} starred folders, the most one person can keep. Unstar one first.` }, 409);
  }
  if (starred !== has) await setFolderStar(g.email, { driveId, folder, starred });
  const next = starred
    ? (has ? stars : [...stars, { driveId, folder }])
    : stars.filter((s) => !(s.driveId === driveId && s.folder === folder));
  return json({ stars: next.map(({ driveId: d, folder: f }) => ({ driveId: d, folder: f })) });
}
