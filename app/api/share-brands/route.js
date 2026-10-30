import { NextResponse } from 'next/server';
import { getShareBrands } from '@/lib/db';
import { requirePrincipal } from '@/lib/authz';
import { readKits, presentKit } from '@/lib/share-brands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/share-brands → { kits: [{ id, name, accent, logoUrl, logoDarkUrl }] }
 *
 * The brand kits an admin has made (Admin → Brand), for the share dialog to
 * offer under "How the page looks". Anyone signed in: a kit is a choice of
 * look, never a grant, and what the dialog then sends is checked again by
 * the route that makes or changes the link (lib/share-brands-store.js
 * kitRefusal).
 * A read that fails is no kits — the dialog offers the workspace's look,
 * which is what a link with none wears anyway.
 */
export async function GET(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const kits = readKits(await getShareBrands()).map(presentKit);
  return NextResponse.json({ kits }, { headers: { 'cache-control': 'no-store' } });
}
