'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Thumb, fmtSize } from './FileCard';
import { rowWindow } from '@/lib/virtual-rows';
import { LIST_COLUMNS, columnOf, nextSortFor, columnTemplate, fitColumns } from '@/lib/list-columns';
import { deriveAuto } from '@/lib/dam';

/**
 * The library as a list: one row per file, a Name column, and whichever
 * other columns the viewer picked (lib/list-columns.js) — facts about the
 * file, tags, and the workspace's metadata fields. The same collection as
 * FileGrid with the same rules, so the two stay interchangeable:
 *
 *   click      select (toggles, so several can be picked)
 *   dbl-click  open
 *   ↑ ↓        previous / next row
 *   Home End   first / last
 *   Space      select
 *   Enter      open
 *
 * Tags and metadata cells are editable in place for someone who may write:
 * click one (or Tab to it and press Enter) to edit, Enter or clicking away
 * saves, Escape cancels. `onEdit(file, column, value)` does the saving.
 *
 * Rows carry data-file-id, so the page's context menu and drag-to-folder
 * work on them exactly as on cards.
 *
 * Virtualized the way the grid is: the page is the scroller, only the rows
 * near the viewport are mounted, and the row height is read back from the
 * stylesheet rather than assumed.
 *
 * Sorting is the server's (see lib/list-columns.js); a header click asks the
 * page for a new sort and the listing reloads in that order. Columns the
 * server cannot order by have a plain label instead of a button.
 *
 * `before` renders between the header and the files — the page puts the open
 * folder's subfolders there. As a function it is handed the columns on
 * screen, so its rows can line up with them.
 */
const OVERSCAN_ROWS = 8;
const NAME = LIST_COLUMNS[0];

// A phone gets a smaller thumbnail, a narrower name and tighter gaps (the
// stylesheet's phone breakpoint), so its columns are fitted with those.
const NARROW_QUERY = '(max-width: 720px)';
const NARROW_LAYOUT = { thumb: 40, nameMin: 120, gap: 8 };
// The picker's slot at the end of the row, and its width when it also has to
// say how many chosen columns are waiting for room.
const TRAILING = 28;
const TRAILING_WITH_COUNT = 52;

const dateFmt = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
  : null;
const timeFmt = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
  : null;

function When({ at }) {
  if (!at || !dateFmt) return <span className="muted">—</span>;
  const d = new Date(Number(at));
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()}>
      {dateFmt.format(d)}<span className="filelist-time"> {timeFmt.format(d)}</span>
    </time>
  );
}

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return narrow;
}

function SortButton({ col, sort, onSort }) {
  const active = columnOf(sort);
  const on = active?.key === col.key;
  const dir = on ? active.dir : null;
  const next = nextSortFor(col.key, sort) === col.asc ? 'ascending' : 'descending';
  return (
    <button
      type="button"
      className={`filelist-sort${on ? ' active' : ''}`}
      aria-pressed={on}
      aria-label={`${col.label}${on ? `, sorted ${dir === 'asc' ? 'ascending' : 'descending'}` : ''}. Sort ${next}.`}
      onClick={() => onSort?.(nextSortFor(col.key, sort))}
    >
      <span className="truncate">{col.label}</span>
      <span className="filelist-arrow" aria-hidden>{on ? (dir === 'asc' ? '↑' : '↓') : ''}</span>
    </button>
  );
}

export function FileListHeader({ sort, onSort, columns = [], picker = null }) {
  return (
    <div className="filelist-head filelist-cols">
      <span aria-hidden />
      <SortButton col={NAME} sort={sort} onSort={onSort} />
      {columns.map((c) => (c.asc
        ? <SortButton key={c.key} col={c} sort={sort} onSort={onSort} />
        : <span key={c.key} className="filelist-label truncate" title={c.label}>{c.label}</span>))}
      <span className="filelist-colpick">{picker}</span>
    </div>
  );
}

