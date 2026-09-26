import Link from 'next/link';

/**
 * One number and what it means, lifted from the Usage page's stat. With
 * `href` the whole tile is the way to the section behind it. `tone`
 * (warning | danger) colours the sub-line — the words that say what is
 * wrong — and, for danger, the border; the value stays in ink.
 */
export function StatTile({ label, value, sub, href, tone, children }) {
  const cls = `card stat-tile${tone ? ` is-${tone}` : ''}`;
  const inner = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
      {children}
    </>
  );
  return href ? <Link href={href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

/**
 * A bar of used against a whole — the storage-page meter as a component.
 * `label` is what a screen reader hears ("38 GB of 100 GB"). With no max it
 * draws nothing: there is nothing to measure against.
 */
export function Meter({ value = 0, max = 0, label, quiet = false }) {
  const v = Math.max(0, Number(value) || 0);
  const m = Math.max(0, Number(max) || 0);
  if (!m) return null;
  const pct = Math.min(100, (v / m) * 100);
  return (
    <span
      className="admin-meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={m}
      aria-valuenow={Math.min(v, m)}
      aria-label={label}
    >
      <span className="meter-track">
        <span className={`meter-fill${quiet ? ' is-quiet' : ''}`} style={v > 0 ? { width: `${pct}%` } : { width: 0, minWidth: 0 }} />
      </span>
    </span>
  );
}
