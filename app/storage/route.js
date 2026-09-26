import { NextResponse } from 'next/server';
import { legacyStoragePath } from '@/lib/admin-redirects';

export const dynamic = 'force-dynamic';

/** /storage moved into the admin panel (Admin → Storage → Usage). */
export function GET(req) {
  const url = new URL(req.url);
  return NextResponse.redirect(new URL(legacyStoragePath(url.pathname, url.search) || '/admin/usage', req.url), 307);
}
