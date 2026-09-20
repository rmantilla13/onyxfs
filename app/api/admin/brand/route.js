import { NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/admin-guard';
import { getBrandConfig, setBrandConfig } from '@/lib/db';
import { defaultBrandConfig, resolveBrand, sanitizeBrandSubmission } from '@/lib/brand-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET → { saved, defaults, resolved }
 *
 * `defaults` lets the form show each Onyx default as a placeholder rather than
 * an empty field, so a blank input reads as "inherit" instead of "erase".
 */
export async function GET() {
  const guard = await requireSuperAdmin();
  if (guard.error) return guard.error;
  const saved = await getBrandConfig();
  return NextResponse.json({ saved, defaults: defaultBrandConfig(), resolved: resolveBrand(saved) });
}

/** PUT — replace the brand config. Unknown and read-only keys are dropped. */
export async function PUT(req) {
  const guard = await requireSuperAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const clean = sanitizeBrandSubmission(body);
  await setBrandConfig(clean, guard.email);
  return NextResponse.json({ saved: clean, resolved: resolveBrand(clean) });
}
