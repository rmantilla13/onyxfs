import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { listPeople, peopleCounts, peopleWithRoles } from '@/lib/db';
import { getAdminEmails } from '@/lib/auth-allowlist';
import { loadRolesAndPolicy, presentPerson, backfillOnce } from '@/lib/people';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const STATUSES = new Set(['', 'active', 'invited', 'suspended', 'admins']);
const SORTS = new Set(['active', 'name', 'storage']);

/**
 * GET /api/admin/people?q=&status=&role=&sort=&cursor=&limit=
 *   → { people, total, cursor, counts, legacyAdmins }
 *
 * status  active | invited (approved, never signed in) | suspended | admins
 * role    a role id, or 'admin' for the env admins
 * sort    active (default) | name | storage
 * cursor  an offset, from the previous page's `cursor`
 *
 * `legacyAdmins` lists the people who held the retired full-access role and
 * are not in ADMIN_EMAILS — now Members — for the banner that asks the owner
 * to add real admins to ADMIN_EMAILS or leave them as they are.
 */
export async function GET(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const url = new URL(req.url);
  const status = url.searchParams.get('status') || '';
  const sort = url.searchParams.get('sort') || 'active';
  if (!STATUSES.has(status)) return NextResponse.json({ error: 'Unknown status filter.' }, { status: 400 });
  if (!SORTS.has(sort)) return NextResponse.json({ error: 'Unknown sort.' }, { status: 400 });

  let ctx;
  try { ctx = await loadRolesAndPolicy({ fresh: false }); } catch {
    return NextResponse.json({ error: 'Could not read the roles. Try again.' }, { status: 503 });
  }
  try { await backfillOnce(ctx.rawRoles); } catch (e) {
    console.warn('[people] backfill failed, listing what exists:', e.message);
  }

  const adminEmails = getAdminEmails();
  const role = url.searchParams.get('role') || '';
  let roleIds = null;
  let statusFilter = status;
  if (role === 'admin') statusFilter = 'admins';
  else if (role) {
    if (!ctx.rolesConfig.roles.some((r) => r.id === role)) return NextResponse.json({ error: 'Unknown role.' }, { status: 400 });
    roleIds = [role];
  }

  const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 500));
  const legacyIds = [...new Set([...ctx.rolesConfig.legacyFullIds, 'admin'])];
  const [page, counts, legacyHolders] = await Promise.all([
    listPeople({
      q: url.searchParams.get('q') || '', status: statusFilter, roleIds,
      defaultRole: ctx.rolesConfig.defaultRole, adminEmails, sort, offset, limit,
    }),
    peopleCounts({ adminEmails }),
    peopleWithRoles(legacyIds),
  ]);

  const people = page.rows.map((row) => presentPerson(row, { ...ctx, adminEmails }));
  const next = offset + page.rows.length;
  return NextResponse.json({
    people,
    total: page.total,
    cursor: next < page.total ? String(next) : null,
    counts,
    legacyAdmins: legacyHolders.filter((e) => !adminEmails.includes(e)),
  });
}
