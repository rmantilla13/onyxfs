'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import Icon from '@/app/components/ui/Icon';
import { KINDS, LIMITS, metaKey, opsFor } from '@/lib/collections';

const KIND_LABELS = { image: 'Images', video: 'Videos', audio: 'Audio', doc: 'Documents', other: 'Other' };
const OP_LABELS = {
  any: 'is any of', none: 'is none of', set: 'is set', unset: 'is not set', before: 'is before', after: 'is after',
};
const TAG_OP_LABELS = { set: 'has any tag', unset: 'has no tags' };
const takesValues = (op) => op === 'any' || op === 'none';
const takesDay = (op) => op === 'before' || op === 'after';

const blankRule = () => ({ field: 'tag', op: 'any', values: [] });

/**
 * Make or change a collection (lib/collections.js): a name, whether files
 * must meet every rule or any one, and the rules. `collection` is the one
 * being changed, or null for a new one in `driveId` ('' for All Files).
 * `schema` is the workspace's metadata fields, which become rule fields.
 *
 * `onSave(body)` resolves an error message, or null when it saved. Deleting
 * goes through `onDelete`, after a confirm the caller owns.
 */
export default function CollectionEditor({ open, collection = null, driveName = '', schema, onClose, onSave, onDelete }) {
  const [name, setName] = useState('');
  const [match, setMatch] = useState('all');
  const [rules, setRules] = useState([blankRule()]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const nameRef = useRef(null);
  const fields = schema?.fields || [];

  useEffect(() => {
    if (!open) return;
    setName(collection?.name || '');
    setMatch(collection?.match || 'all');
    setRules(collection?.rules?.length ? collection.rules.map((r) => ({ ...r, values: [...r.values] })) : [blankRule()]);
    setError(null);
    setBusy(false);
    nameRef.current?.focus();
  }, [open, collection]);

  const change = (i, patch) => {
    setError(null);
    setRules((rs) => rs.map((r, j) => {
      if (j !== i) return r;
      const next = { ...r, ...patch };
      // A new field starts over: its operators and values are its own.
      if (patch.field && patch.field !== r.field) return { field: patch.field, op: 'any', values: [] };
      if (patch.op && !takesValues(patch.op) && !takesDay(patch.op)) next.values = [];
      if (patch.op && takesDay(patch.op) !== takesDay(r.op)) next.values = [];
      return next;
    }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) { setError('Give the collection a name.'); return; }
    const missing = rules.findIndex((r) => (takesValues(r.op) || takesDay(r.op)) && !r.values.length);
    if (missing !== -1) { setError(`Rule ${missing + 1} needs ${takesDay(rules[missing].op) ? 'a day' : 'a value'}.`); return; }
    setBusy(true);
    const problem = await onSave({ name: name.trim(), match, rules });
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={false}
      onEscape={onClose}
      wide
      title={collection ? `Edit “${collection.name}”` : 'New collection'}
      footer={(
        <>
          {collection && onDelete && (
            <button type="button" className="btn btn-danger collection-delete" onClick={onDelete} disabled={busy}>Delete</button>
          )}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : collection ? 'Save' : 'Make collection'}
          </button>
        </>
      )}
    >
      <form id={id} className="stack collection-editor" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>
          Every file {driveName ? `in ${driveName}` : 'you can see'} that meets these rules, kept up to date as files
          and folders change. A folder’s tags and metadata count for the files inside it. Everyone who can open
          {driveName ? ' the drive' : ' All files'} sees the collection, and only the files they could already open.
        </p>
        <label className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="small">Name</span>
          <input ref={nameRef} className="input" value={name} maxLength={LIMITS.name} placeholder="Spring launch"
            onChange={(e) => { setName(e.target.value); setError(null); }} />
        </label>

        <div className="collection-match small">
          Files that meet
          <select className="input" value={match} onChange={(e) => setMatch(e.target.value)} aria-label="Which rules">
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          of these rules:
        </div>

        <ol className="collection-rules">
          {rules.map((r, i) => (
            <li key={i} className="collection-rule">
              <select className="input" value={r.field} aria-label={`Rule ${i + 1} field`} onChange={(e) => change(i, { field: e.target.value })}>
                <option value="kind">Kind</option>
                <option value="tag">Tag</option>
                {fields.length > 0 && (
                  <optgroup label="Metadata">
                    {fields.map((f) => <option key={f.key} value={`meta:${f.key}`}>{f.label}</option>)}
                  </optgroup>
                )}
              </select>
              <select className="input" value={r.op} aria-label={`Rule ${i + 1} test`} onChange={(e) => change(i, { op: e.target.value })}>
                {opsFor(r.field, schema).map((op) => (
                  <option key={op} value={op}>{(r.field === 'tag' && TAG_OP_LABELS[op]) || OP_LABELS[op]}</option>
                ))}
              </select>
              <RuleValues rule={r} schema={schema} onChange={(values) => change(i, { values })} index={i} />
              <button type="button" className="btn btn-ghost btn-sm collection-rule-remove" disabled={rules.length === 1}
                aria-label={`Remove rule ${i + 1}`} title="Remove rule"
                onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ol>
        {rules.length < LIMITS.rules && (
          <button type="button" className="btn btn-sm collection-add-rule" onClick={() => setRules((rs) => [...rs, blankRule()])}>
            <Icon name="plus" size={14} /> Add rule
          </button>
        )}
        {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
      </form>
    </Dialog>
  );
}

const splitValues = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** A rule's values: kinds and listed choices as toggles, a day as a date, the rest as words. */
function RuleValues({ rule, schema, onChange, index }) {
  const [draft, setDraft] = useState(rule.values.join(', '));
  // Values changed from outside — the dialog opened again (it stays mounted
  // while shut), a new field, a rule above removed — show; what is being
  // typed, a trailing comma and all, stays as typed.
  const values = rule.values.join(',');
  useEffect(() => {
    setDraft((d) => (splitValues(d).join(',') === values ? d : rule.values.join(', ')));
  }, [values]); // eslint-disable-line react-hooks/exhaustive-deps

  if (takesDay(rule.op)) {
    return (
      <input type="date" className="input collection-values" value={rule.values[0] || ''} aria-label={`Rule ${index + 1} day`}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])} />
    );
  }
  if (!takesValues(rule.op)) return <span className="collection-values" />;

  const key = metaKey(rule.field);
  const def = key ? schema?.fields?.find((f) => f.key === key) : null;
  const choices = rule.field === 'kind' ? KINDS : def?.options?.length ? def.options : null;
  if (choices) {
    const toggle = (v) => onChange(rule.values.includes(v) ? rule.values.filter((x) => x !== v) : [...rule.values, v]);
    return (
      <div className="collection-values collection-choices" role="group" aria-label={`Rule ${index + 1} values`}>
        {choices.map((v) => (
          <button key={v} type="button" className={`chip${rule.values.includes(v) ? ' is-on' : ''}`}
            aria-pressed={rule.values.includes(v)} onClick={() => toggle(v)}>
            {rule.field === 'kind' ? KIND_LABELS[v] : v}
          </button>
        ))}
      </div>
    );
  }
  return (
    <input className="input collection-values" value={draft} aria-label={`Rule ${index + 1} values`}
      placeholder={rule.field === 'tag' ? 'hero, spring' : 'One value, or several with commas'}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(splitValues(e.target.value));
      }} />
  );
}
