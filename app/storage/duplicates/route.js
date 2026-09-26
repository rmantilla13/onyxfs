import { NextResponse } from 'next/server';
import { legacyStoragePath } from '@/lib/admin-redirects';

export const dynamic = 'force-dynamic';

/** /storage/duplicates moved into the admin panel (Admin → Storage → Duplicates). */
export function GET(req) {
  const url = new URL(req.url);
  return NextResponse.redirect(new URL(legacyStoragePath(url.pathname, url.search) || '/admin/usage/duplicates', req.url), 307);
}
