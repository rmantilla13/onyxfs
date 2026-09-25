import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/auth';
import { isAdmin } from '@/lib/auth-allowlist';
import { loadBrand } from '@/lib/brand-config';
import {
  listFilespacesForSpace, storageReport, countFilesUnderPrefix, duplicateSummary, getFeatureFlags,
} from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import { fmtSize } from '@/lib/media';
import { crumbsFor } from '@/lib/folder-ops';
import { kindBreakdown, kindLabel, formatLabel, TRASH_RETENTION_DAYS } from '@/lib/storage-report';
import { buildLabel, buildDetail } from '@/lib/version';
import TopNav from '@/app/components/TopNav';
import { Thumb } from '@/app/components/ui/FileCard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Storage' };

const size = (n) => fmtSize(n) || '0 B';
const files = (n) => `${n.toLocaleString()} file${n === 1 ? '' : 's'}`;
const pct = (share) => (share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);
// A bar's fill: at least a sliver when there is anything at all, nothing
// when there is nothing — an empty drive should not look like a small one.
const bar = (n, max) => (n > 0 ? { width: `${(n / max) * 100}%` } : { width: 0, minWidth: 0 });
const extOf = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')) || [])[1] || null;

/**
 * What is using the space: the library by type, by drive and by format, the
 * largest files, the duplicates and the trash. Admins only — it describes
 * every file, whoever may open it, so it is gated here and the queries
 * (lib/db.js) do not filter.
 */
