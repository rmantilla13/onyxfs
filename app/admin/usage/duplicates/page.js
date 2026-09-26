import { listFilespaces, listDuplicateFiles, duplicateSummary, getFeatureFlags } from '@/lib/db';
import { presignFileUrls, getStorageConfig, storageMode } from '@/lib/storage';
import { groupDuplicates, TRASH_RETENTION_DAYS } from '@/lib/storage-report';
import { requireAdminPage } from '../../_lib/guard';
import DuplicatesClient from './DuplicatesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Duplicates · Admin' };

/**
 * Admin → Storage → Duplicates (was /storage/duplicates): files stored more
 * than once, and the clean-up. Admins only, like Usage: the sets span every
 * drive and folder. Removing a copy goes through DELETE /api/files/[id], so
 * it is the same trash (or delete) as anywhere else, with the same checks.
 */
export default async function DuplicatesPage() {
  await requireAdminPage('/admin/usage/duplicates');
  const [drives, flags, rows, summary, cfg] = await Promise.all([
    listFilespaces(),
    getFeatureFlags(),
    listDuplicateFiles(),
    duplicateSummary(),
    getStorageConfig(),
  ]);
  const groups = groupDuplicates(await presignFileUrls(rows));

  return (
    <DuplicatesClient
      groups={groups}
      summary={summary}
      drives={drives.map((d) => ({ id: d.id, name: d.name, prefix: d.prefix }))}
      trash={flags.trash !== false}
      retentionDays={TRASH_RETENTION_DAYS}
      canScan={storageMode(cfg) === 's3'}
    />
  );
}
