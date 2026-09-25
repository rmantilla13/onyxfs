'use client';

import { useState } from 'react';

/**
 * The facet filters, as a panel that opens under the toolbar instead of a
 * rail down the side of the page. The rail spent most of the sidebar on
 * checkboxes that are set once and then left alone; folded away, the folders
 * get the room and the filters are one click from being adjusted.
 *
 * `defs` is buildFacets() output: every facet with its values and counts over
 * the loaded files. Counts describe what is on screen, not the whole bucket.
 */
const SHOWN = 6;

export default function FilterPanel({ id, defs, selected, onToggle, onClear, onClose }) {
  const active = countActive(selected);
  // A facet with nothing loaded under it still shows while one of its values
  // is selected, so the selection can be undone from here.
  const facets = defs.filter((d) => d.values.length > 0 || selected[d.key]?.length);
  return (
    <section id={id} className="filters-panel card" aria-label="Filters">
      <div className="filters-head">
        <strong className="small">Filters</strong>
        <span className="small muted">
          {active ? `${active} selected` : 'Narrow what is loaded by its metadata'}
        </span>
        <div className="spacer" />
        {active > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>Clear all</button>}
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close filters">
          <span aria-hidden>✕</span>
        </button>
      </div>
      {facets.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>Nothing loaded here has metadata to filter by yet.</p>
      ) : (
        <div className="filters-grid">
          {facets.map((d) => (
            <FacetGroup key={d.key} def={d} selected={selected[d.key] || []} onToggle={(v) => onToggle(d.key, v)} />
          ))}
        </div>
      )}
    </section>
  );
}

function FacetGroup({ def, selected, onToggle }) {
  const [all, setAll] = useState(false);
  // Selected values the loaded files no longer carry (an edit, a reload)
  // still get a row, at count 0, rather than becoming an invisible filter.
  const present = new Set(def.values.map((v) => v.value));
  const values = [...def.values, ...selected.filter((v) => !present.has(v)).map((value) => ({ value, count: 0 }))];
  const listed = all ? values : values.filter((v, i) => i < SHOWN || selected.includes(v.value));
  return (
    <fieldset className="facet">
      <legend className="facet-title">{def.label}</legend>
      {listed.map((v) => (
        <label key={v.value} className="facet-row">
          <input type="checkbox" checked={selected.includes(v.value)} onChange={() => onToggle(v.value)} />
          <span className="truncate" title={v.value}>{v.value}</span>
          <span className="facet-count muted">{v.count}</span>
        </label>
      ))}
      {values.length > SHOWN && (
        <button type="button" className="facet-more" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${values.length}`}
        </button>
      )}
    </fieldset>
  );
}

/**
 * What is filtered, while the panel is closed: one chip per selected value,
 * each of which removes itself. Without this a closed panel hides the reason
 * half the folder is missing.
 */
export function ActiveFilters({ defs, selected, onToggle, onClear, onEdit }) {
  const labels = new Map(defs.map((d) => [d.key, d.label]));
  const chips = Object.entries(selected || {}).flatMap(([key, values]) =>
    (values || []).map((value) => ({ key, value, label: labels.get(key) || key })));
  if (!chips.length) return null;
  return (
    <div className="filter-chips" role="group" aria-label="Active filters">
      {chips.map((c) => (
        <button
          key={`${c.key}\u0000${c.value}`}
          type="button"
          className="filter-chip"
          onClick={() => onToggle(c.key, c.value)}
          aria-label={`Remove filter ${c.label}: ${c.value}`}
          title="Remove this filter"
        >
          <span className="muted">{c.label}</span>
          <span className="truncate">{c.value}</span>
          <span aria-hidden>✕</span>
        </button>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>Clear all</button>
    </div>
  );
}

export function countActive(selected) {
  return Object.values(selected || {}).reduce((n, v) => n + (v?.length || 0), 0);
}
