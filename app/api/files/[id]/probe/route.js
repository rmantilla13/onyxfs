import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFileById, buildPrincipal, canModifyFile, setFileFrameModel } from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import { effectiveKind, mediaFacts } from '@/lib/media';
import { probeMp4, probeMetadata, rangeReader } from '@/lib/mp4-probe';

export const runtime = 'nodejs';

// Long enough for a slow bucket to answer a handful of small range requests,
// short enough that a detail page's background backfill never hangs a lambda.
const READ_TIMEOUT_MS = 10_000;

/**
 * POST /api/files/[id]/probe — read a stored video's frame model (exact rate,
 * frame count, start timecode) from its container and record it.
 *
 * Uploads are probed in the browser; this backfills files from before that,
 * or from the desktop app, which the detail page asks for when it opens a
 * video whose metadata has no `fps`. It reads only the container's headers
 * through range requests — never the media — and records the result without
 * touching the file's version or Modified date (setFileFrameModel).
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

  const [signed] = await presignFileUrls([file], { expiresIn: 600 });
  const url = signed?.url;
  if (!url || !/^https?:\/\//.test(url)) return NextResponse.json({ error: 'This file has no readable source.' }, { status: 400 });

  let probe = null;
  try {
    const { readRange, size } = await rangeReader(url, {
      fetchImpl: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(READ_TIMEOUT_MS) }),
    });
    probe = await probeMp4(readRange, { size });
  } catch (e) {
    // A read that failed says nothing about the file; try again another time.
    return NextResponse.json({ error: `Could not read this file’s container: ${e.message}` }, { status: 502 });
  }

  const facts = mediaFacts(probeMetadata(probe));
  if (!facts.fps) {
    const updated = await setFileFrameModel(file.id, { fpsUnknown: true });
    return NextResponse.json({ metadata: updated?.metadata || md, probed: true, found: false });
  }
  // The browser's width, height and duration are what the rest of the app
  // uses; the container's fill in only where the row has none.
  const fallback = mediaFacts({ width: probe.width, height: probe.height, duration: probe.duration });
  const updated = await setFileFrameModel(file.id, { ...facts, fpsUnknown: false }, fallback);
  return NextResponse.json({ metadata: updated?.metadata || { ...md, ...facts }, probed: true, found: true });
}