export default async function StoragePage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin?callbackUrl=/storage');
  if (!isAdmin(email)) redirect('/files');

  const [brand, drives, flags] = await Promise.all([loadBrand(), listFilespacesForSpace(email), getFeatureFlags()]);
  const [report, dups, driveRows] = await Promise.all([
    storageReport({ drivePrefixes: drives.map((d) => d.prefix) }),
    duplicateSummary(),
    Promise.all(drives.map(async (d) => ({ ...d, ...(await countFilesUnderPrefix(d.prefix).catch(() => ({ files: 0, bytes: 0 }))) }))),
  ]);

  const nav = (
    <TopNav
      build={{ label: buildLabel(), detail: buildDetail() }}
      brandName={brand.name}
      markPath={brand.visual.logo.markPath}
      email={email}
      isAdmin
      filespaces={drives}
    />
  );
  if (!report) {
    return (
      <>
        {nav}
        <main className="shell storage-page"><p className="muted">No database is connected, so there is nothing to measure.</p></main>
      </>
    );
  }

  const total = report.live.bytes;
  const kinds = kindBreakdown(report.kinds, total);
  const largest = await presignFileUrls(report.largest);
  const byDrive = [...driveRows].sort((a, b) => b.bytes - a.bytes);
  const driveMax = Math.max(1, ...byDrive.map((d) => d.bytes), report.outsideDrives.bytes);
  const formatMax = Math.max(1, ...report.formats.map((f) => f.bytes));

  return (
    <>
      {nav}
      <main className="shell storage-page">
        <header className="storage-head">
          <div style={{ minWidth: 0 }}>
            <h1 className="storage-title">Storage</h1>
            <p className="muted storage-sub">
              <strong className="storage-total">{size(total)}</strong> in {files(report.live.files)}
              {report.trash.files > 0 && <> · {size(report.trash.bytes)} more in the trash</>}
            </p>
          </div>
          <Link href="/storage/duplicates" className="btn">
            Find duplicates
            {dups.extra > 0 && <span className="count-badge">{dups.extra}</span>}
          </Link>
        </header>

        <section className="card storage-card" aria-labelledby="st-kind">
          <h2 id="st-kind" className="storage-h2">By type</h2>
          <div
            className="usage-bar"
            role="img"
            aria-label={kinds.filter((k) => k.bytes > 0).map((k) => `${k.label} ${pct(k.share)}`).join(', ') || 'Empty'}
          >
            {kinds.filter((k) => k.bytes > 0).map((k) => (
              <span key={k.kind} className={`usage-seg kind-${k.kind}`} style={{ width: `${k.share * 100}%` }} title={`${k.label}: ${size(k.bytes)}`} />
            ))}
          </div>
          <ul className="usage-legend">
            {kinds.map((k) => (
              <li key={k.kind} className={k.files ? '' : 'is-empty'}>
                <span className={`usage-dot kind-${k.kind}`} aria-hidden />
                <span className="usage-legend-label">{k.label}</span>
                <span className="usage-legend-size">{size(k.bytes)}</span>
                <span className="muted small">{files(k.files)} · {pct(k.share)}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="storage-grid">
          <section className="card storage-card" aria-labelledby="st-drives">
            <h2 id="st-drives" className="storage-h2">By drive</h2>
            {byDrive.length === 0 && (
              <p className="small muted" style={{ margin: '0 0 var(--s3)' }}>
                No drives yet. <Link href="/files?new=drive" className="info-link">Make one</Link> to give a team its own space.
              </p>
            )}
            <ul className="meter-list">
              {byDrive.map((d) => (
                <li key={d.id}>
                  <Link href={`/files?filespace=${encodeURIComponent(d.id)}`} className="meter-row">
                    <span className="meter-name truncate">{d.name}</span>
                    <span className="meter-value">{size(d.bytes)}</span>
                    <span className="meter-track" aria-hidden><span className="meter-fill" style={bar(d.bytes, driveMax)} /></span>
                    <span className="meter-note small muted">{files(d.files)}</span>
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/files" className="meter-row">
                  <span className="meter-name truncate">{byDrive.length ? 'Not in a drive' : 'All files'}</span>
                  <span className="meter-value">{size(report.outsideDrives.bytes)}</span>
                  <span className="meter-track" aria-hidden><span className="meter-fill is-quiet" style={bar(report.outsideDrives.bytes, driveMax)} /></span>
                  <span className="meter-note small muted">{files(report.outsideDrives.files)}</span>
                </Link>
              </li>
            </ul>
            {byDrive.length > 1 && (
              <p className="small muted" style={{ margin: 'var(--s3) 0 0' }}>A drive inside another counts toward both.</p>
            )}
          </section>

          <section className="card storage-card" aria-labelledby="st-formats">
            <h2 id="st-formats" className="storage-h2">Largest formats</h2>
            {report.formats.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing stored yet.</p>}
            <ul className="meter-list">
              {report.formats.slice(0, 8).map((f) => (
                <li key={`${f.kind}:${f.ext}`} className="meter-row">
                  <span className="meter-name">
                    <span className={`usage-dot kind-${f.kind}`} aria-hidden />
                    {formatLabel(f.ext)}
                    <span className="muted small"> {kindLabel(f.kind).toLowerCase()}</span>
                  </span>
                  <span className="meter-value">{size(f.bytes)}</span>
                  <span className="meter-track" aria-hidden><span className={`meter-fill kind-${f.kind}`} style={bar(f.bytes, formatMax)} /></span>
                  <span className="meter-note small muted">{files(f.files)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="card storage-card" aria-labelledby="st-largest">
          <h2 id="st-largest" className="storage-h2">Largest files</h2>
          {largest.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing stored yet.</p>}
          <ol className="big-files">
            {largest.map((f) => (
              <li key={f.id}>
                <Link href={`/files/${f.id}`} className="big-file">
                  <span className="big-file-thumb"><Thumb file={f} label={formatLabel(extOf(f.name))} /></span>
                  <span className="big-file-text">
                    <span className="truncate big-file-name">{f.name}</span>
                    <span className="truncate small muted">{crumbsFor(f.folder || '').map((c) => c.name).join(' / ')}</span>
                  </span>
                  <span className="big-file-size">{size(f.size)}</span>
                  <span className="big-file-share small muted">{total ? pct(f.size / total) : ''}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <div className="storage-grid">
          <section className="card storage-card" aria-labelledby="st-dups">
            <h2 id="st-dups" className="storage-h2">Duplicates</h2>
            {dups.extra > 0 ? (
              <p className="storage-stat">
                <strong>{size(dups.bytes)}</strong>
                <span className="muted small"> in {files(dups.extra)} that are extra copies of another</span>
              </p>
            ) : (
              <p className="storage-stat"><strong>None found</strong></p>
            )}
            {dups.unhashed > 0 && (
              <p className="small muted" style={{ margin: '0 0 var(--s3)' }}>
                {files(dups.unhashed)} from before duplicate detection {dups.unhashed === 1 ? 'has' : 'have'} not been checked yet.
              </p>
            )}
            <Link href="/storage/duplicates" className="btn btn-sm">{dups.extra > 0 ? 'Review and clean up' : 'Open duplicates'}</Link>
          </section>

          <section className="card storage-card" aria-labelledby="st-trash">
            <h2 id="st-trash" className="storage-h2">Trash</h2>
            <p className="storage-stat">
              <strong>{size(report.trash.bytes)}</strong>
              <span className="muted small"> in {files(report.trash.files)}</span>
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              {flags.trash === false
                ? 'The trash is off: removing a file deletes it at once.'
                : `Removed files still take space until they are purged, ${TRASH_RETENTION_DAYS} days after removal.`}
            </p>
          </section>
        </div>
        <p className="small muted storage-foot">Previews (thumbnails and filmstrips) are stored separately and not counted here.</p>
      </main>
    </>
  );
}
