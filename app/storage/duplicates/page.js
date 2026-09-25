import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isAdmin } from '@/lib/auth-allowlist';
import { loadBrand } from '@/lib/brand-config';
import { listFilespacesForSpace, listDuplicateFiles, duplicateSummary, getFeatureFlags } from '@/lib/db';
import { presignFileUrls, getStorageConfig, storageMode } from '@/lib/storage';
import { groupDuplicates, TRASH_RETENTION_DAYS } from '@/lib/storage-report';
import { buildLabel, buildDetail } from '@/lib/version';
import TopNav from '@/app/components/TopNav';
import DuplicatesClient from './DuplicatesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Duplicates' };

/**
 * Files stored more than once, and the clean-up. Admins only, like /storage:
 * the sets span every drive and folder. Removing a copy goes through
 * DELETE /api/files/[id], so it is the same trash (or delete) as anywhere
 * else, with the same checks.
 */
export default async function DuplicatesPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin?callbackUrl=/storage/duplicates');
  if (!isAdmin(email)) redirect('/files');

  const [brand, drives, flags, rows, summary, cfg] = await Promise.all([
    loadBrand(),
    listFilespacesForSpace(email),
    getFeatureFlags(),
    listDuplicateFiles(),
    duplicateSummary(),
    getStorageConfig(),
  ]);
  const groups = groupDuplicates(await presignFileUrls(rows));

  return (
    <>
      <TopNav
        build={{ label: buildLabel(), detail: buildDetail() }}
        brandName={brand.name}
        logo={brand.visual.logo}
        email={email}
        isAdmin
        filespaces={drives}
      />
      <DuplicatesClient
        groups={groups}
        summary={summary}
        drives={drives.map((d) => ({ id: d.id, name: d.name, prefix: d.prefix }))}
        trash={flags.trash !== false}
        retentionDays={TRASH_RETENTION_DAYS}
        canScan={storageMode(cfg) === 's3'}
      />
    </>
  );
}
