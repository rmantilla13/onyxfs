import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { countLinksByKit } from '@/lib/db';
import { parseBrandKit, kitNameTaken, isKitId } from '@/lib/share-brands';
import { readKitsForChange, writeKits } from '@/lib/share-brands-store';
import { readJsonBody } from '@/lib/request-body';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const MAX_BODY = 8 * 1024;
const notFound = () => json({ error: 'There is no such kit. It may have been removed; reload the page.' }, 404);

/**
 * PATCH /api/admin/brand/kits/[id] { the whole kit, as POST takes it } → { kit }
 *
 * Replaces the kit under the same id, so every link that wears it shows the
 * change on its next visit — the id, not the name, is what a link keeps.
 */
export async function PATCH(req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  if (!isKitId(params?.id)) return notFound();
  const body = await readJsonBody(req, { max: MAX_BODY });
  if (body.error) return json({ error: body.error }, body.status);
  const parsed = parseBrandKit(body.body);
  if (parsed.error) return json({ error: parsed.error }, 400);

  const read = await readKitsForChange();
  if (read.error) return read.error;
  const before = read.kits.find((k) => k.id === params.id);
  if (!before) return notFound();
  if (kitNameTaken(read.kits, parsed.kit.name, before.id)) return json({ error: `There is a kit called “${parsed.kit.name}” already.` }, 409);

  const kit = { id: before.id, ...parsed.kit, updatedAt: Date.now() };
  await writeKits(read.kits.map((k) => (k.id === kit.id ? kit : k)), guard.email);
  const changed = Object.keys({ ...before, ...kit }).filter((key) => key !== 'updatedAt' && before[key] !== kit[key]);
  await audit(guard.email, 'brand.kit.update', { type: 'brand-kit', id: kit.id, label: kit.name }, { changed });
  const counts = await countLinksByKit().catch(() => ({}));
  return json({ kit: { ...kit, links: counts[kit.id] || 0 } });
}

/**
 * DELETE /api/admin/brand/kits/[id] → { ok, links }
 *
 * The links that wore it are left as they are, and show the workspace's
 * look from their next visit: the page finds no kit by the id they keep
 * (lib/brand-config.js loadShareKit). `links` is how many live ones that is.
 */
export async function DELETE(_req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  if (!isKitId(params?.id)) return notFound();
  const read = await readKitsForChange();
  if (read.error) return read.error;
  const gone = read.kits.find((k) => k.id === params.id);
  if (!gone) return notFound();
  await writeKits(read.kits.filter((k) => k.id !== gone.id), guard.email);
  const links = (await countLinksByKit().catch(() => ({})))[gone.id] || 0;
  await audit(guard.email, 'brand.kit.delete', { type: 'brand-kit', id: gone.id, label: gone.name }, { links });
  return json({ ok: true, links });
}
