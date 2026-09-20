'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Panel, Field } from '@/app/components/ui/Layout';
import { useToast } from '@/app/components/ui/Toast';
import { expiryState, normalizeSchema } from '@/lib/dam';

/**
 * The per-file metadata editor.
 *
 * Which fields exist is admin-configurable, so nothing here names one: the
 * form is built from schema.fields and the only thing this component knows
 * about a field is its type. Adding a field in Admin has to be enough to make
 * it appear here.
 *
 * Read-only when the caller cannot write, rather than absent — seeing an
 * asset's provenance and rights is not a privilege, changing them is. (The
 * People panel hides itself instead, but only because its API is owner-only
 * and the editor would 403 the moment it loaded.)
 */

/**
 * Stored value → the yyyy-mm-dd an <input type="date"> demands.
 *
 * UTC throughout, deliberately: Date parses 'yyyy-mm-dd' as UTC midnight, so
 * reading it back with the local getters returns the previous day anywhere
 * west of Greenwich — an off-by-one that only ever shows up for half the
 * world. Epoch milliseconds are accepted on the way in because the rest of
 * this API thinks in timestamps and something may well have written one.
 */
function toDateInput(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (!/^-?\d+$/.test(s)) return ''; // unparseable: show nothing rather than a guess
  const d = new Date(Number(s));
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * The other direction is deliberately the identity: we store the yyyy-mm-dd
 * string itself, not a timestamp.
 *
 * Dates elsewhere in this API are epoch milliseconds, so sending one here is
 * the obvious move and it is wrong. validateMetadataPatch coerces every
 * non-multiselect value with String(), so 1769817600000 lands in the JSONB as
 * the *string* "1769817600000"; expiryState then runs new Date(raw).getTime()
 * over that, gets NaN and skips the field — a usage right that quietly never
 * expires. 'yyyy-mm-dd' survives both that coercion and the .slice(0, 10) the
 * facet rail applies to date values.
 */
const fromDateInput = (s) => s;

/** A field's value in draft shape: string[] for multiselect, string otherwise. */
const pick = (state, f) => {
  const v = state[f.key];
  if (f.type === 'multiselect') return Array.isArray(v) ? v : [];
  return v == null ? '' : v;
};

const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : String(v ?? '').trim() === '');

const sameValue = (a, b) => (Array.isArray(a) || Array.isArray(b)
  ? Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
  : a === b);

/** Stored metadata → the editor's draft shape, coerced the way dam.js reads it. */
function toDraft(metadata, fields) {
  const md = metadata && typeof metadata === 'object' ? metadata : {};
  const out = {};
  for (const f of fields) {
    const v = md[f.key];
    if (f.type === 'multiselect') {
      out[f.key] = Array.isArray(v) ? v.map(String).filter(Boolean) : (v == null || v === '' ? [] : [String(v)]);
    } else if (f.type === 'date') {
      out[f.key] = toDateInput(v);
    } else {
      out[f.key] = v == null ? '' : String(v);
    }
  }
  return out;
}

/** Ungrouped fields first, then each group in the order the schema introduces it. */
function groupFields(fields) {
  const groups = [];
  const byName = new Map();
  for (const f of fields) {
    const name = f.group || '';
    if (!byName.has(name)) {
      const g = { name, fields: [] };
      byName.set(name, g);
      groups.push(g);
    }
    byName.get(name).fields.push(f);
  }
  return groups.sort((a, b) => (a.name ? 1 : 0) - (b.name ? 1 : 0));
}

/**
 * Fold an add-box's text into a chip list. Split on commas only — unlike the
 * People panel, which also splits on whitespace: emails and role ids never
 * contain a space, but “Spring Campaign” does, and shredding it into two
 * values is worse than making someone type a comma.
 */
function mergeChips(values, text) {
  const next = [...values];
  for (const part of String(text).split(',').map((s) => s.trim()).filter(Boolean)) {
    // Exact match, no case folding: validateMetadataPatch dedupes with a Set
    // over the raw strings, so anything cleverer here would disagree with the
    // values that actually get stored and counted in the facet rail.
    if (!next.includes(part)) next.push(part);
  }
  return next;
}