export default function FileList({
  files,
  selected,
  onSelect,
  onOpen,
  badgesFor,
  labelFor,
  emptyState,
  label = 'Files',
  onMissingThumb,
  onDragFile,
  sort,
  onSort,
  before = null,
  columns = [],
  picker = null,
  loading = false,
  canEdit = false,
  onEdit,
  suggestionsFor,
  onOpenFolder,
  usageRights = false,
}) {
  const outer = useRef(null);
  const ref = useRef(null);
  const cells = useRef([]);
  const pendingFocus = useRef(null);
  const [active, setActive] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });
  // The one cell being edited, as `${fileId}\0${columnKey}`: opening another
  // closes this one, and its row stops being draggable, which would
  // otherwise turn a text selection in the field into a file drag.
  const [editing, setEditing] = useState(null);
  const narrow = useNarrow();

  // The list's own width, so the columns can be fitted to it (fitColumns in
  // lib/list-columns.js). A callback ref, because the element comes and goes
  // with the loading and empty states; set during commit, before paint. React
  // calls it with null on unmount, which is the one place to disconnect — an
  // effect cleanup would also run in Strict Mode's rehearsal unmount and
  // leave the list measuring nothing from then on.
  const [width, setWidth] = useState(0);
  const resize = useRef(null);
  const measureWidth = useCallback((el) => {
    resize.current?.disconnect();
    resize.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    resize.current = new ResizeObserver(() => setWidth(el.clientWidth));
    resize.current.observe(el);
  }, []);

  const layout = narrow ? NARROW_LAYOUT : {};
  let trailing = TRAILING;
  let shown = fitColumns(columns, width, { ...layout, trailing });
  if (shown.length < columns.length) {
    trailing = TRAILING_WITH_COUNT;
    shown = fitColumns(columns, width, { ...layout, trailing });
  }
  const waiting = columns.slice(shown.length).map((c) => c.key);
  const style = { '--filelist-cols': columnTemplate(shown, { ...layout, trailing }) };
  const pickerEl = typeof picker === 'function' ? picker(waiting) : picker;

  useEffect(() => {
    setActive((i) => Math.min(Math.max(0, i), Math.max(0, files.length - 1)));
  }, [files.length]);

  // One row's height, from the first mounted row. Every row is the same
  // height by construction (one line, fixed thumbnail), which is what makes a
  // fixed pitch safe.
  const measure = useCallback(() => {
    const row = ref.current?.firstElementChild;
    const h = row ? row.getBoundingClientRect().height : 48;
    setPitch((p) => (Math.abs(p - h) < 0.5 ? p : Math.max(1, h)));
  }, []);

  const updateRange = useCallback(() => {
    const el = outer.current;
    if (!el || !pitch) return;
    const { start, end } = rowWindow({
      top: el.getBoundingClientRect().top,
      viewport: window.innerHeight,
      pitch,
      rowCount: files.length,
      overscan: OVERSCAN_ROWS,
    });
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [pitch, files.length]);

  useLayoutEffect(() => { measure(); }, [measure, files.length]);
  useLayoutEffect(() => { updateRange(); }, [updateRange]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; updateRange(); });
    };
    const ro = new ResizeObserver(() => { measure(); onScroll(); });
    if (outer.current) ro.observe(outer.current);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [measure, updateRange]);

  useEffect(() => {
    const i = pendingFocus.current;
    if (i == null) return;
    const el = cells.current[i];
    if (!el) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  });

  const focusRow = useCallback((i) => {
    const next = Math.min(Math.max(0, i), files.length - 1);
    setActive(next);
    pendingFocus.current = next;
    const el = cells.current[next];
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    } else if (outer.current && pitch) {
      const top = outer.current.getBoundingClientRect().top + window.scrollY + next * pitch;
      const bottom = top + pitch;
      if (top < window.scrollY) window.scrollTo(0, top);
      else if (bottom > window.scrollY + window.innerHeight) window.scrollTo(0, bottom - window.innerHeight);
    }
  }, [files.length, pitch]);

  const onKeyDown = useCallback((e, index) => {
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    // A shortcut, not a move: ⌘↑ is "up to the enclosing folder".
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: files.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      focusRow(moves[e.key]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen?.(files[index]);
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      onSelect?.(files[index]);
    }
  }, [files, focusRow, onOpen, onSelect]);

  const head = <FileListHeader sort={sort} onSort={onSort} columns={shown} picker={pickerEl} />;
  if (loading) {
    return (
      <div className="filelist" style={style} ref={measureWidth}>
        {head}
        <div className="empty">Loading…</div>
      </div>
    );
  }

  const beforeEl = typeof before === 'function' ? before(shown) : before;
  if (!files.length && !beforeEl) return emptyState || null;

  const first = range.start;
  const last = Math.min(files.length, range.end);
  const tabbable = active >= first && active < last ? active : first;
  const ctx = { labelFor, canEdit, onEdit, suggestionsFor, onOpenFolder, usageRights, editing, setEditing };

  return (
    <div className="filelist" style={style} ref={measureWidth}>
      {head}
      {beforeEl}
      {files.length === 0 ? emptyState : (
        <div ref={outer} className="filelist-body" style={{ position: 'relative', height: files.length * pitch || undefined }}>
          <div
            role="listbox"
            aria-label={label}
            aria-multiselectable="true"
            ref={ref}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${first * pitch}px)` }}
          >
            {files.slice(first, Math.max(last, first + 1)).map((f, n) => {
              const i = first + n;
              const isSel = selected?.has(f.id) || false;
              const type = labelFor?.(f) || f.kind || '';
              const rowEditing = !!editing && editing.startsWith(`${f.id}\u0000`);
              return (
                <div
                  key={f.id}
                  role="option"
                  aria-selected={isSel}
                  data-file-id={f.id}
                  className={`filelist-row filelist-cols${isSel ? ' is-selected' : ''}${rowEditing ? ' is-editing' : ''}`}
                  tabIndex={i === tabbable ? 0 : -1}
                  ref={(el) => { cells.current[i] = el; }}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  onClick={() => { setActive(i); onSelect?.(f); }}
                  onDoubleClick={() => onOpen?.(f)}
                  draggable={!!onDragFile && !rowEditing}
                  onDragStart={onDragFile ? (e) => onDragFile(f, e) : undefined}
                >
                  <span className="filelist-thumb">
                    <Thumb file={f} label={type} onMissingThumb={onMissingThumb} />
                  </span>
                  <span className="filelist-name">
                    <span className="truncate" title={f.name}>{f.name}</span>
                    {badgesFor?.(f)}
                  </span>
                  {shown.map((c) => <Cell key={c.key} file={f} col={c} ctx={ctx} tabbable={i === tabbable} />)}
                  <span aria-hidden />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cells ────────────────────────────────────────────────────────────────────

function Cell({ file, col, ctx, tabbable }) {
  if (col.edit) return <EditableCell file={file} col={col} ctx={ctx} tabbable={tabbable} />;
  const md = file.metadata || {};
  switch (col.key) {
    case 'size':
      return <span className="filelist-cell filelist-num muted">{fmtSize(file.size) || '—'}</span>;
    case 'type': {
      const type = ctx.labelFor?.(file) || file.kind || '';
      return <span className="filelist-cell muted truncate" title={file.mime || undefined}>{type || '—'}</span>;
    }
    case 'modified':
      return <span className="filelist-cell filelist-date muted"><When at={file.updatedAt} /></span>;
    case 'added':
      return <span className="filelist-cell filelist-date muted"><When at={file.createdAt} /></span>;
    case 'added_by':
      return <span className="filelist-cell muted truncate" title={file.createdBy || undefined}>{file.createdBy || '—'}</span>;
    case 'dimensions':
      return <span className="filelist-cell filelist-num muted">{md.width && md.height ? `${md.width} × ${md.height}` : '—'}</span>;
    case 'aspect_ratio':
      return <span className="filelist-cell filelist-num muted">{deriveAuto(file).aspect_ratio || '—'}</span>;
    case 'folder': {
      const where = file.folder || 'All files';
      if (!ctx.onOpenFolder) return <span className="filelist-cell muted truncate" title={where}>{where}</span>;
      return (
        <span className="filelist-cell">
          <button
            type="button"
            className="filelist-link truncate"
            tabIndex={tabbable ? 0 : -1}
            title={`Open ${where}`}
            onClick={(e) => { e.stopPropagation(); ctx.onOpenFolder(file.folder || ''); }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {where}
          </button>
        </span>
      );
    }
    default:
      return <span className="filelist-cell" />;
  }
}

const isMulti = (col) => col.edit === 'tags' || col.edit === 'multiselect';

function cellValue(file, col) {
  if (col.key === 'tags') return file.tags || [];
  return col.field ? file.metadata?.[col.field.key] : undefined;
}

const canon = (v) => {
  if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return null;
  return Array.isArray(v) ? v.map(String) : String(v);
};
const sameValue = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const textOf = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

/** 'YYYY-MM-DD' as a local calendar day — not midnight UTC, which is the day before west of Greenwich. */
function localDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const SOON_MS = 30 * 24 * 60 * 60 * 1000;

function CellValue({ value, col, usageRights }) {
  if (canon(value) == null) return <span className="cell-empty">—</span>;
  if (isMulti(col)) {
    const list = Array.isArray(value) ? value : [value];
    return (
      <span className="cell-chips">
        {list.map((v) => <span key={v} className="tag">{v}</span>)}
      </span>
    );
  }
  if (col.edit === 'date') {
    const day = localDay(value);
    if (!day || !dateFmt) return <span className="truncate">{String(value)}</span>;
    // The list's reading of the usage-rights rule in lib/dam.js expiryState:
    // an expiry date that has passed, or is within thirty days.
    let state = '';
    if (usageRights && /expir/i.test(col.field?.key || '')) {
      const t = day.getTime();
      if (t < Date.now()) state = ' is-expired';
      else if (t - Date.now() < SOON_MS) state = ' is-soon';
    }
    return <span className={`cell-date${state}`}>{dateFmt.format(day)}</span>;
  }
  return <span className="truncate">{String(value)}</span>;
}

function EditableCell({ file, col, ctx, tabbable }) {
  const value = cellValue(file, col);
  const id = `${file.id}\u0000${col.key}`;
  const editing = ctx.editing === id;
  const button = useRef(null);
  const refocus = useRef(false);

  // Back to the cell after a keyboard Enter or Escape, so the next Tab or
  // arrow carries on from here rather than from the top of the page.
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      button.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  const display = <CellValue value={value} col={col} usageRights={ctx.usageRights} />;
  if (!ctx.canEdit) return <span className="filelist-cell">{display}</span>;

  if (editing) {
    const done = (next, viaKey) => {
      refocus.current = !!viaKey;
      ctx.setEditing(null);
      if (next !== undefined && !sameValue(next, value)) ctx.onEdit?.(file, col, next);
    };
    const Editor = isMulti(col) ? MultiEditor : SingleEditor;
    return (
      <span className="filelist-cell is-editing">
        <Editor col={col} value={value} suggestions={ctx.suggestionsFor?.(col) || []} onDone={done} />
      </span>
    );
  }

  const start = (e) => { e.stopPropagation(); ctx.setEditing(id); };
  return (
    <span className="filelist-cell">
      <button
        ref={button}
        type="button"
        className="cell-edit"
        tabIndex={tabbable ? 0 : -1}
        onClick={start}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') { e.preventDefault(); start(e); }
        }}
        aria-label={`${col.label}: ${textOf(value) || 'empty'}. Edit`}
        title={`Edit ${col.label}`}
      >
        {display}
      </button>
    </span>
  );
}

// Keep a click or key inside an editor from reaching the row, where it would
// select, open or drag the file.
const stop = (e) => e.stopPropagation();

/** Text, date and single-choice fields: a control in the cell itself. */
function SingleEditor({ col, value, suggestions, onDone }) {
  const ref = useRef(null);
  const settled = useRef(false);
  const listId = useId();
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const type = col.edit;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (type === 'text') el.select();
  }, [type]);

  const finish = (commit, viaKey, raw = draft) => {
    if (settled.current) return;
    settled.current = true;
    const v = String(raw || '').trim();
    onDone(commit ? (v || null) : undefined, viaKey);
  };

  const common = {
    ref,
    className: 'input cell-input',
    'aria-label': col.label,
    onClick: stop,
    onDoubleClick: stop,
    onPointerDown: stop,
    onBlur: (e) => finish(true, false, e.currentTarget.value),
    onKeyDown: (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true, true, e.currentTarget.value); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
    },
  };

  if (type === 'select') {
    const options = [...new Set([...(col.field?.options || []), ...suggestions, ...(draft ? [draft] : [])])];
    return (
      <select {...common} value={draft} onChange={(e) => { setDraft(e.target.value); finish(true, true, e.target.value); }}>
        <option value="">—</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (type === 'date') {
    return <input {...common} type="date" value={draft.slice(0, 10)} onChange={(e) => setDraft(e.target.value)} />;
  }
  return (
    <>
      <input {...common} type="text" value={draft} onChange={(e) => setDraft(e.target.value)} list={suggestions.length ? listId : undefined} autoComplete="off" />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.slice(0, 50).map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </>
  );
}

/**
 * Tags and multi-value fields: a small panel over the cell with a field to
 * add a value and a checklist of the values already in use, the file's own
 * ticked and first. Done, Enter in an empty field or clicking away saves;
 * Escape or Cancel leaves the file as it was.
 */
function MultiEditor({ col, value, suggestions, onDone }) {
  const isTags = col.edit === 'tags';
  // Tags are stored lowercased (normalizeTags in lib/db.js); showing them
  // that way here means what is ticked is what will be saved.
  const norm = useCallback((s) => (isTags ? String(s).trim().toLowerCase() : String(s).trim()), [isTags]);
  const [picked, setPicked] = useState(() => (Array.isArray(value) ? value.map(String) : value ? [String(value)] : []));
  const [text, setText] = useState('');
  const [place, setPlace] = useState({ up: false, dx: 0 });
  const box = useRef(null);
  const input = useRef(null);
  const settled = useRef(false);
  const latest = useRef(picked);
  latest.current = picked;

  const finish = useCallback((commit, viaKey) => {
    if (settled.current) return;
    settled.current = true;
    onDone(commit ? latest.current : undefined, viaKey);
  }, [onDone]);

  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);

  // Open upward when there is no room below — a row near the bottom of the
  // window would otherwise put the checklist off screen — and slide left
  // when the column is the last one, near the window's right edge.
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom > window.innerHeight - 8 && r.top - r.height > 8;
    const dx = r.right > window.innerWidth - 8 ? Math.round(window.innerWidth - 8 - r.right) : 0;
    if (up || dx) setPlace({ up, dx });
  }, []);

  useEffect(() => {
    const onDown = (e) => { if (!box.current?.contains(e.target)) finish(true, false); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [finish]);

  const toggle = (v) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const add = (raw) => {
    const v = norm(raw);
    if (!v) return;
    setPicked((p) => (p.includes(v) ? p : [...p, v]));
    setText('');
  };

  const known = [...new Set([...picked, ...(col.field?.options || []), ...suggestions.map(String)])];
  const q = text.trim().toLowerCase();
  const list = known
    .filter((v) => !q || v.toLowerCase().includes(q))
    .sort((a, b) => Number(picked.includes(b)) - Number(picked.includes(a)));
  const exact = known.some((v) => v.toLowerCase() === norm(text).toLowerCase());

  return (
    <div
      ref={box}
      className={`cell-pop${place.up ? ' is-up' : ''}`}
      style={place.dx ? { transform: `translateX(${place.dx}px)` } : undefined}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
      }}
    >
      <input
        ref={input}
        className="input cell-input"
        value={text}
        placeholder={isTags ? 'Add a tag…' : `Add to ${col.label}…`}
        aria-label={`Add to ${col.label}`}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // The field's own value, not `text`: a key that lands before the
          // previous keystroke's render would otherwise see the old one.
          const typed = e.currentTarget.value;
          if (e.key === 'Enter') {
            e.preventDefault();
            if (typed.trim()) add(typed);
            else finish(true, true);
          } else if (e.key === 'Backspace' && !typed && picked.length) {
            setPicked((p) => p.slice(0, -1));
          }
        }}
      />
      <div className="cell-pop-list" role="group" aria-label={col.label}>
        {list.map((v) => (
          <label key={v} className="cell-pop-row">
            <input type="checkbox" checked={picked.includes(v)} onChange={() => toggle(v)} />
            <span className="truncate">{v}</span>
          </label>
        ))}
        {text.trim() && !exact && (
          <button type="button" className="cell-pop-add" onClick={() => { add(text); input.current?.focus(); }}>
            Add “{norm(text)}”
          </button>
        )}
        {!list.length && !text.trim() && <p className="small muted cell-pop-empty">Type to add one.</p>}
      </div>
      <div className="cell-pop-foot">
        <span className="small muted">{picked.length ? `${picked.length} chosen` : 'None'}</span>
        <div className="spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => finish(false, true)}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => finish(true, true)}>Done</button>
      </div>
    </div>
  );
}
