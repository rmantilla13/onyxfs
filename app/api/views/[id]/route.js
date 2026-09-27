import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/authz';
import { listSavedViews, updateSavedView, deleteSavedView, listFilespacesForSpace } from '@/lib/db';
import {
  validateViewInput, visibleViews, sameName, toClientView, normalizeFilters, normalizeDisplay, normalizeSort,
} from '@/lib/views';
import { readJsonBody } from '@/lib/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One saved view: rename it, rescope it, save changes to it, delete it.
 * Only its owner, and only while it is one they can see — someone else's
 * view, and one scoped to a drive they were taken off, are both a 404, the
 * same answer as an id that never existed (see ../route.js).
 */

const json = (body, status = 200) => NextResponse.json(body, { status });

/** The caller's view `id` as GET /api/views would list it, with what the checks need. */
async function mine(g, id) {
  const [views, drives] = await Promise.all([listSavedViews(g.email), listFilespacesForSpace(g.email, g.principal)]);
  const visible = visibleViews(views, drives);
  return { view: visible.find((v) => v.id === id) || null, visible, drives };
}

/**
 * PATCH { name?, driveId?, filters?, sort?, display? } → { view }
 *
 * What is sent replaces what was saved, setting by setting; what is not sent
 * stays. `filters` and `display` are replaced whole, as the page sends them.
 */
export async function PATCH(req, { params }) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const read = await readJsonBody(req);
  if (read.error) return json({ error: read.error }, read.status);
  const v = validateViewInput(read.body, { partial: true });
  if (v.error) return json({ error: v.error }, 400);

  const { view, visible, drives } = await mine(g, String(params?.id || ''));
  if (!view) return json({ error: 'No such view.' }, 404);
  if (v.value.driveId && !drives.some((d) => d.id === v.value.driveId)) {
    return json({ error: 'That is not a drive you can open.' }, 400);
  }
  if (v.value.name && visible.some((x) => x.id !== view.id && sameName(x.name, v.value.name))) {
    return json({ error: `You already have a view called “${v.value.name}”.` }, 409);
  }
  const next = {
    name: v.value.name ?? view.name,
    driveId: v.value.driveId !== undefined ? v.value.driveId : view.driveId,
    filters: v.value.filters ?? normalizeFilters(view.filters),
    sort: v.value.sort ?? normalizeSort(view.sort),
    display: v.value.display ?? normalizeDisplay(view.display),
  };
  const saved = await updateSavedView(view.id, g.email, next);
  if (!saved) return json({ error: 'No such view.' }, 404);
  return json({ view: toClientView(saved) });
}

/** DELETE → { ok: true } */
export async function DELETE(_req, { params }) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { view } = await mine(g, String(params?.id || ''));
  if (!view || !(await deleteSavedView(view.id, g.email))) return json({ error: 'No such view.' }, 404);
  return json({ ok: true });
}
