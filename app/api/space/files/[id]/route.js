import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { getFileById, canAccessFile } from '@/lib/db';
import { can } from '@/lib/authz';
import { presignFileUrls } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A File Provider downloads a file when it is opened, which for a
// multi-gigabyte master can take longer than an hour on a slow line. The URL
// only has to outlive the start of the transfer, but a range retry after a
// dropped connection reuses it, so it is given the playable-video window.
const CONTENT_URL_TTL = 21600;

/**
 * GET /api/space/files/<id> (bearer) → { id, url, expiresAt, version, contentHash }
 *
 * Where to fetch one file's bytes, for a native client materialising it on
 * open. Authorize → presign, the same single-file check the web's detail view
 * makes (canAccessFile: drive boundary, owner, org, grants), so a device is
 * never handed a URL the web would refuse.
 *
 * Under /api/space so a bearer request gets a clean 401 rather than the
 * cookie gate's redirect to a sign-in page an extension cannot show.
 */
export async function GET(req, { params }) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  const { principal } = gate;
  const allowed = can(principal, 'desktop.mount');
  if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: allowed.status });

  const file = await getFileById(params.id);
  // A file you may not see and a file that does not exist answer the same, so
  // an id cannot be used to learn that something is there.
  if (!file || file.deletedAt || !(await canAccessFile(file, principal))) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const [signed] = await presignFileUrls([file], { expiresIn: CONTENT_URL_TTL });
  if (!signed?.url) return NextResponse.json({ error: 'This file has no stored copy to download.' }, { status: 409 });
  return NextResponse.json({
    id: file.id,
    url: signed.url,
    expiresAt: Date.now() + CONTENT_URL_TTL * 1000,
    version: file.version ?? 1,
    contentHash: file.contentHash || null,
  });
}
