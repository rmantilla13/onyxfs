import { NextResponse } from 'next/server';
import {
  createFilespace, grantFilespaceAccess, listFilespaces, filespaceSetupProblem, countFilespacesCreatedBy,
  prefixHoldsFiles,
} from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { getStorageConfig, storageMode, s3ListObjects } from '@/lib/storage';
import { drivePrefixFor } from '@/lib/folder-ops';
import { prefixOverlap } from '@/lib/drive-access';
import { audit } from '@/lib/audit';

// Suffixes tried for a name whose folder is taken: campaigns, campaigns-2, …
const MAX_SUFFIX = 50;

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
 *
 * Its creator becomes its OWNER, which reaches everything under the prefix —
 * on the web, and in the credentials STS scopes to it. So the prefix has to
 * be empty ground: not inside another drive or around one (membership of
 * either counts, lib/drive-access.js, so a drive around an admin's would hand
 * its creator every file in it), and not over files already stored there —
 * a deleted drive's leftovers, whose next namesake would otherwise inherit
 * them, private ones included. A taken folder moves on to the next suffix;
 * a parent folder that itself lies in a drive refuses outright.
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
  // The name first (taken, too long), before any looking for a folder.
  const named = filespaceSetupProblem({ name, bucket: cfg.bucket, prefix: `${parent}/${slug}` }, others.map((o) => ({ name: o.name })));
  if (named) return NextResponse.json({ error: named.error }, { status: named.status });
  const outer = prefixOverlap(parent, others)?.inside;
  if (outer) {
    return NextResponse.json({
      error: `Drives made here would sit inside the drive “${outer.name}”. Ask an admin to choose another folder for them.`,
    }, { status: 409 });
  }

  // The name decides the folder; a second "Campaigns" gets campaigns-2, and
  // so does a "Campaigns" whose folder already holds something.
  let prefix = null;
  try {
    for (let n = 1; n <= MAX_SUFFIX && !prefix; n++) {
      const candidate = n === 1 ? `${parent}/${slug}` : `${parent}/${slug}-${n}`;
      if (await groundTaken(candidate, others, cfg)) continue;
      prefix = candidate;
    }
  } catch (e) {
    console.warn('[filespaces] could not check where the drive would go:', e.message);
    return NextResponse.json({ error: 'Couldn’t check where the drive would go, so nothing was made. Try again.' }, { status: 503 });
  }
  if (!prefix) {
    return NextResponse.json({ error: `Every folder for “${name}” is taken. Choose another name.` }, { status: 409 });
  }
  const problem = filespaceSetupProblem({ name, bucket: cfg.bucket, prefix }, others);
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });

  const filespace = await createFilespace({ name, bucket: cfg.bucket, prefix, createdBy: email });
  // Admins reach every drive already; for anyone else the drive is theirs.
  if (!principal.isAdmin) await grantFilespaceAccess({ filespaceId: filespace.id, email, role: 'owner', grantedBy: email });
  await audit(email, 'drive.create', { type: 'drive', id: filespace.id, label: filespace.name }, { selfServe: true, prefix });
  return NextResponse.json({ filespace });
}

/**
 * Is this prefix unusable for a new drive: a drive's own, one that holds a
 * drive, or one with anything stored under it — a file row (live or
 * trashed), or an object in the bucket the catalog never recorded. Throws
 * when the bucket cannot be asked; the caller refuses rather than guessing.
 */
async function groundTaken(prefix, drives, cfg) {
  if (prefixOverlap(prefix, drives)) return true;
  if (await prefixHoldsFiles(prefix)) return true;
  const objects = await s3ListObjects(cfg, { prefix, max: 1 });
  return objects.length > 0;
}
