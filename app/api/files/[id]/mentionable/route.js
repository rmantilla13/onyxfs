import { listMentionCandidates } from '@/lib/db';
import { openReview, peopleWhoCanRead, drivePool, reviewJson } from '@/lib/review-guard';

export const runtime = 'nodejs';

// How many people the autocomplete shows, and how many it will check to find
// them. Each check is a principal lookup, and this runs as someone types.
const SHOW = 8;
const CHECK = 16;

/**
 * GET /api/files/[id]/mentionable?q=
 *
 * People an @mention on this file may name: only those who could read it —
 * a drive's members (and admins, and whoever it was shared with) for a file in
 * a drive; anyone let in for an org-visible library file. Every suggestion is
 * held to canAccessFile, so the list never shows someone the file is hidden
 * from, and never shows the asker themselves.
 */
export async function GET(req, { params }) {
  const g = await openReview(params.id, 'mention');
  if (g.error) return g.error;
  const q = String(new URL(req.url).searchParams.get('q') || '').slice(0, 100);

  const pool = await drivePool(g.file).catch(() => null);
  const candidates = (await listMentionCandidates({ q, limit: 200 }))
    .filter((p) => p.email !== g.email && (!pool || pool.has(p.email)))
    .slice(0, CHECK);
  const readable = new Set(await peopleWhoCanRead(g.file, candidates.map((p) => p.email), { cap: CHECK }));
  const people = candidates
    .filter((p) => readable.has(p.email))
    .slice(0, SHOW)
    .map((p) => ({ email: p.email, name: p.name || null }));
  return reviewJson({ people }, 200);
}
