import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getSetting, setSetting, listFilespaces } from '@/lib/db';
import { prefixOverlap } from '@/lib/drive-access';
import { isSuperAdmin } from '@/lib/auth-allowlist';
import { parsePolicy, validatePolicy, DEFAULT_POLICY, SUPER_ADMIN_POLICY_KEYS } from '@/lib/policy';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const KEY = 'policy.limits';

/**
 * GET → { policy, defaults, superAdminKeys, canEditMoney }
 *
 * The org's ceilings: storage quota, largest upload, the AI budget, per-job
 * ceiling and concurrency, the longest link expiry, and self-serve drives.
 * Every number caps what a role or a person override may be. The defaults
 * change nothing at deploy: storage unlimited, AI at $0 (off).
 */
export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let saved;
  try { saved = await getSetting(KEY, { fresh: true, strict: true }); } catch {
    return NextResponse.json({ error: 'Could not read the policy. Try again.' }, { status: 503 });
  }
  return NextResponse.json({
    policy: parsePolicy(saved),
    defaults: DEFAULT_POLICY,
    superAdminKeys: SUPER_ADMIN_POLICY_KEYS,
    canEditMoney: isSuperAdmin(guard.email),
  });
}

/**
 * PUT { ...fields } — change some of the ceilings. Only the fields sent are
 * changed. The AI budget, per-job ceiling and concurrency need a
 * super-admin (403 otherwise); every value is validated, and a bad one
 * refuses the whole save rather than being quietly dropped.
 */
export async function PUT(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  let current;
  try { current = await getSetting(KEY, { fresh: true, strict: true }); } catch {
    return NextResponse.json({ error: 'Could not read the current policy, so nothing was saved. Try again.' }, { status: 503 });
  }
  const result = validatePolicy(body, current, { superAdmin: isSuperAdmin(guard.email) });
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 400 });
  if (!result.changed.length) return NextResponse.json({ policy: result.policy, changed: [] });
  if (result.changed.includes('selfServeParentPrefix')) {
    // Every drive made there would sit inside this one, and its creator would
    // be owner of a folder in someone else's drive. POST /api/filespaces
    // refuses then too; saying so here is the kinder place.
    const outer = prefixOverlap(result.policy.selfServeParentPrefix, await listFilespaces())?.inside;
    if (outer) {
      return NextResponse.json({ error: `“${result.policy.selfServeParentPrefix}” is inside the drive “${outer.name}”. Choose a folder outside every drive.` }, { status: 400 });
    }
  }

  await setSetting(KEY, result.policy, guard.email);
  const before = parsePolicy(current);
  await audit(guard.email, 'policy.update', { type: 'policy', id: KEY, label: 'Org limits' },
    Object.fromEntries(result.changed.map((k) => [k, { from: before[k], to: result.policy[k] }])));
  return NextResponse.json({ policy: result.policy, changed: result.changed });
}
