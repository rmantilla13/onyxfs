import Link from 'next/link';
import {
  storageReport, listDrivesWithUsage, duplicateSummary, getFeatureFlags, storageByPerson,
} from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import { fmtSize } from '@/lib/media';
import { crumbsFor } from '@/lib/folder-ops';
import { driveForKey } from '@/lib/admin-drives';
import { kindLabel, formatLabel, TRASH_RETENTION_DAYS } from '@/lib/storage-report';
import { Thumb } from '@/app/components/ui/FileCard';
import { requireAdminPage } from '../_lib/guard';
import AdminPage from '../_ui/AdminPage';
import AdminState from '../_ui/AdminState';
import KindBreakdown from '../_ui/KindBreakdown';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Usage · Admin' };

const size = (n) => fmtSize(n) || '0 B';
const files = (n) => `${Number(n).toLocaleString('en-US')} file${n === 1 ? '' : 's'}`;
const pct = (share) => (share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);
// A bar's fill: at least a sliver when there is anything at all, nothing
// when there is nothing — an empty drive should not look like a small one.
const bar = (n, max) => (n > 0 ? { width: `${(n / max) * 100}%` } : { width: 0, minWidth: 0 });
const extOf = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')) || [])[1] || null;

/**
 * Admin → Storage → Usage (was /storage): what is using the space — by type,
 * drive, format and person, the largest files, the duplicates and the trash.
 *
 * It describes every file, whoever may open it, so it is gated here and the
 * queries (lib/db.js) do not filter. The largest files are presigned last,
 * after the gate, and only those twenty.
 */
