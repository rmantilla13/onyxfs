import { NextResponse } from 'next/server';
import { deleteShareTemplate } from '@/lib/db';
import { requirePrincipal } from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/share-templates/[id] — remove one of your own templates. Links
 * made from it are unchanged: a template is only where a form started. Not
 * yours, or not there, is the same 404.
 */
export async function DELETE(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const removed = await deleteShareTemplate(g.email, params?.id);
  if (!removed) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
