import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getStorageConfig, storageMode, buildMountInstaller } from '@/lib/storage';
import { getBrandConfig } from '@/lib/db';
import { resolveBrand } from '@/lib/brand-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/storage/installer — download a branded macOS .command that
 * mounts the configured bucket as a local drive (rclone + macFUSE).
 * Admin-only: the script embeds the bucket credentials.
 */
export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const cfg = await getStorageConfig({ fresh: true });
  if (storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'Configure a custom S3 bucket first (Storage → Custom bucket).' }, { status: 400 });
  }

  let brand = { name: 'Onyx', accent: '#5A6B1F' };
  try {
    const b = resolveBrand(await getBrandConfig());
    brand = { name: b.name || 'Onyx', accent: b.colorAccentDeep || b.colorAccent || '#5A6B1F' };
  } catch {}

  const script = buildMountInstaller(cfg, brand);
  const slug = (brand.name || 'Brand').replace(/[^A-Za-z0-9]+/g, '-');
  return new NextResponse(script, {
    headers: {
      'Content-Type': 'application/x-sh; charset=utf-8',
      'Content-Disposition': `attachment; filename="Install-${slug}-library.command"`,
    },
  });
}
