import { listDrivesWithUsage } from '@/lib/db';
import { getStorageConfig } from '@/lib/storage';
import { driveRows } from '@/lib/admin-drives';
import { requireAdminPage } from '../_lib/guard';
import DrivesList from './DrivesList';

export const dynamic = 'force-dynamic';

/**
 * Admin → Drives. The list lives in the layout and a drive's editor is the
 * page under it (/admin/drives/<id>), so opening and closing a drive swaps
 * only the drawer: the list keeps its sort and scroll behind it, and the
 * drawer has an address of its own to link to.
 *
 * Sizes come from one grouped query (listDrivesWithUsage), not a count per
 * drive.
 */
export default async function DrivesLayout({ children }) {
  await requireAdminPage('/admin/drives');
  const [drives, cfg] = await Promise.all([
    listDrivesWithUsage(),
    getStorageConfig().catch(() => null),
  ]);
  return (
    <>
      <DrivesList
        rows={driveRows(drives, { defaultBucket: cfg?.bucket || '' })}
        storage={{ bucket: cfg?.bucket || '', region: cfg?.region || '' }}
      />
      {children}
    </>
  );
}
