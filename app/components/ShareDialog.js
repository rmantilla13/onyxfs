'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import Icon from '@/app/components/ui/Icon';
import { useToast } from '@/app/components/ui/Toast';
import {
  SHARE_KINDS, SHARE_REVIEW, SHARE_VIEWS, SHARE_THEMES, SHARE_LOGOS, SHARE_ACCENTS, SHARE_TEMPLATES,
  MIN_PASSWORD, LOOK_TITLE_MAX, LOOK_MESSAGE_MAX, TEMPLATE_NAME_MAX, expiryLabel,
} from '@/lib/share-kinds';
import {
  blankForm, applyTemplate, formFromShare, createRequest, changeRequest, templateSettings,
  expiryChoices, defaultDate, toLocalInput, lookSummary,
} from '@/lib/share-form';
import { effectiveKind } from '@/lib/media';

const KIND_LABEL = Object.fromEntries(SHARE_KINDS.map((k) => [k.id, k.label]));
const LEVEL_LABEL = { view: 'View only', comment: 'Can comment', approve: 'Can approve' };
const LEVEL_RANK = { view: 0, comment: 1, approve: 2 };
const dateFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }) : null;
const stampFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

// A folder's link is public or password-protected: a private one would open
// only for people who can already open the folder.
const FOLDER_KINDS = SHARE_KINDS.filter((k) => k.id !== 'private').map((k) => (
  k.id === 'public' ? { ...k, detail: 'Anyone with the link can open the folder.' } : k
));

/** What a level lets people do, said for this file: frames on a video, spots on a picture. */
function levelDetail(level, video) {
  if (level === 'comment') {
    return video
      ? 'They can comment on frames and ranges, draw on the picture, and reply.'
      : 'They can pin comments to spots, draw on the picture, and reply.';
  }
  if (level === 'approve') return 'They can comment, and approve it or ask for changes — which counts toward its status.';
  return 'They can open it.';
}

