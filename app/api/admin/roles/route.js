import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getSetting, setRolesConfig, countPeopleByRole, clearRoleAssignments } from '@/lib/db';
import { parseRolesConfig, validateRolesConfig, CAPABILITIES, NUMERIC_LIMITS, DRIVE_ROLES, ADMIN_ROLE } from '@/lib/roles';
import { readGlobalFlags } from '@/lib/authz';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET → { config, capabilities, limits, driveRoles, counts, admin, legacyFullIds, flags }
 *
 * The roles as the server reads them (v1 blobs come back as v2), what each
 * capability is, how many people hold each role, and the implicit Admin
 * role for display — it is never in `config.roles`, because it is not one.
 * `flags` lets the matrix say "Off for the whole org" beside a capability
 * whose flag is off.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let saved;
  try { saved = await getSetting('roles.config', { fresh: true, strict: true }); } catch {
    return NextResponse.json({ error: 'Could not read the roles. Try again.' }, { status: 503 });
  }
  const { legacyFullIds, ...config } = parseRolesConfig(saved);
  const [counts, flags] = await Promise.all([countPeopleByRole(config.defaultRole), readGlobalFlags()]);
  return NextResponse.json({
    config: { ...config, assignments: undefined },
    capabilities: CAPABILITIES,
    limits: [...NUMERIC_LIMITS, 'driveCeiling'],
    driveRoles: DRIVE_ROLES,
    counts,
    admin: { id: ADMIN_ROLE.id, name: ADMIN_ROLE.name, description: ADMIN_ROLE.description },
    legacyFullIds,
    flags,
  });
}

/**
 * PUT { roles: [...], defaultRole } — save the roles. Validated strictly
 * (validateRolesConfig): no `full`, only known capabilities, limits whole
 * numbers or null, built-ins kept. A custom role left out is deleted, and
 * its people move to the default role; the response says how many.
 * v1's assignments map is carried over as stored and never taken from the
 * request.
 */
export async function PUT(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  let current;
  try { current = await getSetting('roles.config', { fresh: true, strict: true }); } catch {
    return NextResponse.json({ error: 'Could not read the current roles, so nothing was saved. Try again.' }, { status: 503 });
  }
  const result = validateRolesConfig(body, current);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });

  await setRolesConfig(result.config, guard.email);
  const moved = await clearRoleAssignments(result.removed);
  const before = parseRolesConfig(current);
  await audit(guard.email, 'roles.update', { type: 'roles', id: 'roles.config', label: 'Roles & limits' }, {
    roles: result.config.roles.map((r) => r.id),
    removed: result.removed,
    movedToDefault: moved,
    defaultRole: before.defaultRole === result.config.defaultRole ? undefined : { from: before.defaultRole, to: result.config.defaultRole },
  });
  const { legacyFullIds, assignments, ...config } = parseRolesConfig(result.config);
  return NextResponse.json({ config, removed: result.removed, movedToDefault: moved });
}
