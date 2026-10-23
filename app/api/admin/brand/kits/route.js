import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { countLinksByKit } from '@/lib/db';
import { parseBrandKit, kitNameTaken, MAX_KITS } from '@/lib/share-brands';
import { newKitId, readKitsForChange, writeKits } from '@/lib/share-brands-store';
import { readJsonBody } from '@/lib/request-body';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
// A kit is a name, three addresses, a colour and a font.
const MAX_BODY = 8 * 1024;

/**
 * GET /api/admin/brand/kits → { kits: [{ id, name, logoUrl, logoDarkUrl?,
 * accent, displayFontFamily?, displayFontUrl?, updatedAt, links }] }
 *
 * The brand kits sharers may dress a link's page in (lib/share-brands.js),
 * each with how many live links wear it now (`links`). Admins only, like
 * the workspace brand: the addresses here are what share pages load.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const read = await readKitsForChange();
  if (read.error) return read.error;
  const counts = await countLinksByKit().catch(() => ({}));
  return json({ kits: read.kits.map((k) => ({ ...k, links: counts[k.id] || 0 })) });
}

/**
 * POST /api/admin/brand/kits { name, logoUrl, logoDarkUrl?, accent,
 * displayFontFamily?, displayFontUrl? } → { kit }
 *
 * A new kit, checked whole (parseBrandKit) and refused with a sentence for
 * the form when anything is wrong. Names are kept apart, in any case, since
 * the share dialog offers kits by name.
 */
export async function POST(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const body = await readJsonBody(req, { max: MAX_BODY });
  if (body.error) return json({ error: body.error }, body.status);
  const parsed = parseBrandKit(body.body);
  if (parsed.error) return json({ error: parsed.error }, 400);

  const read = await readKitsForChange();
  if (read.error) return read.error;
  if (read.kits.length >= MAX_KITS) return json({ error: `A workspace can keep ${MAX_KITS} kits. Remove one to add another.` }, 409);
  if (kitNameTaken(read.kits, parsed.kit.name)) return json({ error: `There is a kit called “${parsed.kit.name}” already.` }, 409);

  const kit = { id: newKitId(), ...parsed.kit, updatedAt: Date.now() };
  await writeKits([...read.kits, kit], guard.email);
  await audit(guard.email, 'brand.kit.create', { type: 'brand-kit', id: kit.id, label: kit.name }, { accent: kit.accent });
  return json({ kit: { ...kit, links: 0 } });
}
