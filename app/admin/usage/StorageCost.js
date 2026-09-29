import { fmtSize } from '@/lib/media';
import { fmtUsd, fmtPriceDate, lineNote, unitsNote } from '@/lib/storage-pricing';

const size = (n) => fmtSize(n) || '0 B';
const bar = (n, max) => (n > 0 ? { width: `${(n / max) * 100}%` } : { width: 0, minWidth: 0 });

/**
 * The Storage cost card on Admin → Usage: what keeping the library costs a
 * month, by where it is kept (lib/storage-pricing.js).
 *
 * A server component, like the page: the prices, the storage config and the
 * drives' keys stay on the server, and only the figures are rendered. A line
 * is keyed by its place in the list rather than by its location's key, which
 * names the endpoint and would otherwise ride along in the payload.
 *
 * `estimate` is estimateStorageCost's, or null when the files are in Vercel
 * Blob, which has no bucket to price. `stored` is billableStorage's.
 */
export default function StorageCost({ estimate, stored }) {
  if (!estimate) {
    return (
      <section className="card admin-card" aria-labelledby="st-cost">
        <h2 id="st-cost" className="admin-h2 admin-card-title">Storage cost</h2>
        <p className="small muted admin-note">Files are kept in Vercel Blob, which this estimate does not price.</p>
      </section>
    );
  }

  const { lines } = estimate;
  const max = Math.max(1, ...lines.map((l) => l.bytes));
  // One note per service priced here, in the order its lines appear.
  const services = [...new Map(lines.filter((l) => l.price).map((l) => [l.price.provider, l.price])).values()];
  const proxies = stored?.proxies || { files: 0, unsized: 0 };
  const counted = proxies.files > 0
    ? 'the files, the trash (stored until it is purged) and streaming proxies'
    : 'the files and the trash (stored until it is purged)';
  const left = ['downloads', 'API requests'];
  if (proxies.unsized > 0) left.push(`${proxies.unsized.toLocaleString('en-US')} ${proxies.unsized === 1 ? 'proxy' : 'proxies'} made without a reported size`);
  left.push('thumbnails, posters and filmstrips, whose sizes are not recorded');

  return (
    <section className="card admin-card" aria-labelledby="st-cost">
      <h2 id="st-cost" className="admin-h2 admin-card-title">Storage cost</h2>
      {estimate.usd != null ? (
        <p className="storage-stat">
          <strong>{fmtUsd(estimate.usd)}</strong>
          <span className="muted small">
            {' '}a month, estimated
            {estimate.unpricedBytes > 0 && <>, and {size(estimate.unpricedBytes)} not priced</>}
          </span>
        </p>
      ) : (
        <p className="storage-stat">
          <strong>No list price</strong>
          <span className="muted small"> for where these files are kept</span>
        </p>
      )}
      <ul className="meter-list">
        {lines.map((l, i) => (
          <li key={i} className="meter-row">
            <span className="meter-name truncate">
              {l.location.name}
              {l.location.bucket && <><span className="muted"> · </span><span className="admin-mono">{l.location.bucket}</span></>}
              {l.location.region && <span className="muted small"> {l.location.region}</span>}
            </span>
            <span className="meter-value">{l.price ? fmtUsd(l.usd) : <span className="muted">Not priced</span>}</span>
            {/* A share of the bytes; a lone line's bar would only ever be full. */}
            {lines.length > 1 && (
              <span className="meter-track" aria-hidden>
                <span className={`meter-fill${l.price ? '' : ' is-quiet'}`} style={bar(l.bytes, max)} />
              </span>
            )}
            <span className="meter-note small muted">{lineNote(l)}</span>
          </li>
        ))}
      </ul>
      <div className="admin-card-foot small muted storage-notes">
        <p>
          An estimate of storage alone{estimate.checked && <>, at list prices as of {fmtPriceDate(estimate.checked)}</>},
          counting {counted}. Not included: {left.slice(0, -1).join(', ')}, and {left[left.length - 1]}.
        </p>
        {services.map((p) => (
          <p key={p.provider}>
            <a href={p.source} className="info-link" target="_blank" rel="noreferrer">{p.name}</a>: {[p.terms, unitsNote(p)].filter(Boolean).join(' ')}
          </p>
        ))}
      </div>
    </section>
  );
}
