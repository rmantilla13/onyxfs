'use client';

import Menu, { MenuItem, MenuSeparator, MenuLabel } from '@/app/components/ui/Menu';
import Icon from '@/app/components/ui/Icon';
import { SORT_FIELDS, sortParts, sortFor, describeSort } from '@/lib/views';

/**
 * The files toolbar, under the title bar: on the left what the view shows —
 * Sort, Filters, and what is applied (the search from the top bar and the
 * metadata filters, each a chip that removes itself); on the right the view
 * itself — Select view, then what acts on the selection (Download, More),
 * then Display.
 *
 * Every control is one height and one radius (.tb-btn), with hairlines
 * between the groups. On a phone the labels go and the icons stay; what
 * still does not fit wraps to a second line rather than past the edge.
 */
export default function FilesToolbar({
  sort, onSort,
  filters = null,
  query, onClearQuery, onEditQuery,
  chips = null,
  viewMenu, selectedCount = 0, onDownload, downloadCount = 0, moreMenu, display,
}) {
  return (
    <div className="files-toolbar" role="group" aria-label="View controls">
      <div className="tb-group tb-left">
        <SortMenu sort={sort} onSort={onSort} />
        {filters && (
          <>
            <span className="tb-div" aria-hidden />
            <button
              type="button"
              className={`btn tb-btn${filters.open ? ' is-open' : ''}`}
              onClick={filters.onToggle}
              aria-expanded={filters.open}
              aria-controls="files-filters"
              aria-label={filters.count ? `Filters, ${filters.count} applied` : 'Filters'}
            >
              <Icon name="list-filter" size={16} />
              <span className="tb-label">Filters</span>
              {filters.count > 0 && <span className="count-badge">{filters.count}</span>}
            </button>
          </>
        )}
      </div>
      {(query || chips) && (
        <div className="tb-chips">
          {query && (
            <span className="filter-chip search-chip">
              <button type="button" className="search-chip-edit" onClick={onEditQuery} title="Change the search">
                <Icon name="search" size={13} />
                <span className="muted">Search:</span>
                <span className="truncate">{query}</span>
              </button>
              <button type="button" className="search-chip-x" onClick={onClearQuery} aria-label={`Remove the search for ${query}`} title="Remove the search">
                <Icon name="x" size={12} />
              </button>
            </span>
          )}
          {chips}
        </div>
      )}
      <div className="tb-group tb-right">
        {selectedCount > 0 && <span className="tb-count" aria-live="polite">{selectedCount.toLocaleString()} selected</span>}
        {viewMenu}
        <span className="tb-div" aria-hidden />
        <button
          type="button"
          className="btn tb-btn tb-icon"
          onClick={onDownload}
          disabled={!downloadCount}
          aria-label={downloadCount ? `Download ${downloadCount} file${downloadCount === 1 ? '' : 's'}` : 'Download the selection'}
          title={downloadCount ? `Download ${downloadCount} file${downloadCount === 1 ? '' : 's'}` : 'Select files to download them'}
        >
          <Icon name="download" size={16} />
        </button>
        {moreMenu}
        {display}
      </div>
    </div>
  );
}

/**
 * The listing's order: what by, then which way — in the words that suit the
 * field ("Newest first" for a date, "A to Z" for a name). A new field starts
 * in its natural direction: names A to Z, sizes and dates largest and newest
 * first.
 */
function SortMenu({ sort, onSort }) {
  const { field, dir } = sortParts(sort);
  const f = SORT_FIELDS.find((x) => x.key === field) || SORT_FIELDS[0];
  const dirs = f.first === 'asc' ? ['asc', 'desc'] : ['desc', 'asc'];
  return (
    <Menu
      ariaLabel={`Sort: ${describeSort(sort)}`}
      title={`Sorted by ${describeSort(sort).toLowerCase()}`}
      align="left"
      buttonClassName="btn tb-btn"
      menuClassName="sort-menu"
      trigger={(
        <>
          <Icon name="arrow-up-down" size={16} />
          <span className="tb-label">Sort</span>
        </>
      )}
    >
      <MenuLabel>Sort by</MenuLabel>
      {SORT_FIELDS.map((x) => (
        <MenuItem key={x.key} checked={x.key === field} onClick={() => onSort(x.key === field ? sort : sortFor(x.key))}>{x.label}</MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Order</MenuLabel>
      {dirs.map((d) => (
        <MenuItem key={d} checked={d === dir} onClick={() => onSort(sortFor(field, d))}>{f[`${d}Label`]}</MenuItem>
      ))}
    </Menu>
  );
}

/** The More menu's items, built by the page (it knows what may be done here). */
export function MoreMenu({ children }) {
  return (
    <Menu ariaLabel="More actions" title="More" buttonClassName="btn tb-btn tb-icon" menuClassName="more-menu" trigger={<Icon name="ellipsis" size={16} />}>
      {children}
    </Menu>
  );
}

export { MenuItem, MenuSeparator, MenuLabel };
