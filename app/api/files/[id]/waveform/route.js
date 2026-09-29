import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, setFileWaveform } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { presignFileUrls } from '@/lib/storage';
import { effectiveKind } from '@/lib/media';
import { waveformFacts } from '@/lib/waveform';

export const runtime = 'nodejs';

/**
 * The file a waveform may be recorded for, by this caller: a live sound they
 * may change — the files.edit capability, then canModifyFile, as a
 * thumbnail's. → { file } or { error: Response }.
 */
async function writableSound(req, id) {
  const g = await requirePrincipal(req);
  if (g.error) return { error: g.error };
  const { principal } = g;
  const allowed = can(principal, 'files.edit');
  if (!allowed.ok) return { error: refusal(allowed) };
  const file = await getFileById(id);
  if (!file || file.deletedAt) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  if (effectiveKind(file) !== 'audio') return { error: NextResponse.json({ error: 'Only a sound has a waveform.' }, { status: 400 }) };
  if (!(await canModifyFile(file, principal))) return { error: NextResponse.json({ error: 'No access' }, { status: 403 }) };
  return { file };
}

/**
 * GET /api/files/[id]/waveform — 204 when the caller may record a waveform
 * for this file (the PUT below would be allowed), else why not.
 *
 * Asked before the sound is downloaded to draw one, as the thumbnail route's
 * GET is asked before a picture is: being able to write to the library is not
 * being able to write to every file in it, and finding that out from the PUT
 * comes after the whole download.
 */
export async function GET(req, { params }) {
  const w = await writableSound(req, params.id);
  if (w.error) return w.error;
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/**
 * PUT /api/files/[id]/waveform  Body: { waveform, contentHash? }
 *
 * Record the shape of a sound (lib/waveform.js) that a browser drew from its
 * bytes — the uploader's, or an editor's who opened it — or Onyx for Mac from
 * the copy it just uploaded. Both take the browser's session or the Mac's
 * bearer token (requirePrincipal), like the thumbnail routes.
 *
 * `contentHash` is the contents it was drawn from, as the row said: when the
 * file's contents have been replaced since, 409, and nothing is written — the
 * shape is of a sound the file no longer holds.
 */
export async function PUT(req, { params }) {
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const waveform = waveformFacts(body?.waveform);
  if (!waveform) return NextResponse.json({ error: 'Not a waveform.' }, { status: 400 });

  const w = await writableSound(req, params.id);
  if (w.error) return w.error;

  let file;
  try {
    file = await setFileWaveform(w.file.id, waveform, {
      contentHash: typeof body.contentHash === 'string' && body.contentHash ? body.contentHash.slice(0, 256) : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not save the waveform.' }, { status: 500 });
  }
  if (file === 'changed') return NextResponse.json({ error: 'The file changed while its waveform was drawn.' }, { status: 409 });
  if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const [signed] = await presignFileUrls([file]);
  return NextResponse.json({ file: signed || file });
}
