import { NextResponse } from 'next/server';
import {
  createFilespace, grantFilespaceAccess, listFilespaces, filespaceSetupProblem, countFilespacesCreatedBy,
} from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { getStorageConfig, storageMode } from '@/lib/storage';
import { drivePrefixFor } from '@/lib/folder-ops';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST { name } → { filespace } — make a drive yourself, when the org allows
 * it (policy.limits.drivesSelfServe, off by default) and your role has
 * drives.create. You become its owner.
 *
 * Deliberately narrower than the admin route (POST /api/admin/filespaces):
 * the drive always lives in the configured bucket, under the org's
 * self-serve folder (selfServeParentPrefix, "drives/" by default), at a
 * prefix derived from its name — no bucket, endpoint, role or keys of its
 * own. Each person may make drivesPerPerson of them.
 */
export async function POST(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal, email } = g;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const ownedCount = principal.isAdmin ? 0 : await countFilespacesCreatedBy(email);
  const allowed = can(principal, 'drives.create', { ownedCount });
  if (!allowed.ok) return refusal(allowed);

  const cfg = await getStorageConfig();
  if (storageMode(cfg) !== 's3' || !cfg.bucket) {
    return NextResponse.json({ error: 'Drives need an S3 bucket, and none is configured.' }, { status: 400 });
  }
  const name = String(body?.name || '').trim();
  const slug = drivePrefixFor(name);
  if (!slug) return NextResponse.json({ error: 'Give the drive a name with at least one letter or digit.' }, { status: 400 });

  const parent = principal.policy.selfServeParentPrefix.replace(/\/+$/, '');
  const others = await listFilespaces();
  // The name decides the folder; a second "Campaigns" gets campaigns-2.
  let prefix = `${parent}/${slug}`;
  for (let n = 2; others.some((o) => String(o.prefix).replace(/^\/+|\/+$/g, '') === prefix) && n < 100; n++) {
    prefix = `${parent}/${slug}-${n}`;
  }
  const problem = filespaceSetupProblem({ name, bucket: cfg.bucket, prefix }, others);
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });

  const filespace = await createFilespace({ name, bucket: cfg.bucket, prefix, createdBy: email });
  // Admins reach every drive already; for anyone else the drive is theirs.
  if (!principal.isAdmin) await grantFilespaceAccess({ filespaceId: filespace.id, email, role: 'owner', grantedBy: email });
  await audit(email, 'drive.create', { type: 'drive', id: filespace.id, label: filespace.name }, { selfServe: true, prefix });
  return NextResponse.json({ filespace });
}
