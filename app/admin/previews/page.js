import { listFilespaces, previewSummary } from '@/lib/db';
import { getStorageConfig, storageMode } from '@/lib/storage';
import { loadBrand } from '@/lib/brand-config';
import { requireAdminPage } from '../_lib/guard';
import AdminPage, { AdminCard } from '../_ui/AdminPage';
import AdminState from '../_ui/AdminState';
import { StatTile } from '../_ui/StatTile';
import PreviewsRunner from './PreviewsRunner';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Previews · Admin' };

const num = (v) => (Number(v) || 0).toLocaleString('en-US');
const files = (v) => `${num(v)} file${Number(v) === 1 ? '' : 's'}`;

/** previewSummary's groups added together. */
function sum(...groups) {
  const out = { files: 0, thumbs: 0, legacy: 0, noSizes: 0, noPlaceholder: 0, noPoster: 0 };
  for (const g of groups) for (const k of Object.keys(out)) out[k] += Number(g?.[k]) || 0;
  return out;
}

/**
 * Admin → Storage → Previews: the thumbnails of the library's pictures and
 * videos — which have theirs, which lack a part of it — and a run that
 * draws them again in the admin's browser (./PreviewsRunner.js), where every
 * thumbnail is drawn: nothing here decodes a file on the server.
 *
 * The counts are one query over every live file (lib/db.js previewSummary),
 * split by what a browser can draw (lib/preview-jobs.js previewClass). HEIC
 * and TIFF, which only Safari decodes, and formats no browser decodes are
 * counted apart: the Mac app makes theirs, or nothing does. The counts
 * describe every drive, whoever may open it, so the page is gated here.
 */
export default async function PreviewsPage() {
  await requireAdminPage('/admin/previews');
  const [summary, drives, cfg, brand] = await Promise.all([
    previewSummary().catch((e) => {
      console.warn('[admin/previews] summary:', e.message);
      return null;
    }),
    listFilespaces().catch(() => []),
    getStorageConfig(),
    loadBrand(),
  ]);
  const mac = `${brand.name} for Mac`;
  const inBucket = storageMode(cfg) === 's3';
  const description = 'Thumbnails for the library’s pictures and videos: which have theirs, which lack a part, and drawing them again in this browser.';

  if (!inBucket) {
    return (
      <AdminPage title="Previews" description={description}>
        <AdminState
          kind="empty"
          title="Previews are kept in a bucket"
          message="Storage is set to Vercel Blob, where no thumbnails are made. Files kept in an S3-compatible bucket get theirs beside them, and are counted here."
        />
      </AdminPage>
    );
  }

  const drawn = summary ? sum(summary.image, summary.video) : null;
  const safari = summary ? sum(summary.heic, summary.tiff) : null;
  const never = summary ? sum(summary.never) : null;
  const without = drawn ? drawn.files - drawn.thumbs : 0;

  return (
    <AdminPage title="Previews" description={description}>
      {!summary && (
        <AdminState kind="error" title="The counts could not be read." error={{ message: 'The database did not answer. Reload the page to try again.' }} />
      )}

      {summary && drawn.files + safari.files + never.files === 0 && (
        <AdminState
          kind="empty"
          title="No pictures or videos yet"
          message="Pictures and videos get their thumbnails as they are uploaded. Their counts appear here."
        />
      )}

      {summary && drawn.files > 0 && (
        <AdminCard
          title="Thumbnails"
          id="pv-counts"
          hint={`Of the ${files(drawn.files)} in the bucket that a browser can draw: pictures in the formats every browser decodes, and videos in MP4, MOV and WebM.`}
        >
          <div className="admin-tiles">
            <StatTile label="With a thumbnail" value={num(drawn.thumbs)} sub={`of ${files(drawn.files)}`} />
            <StatTile
              label="Without one"
              value={num(without)}
              tone={without > 0 ? 'warning' : undefined}
              sub={without > 0 ? 'Their tiles show only the kind of file' : 'Every one has its picture'}
            />
            <StatTile label="Without smaller sizes" value={num(drawn.noSizes)} sub="Cards and list rows load the whole thumbnail" />
            <StatTile label="Without a placeholder" value={num(drawn.noPlaceholder)} sub="Their tiles are blank until it arrives" />
            <StatTile label="Videos without a player poster" value={num(drawn.noPoster)} sub="The player enlarges the thumbnail" />
          </div>
          {drawn.legacy > 0 && (
            <p className="small muted admin-card-foot">
              {files(drawn.legacy)} {drawn.legacy === 1 ? 'has a thumbnail' : 'have thumbnails'} from before the server named them, which cannot be given smaller sizes or a placeholder: a run draws {drawn.legacy === 1 ? 'it' : 'those'} again whole.
            </p>
          )}
        </AdminCard>
      )}

      {summary && safari.files + never.files > 0 && (
        <AdminCard title={`Made by ${mac}, or not at all`} id="pv-mac">
          <ul className="preview-other">
            {safari.files > 0 && (
              <li>
                <strong>{files(safari.files)} in HEIC or TIFF</strong>
                <span className="small muted"> · {num(safari.thumbs)} with a thumbnail</span>
                <p className="small muted admin-note">
                  Safari decodes these, so a run started in Safari includes them. Other browsers leave them to {mac}, which makes their thumbnails as it syncs a drive.
                </p>
              </li>
            )}
            {never.files > 0 && (
              <li>
                <strong>{files(never.files)} in formats no browser decodes</strong>
                <span className="small muted"> · {num(never.thumbs)} with a thumbnail</span>
                <p className="small muted admin-note">
                  RAW photos, PSDs, AVI and MKV videos and the like. Only {mac} makes their thumbnails.
                </p>
              </li>
            )}
          </ul>
          <p className="small muted admin-card-foot">
            A MOV holding ProRes counts as a video a browser can draw, since nothing on the file says which codec is inside. Only Safari decodes ProRes: another browser fails on it, and says so at the end of a run.
          </p>
        </AdminCard>
      )}

      <PreviewsRunner
        drives={drives.map((d) => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name))}
        mac={mac}
      />
    </AdminPage>
  );
}
