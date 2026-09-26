import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { listAllShares, deleteShares } from '@/lib/db';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const KINDS = new Set(['public', 'password', 'private']);
const WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /api/admin/links?kind=&creator=&expiring=1&orphaned=1&cursor=
 *   → { links, total, cursor }
 *
 * Every live link, newest first: its file, kind, who made it — marked
 * suspended, or removed when they are gone altogether (orphaned) — when it
 * expires and how often it was opened. `expiring=1` narrows to links that
 * expire within 7 days. Never a password or its hash; the token is the
 * link, and admins may revoke it, so it is returned.
 */
export async function GET(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') || null;
  if (kind && !KINDS.has(kind)) return NextResponse.json({ error: 'Unknown link kind.' }, { status: 400 });
  const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
  const page = await listAllShares({
    kind,
    creator: url.searchParams.get('creator') || null,
    expiringWithinMs: url.searchParams.get('expiring') === '1' ? WEEK : null,
    orphaned: url.searchParams.get('orphaned') === '1',
    offset,
    limit: Number(url.searchParams.get('limit')) || 100,
  });
  const next = offset + page.rows.length;
  return NextResponse.json({ links: page.rows, total: page.total, cursor: next < page.total ? String(next) : null });
}

/** DELETE { tokens: [...] } — revoke links in bulk. */
export async function DELETE(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const tokens = Array.isArray(body?.tokens) ? body.tokens.map(String).filter(Boolean) : [];
  if (!tokens.length) return NextResponse.json({ error: 'tokens must be a non-empty list.' }, { status: 400 });
  if (tokens.length > 500) return NextResponse.json({ error: 'Revoke at most 500 links at once.' }, { status: 400 });
  const removed = await deleteShares(tokens);
  if (removed.length) {
    await audit(guard.email, 'share.revoke', { type: 'links', id: 'bulk', label: `${removed.length} link${removed.length === 1 ? '' : 's'}` }, {
      // A token is the link itself: record enough to recognise it, not to use it.
      links: removed.map((r) => ({ token: r.token.slice(0, 6), fileId: r.fileId, createdBy: r.createdBy })),
    });
  }
  return NextResponse.json({ revoked: removed.length });
}
