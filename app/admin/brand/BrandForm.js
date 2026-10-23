'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/app/components/ui/Toast';
import { api } from '../_ui/api';

const HEX = /^#[0-9a-f]{6}$/i;

// The form, in the groups an admin re-branding thinks in. Every key is one
// lib/brand-config.js sanitizeBrandSubmission keeps; `colour` fields get a
// picker beside the text.
const GROUPS = [
  {
    title: 'Name',
    fields: [
      { key: 'name', label: 'Name', hint: 'What the workspace is called, everywhere it says its name.' },
      { key: 'tagline', label: 'Tagline' },
      { key: 'description', label: 'Description', hint: 'For link previews and search results.' },
      { key: 'supportEmail', label: 'Support address', hint: 'Where people are told to write for help.' },
      { key: 'origin', label: 'Web address', hint: 'Where the workspace is reached. Sign-in links point here, so change it only when the address changes.' },
    ],
  },
  {
    title: 'Colours',
    fields: [
      { key: 'colorPaper', label: 'Page', colour: true },
      { key: 'colorInk', label: 'Text', colour: true },
      { key: 'colorMuted', label: 'Quiet text', colour: true },
      { key: 'colorLine', label: 'Lines', colour: true },
      { key: 'colorAccent', label: 'Accent', colour: true },
      { key: 'colorAccentDeep', label: 'Accent, pressed', colour: true },
      { key: 'colorAccentAlt', label: 'Second accent', colour: true },
      { key: 'colorAccentCool', label: 'Third accent', colour: true },
    ],
    hint: 'For the light scheme. The dark scheme is drawn from these, each colour lifted as far as it takes to read.',
  },
  {
    title: 'Type',
    fields: [
      { key: 'displayFontFamily', label: 'Display font', hint: 'Headings, as CSS names it, with fallbacks.' },
      { key: 'displayFontUrl', label: 'Display font stylesheet', hint: 'https://, or a path on this site.' },
      { key: 'bodyFontFamily', label: 'Body font' },
      { key: 'bodyFontUrl', label: 'Body font stylesheet' },
    ],
  },
  {
    title: 'Logo',
    fields: [
      { key: 'markUrl', label: 'Mark', hint: 'The square one: the browser tab, and beside the name where there is no wordmark.' },
      { key: 'lockupUrl', label: 'Wordmark', hint: 'The logo with the name in it.' },
      { key: 'lockupDarkUrl', label: 'Wordmark for the dark scheme', hint: 'Blank uses the wordmark in both.' },
      { key: 'radius', label: 'Corner radius', hint: 'As CSS writes it: 8px.' },
    ],
  },
  {
    title: 'Desktop app',
    fields: [
      { key: 'desktopProductName', label: 'App name' },
      { key: 'mountFolder', label: 'Folder in the home folder', hint: 'Where the drive appears on a Mac.' },
      { key: 'desktopScheme', label: 'Link scheme', readOnly: true, hint: 'Built into the app and registered with the system when it is installed, so it cannot change here.' },
    ],
  },
];

const KEYS = GROUPS.flatMap((g) => g.fields.filter((f) => !f.readOnly).map((f) => f.key));
// Everything saved, not only what the form shows: the save replaces the
// whole brand, so a field set some other way (colorWarning, say) has to be
// sent back as it was, or saving the form would quietly drop it.
const formOf = (config) => ({ ...(config || {}), ...Object.fromEntries(KEYS.map((k) => [k, config?.[k] ?? ''])) });

/**
 * The workspace brand, on Admin → Brand: every field lib/brand-config.js
 * lets an admin set, each showing the default it falls back to. Saved
 * whole (PUT /api/admin/brand): what the form holds replaces what was
 * saved, and a field left blank is the default again. The server refuses a
 * colour or an address it would not use, saying which.
 */
export default function BrandForm({ config, defaults }) {
  const router = useRouter();
  const toast = useToast();
  const id = useId();
  const [form, setForm] = useState(() => formOf(config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => { setError(null); setForm((f) => ({ ...f, [k]: v })); };

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = await api('/api/admin/brand', { method: 'PUT', json: { config: form } });
      setForm(formOf(body.config));
      toast.success('Saved. Pages show the brand from their next load.');
      router.refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-form brand-form" onSubmit={save} noValidate>
      {GROUPS.map((g) => (
        <fieldset key={g.title} className="brand-group">
          <legend className="brand-group-title">{g.title}</legend>
          {g.hint && <p className="admin-field-hint">{g.hint}</p>}
          <div className="admin-form-grid">
            {g.fields.map((f) => {
              const fid = `${id}-${f.key}`;
              const fallback = String(defaults?.[f.key] ?? '');
              const value = f.readOnly ? fallback : form[f.key];
              const invalid = error?.body?.field === f.key;
              return (
                <div key={f.key} className="admin-field">
                  <label className="admin-field-label" htmlFor={fid}>{f.label}</label>
                  {f.colour ? (
                    <span className="admin-field-row">
                      <input type="color" className="kit-color" value={HEX.test(value) ? value : fallback}
                        onChange={(e) => set(f.key, e.target.value.toUpperCase())} aria-label={`Pick ${f.label.toLowerCase()}`} />
                      <input id={fid} className="input admin-mono" value={value} onChange={(e) => set(f.key, e.target.value)}
                        placeholder={fallback} maxLength={7} autoComplete="off" spellCheck={false} aria-invalid={invalid || undefined} />
                    </span>
                  ) : (
                    <input id={fid} className="input" value={value} disabled={f.readOnly} onChange={(e) => set(f.key, e.target.value)}
                      placeholder={fallback} maxLength={400} autoComplete="off" spellCheck={false} aria-invalid={invalid || undefined} />
                  )}
                  {f.hint && <span className="admin-field-hint">{f.hint}</span>}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      {error && <p className="small admin-inline-error" role="alert">{error.message}</p>}
      <div className="admin-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save brand'}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setError(null); setForm(formOf(config)); }}>Discard changes</button>
      </div>
    </form>
  );
}
