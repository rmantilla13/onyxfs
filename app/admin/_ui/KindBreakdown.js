import { fmtSize } from '@/lib/media';
import { kindBreakdown } from '@/lib/storage-report';

const size = (n) => fmtSize(n) || '0 B';
const files = (n) => `${Number(n).toLocaleString('en-US')} file${n === 1 ? '' : 's'}`;
const pct = (share) => (share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);

/**
 * Stored bytes by kind — video, images, audio, documents, other — as one
 * bar and its legend. The Usage page shows the library's; a drive's drawer
 * shows the drive's. `rows` are { kind, files, bytes }.
 */
export default function KindBreakdown({ rows = [], total = 0, label = 'By type' }) {
  const kinds = kindBreakdown(rows, total);
  const shown = kinds.filter((k) => k.bytes > 0);
  return (
    <>
      <div className="usage-bar" role="img" aria-label={`${label}: ${shown.map((k) => `${k.label} ${pct(k.share)}`).join(', ') || 'empty'}`}>
        {shown.map((k) => (
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
    </>
  );
}
