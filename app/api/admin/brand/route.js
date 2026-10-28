import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getBrandConfig, setBrandConfig } from '@/lib/db';
import { defaultBrandConfig, sanitizeBrandSubmission } from '@/lib/brand-config';
import { parseKitUrl } from '@/lib/share-brands';
import { readJsonBody } from '@/lib/request-body';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const MAX_BODY = 16 * 1024;

const COLOURS = ['colorPaper', 'colorInk', 'colorMuted', 'colorLine', 'colorAccent', 'colorAccentDeep', 'colorAccentAlt', 'colorAccentCool', 'colorWarning', 'colorDanger'];
const IMAGES = { markUrl: 'The mark', lockupUrl: 'The wordmark', lockupDarkUrl: 'The dark wordmark', displayFontUrl: 'The display font', bodyFontUrl: 'The body font' };

/**
 * GET /api/admin/brand → { config, defaults }
 *
 * The workspace brand as saved (only the fields an admin set) and the Onyx
 * defaults it is laid over (lib/brand-config.js), for the form to show each
 * default as a placeholder rather than an empty box. Read fresh: the form
 * must never show a brand older than the one just saved.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let config;
  try {
    config = await getBrandConfig({ fresh: true, strict: true });
  } catch {
    return json({ error: 'Could not read the brand. Try again.' }, 503);
  }
  return json({ config: sanitizeBrandSubmission(config), defaults: defaultBrandConfig() });
}

/**
 * PUT /api/admin/brand { config } → { config }
 *
 * The whole workspace brand, as the form holds it: what is sent replaces
 * what was saved, and a field left blank goes back to the default. Only the
 * fields the form may write are kept (sanitizeBrandSubmission — never the
 * desktop scheme, which is compiled into the app). A colour that is not
 * #RRGGBB, or an address that is not https:// or a path on this site, is
 * refused with a sentence saying which, rather than saved and ignored.
 */
export async function PUT(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const read = await readJsonBody(req, { max: MAX_BODY });
  if (read.error) return json({ error: read.error }, read.status);
  const submitted = read.body?.config;
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return json({ error: 'Send the brand to save.' }, 400);

  const config = sanitizeBrandSubmission(submitted);
  for (const key of COLOURS) {
    if (config[key] != null && !/^#[0-9a-fA-F]{6}$/.test(config[key].trim())) {
      return json({ error: `Write each colour as #RRGGBB (${key.replace(/^color/, '')} is “${config[key]}”).`, field: key }, 400);
    }
  }
  for (const [key, what] of Object.entries(IMAGES)) {
    const checked = parseKitUrl(config[key], what);
    if (checked.error) return json({ error: checked.error, field: key }, 400);
  }

  await setBrandConfig(config, guard.email);
  await audit(guard.email, 'brand.update', { type: 'brand', id: 'brand.config', label: 'Workspace brand' }, { fields: Object.keys(config) });
  return json({ config });
}
