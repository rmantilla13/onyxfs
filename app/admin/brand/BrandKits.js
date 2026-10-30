'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import Icon from '@/app/components/ui/Icon';
import { KIT_NAME_MAX, KIT_URL_MAX, KIT_FONT_MAX, MAX_KITS } from '@/lib/share-brands';
import { api } from '../_ui/api';

const ROUTE = '/api/admin/brand/kits';
const BLANK = { name: '', logoUrl: '', logoDarkUrl: '', accent: '', displayFontFamily: '', displayFontUrl: '' };
const HEX = /^#[0-9a-f]{6}$/i;

const linksLabel = (n) => (n ? `${n} live link${n === 1 ? '' : 's'}` : 'No live links');

/**
 * A kit's logo on each scheme's page colour (`surfaces`), as a share page
 * will show it: the dark one on the dark page, or the light one again when
 * there is none. An image that does not load says so, rather than leaving
 * an empty tile that looks like a logo that is white on white.
 */
function LogoTiles({ logoUrl, logoDarkUrl, name, surfaces, size = 'sm' }) {
  const [broken, setBroken] = useState({});
  const tile = (scheme, src) => (
    <span className={`kit-tile is-${scheme} is-${size}`} style={{ background: surfaces[scheme].paper, color: surfaces[scheme].muted }}
      title={scheme === 'light' ? 'Light scheme' : 'Dark scheme'}>
      {src && !broken[src]
        // An admin's own address, previewed as typed.
        ? <img src={src} alt={`${name || 'The kit'}, ${scheme} scheme`} onError={() => setBroken((b) => ({ ...b, [src]: true }))} />
        : <span className="kit-tile-note">{src ? 'Does not load' : 'No logo'}</span>}
    </span>
  );
  return (
    <span className="kit-tiles">
      {tile('light', logoUrl)}
      {tile('dark', logoDarkUrl || logoUrl)}
    </span>
  );
}

/**
 * Making a kit, or changing one (`kit`): the whole kit, sent as typed and
 * checked by the server. A new kit's accent starts as the workspace's
 * (`accent`, from the resolved brand), to change from.
 */
