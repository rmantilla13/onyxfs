import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFileById, buildPrincipal, canModifyFile, setFileFrameModel } from '@/lib/db';
import { getStorageConfig, storageMode, s3PresignGet } from '@/lib/storage';
import { effectiveKind, mediaFacts } from '@/lib/media';
import { probeMp4, probeMetadata, rangeReader } from '@/lib/mp4-probe';

export const runtime = 'nodejs';

// Long enough for a slow bucket to answer a handful of small range requests,
// short enough that a detail page's background backfill never hangs a lambda.
const READ_TIMEOUT_MS = 10_000;

// Vercel Blob's public stores. A Blob row's url is whatever the uploader
// recorded, so it is fetched only when it points at one of these.
const BLOB_HOST = /(^|\.)blob\.vercel-storage\.com$/;

/**
 * Where the server may read this file from, or null.
 *
 * Never simply the row's `url`: for a Blob row that is whatever the client
 * sent when it recorded the upload, and fetching it would let anyone who can
 * add a file make the server request any address it likes. An S3 row is
 * signed afresh from its storage key against the deployment's own bucket
 * (the CDN shortcut in presignFileUrls hands back the stored url, so it is
 * not used); a Blob row is read only from Vercel Blob itself.
 */
async function sourceFor(file) {
  if (file.storage === 's3' && file.storageKey) {
    const cfg = await getStorageConfig();
    if (storageMode(cfg) !== 's3') return null;
    return s3PresignGet(cfg, file.storageKey, { expiresIn: 600 });
  }
  if (file.storage === 'blob') {
    try {
      const u = new URL(file.url);
      if (u.protocol === 'https:' && BLOB_HOST.test(u.hostname)) return u.href;
    } catch { /* not a URL at all */ }
  }
  return null;
}

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
 * a URL is minted only for a file the caller may change (see sourceFor for
 * which URLs it will read at all). A file this cannot read (WebM, a
 * fragmented MP4 with no sample table) is marked, so it is not probed again
 * on every visit.
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

  const url = await sourceFor(file).catch(() => null);
  if (!url) return NextResponse.json({ error: 'This file is not in storage the server can read.' }, { status: 400 });

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
