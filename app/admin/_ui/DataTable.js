'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { sortRows, nextSort } from '@/lib/admin-table';

/**
 * A table for an admin list: a real <thead>, headers that sort (with
 * aria-sort, so the order is announced as well as drawn), and rows that open
 * what they describe.
 *
 *   columns: [{
 *     key, label,
 *     value?: row => sortable value (default row[key]),
 *     render?: row => node (default the value),
 *     sortable?: false to leave a column unsorted,
 *     align?: 'right', num?: true (right-aligned, tabular figures),
 *     primary?: true — the row's name: a link to rowHref, and a card's title,
 *     truncate?: true — one line with an ellipsis; the full text on hover,
 *     actions?: true — a ⋯ menu or buttons; never the row's click,
 *     shrink?: true — as narrow as its content,
 *   }]
 *
 * `rowHref(row)` makes each row open its page. The primary cell carries the
 * link, so a keyboard reaches it by Tab like any other; a click anywhere
 * else on the row goes to the same place, unless it lands on a control of
 * its own.
 *
 * At 720px and narrower each row is drawn as a card (admin.css). The table
 * roles are written out, so a screen reader still hears a table when the
 * CSS changes how it is displayed.
 */
export default function DataTable({ label, columns, rows, rowKey = (r) => r.id, rowHref, initialSort, empty = null, className = '' }) {
  const router = useRouter();
  const [sort, setSort] = useState(initialSort || null);
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);

  if (!rows?.length) return empty;

  const open = (e, row) => {
    if (!rowHref) return;
    // Let a link, a button or a field inside the row do its own thing.
    if (e.target.closest('a, button, input, select, textarea, label, [role="menu"]')) return;
    const href = rowHref(row);
    if (!href) return;
    if (e.metaKey || e.ctrlKey) { window.open(href, '_blank', 'noopener'); return; }
    router.push(href, { scroll: false });
  };

  return (
    <div className={`dt-wrap ${className}`}>
      <table className="dt" role="table" aria-label={label}>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((c) => {
              const dir = sort?.key === c.key ? sort.dir : null;
              const sortable = c.sortable !== false && !c.actions;
              return (
                <th
                  key={c.key}
                  role="columnheader"
                  scope="col"
                  className={cellClass(c)}
                  aria-sort={sortable ? (dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none') : undefined}
                >
                  {c.actions ? <span className="sr-only">{c.label || 'Actions'}</span> : sortable ? (
                    <button type="button" className="dt-sort" onClick={() => setSort((s) => nextSort(s, c))}>
                      {c.label}
                      <span className="dt-sort-mark" aria-hidden>{dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '↕'}</span>
                    </button>
                  ) : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {sorted.map((row) => {
            const href = rowHref ? rowHref(row) : null;
            return (
              <tr
                key={rowKey(row)}
                role="row"
                className={`dt-row${href ? ' is-clickable' : ''}`}
                onClick={href ? (e) => open(e, row) : undefined}
              >
                {columns.map((c) => {
                  const value = c.render ? c.render(row) : cellValue(c, row);
                  const blank = value == null || value === '' || value === false;
                  const body = c.truncate
                    ? <span className="dt-cell-truncate" title={typeof value === 'string' ? value : undefined}>{value}</span>
                    : value;
                  return (
                    <td
                      key={c.key}
                      role="cell"
                      className={[cellClass(c), c.primary && 'dt-primary', c.actions && 'dt-actions', blank && 'is-blank'].filter(Boolean).join(' ') || undefined}
                    >
                      {!c.primary && !c.actions && <span className="dt-label" aria-hidden>{c.label}</span>}
                      {c.primary && href ? <Link href={href} scroll={false}>{body}</Link> : body}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const cellValue = (c, row) => {
  const v = c.value ? c.value(row) : row?.[c.key];
  return v == null ? '' : v;
};

const cellClass = (c) => [c.num && 'is-num', c.align === 'right' && 'is-right', c.shrink && 'is-shrink'].filter(Boolean).join(' ') || undefined;