function KitForm({ kit = null, accent, surfaces, onDone }) {
  const router = useRouter();
  const toast = useToast();
  const id = useId();
  const [form, setForm] = useState(() => (kit ? { ...BLANK, ...kit } : { ...BLANK, accent }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => { setError(null); setForm((f) => ({ ...f, [k]: e.target.value })); };

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const body = {
      name: form.name, logoUrl: form.logoUrl, logoDarkUrl: form.logoDarkUrl, accent: form.accent,
      displayFontFamily: form.displayFontFamily, displayFontUrl: form.displayFontUrl,
    };
    try {
      if (kit) await api(`${ROUTE}/${encodeURIComponent(kit.id)}`, { method: 'PATCH', json: body });
      else await api(ROUTE, { method: 'POST', json: body });
      toast.success(kit
        ? `Saved “${form.name.trim()}”. Links that wear it show the change on their next visit.`
        : `Added “${form.name.trim()}”. Sharers can choose it the next time they open Share.`);
      onDone();
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-form kit-form" onSubmit={save} noValidate>
      <div className="admin-form-grid">
        <div className="admin-field">
          <label className="admin-field-label" htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="input" value={form.name} onChange={set('name')} maxLength={KIT_NAME_MAX} placeholder="Acme Studio" autoComplete="off" autoFocus={!kit} />
          <span className="admin-field-hint">What sharers choose it by.</span>
        </div>
        <div className="admin-field">
          <label className="admin-field-label" htmlFor={`${id}-accent`}>Accent</label>
          <span className="admin-field-row">
            <input type="color" className="kit-color" value={HEX.test(form.accent) ? form.accent : accent}
              onChange={(e) => { setError(null); setForm((f) => ({ ...f, accent: e.target.value.toUpperCase() })); }} aria-label="Pick the accent" />
            <input id={`${id}-accent`} className="input admin-mono" value={form.accent} onChange={set('accent')} maxLength={7} placeholder={accent} autoComplete="off" spellCheck={false} />
          </span>
          <span className="admin-field-hint">Darkened on the page as far as it takes to read as text, and lifted for the dark scheme.</span>
        </div>
        <div className="admin-field">
          <label className="admin-field-label" htmlFor={`${id}-logo`}>Logo</label>
          <input id={`${id}-logo`} className="input" value={form.logoUrl} onChange={set('logoUrl')} maxLength={KIT_URL_MAX} placeholder="https://… or /brand/acme.svg" autoComplete="off" spellCheck={false} />
          <span className="admin-field-hint">A wordmark or lockup, shown 22 pixels high. https://, or a path on this site.</span>
        </div>
        <div className="admin-field">
          <label className="admin-field-label" htmlFor={`${id}-dark`}>Logo for the dark scheme <span className="muted">— optional</span></label>
          <input id={`${id}-dark`} className="input" value={form.logoDarkUrl} onChange={set('logoDarkUrl')} maxLength={KIT_URL_MAX} placeholder="The logo, again" autoComplete="off" spellCheck={false} />
          <span className="admin-field-hint">For a logo whose dark letters would vanish on a dark page.</span>
        </div>
        <div className="admin-field">
          <label className="admin-field-label" htmlFor={`${id}-font`}>Display font <span className="muted">— optional</span></label>
          <input id={`${id}-font`} className="input" value={form.displayFontFamily} onChange={set('displayFontFamily')} maxLength={KIT_FONT_MAX} placeholder="The workspace’s" autoComplete="off" spellCheck={false} />
          <span className="admin-field-hint">As CSS names it, with fallbacks: Fraunces, Georgia, serif.</span>
        </div>
        <div className="admin-field">
          <label className="admin-field-label" htmlFor={`${id}-fonturl`}>Font stylesheet <span className="muted">— optional</span></label>
          <input id={`${id}-fonturl`} className="input" value={form.displayFontUrl} onChange={set('displayFontUrl')} maxLength={KIT_URL_MAX} placeholder="https://fonts.googleapis.com/css2?family=…" autoComplete="off" spellCheck={false} />
          <span className="admin-field-hint">Where the font is loaded from, unless visitors have it already.</span>
        </div>
      </div>
      <div className="kit-preview">
        <span className="small muted">On a share page</span>
        <LogoTiles logoUrl={form.logoUrl.trim()} logoDarkUrl={form.logoDarkUrl.trim()} name={form.name} surfaces={surfaces} size="lg" />
      </div>
      {error && <p className="small admin-inline-error" role="alert">{error}</p>}
      <div className="admin-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : kit ? 'Save kit' : 'Add kit'}</button>
        <button type="button" className="btn" onClick={onDone} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * The brand kits, on Admin → Brand: each with its logos on both schemes, its
 * accent and font, and how many live links wear it; added, changed and
 * removed here. Removing one asks first, and says what happens to the links
 * that wear it: they go back to the workspace's look.
 */
export default function BrandKits({ kits, accent, surfaces }) {
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(null);

  const remove = async (kit) => {
    const ok = await confirm({
      title: `Remove “${kit.name}”?`,
      body: kit.links
        ? `${linksLabel(kit.links)} wear it. They keep working, and show the workspace’s look from their next visit. Adding a kit with the same name later does not bring it back to them.`
        : 'No live link wears it. Sharers stop being offered it.',
      confirmLabel: 'Remove kit',
    });
    if (!ok) return;
    setBusy(kit.id);
    try {
      await api(`${ROUTE}/${encodeURIComponent(kit.id)}`, { method: 'DELETE' });
      toast.success(`Removed “${kit.name}”.`);
      if (editing === kit.id) setEditing(null);
      router.refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="kit-section">
      {kits.length === 0 && editing !== 'new' && (
        <p className="small muted kit-empty">None yet. Share pages wear the workspace brand until a kit is added and chosen.</p>
      )}
      {kits.length > 0 && (
        <ul className="kit-list">
          {kits.map((k) => (
            <li key={k.id} className={`kit-row${editing === k.id ? ' is-editing' : ''}`}>
              <div className="kit-row-main">
                <LogoTiles logoUrl={k.logoUrl} logoDarkUrl={k.logoDarkUrl} name={k.name} surfaces={surfaces} />
                <span className="kit-text">
                  <strong className="kit-name">{k.name}</strong>
                  <span className="small muted kit-facts">
                    {/* An admin's colour, drawn as its own value. */}
                    <span className="kit-swatch" style={{ background: k.accent }} aria-hidden="true" />
                    <span className="admin-mono">{k.accent}</span>
                    <span>· {k.displayFontFamily ? k.displayFontFamily.split(',')[0].replace(/['"]/g, '') : 'Workspace font'}</span>
                    <span>· {linksLabel(k.links)}</span>
                  </span>
                </span>
                <span className="kit-actions">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(editing === k.id ? null : k.id)} aria-expanded={editing === k.id}>
                    <Icon name="pencil" size={14} /> Edit
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(k)} disabled={busy === k.id}>
                    {busy === k.id ? 'Removing…' : 'Remove'}
                  </button>
                </span>
              </div>
              {editing === k.id && <KitForm key={`${k.id}-${k.updatedAt}`} kit={k} accent={accent} surfaces={surfaces} onDone={() => setEditing(null)} />}
            </li>
          ))}
        </ul>
      )}
      {editing === 'new' ? (
        <div className="kit-new">
          <h3 className="kit-new-title">New kit</h3>
          <KitForm accent={accent} surfaces={surfaces} onDone={() => setEditing(null)} />
        </div>
      ) : (
        <div className="admin-form-actions">
          <button type="button" className="btn" onClick={() => setEditing('new')} disabled={kits.length >= MAX_KITS}>
            <Icon name="plus" size={16} /> Add a kit
          </button>
          {kits.length >= MAX_KITS && <span className="small muted">A workspace can keep {MAX_KITS}. Remove one to add another.</span>}
        </div>
      )}
      {confirmElement}
    </div>
  );
}
