'use client';

import { useId, useRef, useState } from 'react';
import Popover from '@/app/components/ui/Popover';
import Icon from '@/app/components/ui/Icon';
import { moveColumn } from '@/lib/list-columns';

/**
 * Display: how the view on screen shows its files — the layout, which
 * metadata fields go on cards and list rows, whether a thumbnail fills its
 * box or fits in it, the card size, and whether every folder beneath this
 * one is flattened into one listing. It took over the list's column picker:
 * the fields are the list's columns, and the grid's and tiles' captions.
 *
 * Every change applies at once. They belong to the view (lib/views.js): a
 * built-in keeps them in this browser; a saved view shows what changed and
 * offers to save it (`dirty`, `onSave`) or put it back (`onRevert`).
 */

/* icons: layout-grid list layout-dashboard kanban */
const LAYOUTS = [
  { key: 'grid', label: 'Grid', icon: 'layout-grid' },
  { key: 'list', label: 'List', icon: 'list' },
  { key: 'tile', label: 'Tile', icon: 'layout-dashboard' },
  { key: 'column', label: 'Column', icon: 'kanban' },
];
const SIZES = [
  { key: 's', label: 'S', name: 'Small' },
  { key: 'm', label: 'M', name: 'Medium' },
  { key: 'l', label: 'L', name: 'Large' },
];

/**
 * A row of choices, one of which is chosen: a radio group, so the arrow keys
 * move along it and Tab leaves it, as the platform's own segmented controls.
 */