export default function MetadataPanel({ fileId, schema, metadata, canWrite, onSaved }) {
  const toast = useToast();
  const uid = useId();

  // Normalized here as well as on the server: this panel takes whatever the
  // page had, and a schema straight out of settings can carry duplicate keys
  // or a type nothing renders. normalizeSchema is stable once applied, so the
  // second pass costs nothing and the render below never has to be defensive.
  const fields = useMemo(() => normalizeSchema(schema).fields, [schema]);
  const groups = useMemo(() => groupFields(fields), [fields]);

  const [base, setBase] = useState(() => toDraft(metadata, fields));
  const [draft, setDraft] = useState(base);
  // Text typed into a multiselect's add box but not yet committed to a chip.
  const [adding, setAdding] = useState({});
  const [saving, setSaving] = useState(false);

  // Re-seed only when the panel is pointed at a different file. Deliberately
  // NOT whenever `metadata` changes: the parent re-renders on router.refresh()
  // after any sibling panel saves, and rebasing there would wipe an edit in
  // progress under the person typing it. The ref guard is what makes the
  // dependency list harmless — extra runs do nothing.
  const seeded = useRef(fileId);
  useEffect(() => {
    if (seeded.current === fileId) return;
    seeded.current = fileId;
    const next = toDraft(metadata, fields);
    setBase(next);
    setDraft(next);
    setAdding({});
  }, [fileId, metadata, fields]);

  const changed = useMemo(
    () => fields.filter((f) => !sameValue(pick(draft, f), pick(base, f))),
    [fields, draft, base],
  );
  // An uncommitted chip counts as a change, or Save sits disabled over a value
  // the person has already typed with no way to press it.
  const uncommitted = Object.values(adding).some((t) => String(t || '').trim());
  const dirty = changed.length > 0 || uncommitted;

  // The same verdict the grid shows, over the draft rather than the saved
  // values so a date just picked is reflected before it is saved. Via
  // expiryState so the 30-day window is not copied into a second place.
  const expiry = useMemo(() => expiryState({ metadata: draft }, { fields }), [draft, fields]);

  const setField = useCallback((key, value) => setDraft((d) => ({ ...d, [key]: value })), []);

  const commitChips = useCallback((f, text) => {
    if (!String(text).trim()) {
      setAdding((a) => ({ ...a, [f.key]: '' }));
      return;
    }
    setDraft((d) => ({ ...d, [f.key]: mergeChips(pick(d, f), text) }));
    setAdding((a) => ({ ...a, [f.key]: '' }));
  }, []);

  const discard = useCallback(() => {
    setDraft(base);
    setAdding({});
  }, [base]);

  const save = useCallback(async () => {
    // Fold every half-typed chip in first — pressing Save plainly means "keep
    // what I typed", including the value still sitting in an add box.
    let next = draft;
    for (const f of fields) {
      if (f.type !== 'multiselect') continue;
      const text = String(adding[f.key] || '').trim();
      if (text) next = { ...next, [f.key]: mergeChips(pick(next, f), text) };
    }
    if (next !== draft) {
      setDraft(next);
      setAdding({});
    }

    const keys = fields.filter((f) => !sameValue(pick(next, f), pick(base, f)));
    if (!keys.length) return;

    const patch = {};
    for (const f of keys) patch[f.key] = f.type === 'date' ? fromDateInput(pick(next, f)) : pick(next, f);

    // Emptied fields will not survive the round trip: validateMetadataPatch
    // skips empty values and updateFile merges, so there is currently no way
    // to clear a field from here. Send them anyway — the rebase below then
    // shows what is really stored — and name them afterwards instead of
    // reporting a clean success.
    const refused = keys.filter((f) => isEmpty(patch[f.key]));

    setSaving(true);
    try {
      const r = await fetch(`/api/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // Only the changed keys. That is new: as of today updateFile MERGES
        // the metadata jsonb (`||`). It used to replace the column, which is
        // what a reader who knows this code will expect — under the old
        // behaviour a partial patch silently deleted width/height and took the
        // aspect-ratio facet with it, so an editor had to send the whole
        // object back every time. Sending it whole now would be worse than
        // redundant: it would stamp on anything the bulk editor or the tagger
        // merged in while this form was open.
        body: JSON.stringify({ metadata: patch }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Could not save metadata (${r.status}).`);
      if (!out.file) throw new Error('The file was not updated — it may have been deleted.');

      // Rebase on what came back, not on what was sent. The server drops keys
      // it will not store, and the only honest thing the form can show is the
      // row as it now exists. Inputs are disabled while saving, so nothing
      // typed in the meantime is lost to this.
      const stored = toDraft(out.file.metadata, fields);
      setBase(stored);
      setDraft(stored);

      if (!refused.length) {
        toast.success('Metadata saved.');
      } else {
        // An error toast, not a success: this one must not auto-dismiss,
        // because the field on screen has just snapped back to its old value
        // and a message that vanishes first leaves that looking like a bug.
        const names = refused.map((f) => f.label).join(', ');
        const saved = keys.length - refused.length;
        toast.error(
          `${saved ? 'Saved. ' : ''}${names} could not be emptied — clearing a field is not supported yet, so the old `
          + `${refused.length > 1 ? 'values are' : 'value is'} still stored.`,
        );
      }
      onSaved?.(out.file);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }, [fileId, fields, draft, base, adding, toast, onSaved]);

  const badge = expiry === 'expired'
    ? <span className="tag tag-danger">Rights expired</span>
    : expiry === 'soon' ? <span className="tag tag-warning">Expiring soon</span> : null;

  if (!fields.length) {
    return (
      <Panel title="Metadata">
        <p className="muted small" style={{ margin: 0 }}>No metadata fields are defined.</p>
      </Panel>
    );
  }

  if (!canWrite) {
    const blank = fields.every((f) => isEmpty(pick(draft, f)));
    return (
      <Panel title="Metadata" actions={badge}>
        {blank
          ? <p className="muted small" style={{ margin: 0 }}>Nothing recorded yet.</p>
          : groups.map((g) => (
            <div key={g.name || '_'} className={g.name ? 'meta-group' : undefined}>
              {g.name && <h3 className="meta-group-title">{g.name}</h3>}
              <dl className="detail-list meta-readonly">
                {g.fields.map((f) => (
                  <ReadOnlyRow key={f.key} field={f} value={pick(draft, f)} raw={metadata?.[f.key]} />
                ))}
              </dl>
            </div>
          ))}
      </Panel>
    );
  }

  return (
    <Panel title="Metadata" actions={badge}>
      {groups.map((g) => (
        <div key={g.name || '_'} className={g.name ? 'meta-group' : undefined}>
          {g.name && <h3 className="meta-group-title">{g.name}</h3>}
          {g.fields.map((f) => (
            <FieldControl
              key={f.key}
              id={`${uid}-${f.key}`}
              field={f}
              value={pick(draft, f)}
              disabled={saving}
              draft={adding[f.key] || ''}
              onChange={(v) => setField(f.key, v)}
              onDraft={(t) => setAdding((a) => ({ ...a, [f.key]: t }))}
              onCommit={(t) => commitChips(f, t)}
            />
          ))}
        </div>
      ))}

      <div className="row" style={{ marginTop: 'var(--s4)' }}>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save metadata'}
        </button>
        {dirty && !saving && <button className="btn btn-ghost btn-sm" onClick={discard}>Discard</button>}
      </div>
    </Panel>
  );
}

function FieldControl({ id, field: f, value, draft, disabled, onChange, onDraft, onCommit }) {
  if (f.type === 'multiselect') {
    const listId = f.options?.length ? `${id}-options` : undefined;
    return (
      // Not a <label> wrapping the lot, the way Field does it: a chip's remove
      // button inside a label competes with the label for the click.
      <div style={{ marginBottom: 'var(--s3)' }}>
        <label className="small meta-label" htmlFor={id}>{f.label}</label>
        <Chips values={value} disabled={disabled} onRemove={(v) => onChange(value.filter((x) => x !== v))} />
        <input
          id={id}
          className="input"
          type="text"
          value={draft}
          disabled={disabled}
          autoComplete="off"
          list={listId}
          placeholder="Add a value…"
          onChange={(e) => {
            const v = e.target.value;
            // Typing or pasting a comma is the same gesture as pressing Enter.
            if (v.includes(',')) onCommit(v); else onDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onCommit(draft); }
            else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => { if (draft.trim()) onCommit(draft); }}
        />
        {listId && (
          // Suggestions, not a closed vocabulary: the server never checks a
          // value against field.options, so the box stays free text.
          <datalist id={listId}>
            {f.options.filter((o) => !value.includes(o)).map((o) => <option key={o} value={o} />)}
          </datalist>
        )}
        <div className="muted small" style={{ marginTop: 'var(--s1)' }}>Type a value, then Enter or comma.</div>
      </div>
    );
  }

  if (f.type === 'select') {
    const options = f.options || [];
    // A value stored before the options were edited would render as blank and
    // read as "nothing chosen" while it is still what the file says. Carry it.
    const orphan = value && !options.includes(value) ? value : null;
    return (
      <Field label={f.label}>
        <select className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {orphan && <option value={orphan}>{orphan} (not in the list)</option>}
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
    );
  }

  if (f.type === 'date') {
    return (
      <Field label={f.label}>
        <input className="input" type="date" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }

  // 'text', and anything else. normalizeSchema already folds an unknown type
  // down to text, so this arm is for a schema that reached us un-normalized —
  // or for a type added to dam.js later, which should render as something
  // editable rather than as a hole in the form.
  return (
    <Field label={f.label}>
      <input className="input" type="text" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function Chips({ values, disabled, onRemove }) {
  if (!values.length) return null;
  return (
    <ul className="meta-chips">
      {values.map((v) => (
        <li key={v} className="tag meta-chip">
          <span title={v}>{v}</span>
          <button className="meta-chip-x" disabled={disabled} onClick={() => onRemove(v)} aria-label={`Remove ${v}`}>
            <span aria-hidden>✕</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReadOnlyRow({ field: f, value, raw }) {
  let body;
  if (f.type === 'multiselect') {
    body = value.length
      ? <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{value.map((v) => <span key={v} className="tag">{v}</span>)}</span>
      : '—';
  } else if (f.type === 'date') {
    // Left as yyyy-mm-dd rather than localised: toLocaleDateString renders
    // differently on the server and in the browser, and this panel is
    // server-rendered. `raw` is the fallback for a stored value too odd for
    // toDateInput to read, which is still better shown than hidden.
    body = value || (raw ? String(raw) : '—');
  } else {
    body = value || '—';
  }
  return (
    <>
      <dt className="small muted">{f.label}</dt>
      <dd className="small" style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{body}</dd>
    </>
  );
}
