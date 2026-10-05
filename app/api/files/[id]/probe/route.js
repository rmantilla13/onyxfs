import { NextResponse } from 'next/server';
import { getFileById, canModifyFile } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { effectiveKind, wantsProbe } from '@/lib/media';
import { probeFrameModel } from '@/lib/frame-probe';

export const runtime = 'nodejs';

/**
 * POST /api/files/[id]/probe — read a stored video's frame model (exact rate,
 * frame count, start timecode) and codec from its container and record them.
 *
 * Uploads are probed in the browser; this backfills files from before that,
 * or from the desktop app, which the detail page asks for when it opens a
 * video whose metadata has no `fps` or no `videoCodec` (lib/media.js
 * wantsProbe). A video it finds some browser will not play is then offered
 * to the Macs for a streamable version (lib/db.js listProxyJobs). Admin →
 * Usage's "Probe all videos" does the same for the whole library; both go
 * through lib/frame-probe.js, which reads only the container's headers and
 * says which URLs it will read at all.
 *
 * Editors only: it writes to the row. Authorize → presign, in that order, so
 * a URL is minted only for a file the caller may change. A file this cannot
 * read (WebM, a fragmented MP4 with no sample table) is marked, so it is not
 * probed again on every visit.
 */
export async function POST(_req, { params }) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal } = g;
  const allowed = can(principal, 'files.edit');
  if (!allowed.ok) return refusal(allowed);

  const file = await getFileById(params.id);
  if (!file || file.deletedAt) return NextResponse.json({ error: 'File not found' }, { status: 404 });
  if (!(await canModifyFile(file, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });
  if (effectiveKind(file) !== 'video') return NextResponse.json({ error: 'Only a video has a frame rate.' }, { status: 400 });

  // Nothing left to read: the rate on record, and the codec too or none
  // worth reading (lib/media.js wantsProbe).
  const md = file.metadata || {};
  if (md.fps && !wantsProbe(file)) return NextResponse.json({ metadata: md, probed: false });

  const out = await probeFrameModel(file);
  if (out.state === 'nosource') {
    return NextResponse.json({ error: 'This file is not in storage the server can read.' }, { status: 400 });
  }
  if (out.state === 'failed') {
    // A read that failed says nothing about the file; try again another time.
    return NextResponse.json({ error: `Could not read this file’s container: ${out.error}` }, { status: 502 });
  }
  if (out.state === 'changed') {
    // What was read is not what the file holds now; its next visit reads that.
    return NextResponse.json({ error: 'This file’s contents changed while they were read.' }, { status: 409 });
  }
  return NextResponse.json({ metadata: out.metadata, probed: true, found: out.state === 'found' });
}
