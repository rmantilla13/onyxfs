import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { getFilespaceById, usedBytesBy } from '@/lib/db';
import { can, driveRoleOf, mountRole } from '@/lib/authz';
import {
  getStorageConfig, storageMode, mintFilespaceCredentials, credentialPlan, staticRefusalMessage,
} from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST { filespaceId } → short-lived, prefix-scoped AWS credentials.
 *
 * The bearer token is validated AND the user's filespace grant is re-checked
 * here (not just at login) — so revoking access cuts off new mounts within one
 * STS window. The returned creds carry a sessionToken and expire (≤1h); the
 * desktop refreshes-and-remounts before expiry.
 *
 * Admins (ADMIN_EMAILS) reach every filespace as owner; everyone else needs a
 * grant, and gets the role mountRole decides. On a provider that cannot
 * scope a key to one drive (R2, MinIO, Spaces — see credentialPlan), only an
 * admin is ever given the deployment's own key; everyone else is refused
 * with a message saying so, and reads through the app's streaming instead.
 * A drive with its own key is the same for anyone who may only read it: that
 * key writes, and cannot be narrowed.
 */
export async function POST(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  const { principal } = gate;
  const allowed = can(principal, 'desktop.mount');
  if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: allowed.status });

  let body = {};
  try { body = await req.json(); } catch {}
  const filespaceId = String(body.filespaceId || body.id || '').trim();
  if (!filespaceId) return NextResponse.json({ error: 'filespaceId required' }, { status: 400 });

  const fs = await getFilespaceById(filespaceId);
  if (!fs) return NextResponse.json({ error: 'Filespace not found' }, { status: 404 });

  const driveRole = driveRoleOf(principal, filespaceId);
  if (!driveRole) return NextResponse.json({ error: 'No access to this filespace' }, { status: 403 });
  const canUpload = can(principal, 'files.upload').ok;
  const quota = principal.limits?.storageQuotaBytes;
  const overQuota = canUpload && !principal.isAdmin && quota != null && (await usedBytesBy(gate.email)) >= quota;
  const role = mountRole({ driveRole, canUpload, overQuota });

  const cfg = await getStorageConfig();
  // A filespace with its OWN keys works even if the global Storage backend is
  // Blob / unset — those keys are self-contained. Only require a global S3
  // config when the filespace inherits the master credentials.
  const ownKeys = !!(fs.accessKeyId && fs.hasSecret);
  if (!ownKeys && storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'Storage is not configured for AWS S3.' }, { status: 400 });
  }
  const endpoint = (fs.endpoint || cfg.endpoint) || null;

  // Refuse up front, with the reason, rather than let the ladder fail: on a
  // provider with no per-drive credentials the only rung is the deployment's
  // key, and that goes to admins alone; a drive's own key cannot be made
  // read-only, so it goes only to someone whose mount may write.
  const plan = credentialPlan(cfg, fs, { role, isAdmin: principal.isAdmin });
  if ((plan.strategy === 'static' || plan.strategy === 'filespace-static') && !plan.staticAllowed) {
    const message = staticRefusalMessage(cfg, plan.strategy === 'filespace-static' ? fs : null);
    return NextResponse.json({ error: message, role: 'viewer', readOnly: true }, { status: 403 });
  }

  try {
    // Credential ladder: own keys (static) → AssumeRole → GetFederationToken →
    // master static key (admins only). `mode` tells the client which rung was used.
    const creds = await mintFilespaceCredentials(cfg, fs, { role, isAdmin: principal.isAdmin });
    return NextResponse.json({
      filespaceId: fs.id,
      name: fs.name,
      role,
      ...creds, // accessKeyId, secretAccessKey, sessionToken?, expiration?, bucket, prefix, region, remotePath, mode
      endpoint,
      accelerate: !!cfg.accelerate && !endpoint,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Failed to mint credentials' }, { status: 500 });
  }
}
