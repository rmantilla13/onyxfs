import { NextResponse } from 'next/server';
import { listShareTemplates, saveShareTemplate } from '@/lib/db';
import { requirePrincipal } from '@/lib/authz';
import { parseTemplateName, parseTemplateSettings, MAX_TEMPLATES } from '@/lib/share-kinds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Someone's own share templates: starting points for the share dialog's form
 * (lib/share-kinds.js — the built-in ones are there too, as constants). A
 * template is choices, never a grant: a link made from one is parsed and
 * checked as any other, so nothing here is gated on the role's link
 * capabilities or the `shares` flag. Each person sees and changes only
 * their own.
 *
 * GET /api/share-templates → { templates: [{ id, name, settings, createdAt }] }
 */
export async function GET(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  return NextResponse.json({ templates: await listShareTemplates(g.email) });
}

/**
 * POST /api/share-templates { name, settings } → { template }
 *
 * Keeps the settings (parseTemplateSettings: who the link is for, its expiry
 * in days, what its people may do, downloads, its views and its look —
 * never a password, nor a single date) under the name. Saving under a name
 * already used replaces that template.
 */
export async function POST(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  const name = parseTemplateName(body.name);
  if (name.error) return NextResponse.json({ error: name.error }, { status: 400 });
  const settings = parseTemplateSettings(body.settings);
  if (settings.error) return NextResponse.json({ error: settings.error }, { status: 400 });
  const template = await saveShareTemplate(g.email, { name: name.name, settings: settings.settings }, { max: MAX_TEMPLATES });
  if (!template) {
    return NextResponse.json({ error: `You can keep ${MAX_TEMPLATES} templates. Remove one to save another.` }, { status: 409 });
  }
  return NextResponse.json({ template });
}
