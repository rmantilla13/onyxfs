import { loadBrand, defaultBrandConfig } from '@/lib/brand-config';
import { corsOrigins } from '@/lib/storage-cors';

/**
 * The origins this deployment's bucket should let browsers upload from:
 * the one the request came in on, NEXT_PUBLIC_APP_URL, the brand's own
 * origin when one is configured, and Vercel previews when on Vercel
 * (corsOrigins has the rule). Shared by Apply CORS and by the Backend page,
 * which shows them before anything is applied.
 */
export async function deploymentOrigins(req) {
  let requestOrigin = '';
  try { requestOrigin = new URL(req.url).origin; } catch { /* leave blank */ }
  const brand = await loadBrand().catch(() => null);
  return corsOrigins({
    requestOrigin,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || '',
    brandOrigin: brand?.origin || '',
    fallbackOrigin: defaultBrandConfig().origin,
    vercel: !!process.env.VERCEL_ENV,
  });
}
