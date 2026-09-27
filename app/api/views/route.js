import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/authz';
import { listSavedViews, createSavedView, listFilespacesForSpace } from '@/lib/db';
import { validateViewInput, visibleViews, sameName, toClientView, LIMITS } from '@/lib/views';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A person's saved views of the files page (lib/views.js): named filters,
 * a sort and display settings, shared by the web and the Mac app. Each
 * person reads and writes only their own — the owner is the session, never
 * a parameter — and a view scoped to a drive comes back only while that
 * drive is one they can open.
 *
 * A view grants nothing. It is a description of a listing; the listing it
 * describes still goes through /api/files and its access rules.
 */

const json = (body, status = 200) => NextResponse.json(body, { status });

/** GET → { views: [{ id, name, driveId, filters, sort, display, updatedAt }] }, oldest first. */
export async function GET() {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const [views, drives] = await Promise.all([listSavedViews(g.email), listFilespacesForSpace(g.email, g.principal)]);
  return json({ views: visibleViews(views, drives).map(toClientView) });
}

/**
 * POST { name, driveId?, filters?, sort?, display? } → 201 { view }
 *
 * 400 names what is wrong with the view; 409 is a name already in use, or
 * the most views one person may keep.
 */
export async function POST(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const read = await readJsonBody(req);
  if (read.error) return json({ error: read.error }, read.status);
  const v = validateViewInput(read.body);
  if (v.error) return json({ error: v.error }, 400);

  const [views, drives] = await Promise.all([listSavedViews(g.email), listFilespacesForSpace(g.email, g.principal)]);
  // The same answer for a drive that does not exist and one they are not
  // in: which drives exist is not theirs to find out from here.
  if (v.value.driveId && !drives.some((d) => d.id === v.value.driveId)) {
    return json({ error: 'That is not a drive you can open.' }, 400);
  }
  if (views.length >= LIMITS.views) {
    return json({ error: `You have ${LIMITS.views} saved views, the most one person can keep. Delete one first.` }, 409);
  }
  if (visibleViews(views, drives).some((x) => sameName(x.name, v.value.name))) {
    return json({ error: `You already have a view called “${v.value.name}”.` }, 409);
  }
  const view = await createSavedView(g.email, v.value);
  return json({ view: toClientView(view) }, 201);
}
