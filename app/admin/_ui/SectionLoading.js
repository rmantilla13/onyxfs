/**
 * What a section shows while its server data loads (each section's
 * loading.js): the shape of its header, then skeleton rows or tiles in
 * --surface-sunken, so the page does not jump when the data arrives.
 *
 * No hooks, so a loading.js (a server component) can render it as it is.
 */
export default function SectionLoading({ rows = 6, tiles = 0, label = 'Loading…' }) {
  return (
    <div className="admin-page" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="admin-head" aria-hidden>
        <div className="admin-head-text">
          <span className="skel skel-title" />
          <span className="skel skel-line" />
        </div>
      </div>
      {tiles > 0 && (
        <div className="admin-tiles" aria-hidden>
          {Array.from({ length: tiles }, (_, i) => <span key={i} className="skel skel-tile" />)}
        </div>
      )}
      {rows > 0 && (
        <div className="admin-skeleton" aria-hidden>
          {Array.from({ length: rows }, (_, i) => <span key={i} className="skel skel-row" />)}
        </div>
      )}
    </div>
  );
}
