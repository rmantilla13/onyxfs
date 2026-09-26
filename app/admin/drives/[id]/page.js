import { getFilespaceById, countFilesUnderPrefix, driveKindUsage } from '@/lib/db';
import { getStorageConfig, storageMode } from '@/lib/storage';
import { publicDrive } from '@/lib/admin-drives';
import { requireAdminPage } from '../../_lib/guard';
import DriveDrawer from './DriveDrawer';
import RouteDrawer from '../../_ui/RouteDrawer';
import AdminState from '../../_ui/AdminState';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const fs = params?.id ? await getFilespaceById(params.id).catch(() => null) : null;
  return { title: fs ? `${fs.name} · Drives` : 'Drives' };
}

/**
 * One drive's editor, open over the list: members, where it lives and with
 * which keys, diagnostics, what it holds, and deleting it.
 *
 * getFilespaceById returns the drive's secret for the credential code; it
 * goes through publicDrive before anything reaches the browser, which keeps
 * only whether a secret is stored.
 */
export default async function DrivePage({ params }) {
  const id = String(params?.id || '');
  await requireAdminPage(`/admin/drives/${encodeURIComponent(id)}`);
  const fs = id ? await getFilespaceById(id) : null;
  if (!fs) {
    return (
      <RouteDrawer back="/admin/drives" title="Drive not found">
        <div className="drawer-pad">
          <AdminState kind="empty" title="This drive does not exist." message="It may have been deleted. The list behind shows every drive there is." />
        </div>
      </RouteDrawer>
    );
  }
  const [stored, kinds, cfg] = await Promise.all([
    countFilesUnderPrefix(fs.prefix),
    driveKindUsage(fs.prefix),
    getStorageConfig().catch(() => null),
  ]);
  return (
    <DriveDrawer
      drive={publicDrive(fs)}
      stored={stored}
      kinds={kinds}
      storage={{ bucket: cfg?.bucket || '', region: cfg?.region || '', mode: cfg ? storageMode(cfg) : 'unknown' }}
    />
  );
}