/** Radios drawn as one segmented control (the .share-segments pattern). */
function Segments({ name, value, options, onChange, disabled = false, label }) {
  return (
    <div className="share-segments" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.id} className={`share-segment${value === o.id ? ' is-on' : ''}`} title={o.detail || undefined}>
          <input type="radio" name={name} value={o.id} checked={value === o.id} disabled={disabled} onChange={() => onChange(o.id)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Links to one file, or to one folder: make one, see, copy, open, change or
 * revoke the ones that exist, and start from a template. The server decides
 * who may; this only asks, and offers what the list says may be made
 * (`can`, lib/share-guard.js linkChoices).
 *
 * A link is who it is for (public, password, private — a folder's, public or
 * password), what its people may do (comment and approve, on a photo or a
 * video; download, anywhere), when it expires (a number of days, or a date),
 * and how its page looks (lib/share-kinds.js: a view, a scheme, an accent,
 * the logo, and a title, a note and the sharer's name). The form is
 * lib/share-form.js, which turns it into the requests and back.
 *
 * A file (`file`): GET/POST /api/files/[id]/shares; PATCH …/[token] changes
 * an existing link in place. `canReview` says the server would let this
 * person make a link take comments; it decides again. A folder (`folder`:
 * { path, filespaceId }): /api/files/folders/shares, the same, with no
 * comments. `canCreate` false (a role that may not make public or password
 * links) leaves the list, to copy, change and revoke, and no new link.
 *
 * Templates (SHARE_TEMPLATES, and the person's own from
 * /api/share-templates) only fill the form: what it then sends is checked
 * as anything typed would be.
 *
 * A new link is copied as it is made, because copying it is the next thing
 * anyone does. The clipboard can refuse (no focus, an old browser), so the
 * link is always in the list with its own Copy button too.
 */
export default function ShareDialog({ file = null, folder = null, open, onClose, canReview = false, canCreate = true }) {
  const isFolder = !!folder;
  const target = isFolder ? 'folder' : 'file';
  const [shares, setShares] = useState(null);
  const [can, setCan] = useState(null);
  const [form, setForm] = useState(() => blankForm(target));
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fresh, setFresh] = useState(null);
  const [mine, setMine] = useState([]);
  const [applied, setApplied] = useState(null);
  const [naming, setNaming] = useState(null);
  const toast = useToast();
  const id = useId();

  const folderPath = folder?.path || '';
  const folderDrive = folder?.filespaceId || '';
  // Where the links live: a file's under the file; a folder's by its path and drive.
  const base = isFolder ? '/api/files/folders/shares' : file ? `/api/files/${file.id}/shares` : null;
  const listUrl = isFolder
    ? `${base}?${new URLSearchParams({ folder: folderPath, ...(folderDrive ? { filespace: folderDrive } : {}) })}`
    : base;
  const kinds = isFolder ? FOLDER_KINDS : SHARE_KINDS;
  const reviewable = !isFolder && canReview;
  const creatable = !isFolder || canCreate;
  const video = file && !isFolder ? effectiveKind(file) === 'video' : false;
  const name = isFolder ? folderPath.slice(folderPath.lastIndexOf('/') + 1) : file?.name;
  const editShare = editing ? (shares || []).find((s) => s.token === editing) || null : null;
  const kind = editShare ? editShare.kind : form.kind;
  const level = kind === 'private' ? 'view' : form.review;
  const views = SHARE_VIEWS[target];
  const expiry = expiryChoices(can);
  const showForm = creatable || !!editShare;

  useEffect(() => {
    if (!open || !listUrl) return undefined;
    let live = true;
    setShares(null);
    setCan(null);
    setError(null);
    setFresh(null);
    setEditing(null);
    setApplied(null);
    setNaming(null);
    // A fresh form each time: comments, a look and a kind a folder cannot
    // have are never carried over from the last thing the dialog was open for.
    setForm(blankForm(target));
    fetch(listUrl)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) { setError(body.error || `Could not load the links (HTTP ${r.status}).`); setShares([]); return; }
        setShares(body.shares || []);
        if (body.can) {
          setCan(body.can);
          setForm(blankForm(target, body.can));
        }
      })
      .catch((e) => { if (live) { setError(e.message); setShares([]); } });
    fetch('/api/share-templates')
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((body) => { if (live) setMine(body.templates || []); })
      .catch(() => {});
    return () => { live = false; };
  }, [open, listUrl, target]);

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
    setApplied(null);
  };

  const linkFor = (token) => `${window.location.origin}/s/${token}`;

  const copy = useCallback(async (token, quiet = false) => {
    try {
      await navigator.clipboard.writeText(linkFor(token));
      if (!quiet) toast.success('Link copied.');
      return true;
    } catch {
      if (!quiet) toast.error('Could not copy. Select the link and copy it instead.');
      return false;
    }
  }, [toast]);

  const pickTemplate = (t) => {
    setForm((f) => applyTemplate(f, t.settings, { target, can, reviewable }));
    setApplied(t.id);
    setError(null);
  };

  const startEdit = (s) => {
    setEditing(s.token);
    setForm(formFromShare(s, target));
    setApplied(null);
    setNaming(null);
    setError(null);
  };

  const stopEdit = () => {
    setEditing(null);
    setForm(blankForm(target, can));
    setError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!editShare && !creatable) return;
    if (!editShare && form.kind === 'password' && form.password.length < MIN_PASSWORD) {
      setError(`Use a password of at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (form.expires === 'date' && !form.expiresAt) {
      setError('Choose the date the link expires.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editShare) {
        const levels = editShare.levels || [];
        const r = await fetch(`${base}/${encodeURIComponent(editShare.token)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(changeRequest(form, editShare, { target, reviewable: levels.length > 1 })),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { setError(body.error || `Could not change the link (HTTP ${r.status}).`); return; }
        if (body.share) setShares((list) => (list || []).map((s) => (s.token === editShare.token ? body.share : s)));
        setFresh(editShare.token);
        setEditing(null);
        setForm(blankForm(target, can));
        toast.success('Link changed. It works as it did, with the new settings.');
        return;
      }
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(isFolder ? { folder: folderPath, filespaceId: folderDrive || undefined } : {}),
          ...createRequest(form, { target, reviewable }),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error || `Could not make the link (HTTP ${r.status}).`); return; }
      const share = body.share;
      setShares((list) => [share, ...(list || []).filter((s) => s.token !== share.token)]);
      setFresh(share.token);
      set({ password: '' });
      const copied = await copy(share.token, true);
      const what = share.review ? 'Review link' : 'Link';
      toast.success(copied ? `${what} made and copied.` : `${what} made.`);
    } finally {
      setBusy(false);
    }
  };

  const saveTemplate = async () => {
    const r = await fetch('/api/share-templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: naming, settings: templateSettings(form, target) }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(body.error || `Could not save the template (HTTP ${r.status}).`); return; }
    setMine((list) => [...list.filter((t) => t.id !== body.template.id), body.template]);
    setApplied(body.template.id);
    setNaming(null);
    toast.success(`Saved “${body.template.name}”. It is here the next time you share.`);
  };

  const removeTemplate = async (t) => {
    const r = await fetch(`/api/share-templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    if (!r.ok) { toast.error('Could not remove the template.'); return; }
    setMine((list) => list.filter((x) => x.id !== t.id));
    if (applied === t.id) setApplied(null);
  };

  const revoke = async (token) => {
    const r = await fetch(`${base}/${encodeURIComponent(token)}`, { method: 'DELETE' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(body.error || `Could not revoke the link (HTTP ${r.status}).`); return; }
    setShares((list) => (list || []).filter((s) => s.token !== token));
    if (editing === token) stopEdit();
    toast.success('Link revoked. It stops working now.');
  };

  const changeLevel = async (token, next) => {
    const r = await fetch(`${base}/${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ review: next }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(body.error || `Could not change the link (HTTP ${r.status}).`); return; }
    if (body.share) setShares((list) => (list || []).map((s) => (s.token === token ? body.share : s)));
    toast.success(next === 'view'
      ? 'The link is view only now. Comments already made stay on the file.'
      : `People with the link ${next === 'approve' ? 'can comment and approve' : 'can comment'} now.`);
  };

  // A link's level can go up only for someone who may make review links,
  // and down for anyone here — the route holds both to the same rule.
  const levelsFor = (s) => SHARE_REVIEW.filter((l) => reviewable || LEVEL_RANK[l.id] <= LEVEL_RANK[s.review || 'view']);
  const kindAllowed = (k) => !can || can.kinds.includes(k);
  const formReviewable = editShare ? (editShare.levels || []).length > 1 : reviewable;
  const levelChoices = editShare ? SHARE_REVIEW.filter((l) => (editShare.levels || ['view']).includes(l.id)) : SHARE_REVIEW;

  if (!file && !folder) return null;
  const templates = [...SHARE_TEMPLATES.map((t) => ({ ...t, builtIn: true })), ...mine];
  return (
    <Dialog open={open} onClose={onClose} title="Share" wide dismissable={!busy}>
      <p className="share-dialog-file" title={isFolder ? folderPath : file.name}>{name}</p>

      {showForm && (
        <div className="share-templates" role="group" aria-label="Start from a template">
          <span className="small muted">Start from</span>
          {templates.map((t) => (
            <span key={t.id} className={`share-template${applied === t.id ? ' is-on' : ''}`}>
              <button type="button" className="share-template-use" onClick={() => pickTemplate(t)} title={t.detail || 'Your template'}>
                {t.name}
              </button>
              {!t.builtIn && (
                <button type="button" className="share-template-remove" onClick={() => removeTemplate(t)} aria-label={`Remove the template ${t.name}`} title="Remove template">
                  <Icon name="x" size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {showForm ? (
        <form id={id} onSubmit={submit} className="share-form">
          {editShare && (
            <div className="share-editing">
              <span className={`tag share-tag share-tag-${editShare.kind}`}>{KIND_LABEL[editShare.kind]}</span>
              <span className="small">
                Changing <span className="mono">…{editShare.token.slice(-6)}</span>. The link stays the same; its people see the change on their next visit.
              </span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={stopEdit}>Cancel</button>
            </div>
          )}

          <div className="share-form-cols">
            <div className="share-form-col">
              {!editShare && (
                <fieldset className="share-section">
                  <legend className="share-section-title">Who can open it</legend>
                  <div className={`share-kinds${isFolder ? ' is-two' : ''}`}>
                    {kinds.map((k) => {
                      const allowed = kindAllowed(k.id);
                      return (
                        <label
                          key={k.id}
                          className={`share-kind${form.kind === k.id ? ' is-on' : ''}${allowed ? '' : ' is-off'}`}
                          title={allowed ? undefined : 'Your role can’t make this kind of link here.'}
                        >
                          <input type="radio" name="kind" value={k.id} checked={form.kind === k.id} disabled={!allowed}
                            onChange={() => set({ kind: k.id })} />
                          <span className="share-kind-text">
                            <strong>{k.label}</strong>
                            <span className="small muted">{k.detail}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {form.kind === 'password' && (
                    <label className="stack share-field">
                      <span className="small">Password</span>
                      {/* Text, not password: the sharer is choosing it to send on,
                          and needs to see what they typed. */}
                      <input className="input" type="text" value={form.password} onChange={(e) => set({ password: e.target.value })}
                        placeholder={`At least ${MIN_PASSWORD} characters`} autoComplete="off" spellCheck={false} />
                    </label>
                  )}
                </fieldset>
              )}

              <fieldset className="share-section">
                <legend className="share-section-title">What they can do</legend>
                {formReviewable && (
                  <div className="share-review">
                    <Segments name="review" label="What people with the link can do" value={level} options={levelChoices}
                      disabled={kind === 'private'} onChange={(v) => set({ review: v })} />
                    <p className="small muted share-review-detail">
                      {kind === 'private'
                        ? 'A private link opens only for members, who comment on the file itself.'
                        : levelDetail(level, video)}
                    </p>
                  </div>
                )}
                <label className={`share-check${kind === 'private' ? ' is-off' : ''}`}>
                  <input type="checkbox" checked={kind === 'private' || form.downloads} disabled={kind === 'private'}
                    onChange={(e) => set({ downloads: e.target.checked })} />
                  <span>
                    <span>Allow downloads</span>
                    <span className="small muted">
                      {kind === 'private'
                        ? ' Members can download it in the workspace anyway.'
                        : form.downloads
                          ? ' The original, and any other version they are offered.'
                          : ' The page offers none and keeps the original out of it where a preview can show the file. Anything on screen can still be captured, and a sound — or a video with no streamable copy — plays from the original.'}
                    </span>
                  </span>
                </label>
              </fieldset>

              <fieldset className="share-section">
                <legend className="share-section-title">Expires</legend>
                <div className="share-options">
                  <select className="input share-expiry" value={form.expires} aria-label="When the link expires"
                    onChange={(e) => {
                      const v = e.target.value;
                      set({ expires: v, ...(v === 'date' && !form.expiresAt ? { expiresAt: defaultDate(expiry.maxDays) } : {}) });
                    }}>
                    {editShare && (
                      <option value="keep">
                        {editShare.expiresAt
                          ? `Keep: ${stampFmt ? stampFmt.format(new Date(editShare.expiresAt)) : expiryLabel(editShare.expiresAt)}`
                          : 'Keep: never'}
                      </option>
                    )}
                    {expiry.presets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    {expiry.date && <option value="date">On a date…</option>}
                  </select>
                  {form.expires === 'date' && (
                    <input className="input share-date" type="datetime-local" value={form.expiresAt} aria-label="The date the link expires"
                      min={toLocalInput(Date.now() + 5 * 60000)}
                      max={expiry.maxDays != null ? toLocalInput(Date.now() + expiry.maxDays * 86400000) : undefined}
                      onChange={(e) => set({ expiresAt: e.target.value })} />
                  )}
                </div>
                {expiry.maxDays != null && (
                  <p className="small muted share-review-detail">Your links can last up to {expiry.maxDays} day{expiry.maxDays === 1 ? '' : 's'}.</p>
                )}
              </fieldset>
            </div>

            <fieldset className="share-section share-form-col share-look">
              <legend className="share-section-title">
                How the page looks
                <span className="share-look-summary">{lookSummary(form, views)}</span>
              </legend>
              <div className="share-look-row">
                <span className="small">Layout</span>
                <Segments name="view" label="Layout" value={form.view} options={views} onChange={(v) => set({ view: v })} />
              </div>
              <p className="small muted share-review-detail">{views.find((v) => v.id === form.view)?.detail}</p>
              <div className="share-look-row">
                <span className="small">Appearance</span>
                <Segments name="theme" label="Appearance" value={form.theme} options={SHARE_THEMES} onChange={(v) => set({ theme: v })} />
              </div>
              <div className="share-look-row">
                <span className="small">Accent</span>
                <div className="share-swatches" role="radiogroup" aria-label="Accent colour">
                  <label className={`share-swatch is-workspace${!form.accent ? ' is-on' : ''}`} title="The workspace’s accent">
                    <input type="radio" name="accent" checked={!form.accent} onChange={() => set({ accent: '' })} />
                    <span className="share-swatch-dot" />
                    <span className="sr-only">The workspace’s accent</span>
                  </label>
                  {SHARE_ACCENTS.map((c) => (
                    <label key={c} className={`share-swatch${form.accent.toUpperCase() === c ? ' is-on' : ''}`} title={c}>
                      <input type="radio" name="accent" checked={form.accent.toUpperCase() === c} onChange={() => set({ accent: c })} />
                      {/* The sharer's choice of colour, not the brand's: drawn as its own value. */}
                      <span className="share-swatch-dot" style={{ background: c }} />
                      <span className="sr-only">{c}</span>
                    </label>
                  ))}
                  <label className={`share-swatch is-custom${form.accent && !SHARE_ACCENTS.includes(form.accent.toUpperCase()) ? ' is-on' : ''}`} title="Another colour">
                    <input type="color" value={/^#[0-9a-f]{6}$/i.test(form.accent) ? form.accent : '#1D4ED8'}
                      onChange={(e) => set({ accent: e.target.value.toUpperCase() })} aria-label="Another accent colour" />
                  </label>
                </div>
              </div>
              <div className="share-look-row">
                <span className="small">Logo</span>
                <Segments name="logo" label="Logo" value={form.logo} options={SHARE_LOGOS} onChange={(v) => set({ logo: v })} />
              </div>
              <label className="stack share-field">
                <span className="small">Title <span className="muted">— over what you share</span></span>
                <input className="input" type="text" value={form.title} maxLength={LOOK_TITLE_MAX}
                  placeholder={isFolder ? 'e.g. Spring campaign — selects' : 'e.g. Final cut, for review'}
                  onChange={(e) => set({ title: e.target.value })} />
              </label>
              <label className="stack share-field">
                <span className="small">Message</span>
                <textarea className="input share-message" rows={3} value={form.message} maxLength={LOOK_MESSAGE_MAX}
                  placeholder="A note for the people you send it to."
                  onChange={(e) => set({ message: e.target.value })} />
              </label>
              <label className="share-check">
                <input type="checkbox" checked={form.sender} onChange={(e) => set({ sender: e.target.checked })} />
                <span>
                  <span>Show my name</span>
                  <span className="small muted"> “Shared by …”, with your display name. Never your address.</span>
                </span>
              </label>
            </fieldset>
          </div>

          {isFolder && !editShare && (
            <p className="small muted share-folder-note">
              People with the link see the folder as it is whenever they open it — its subfolders, and whatever is added
              later. Files shared only with certain people stay out of it
              {folderDrive ? '.' : ', and so do files in drives: share those from their drive.'}
            </p>
          )}
          {error && <p className="small share-error" role="alert">{error}</p>}

          <div className="share-actions">
            {naming == null ? (
              <button type="button" className="btn btn-ghost" onClick={() => setNaming('')}>
                <Icon name="bookmark-plus" size={16} /> Save as template
              </button>
            ) : (
              <span className="share-naming">
                <input className="input" type="text" value={naming} maxLength={TEMPLATE_NAME_MAX} placeholder="Template name" autoFocus
                  aria-label="Template name"
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); if (naming.trim()) saveTemplate(); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNaming(null); }
                  }} />
                <button type="button" className="btn btn-sm" disabled={!naming.trim()} onClick={saveTemplate}>Save</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNaming(null)}>Cancel</button>
              </span>
            )}
            <span className="spacer" />
            {editShare && <button type="button" className="btn" onClick={stopEdit}>Cancel</button>}
            <button type="submit" className="btn btn-primary share-create" disabled={busy}>
              {busy ? (editShare ? 'Saving…' : 'Making…') : editShare ? 'Save changes' : 'Make link'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="small muted share-folder-note">Your role can’t make links to folders. You can still copy, change and revoke the ones here.</p>
          {error && <p className="small share-error" role="alert">{error}</p>}
        </>
      )}

      <h3 className="share-list-title">{isFolder ? 'Links to this folder' : 'Links to this file'}</h3>
      {shares == null ? (
        <p className="small muted">Loading…</p>
      ) : shares.length === 0 ? (
        <p className="small muted">{isFolder ? 'None yet. Nobody outside can open this folder by a link to it.' : 'None yet. Nobody outside can open this file.'}</p>
      ) : (
        <ul className="share-list">
          {shares.map((s) => {
            const exp = expiryLabel(s.expiresAt);
            const expired = exp === 'Expired';
            const levelEditable = !isFolder && !expired && s.kind !== 'private' && (reviewable || !!s.review);
            const view = s.look?.view ? views.find((v) => v.id === s.look.view)?.label : null;
            return (
              <li key={s.token} className={`share-row${s.token === fresh ? ' is-fresh' : ''}${expired ? ' is-expired' : ''}${s.token === editing ? ' is-editing' : ''}`}>
                <span className={`tag share-tag share-tag-${s.kind}`}>{KIND_LABEL[s.kind] || s.kind}</span>
                <div className="share-row-main">
                  <input
                    className="share-link"
                    readOnly
                    value={linkFor(s.token)}
                    aria-label={`${KIND_LABEL[s.kind]} link`}
                    onFocus={(e) => e.target.select()}
                  />
                  <span className="small muted">
                    {[
                      !levelEditable && s.review ? LEVEL_LABEL[s.review] : null,
                      exp || 'Never expires',
                      s.downloads === false ? 'No downloads' : null,
                      view,
                      s.look?.title ? `“${s.look.title}”` : null,
                      `${s.viewCount} view${s.viewCount === 1 ? '' : 's'}`,
                      s.createdAt && dateFmt ? `made ${dateFmt.format(new Date(s.createdAt))}` : null,
                      s.createdBy ? `by ${s.createdBy}` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {levelEditable && (
                  <select
                    className={`input share-level${s.review ? ' is-review' : ''}`}
                    value={s.review || 'view'}
                    onChange={(e) => changeLevel(s.token, e.target.value)}
                    aria-label="What people with this link can do"
                  >
                    {levelsFor(s).map((l) => <option key={l.id} value={l.id}>{LEVEL_LABEL[l.id]}</option>)}
                  </select>
                )}
                {!expired && <button type="button" className="btn btn-sm" onClick={() => copy(s.token)}>Copy</button>}
                {!expired && (
                  <a className="btn btn-sm btn-ghost btn-icon" href={linkFor(s.token)} target="_blank" rel="noopener noreferrer"
                    aria-label="Open the link in a new tab" title="Open">
                    <Icon name="arrow-up-right" size={16} />
                  </a>
                )}
                <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => (editing === s.token ? stopEdit() : startEdit(s))}
                  aria-label="Change this link" aria-pressed={editing === s.token} title={expired ? 'Change — give it a later expiry' : 'Change'}>
                  <Icon name="pencil" size={16} />
                </button>
                <button type="button" className="btn btn-sm btn-ghost share-revoke" onClick={() => revoke(s.token)}>Revoke</button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
