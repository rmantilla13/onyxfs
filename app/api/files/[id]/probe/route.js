import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFileById, buildPrincipal, canModifyFile } from '@/lib/db';
import { effectiveKind } from '@/lib/media';
import { probeFrameModel } from '@/lib/frame-probe';

export const runtime = 'nodejs';

/**
 * POST /api/files/[id]/probe — read a stored video's frame model (exact rate,
 * frame count, start timecode) from its container and record it.
 *
 * Uploads are probed in the browser; this backfills files from before that,
 * or from the desktop app, which the detail page asks for when it opens a
 * video whose metadata has no `fps`. Admin → Usage's "Probe all videos" does
 * the same for the whole library; both go through lib/frame-probe.js, which
 * reads only the container's headers and says which URLs it will read at all.
 *
 * Editors only: it writes to the row. Authorize → presign, in that order, so
 * a URL is minted only for a file the caller may change. A file this cannot
 * read (WebM, a fragmented MP4 with no sample table) is marked, so it is not
 * probed again on every visit.
 */
export async function POST(_req, { params }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const file = await getFileById(params.id);
  if (!file || file.deletedAt) return NextResponse.json({ error: 'File not found' }, { status: 404 });
  const principal = await buildPrincipal(email);
  if (!(await canModifyFile(file, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });
  if (effectiveKind(file) !== 'video') return NextResponse.json({ error: 'Only a video has a frame rate.' }, { status: 400 });

  const md = file.metadata || {};
  if (md.fps) return NextResponse.json({ metadata: md, probed: false });

  const out = await probeFrameModel(file);
  if (out.state === 'nosource') {
    return NextResponse.json({ error: 'This file is not in storage the server can read.' }, { status: 400 });
  }
  if (out.state === 'failed') {
    // A read that failed says nothing about the file; try again another time.
    return NextResponse.json({ error: `Could not read this file’s container: ${out.error}` }, { status: 502 });
  }
  return NextResponse.json({ metadata: out.metadata, probed: true, found: out.state === 'found' });
}
