import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { listFilespaces, listFilespacesForUser } from '@/lib/db';
import { can } from '@/lib/authz';
import { loadBrand } from '@/lib/brand-config';
import { driveColorHex } from '@/lib/drive-color';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — the filespaces the calling desktop user may mount.
 * Admins (ADMIN_EMAILS) see all, as owner; everyone else sees exactly the
 * drives they are a member of, each at their role after the ceiling their
 * platform role sets — a Viewer granted editor mounts read-only.
 * Returns only what the picker needs — never roleArn / createdBy.
 *
 * A full-access platform role used to list every drive here, and only here:
 * the web and the sync feed showed those people a drive's files only as a
 * member, so the apps had to be told which drives were real (`member`). Now
 * the list is the membership, so `member` is always true; it stays in the
 * response for the clients that read it.
 *
 * `can` is what this account may do to each drive's files as its role and
 * drive role together allow (writeCaps), and `library.can` the same for the
 * library: the Mac mounts a disk writable only where something is.
 *
 * `color` is the drive's own colour, the dot beside its name on the web, as
 * #RRGGBB from the brand's palette: the Mac paints the drive's disk icon in
 * it (apple/ONYXFS.md, "The drive's icon").
 */
/**
 * The writes a platform role allows, as a disk needs them: `upload` new
 * files, `edit` (rename, move) and `delete` files, and `folders` (make,
 * rename, move and remove folders — removing one takes `delete` as well).
 * A disk is writable when any is true; each change is refused alone.
 */
function writeCaps(principal) {
  const has = (cap) => can(principal, cap).ok;
  return {
    upload: has('files.upload'),
    edit: has('files.edit'),
    delete: has('files.delete'),
    folders: has('folders.manage'),
  };
}

export async function GET(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  const { principal } = gate;
  // The `filespaces` flag switches the whole data plane off, read here.
  const allowed = can(principal, 'desktop.mount');
  if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: allowed.status });

  let spaces;
  try {
    spaces = principal.isAdmin
      ? (await listFilespaces()).map((f) => ({ ...f, role: 'owner' }))
      : (await listFilespacesForUser(gate.email))
        .map((f) => ({ ...f, role: principal.driveScope?.roles?.[f.id] || null }))
        .filter((f) => f.role);
  } catch (e) {
    // Never an empty list for a failed read: to a device, "no drives" means
    // its drives were taken away.
    console.warn('[space/filespaces] could not list drives:', e.message);
    return NextResponse.json({ error: 'Drives could not be listed right now.' }, { status: 503, headers: { 'retry-after': '30' } });
  }

  const { palette } = (await loadBrand()).visual;
  // What the platform role allows at all (flags included), before any drive
  // or file says more: a drive's editor whose role may not delete still may
  // not, so a disk offering it would only fail.
  const role = writeCaps(principal);
  const filespaces = spaces.map((f) => {
    const writes = f.role === 'editor' || f.role === 'owner';
    return {
      id: f.id, name: f.name, bucket: f.bucket, prefix: f.prefix, region: f.region || null, role: f.role || 'viewer',
      member: true, color: driveColorHex(f.id, palette),
      can: Object.fromEntries(Object.entries(role).map(([k, v]) => [k, writes && v])),
    };
  });
  // The library: files in no drive. Anyone whose role may upload may add to
  // it, as on the web; changing or removing a file already there is still
  // the file's own question (its creator, a grant), asked by the server.
  return NextResponse.json({ filespaces, library: { can: role }, email: gate.email, isAdmin: principal.isAdmin });
}