function Segmented({ label, options, value, onChange, small = false, disabled = false }) {
  const refs = useRef([]);
  const at = Math.max(0, options.findIndex((o) => o.key === value));
  const step = (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const next = (at + d + options.length) % options.length;
    onChange(options[next].key);
    refs.current[next]?.focus();
  };
  return (
    <div className={`seg${small ? ' seg-sm' : ''}`} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={disabled ? undefined : step}>
      {options.map((o, i) => (
        <button
          key={o.key}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          aria-label={o.name}
          tabIndex={o.key === value ? 0 : -1}
          className="seg-btn"
          disabled={disabled}
          onClick={() => onChange(o.key)}
        >
          {o.icon && <Icon name={o.icon} size={16} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The metadata fields: what is shown, in order, then everything else by group. */
function FieldsPage({ available, fields, defaults, onChange, onBack, onAddField }) {
  const byKey = new Map(available.map((c) => [c.key, c]));
  const shown = fields.map((k) => byKey.get(k)).filter(Boolean);
  const hidden = available.filter((c) => !fields.includes(c.key));
  const groups = [...new Set(hidden.map((c) => c.group))];
  const keys = shown.map((c) => c.key);
  return (
    <div className="display-sub">
      <button type="button" className="display-back" onClick={onBack}>
        <Icon name="chevron-left" size={16} />
        Display preferences
      </button>
      <div className="display-subhead">
        <strong>Metadata fields</strong>
        <div className="spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(defaults)}>Reset</button>
      </div>
      <p className="colpick-label">Shown</p>
      {!shown.length && <p className="small muted colpick-note">None: cards show their names alone.</p>}
      {shown.map((c, i) => (
        <div className="colpick-row" key={c.key}>
          <label className="colpick-check">
            <input type="checkbox" checked onChange={() => onChange(keys.filter((k) => k !== c.key))} />
            <span className="truncate">{c.label}</span>
          </label>
          <button type="button" className="btn btn-ghost btn-sm colpick-move" aria-label={`Move ${c.label} earlier`} title="Move earlier" disabled={i === 0} onClick={() => onChange(moveColumn(keys, c.key, -1))}>
            <Icon name="arrow-up" size={14} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm colpick-move" aria-label={`Move ${c.label} later`} title="Move later" disabled={i === shown.length - 1} onClick={() => onChange(moveColumn(keys, c.key, 1))}>
            <Icon name="arrow-down" size={14} />
          </button>
        </div>
      ))}
      {groups.map((g) => (
        <div key={g}>
          <p className="colpick-label">{g}</p>
          {hidden.filter((c) => c.group === g).map((c) => (
            <label className="colpick-row" key={c.key}>
              <input type="checkbox" checked={false} onChange={() => onChange([...keys, c.key])} />
              <span className="truncate">{c.label}</span>
              {c.edit && <span className="colpick-hint">editable in List</span>}
            </label>
          ))}
        </div>
      ))}
      {onAddField && (
        <div className="colpick-foot">
          <button type="button" className="btn btn-sm" onClick={onAddField}>
            <Icon name="plus" size={14} />New metadata field…
          </button>
        </div>
      )}
    </div>
  );
}

function DisplayPanel({
  display, available, defaults, onChange, builtin, viewName, dirty, onSave, onRevert, canReset, onReset, onAddField, searching, close,
}) {
  const [page, setPage] = useState('main');
  const thumbId = useId();
  const flatId = useId();
  const count = display.fields.filter((k) => available.some((c) => c.key === k)).length;
  // Card size is a grid card's width, a tile row's height and a column's
  // width; a list row is one height. Fit and Fill are a grid card's: a tile
  // is its picture's own shape, and a row's picture is a thumbnail.
  const cards = display.layout !== 'list';
  if (page === 'fields') {
    return (
      <FieldsPage
        available={available}
        fields={display.fields}
        defaults={defaults.fields}
        onChange={(fields) => onChange({ fields })}
        onBack={() => setPage('main')}
        onAddField={onAddField ? () => { close(); onAddField(); } : undefined}
      />
    );
  }
  return (
    <>
      <Segmented label="Layout" options={LAYOUTS} value={display.layout} onChange={(layout) => onChange({ layout })} />
      <h3 className="display-heading">Display preferences</h3>
      <div className="display-row">
        <span id={`${thumbId}-m`}>Metadata</span>
        <button type="button" className="display-select" aria-describedby={`${thumbId}-m`} onClick={() => setPage('fields')}>
          <span>{count === 0 ? 'Names only' : `${count} field${count === 1 ? '' : 's'} selected`}</span>
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
      <div className="display-row">
        <label htmlFor={thumbId}>Thumbnail</label>
        <span className="display-select-wrap">
          <select id={thumbId} className="display-select" value={display.thumb} disabled={display.layout !== 'grid'} onChange={(e) => onChange({ thumb: e.target.value })}>
            <option value="fill">Fill</option>
            <option value="fit">Fit</option>
          </select>
          <Icon name="chevron-down" size={14} />
        </span>
      </div>
      <div className="display-row">
        <span>Card size</span>
        <Segmented label="Card size" options={SIZES} value={display.size} onChange={(size) => onChange({ size })} small disabled={!cards} />
      </div>
      <div className="display-row">
        <label htmlFor={flatId}>Flatten directories</label>
        <input
          id={flatId}
          type="checkbox"
          role="switch"
          className="switch"
          checked={display.flatten && display.layout !== 'column'}
          disabled={display.layout === 'column'}
          aria-checked={display.flatten && display.layout !== 'column'}
          onChange={(e) => onChange({ flatten: e.target.checked })}
        />
      </div>
      {(display.layout === 'column' || searching) && (
        <p className="display-note small muted">
          {display.layout === 'column' ? 'Columns show one folder at a time.' : 'A search looks in every folder below this one.'}
        </p>
      )}
      <div className="display-foot">
        {builtin ? (
          <>
            <span className="small muted">{viewName}: kept in this browser</span>
            <div className="spacer" />
            {canReset && <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>Reset</button>}
          </>
        ) : dirty ? (
          <>
            <span className="small muted">Changed from “{viewName}”</span>
            <div className="spacer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRevert}>Revert</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onSave}>Save to view</button>
          </>
        ) : (
          <span className="small muted">Saved in “{viewName}”</span>
        )}
      </div>
    </>
  );
}

export default function DisplayPopover(props) {
  return (
    <Popover
      label="Display"
      buttonClassName={`btn tb-btn${props.dirty ? ' is-dirty' : ''}`}
      className="display-pop"
      trigger={(
        <>
          <Icon name="layout-grid" size={16} />
          <span className="tb-label">Display</span>
        </>
      )}
    >
      {({ close }) => <DisplayPanel {...props} close={close} />}
    </Popover>
  );
}
