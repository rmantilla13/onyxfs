import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { getFilespaceById, getFilespaceRole } from '@/lib/db';
import { getStorageConfig, storageMode, mintFilespaceCredentials } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST { filespaceId } → short-lived, prefix-scoped AWS credentials.
 *
 * The bearer token is validated AND the user's filespace grant is re-checked
 * here (not just at login) — so revoking access cuts off new mounts within one
 * STS window. The returned creds carry a sessionToken and expire (≤1h); the
 * desktop refreshes-and-remounts before expiry.
 */
export async function POST(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;

  let body = {};
  try { body = await req.json(); } catch {}
  const filespaceId = String(body.filespaceId || body.id || '').trim();
  if (!filespaceId) return NextResponse.json({ error: 'filespaceId required' }, { status: 400 });

  const fs = await getFilespaceById(filespaceId);
  if (!fs) return NextResponse.json({ error: 'Filespace not found' }, { status: 404 });

  // Authorize: env-admins reach every filespace; everyone else needs a grant.
  // One query — a null role means no grant exists (403); a present-but-empty
  // role still mounts as viewer.
  let role = 'owner';
  if (!gate.isAdmin) {
    const grantedRole = await getFilespaceRole({ filespaceId, email: gate.email });
    if (grantedRole === null) return NextResponse.json({ error: 'No access to this filespace' }, { status: 403 });
    role = grantedRole || 'viewer';
  }

  const cfg = await getStorageConfig();
  // A filespace with its OWN keys works even if the global Storage backend is
  // Blob / unset — those keys are self-contained. Only require a global S3
  // config when the filespace inherits the master credentials.
  const ownKeys = !!(fs.accessKeyId && fs.hasSecret);
  if (!ownKeys && storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'Storage is not configured for AWS S3.' }, { status: 400 });
  }
  const endpoint = (fs.endpoint || cfg.endpoint) || null;

  try {
    // Credential ladder: own keys (static) → AssumeRole → GetFederationToken →
    // master static key. `mode` tells the client which rung was used.
    const creds = await mintFilespaceCredentials(cfg, fs, { role });
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