export default async function UsagePage() {
  await requireAdminPage('/admin/usage');
  const [drives, flags] = await Promise.all([listDrivesWithUsage(), getFeatureFlags()]);
  const [report, dups, people] = await Promise.all([
    storageReport({ drivePrefixes: drives.map((d) => d.prefix) }),
    duplicateSummary(),
    storageByPerson({ limit: 10 }),
  ]);

  if (!report) {
    return (
      <AdminPage title="Usage" description="What is using the space.">
        <AdminState kind="empty" title="Nothing to measure" message="No database is connected, so there is no library to measure." />
      </AdminPage>
    );
  }

  // Nothing stored: one sentence and the way to start, not seven cards of
  // zeros. Anything in the trash still counts as something to show.
  if (report.live.files === 0 && report.trash.files === 0) {
    return (
      <AdminPage title="Usage" description="What is using the space.">
        <AdminState
          kind="empty"
          title="Nothing stored yet"
          message={drives.length
            ? 'Files uploaded to the library or to a drive are measured here: by type, drive, format and person.'
            : 'Files uploaded to the library are measured here. A drive gives a team a space of its own to fill.'}
          action={drives.length
            ? <Link href="/files" className="btn btn-primary">Open files</Link>
            : <Link href="/admin/drives" className="btn btn-primary">Make a drive</Link>}
        />
      </AdminPage>
    );
  }

  const total = report.live.bytes;
  const largest = await presignFileUrls(report.largest);
  const byDrive = [...drives].sort((a, b) => b.bytes - a.bytes);
  const driveMax = Math.max(1, ...byDrive.map((d) => d.bytes), report.outsideDrives.bytes);
  const formatMax = Math.max(1, ...report.formats.map((f) => f.bytes));
  const personMax = Math.max(1, ...people.people.map((p) => p.bytes), people.unattributed.bytes);

  return (
    <AdminPage
      title="Usage"
      description={(
        <>
          <strong className="storage-total">{size(total)}</strong> in {files(report.live.files)}
          {report.trash.files > 0 && <> · {size(report.trash.bytes)} more in the trash</>}
        </>
      )}
      actions={(
        <Link href="/admin/usage/duplicates" className="btn">
          Find duplicates
          {dups.extra > 0 && <span className="count-badge">{dups.extra}</span>}
        </Link>
      )}
    >
      <section className="card admin-card" aria-labelledby="st-kind">
        <h2 id="st-kind" className="admin-h2 admin-card-title">By type</h2>
        <KindBreakdown rows={report.kinds} total={total} />
      </section>

      <div className="admin-cols">
        <section className="card admin-card" aria-labelledby="st-drives">
          <h2 id="st-drives" className="admin-h2 admin-card-title">By drive</h2>
          {byDrive.length === 0 && (
            <p className="small muted admin-hint-flat">
              No drives yet. <Link href="/admin/drives" className="info-link">Make one</Link> to give a team its own space.
            </p>
          )}
          <ul className="meter-list">
            {byDrive.map((d) => (
              <li key={d.id}>
                <Link href={`/admin/drives/${encodeURIComponent(d.id)}#usage`} className="meter-row">
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
          {byDrive.length > 1 && <p className="small muted admin-card-foot">A drive inside another counts toward both.</p>}
        </section>

        <section className="card admin-card" aria-labelledby="st-people">
          <h2 id="st-people" className="admin-h2 admin-card-title">By person</h2>
          {people.people.length === 0 && people.unattributed.files === 0 && (
            <p className="small muted admin-note">Nothing stored yet.</p>
          )}
          <ul className="meter-list">
            {people.people.map((p) => (
              <li key={p.email} className="meter-row">
                <span className="meter-name truncate" title={p.email}>{p.email}</span>
                <span className="meter-value">{size(p.bytes)}</span>
                <span className="meter-track" aria-hidden><span className="meter-fill" style={bar(p.bytes, personMax)} /></span>
                <span className="meter-note small muted">{files(p.files)}</span>
              </li>
            ))}
            {people.unattributed.files > 0 && (
              <li className="meter-row">
                <span className="meter-name truncate">No one recorded</span>
                <span className="meter-value">{size(people.unattributed.bytes)}</span>
                <span className="meter-track" aria-hidden><span className="meter-fill is-quiet" style={bar(people.unattributed.bytes, personMax)} /></span>
                <span className="meter-note small muted">{files(people.unattributed.files)}</span>
              </li>
            )}
          </ul>
          <p className="small muted admin-card-foot">
            The ten who added the most, by the files they uploaded that are still in the library.
            {people.unattributed.files > 0 ? ' Files from before uploads were recorded, or dropped into a desktop mount, have no one to count against.' : ''}
          </p>
        </section>
      </div>

      <div className="admin-cols">
        <section className="card admin-card" aria-labelledby="st-formats">
          <h2 id="st-formats" className="admin-h2 admin-card-title">Largest formats</h2>
          {report.formats.length === 0 && <p className="small muted admin-note">Nothing stored yet.</p>}
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

        <div className="admin-stack">
          <section className="card admin-card" aria-labelledby="st-dups">
            <h2 id="st-dups" className="admin-h2 admin-card-title">Duplicates</h2>
            {dups.extra > 0 ? (
              <p className="storage-stat">
                <strong>{size(dups.bytes)}</strong>
                <span className="muted small"> in {files(dups.extra)} that {dups.extra === 1 ? 'is an extra copy of another' : 'are extra copies of others'}</span>
              </p>
            ) : (
              <p className="storage-stat"><strong>None found</strong></p>
            )}
            {dups.unhashed > 0 && (
              <p className="small muted admin-hint-flat">
                {files(dups.unhashed)} from before duplicate detection {dups.unhashed === 1 ? 'has' : 'have'} not been checked yet.
              </p>
            )}
            <Link href="/admin/usage/duplicates" className="btn btn-sm">{dups.extra > 0 ? 'Review and clean up' : 'Open duplicates'}</Link>
          </section>

          <section className="card admin-card" aria-labelledby="st-trash">
            <h2 id="st-trash" className="admin-h2 admin-card-title">Trash</h2>
            <p className="storage-stat">
              <strong>{size(report.trash.bytes)}</strong>
              <span className="muted small"> in {files(report.trash.files)}</span>
            </p>
            <p className="small muted admin-note">
              {flags.trash === false
                ? 'The trash is off: removing a file deletes it at once.'
                : `Removed files still take space until they are purged, ${TRASH_RETENTION_DAYS} days after removal.`}
            </p>
          </section>
        </div>
      </div>

      <section className="card admin-card" aria-labelledby="st-largest">
        <h2 id="st-largest" className="admin-h2 admin-card-title">Largest files</h2>
        {largest.length === 0 && <p className="small muted admin-note">Nothing stored yet.</p>}
        <ol className="big-files">
          {largest.map((f) => (
            <li key={f.id}>
              <Link href={`/files/${f.id}`} className="big-file">
                <span className="big-file-thumb"><Thumb file={f} label={formatLabel(extOf(f.name))} /></span>
                <span className="big-file-text">
                  <span className="truncate big-file-name">{f.name}</span>
                  <span className="truncate small muted">{crumbsFor(f.folder || '', driveForKey(drives, f.storageKey)?.name || 'All files').map((c) => c.name).join(' / ')}</span>
                </span>
                <span className="big-file-size">{size(f.size)}</span>
                <span className="big-file-share small muted">{total ? pct(f.size / total) : ''}</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <p className="small muted admin-note">Previews (thumbnails and filmstrips) are stored separately and not counted here.</p>
    </AdminPage>
  );
}
